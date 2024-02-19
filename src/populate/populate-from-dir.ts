import fs from "fs";
import { readFile } from "node:fs/promises";

import {
  addAuthZFile,
  addAuthZFiles,
  uploadPodFile,
} from "../solid/solid-upload.js";
import { AuthFetchCache } from "../solid/auth-fetch-cache.js";
import { CONTENT_TYPE_BYTE } from "../utils/content-type.js";
import { CliArgsPopulate } from "./populate-args.js";
import { fileExists, makeDirListing } from "../utils/file-utils.js";
import {
  AccountCreateOrder,
  accountEmail,
  PodAndOwnerInfo,
} from "../common/interfaces.js";
import {
  promiseAllWithLimit,
  promiseAllWithLimitByServer,
} from "../utils/async-limiter";
import { copyFile } from "fs/promises";

import { lock, unlock } from "proper-lockfile";

// Node.js fs async function have no stacktrace
// See https://github.com/nodejs/node/issues/30944
// This works around that. And makes the code very ugly.
async function fixFsStacktrace<T>(fsPromise: Promise<T>): Promise<T> {
  try {
    return await fsPromise;
  } catch (e: any) {
    throw new Error(e.message);
  }
}

export class UploadDirsCache {
  cacheFilename?: string = undefined;
  createdDirs: Set<string> = new Set();
  saveCountDown: number = 0;
  onSaveCallback: (count: number) => void;

  constructor(
    cacheFilename?: string,
    onSaveCallback?: (count: number) => void,
    createdPods?: Set<string>
  ) {
    this.cacheFilename = cacheFilename;
    this.onSaveCallback = onSaveCallback || ((a) => {});
    this.createdDirs = createdPods ? createdPods : new Set();
  }

  private index(pod: PodAndOwnerInfoAndDirInfo, filename: string): string {
    return `${pod.webID}-${filename}`;
  }

  async add(pod: PodAndOwnerInfoAndDirInfo, filename: string): Promise<void> {
    this.createdDirs.add(this.index(pod, filename));
    this.saveCountDown++;
    //TODO only add every X files or Y time
    if (this.saveCountDown >= 100) {
      await this.flush();
      this.saveCountDown = 0;
      this.onSaveCallback(this.createdDirs.size);
    }
  }

  async flush() {
    try {
      if (this.cacheFilename) {
        //get a file lock
        await fixFsStacktrace(lock(this.cacheFilename));
        try {
          const dirArr = [...this.createdDirs.values()];
          const newFileContent = JSON.stringify(dirArr, null, 3);

          const cacheFilenameTmp = `${this.cacheFilename}.TMP`;
          const cacheFilenameTmp2 = `${this.cacheFilename}.TMP.OLD`;
          await fixFsStacktrace(
            fs.promises.writeFile(cacheFilenameTmp, newFileContent, {
              encoding: "utf-8",
            })
          );
          console.assert(await fileExists(cacheFilenameTmp));
          // await fs.promises.copyFile(cacheFilenameTmp, this.cacheFilename);
          if (await fileExists(this.cacheFilename)) {
            await fixFsStacktrace(
              fs.promises.rename(this.cacheFilename, cacheFilenameTmp2)
            );
          }
          console.assert(await fileExists(cacheFilenameTmp));
          await fixFsStacktrace(
            fs.promises.rename(cacheFilenameTmp, this.cacheFilename)
          );
          if (await fileExists(cacheFilenameTmp2)) {
            await fixFsStacktrace(fs.promises.rm(cacheFilenameTmp2));
          }
        } finally {
          await fixFsStacktrace(unlock(this.cacheFilename));
        }
      }
    } catch (e) {
      console.log("error in UploadDirsCache.flush()", e);
      throw e;
    }
  }

  has(pod: PodAndOwnerInfoAndDirInfo, filename: string): boolean {
    return this.createdDirs.has(this.index(pod, filename));
  }

  public static async fromFile(
    cacheFilename: string,
    onSaveCallback?: (count: number) => void
  ): Promise<UploadDirsCache> {
    const fileContent = await fixFsStacktrace(
      fs.promises.readFile(cacheFilename, "utf-8")
    );
    const createdPods: Set<string> = new Set(JSON.parse(fileContent));
    return new UploadDirsCache(cacheFilename, onSaveCallback, createdPods);
  }
}

export interface AccountCreateOrderAndDirInfo extends AccountCreateOrder {
  dir: string;
}
export interface PodAndOwnerInfoAndDirInfo extends PodAndOwnerInfo {
  dir: string;
}

export async function findAccountsFromDir(
  dir: string,
  ssAccountCreateUri: string
): Promise<AccountCreateOrderAndDirInfo[]> {
  //This expects a very specific dir layout, typically generated by jbr
  //  in dir there must be subdirs named for accounts/pods.
  //      (accounts and pod names are always assumed to be the same)

  const listing = await makeDirListing(dir, false);
  // return listing.dirs.map((d) => d.name);
  const providedAccountInfo: AccountCreateOrderAndDirInfo[] = [];
  for (const accountDir of listing.dirs) {
    const ai = {
      username: accountDir.name,
      password: "password",
      podName: accountDir.name,
      email: accountEmail(accountDir.name),
      index: providedAccountInfo.length,
      dir: accountDir.fullPath,
      createAccountMethod: undefined, //= auto-detect from URI
      createAccountUri: ssAccountCreateUri,
    };
    providedAccountInfo.push(ai);
  }
  return providedAccountInfo;
}

/**
 *
 * @param usersInfos
 * @param authFetchCache
 * @param cli
 * @param addAclFiles
 * @param addAcrFiles
 * @param uploadDirsCache
 * @param maxParallelism
 */
export async function populatePodsFromDir(
  usersInfos: PodAndOwnerInfoAndDirInfo[],
  authFetchCache: AuthFetchCache,
  cli: CliArgsPopulate,
  addAclFiles: boolean = false,
  addAcrFiles: boolean = false,
  uploadDirsCache?: UploadDirsCache,
  maxParallelism: number = 1
) {
  //This expects a very specific dir layout, typically generated by jbr
  //  in generatedDataBaseDir there must be subdirs named for accounts/pods.
  //      (accounts and pod names are always assumed to be the same)
  //  in these subdirs, are the files to be stored in these pod

  cli.v3(
    `populatePodsFromDir(usersInfos.length=${usersInfos.length}, usersInfos[0].webID=${usersInfos[0]?.webID}, ` +
      `usersInfos[0].dir=${usersInfos[0].dir}, addAclFiles=${addAclFiles}, addAcrFiles=${addAcrFiles})`
  );

  const workTodoByServer: Record<string, (() => Promise<void>)[]> = {};
  let skipCount = 0;
  for (const pod of usersInfos) {
    const podAuth = await authFetchCache.getPodAuth(pod);

    const podListing = await makeDirListing(pod.dir, true);

    if (!podListing.files) {
      cli.v1(
        `populatePodsFromDir will skip empty ${pod.dir} for pod ${pod.podUri}`
      );
      continue;
    }

    cli.v1(
      `populatePodsFromDir will prepare upload of ${podListing.files.length} files to pod ${pod.podUri} (${pod.index}). First file: "${podListing.files[0].pathFromBase}"`
    );
    // cli.v3(
    //   `populatePodsFromDir will upload files to pod ${
    //     pod.podUri
    //   }: ${JSON.stringify(
    //     podListing.files.map((e) => e.pathFromBase),
    //     null,
    //     3
    //   )}`
    // );

    //We don't need to create containers, they should be auto created according to the spec
    // for (const dirToCreate of podListing.dirs) {
    //   const podFilePath = joinUri(xxxxxx, xxxxxxx); `${accountDirPath}/${dirToCreate.pathFromBase}`;
    //   ... create dir in pod
    // }

    for (const fileToUpload of podListing.files) {
      const podFilePath = fileToUpload.fullPath;
      const filePathInPod = fileToUpload.pathFromBase;
      const fileName = fileToUpload.name;
      const fileDirInPod = filePathInPod.substring(
        0,
        filePathInPod.length - fileName.length
      );

      if (!uploadDirsCache || !uploadDirsCache.has(pod, filePathInPod)) {
        const work = async () => {
          cli.v3(
            `Uploading. account=${pod.username} file='${podFilePath}' filePathInPod='${filePathInPod}'`
          );

          const fileContent = await readFile(podFilePath, { encoding: "utf8" });
          await uploadPodFile(
            cli,
            pod,
            fileContent,
            filePathInPod,
            podAuth,
            CONTENT_TYPE_BYTE, //TODO use correct content type
            false,
            true,
            20
          );

          const authZTypes: ("ACP" | "WAC")[] = [];
          if (addAclFiles) {
            authZTypes.push("WAC");
          }
          if (addAcrFiles) {
            authZTypes.push("ACP");
          }
          for (const authZType of authZTypes) {
            await addAuthZFile(
              cli,
              pod,
              podAuth,
              fileDirInPod,
              fileName,
              true,
              false,
              false,
              true,
              authZType,
              false,
              true,
              15
            );
          }
          await uploadDirsCache?.add(pod, filePathInPod);
        };

        if (!workTodoByServer[pod.oidcIssuer]) {
          workTodoByServer[pod.oidcIssuer] = [];
        }
        workTodoByServer[pod.oidcIssuer].push(work);
      } else {
        //skip previously uploaded file
        //TODO test if file is actually uploaded?
        skipCount++;
      }
    }
  }

  const serverCount = Object.keys(workTodoByServer).length;
  let uploadCount = 0;
  for (const workToDo of Object.values(workTodoByServer)) {
    uploadCount += workToDo.length;
  }
  cli.v1(
    `populatePodsFromDir prepare done. Will now upload ${uploadCount} files to ${serverCount} servers. ${skipCount} uploads skipped because already done.`
  );

  if (maxParallelism <= 1) {
    for (const workToDo of Object.values(workTodoByServer)) {
      for (const work of workToDo) {
        await work();
      }
    }
  } else {
    await promiseAllWithLimitByServer(maxParallelism, workTodoByServer);
  }

  await uploadDirsCache?.flush();
}
