import { copyFile, lstat } from 'node:fs/promises';
import { readPluginArchiveIntegrity } from '@/plugins/distribution/integrity';
import { downloadRemoteFileWithLimits, resolvePluginRemoteArchiveMaxBytes } from '@/plugins/discovery/remote/fetch';
import { canonicalizeRemotePluginArchiveUrl, isRemotePluginArchiveLocator } from '@/plugins/store/install/trustIdentity';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

function readRemoteArchiveUrl(locator: string): string | null {
  if (!isRemotePluginArchiveLocator(locator)) return null;
  return canonicalizeRemotePluginArchiveUrl(locator);
}

export async function materializeArchive(params: Readonly<{
  locator: string;
  destinationPath: string;
  signal?: AbortSignal;
}>): Promise<Readonly<{
  distributionSource:
    | Readonly<{ kind: 'localFile'; path: string }>
    | Readonly<{ kind: 'remoteUrl'; url: string }>;
  byteLength: number;
  integrity: string;
  archiveDigestSha256: `sha256:${string}`;
}>> {
  const maximumBytes = resolvePluginRemoteArchiveMaxBytes();
  const remoteUrl = readRemoteArchiveUrl(params.locator);
  if (remoteUrl) {
    await downloadRemoteFileWithLimits({
      url: remoteUrl,
      destinationPath: params.destinationPath,
      maxBytes: maximumBytes,
      errorLabel: 'Remote plugin archive',
      signal: params.signal,
    });
    const facts = await readPluginArchiveIntegrity(params.destinationPath);
    return Object.freeze({
      distributionSource: Object.freeze({
        kind: 'remoteUrl',
        url: remoteUrl,
      }),
      ...facts,
    });
  }

  const sourcePath = expandHomeDirPath(params.locator.trim());
  const sourceStat = await lstat(sourcePath);
  if ((!sourceStat.isFile() && !sourceStat.isSymbolicLink()) || (maximumBytes !== null && sourceStat.size > maximumBytes)) {
    throw new Error(`Local plugin archive exceeds the configured size limit (${maximumBytes} bytes) or is not a file`);
  }
  await copyFile(sourcePath, params.destinationPath);
  const copiedStat = await lstat(params.destinationPath);
  if (!copiedStat.isFile() || copiedStat.isSymbolicLink() || (maximumBytes !== null && copiedStat.size > maximumBytes)) {
    throw new Error('Local plugin archive could not be copied into daemon-owned temporary storage');
  }
  const facts = await readPluginArchiveIntegrity(params.destinationPath);
  return Object.freeze({
    distributionSource: Object.freeze({ kind: 'localFile', path: sourcePath }),
    ...facts,
  });
}
