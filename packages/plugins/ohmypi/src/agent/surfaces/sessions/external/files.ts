import {
  findNewestSessionFileInDir,
  listSessionFileStoreRoots,
  resolveSessionFileStoreDirs,
  scanJsonlSessionFile,
} from '@happier-dev/plugin-sdk/sessions/file-stores';
import { isCanonicalAbsolutePathInsideRoot } from '@happier-dev/plugin-sdk/fs';
import { lstat, realpath } from 'node:fs/promises';

import { OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1 } from '../../../sessionFileStoreDescriptor.js';
import { resolveOhMyPiAgentDir, type OhMyPiExternalSessionSource } from './source.js';

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
  source: OhMyPiExternalSessionSource;
  env?: NodeJS.ProcessEnv;
}>): Promise<string[]> {
  const sessionsRoot = await resolveOhMyPiSessionsRoot(params);
  return [...await listSessionFileStoreRoots({ sessionsRoot })];
}

export async function resolveOhMyPiSessionsRoot(params: Readonly<{
  source: OhMyPiExternalSessionSource;
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

/**
 * Why a session file could not be produced. A caller that collapses these into
 * "no file" cannot tell an absent or unreadable source from one whose bytes now
 * belong to a different session, and a transcript reader that cannot tell them
 * apart reports both as an authoritative empty history.
 */
export type OhMyPiSessionFileResolutionV1 =
  | Readonly<{ ok: true; filePath: string }>
  | Readonly<{ ok: false; reason: 'source_unavailable' | 'source_replaced' }>;

export async function resolveOhMyPiSessionFile(params: Readonly<{
  source: OhMyPiExternalSessionSource;
  remoteSessionId: string;
  sessionFilePath?: string | null;
  env?: NodeJS.ProcessEnv;
}>): Promise<OhMyPiSessionFileResolutionV1> {
  const sessionRoots = await listOhMyPiSessionRoots({
    source: params.source,
    env: params.env,
  });
  if (params.sessionFilePath) {
    const requestedMetadata = await lstat(params.sessionFilePath).catch(() => null);
    if (!requestedMetadata?.isFile() || requestedMetadata.isSymbolicLink()) {
      return { ok: false, reason: 'source_unavailable' };
    }
    const requestedPath = await realpath(params.sessionFilePath).catch(() => null);
    if (!requestedPath) return { ok: false, reason: 'source_unavailable' };
    const isWithinRoot = sessionRoots.some((sessionRoot) => (
      isCanonicalAbsolutePathInsideRoot(sessionRoot, requestedPath)
    ));
    if (!isWithinRoot) return { ok: false, reason: 'source_unavailable' };
    const descriptor = await scanJsonlSessionFile(requestedPath);
    if (!descriptor) return { ok: false, reason: 'source_unavailable' };
    return descriptor.sessionId === params.remoteSessionId
      ? { ok: true, filePath: requestedPath }
      : { ok: false, reason: 'source_replaced' };
  }
  for (const sessionRoot of sessionRoots) {
    const found = await findNewestSessionFileInDir({ sessionId: params.remoteSessionId, dir: sessionRoot });
    if (found) return { ok: true, filePath: found };
  }
  return { ok: false, reason: 'source_unavailable' };
}
