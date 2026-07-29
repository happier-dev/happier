import {
  findNewestSessionFileInDir,
  listSessionFileStoreRoots,
  resolveSessionFileStoreDirs,
  scanJsonlSessionFile,
} from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';
import type { ExternalSessionsSource } from '@happier-dev/plugin-sdk/experimental/sessions';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

import { OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1 } from '../../../sessionFileStoreDescriptor.js';
import { resolveOhMyPiAgentDir } from './source.js';

export type OhMyPiSessionFileIdentityMetadata = Readonly<{
  dev: number | bigint;
  ino: number | bigint;
  birthtimeMs: number;
}>;

export function formatOhMyPiSessionFileGeneration(
  metadata: OhMyPiSessionFileIdentityMetadata,
): string {
  return `${String(metadata.dev)}:${String(metadata.ino)}:${Math.trunc(metadata.birthtimeMs)}`;
}

export async function listOhMyPiSessionRoots(params: Readonly<{
  source: ExternalSessionsSource;
  env?: NodeJS.ProcessEnv;
}>): Promise<string[]> {
  const sessionsRoot = await resolveOhMyPiSessionsRoot(params);
  return [...await listSessionFileStoreRoots({ sessionsRoot })];
}

export async function resolveOhMyPiSessionsRoot(params: Readonly<{
  source: ExternalSessionsSource;
  env?: NodeJS.ProcessEnv;
}>): Promise<string> {
  const agentDir = resolveOhMyPiAgentDir({ source: params.source, env: params.env });
  const resolution = await resolveSessionFileStoreDirs({
    product: OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1,
    env: params.env,
    grantedRoot: {
      v: 1,
      productId: OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1.productId,
      agentDir,
      grantedBy: 'host-config',
    },
  });
  return resolution.sessionsRoot;
}

export async function resolveOhMyPiSessionFile(params: Readonly<{
  source: ExternalSessionsSource;
  remoteSessionId: string;
  sessionFilePath?: string | null;
  env?: NodeJS.ProcessEnv;
}>): Promise<Readonly<{ filePath: string }> | null> {
  const sessionRoots = await listOhMyPiSessionRoots({
    source: params.source,
    env: params.env,
  });
  if (params.sessionFilePath) {
    const requestedMetadata = await lstat(params.sessionFilePath).catch(() => null);
    if (!requestedMetadata?.isFile() || requestedMetadata.isSymbolicLink()) return null;
    const requestedPath = await realpath(params.sessionFilePath).catch(() => null);
    if (!requestedPath) return null;
    const isWithinRoot = sessionRoots.some((sessionRoot) => {
      const pathFromRoot = relative(sessionRoot, requestedPath);
      return pathFromRoot.length > 0
        && !isAbsolute(pathFromRoot)
        && pathFromRoot !== '..'
        && !pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
    });
    if (!isWithinRoot) return null;
    const descriptor = await scanJsonlSessionFile(requestedPath);
    return descriptor?.sessionId === params.remoteSessionId
      ? { filePath: requestedPath }
      : null;
  }
  for (const sessionRoot of sessionRoots) {
    const found = await findNewestSessionFileInDir({ sessionId: params.remoteSessionId, dir: sessionRoot });
    if (found) return { filePath: found };
  }
  return null;
}
