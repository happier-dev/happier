import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_RELATIVE_PATH,
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION,
  parseConnectedAccountRequestAuthCapabilityDocument,
  resolveConnectedAccountRequestAuthCapabilityPath,
} from '@happier-dev/agents/request-auth';

import {
  constantTimeEqualUtf8,
  hashPrivateBearer,
  removePrivateBearerFile,
} from '@/daemon/privateBearerFile';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import {
  readProtectedLocalStateFile,
  verifyProtectedLocalStatePath,
  writeProtectedLocalStateFileAtomic,
  type ProtectedLocalStateOptions,
} from '@/utils/fs/protectedLocalState';
import {
  isPrivateConnectedServiceMaterializedRootStat,
} from '../materialize/privateMaterializedRoot';

export type ConnectedAccountRequestAuthCapabilityDescriptor = Readonly<{
  path: string;
  materializationId: string;
  subjectScopeDigest: string;
  capabilityDigest: string;
}>;

export type ConnectedAccountRequestAuthCapabilityRecoveryFacts = Readonly<{
  path: string;
  materializationId: string;
  subjectScopeDigest: string;
}>;

const CAPABILITY_MUTATION_LOCK_TIMEOUT_MS = 5_000;
const CAPABILITY_MUTATION_LOCK_STALE_AFTER_MS = 30_000;

async function withCapabilityMutationLock<T>(
  materializedRootDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const rootDir = resolve(materializedRootDir);
  return await withJsonOwnerFileLock({
    lockPath: `${rootDir}.request-auth-capability.lock`,
    timeoutMs: CAPABILITY_MUTATION_LOCK_TIMEOUT_MS,
    staleAfterMs: CAPABILITY_MUTATION_LOCK_STALE_AFTER_MS,
    errorCode: 'connected_account_request_auth_capability_lock_timeout',
  }, operation);
}

function normalizeNonEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isSha256Digest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function fixedDigestEquals(left: string, right: string): boolean {
  return isSha256Digest(left)
    && isSha256Digest(right)
    && constantTimeEqualUtf8(left, right);
}

export function digestConnectedAccountRequestAuthCapability(value: unknown): string {
  const normalized = normalizeNonEmpty(value);
  if (!normalized) return '';
  return hashPrivateBearer(normalized).slice('sha256:'.length);
}

export async function writeConnectedAccountRequestAuthCapabilityFile(input: Readonly<{
  rootDir: string;
  materializationId: string;
  subjectScopeDigest: string;
  httpPort: number;
  protectedLocalStateOptions?: ProtectedLocalStateOptions;
}>): Promise<ConnectedAccountRequestAuthCapabilityDescriptor> {
  const capability = randomBytes(32).toString('base64url');
  const document = parseConnectedAccountRequestAuthCapabilityDocument({
    v: CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION,
    materializationId: input.materializationId,
    subjectScopeDigest: input.subjectScopeDigest,
    capability,
    httpPort: input.httpPort,
  });
  if (!document) {
    throw new Error('connected_account_request_auth_capability_scope_invalid');
  }
  const { materializationId, subjectScopeDigest } = document;

  const rootDir = resolve(input.rootDir);
  const rootStat = await lstat(rootDir);
  const protectedLocalStateOptions = input.protectedLocalStateOptions ?? {};
  const platform = protectedLocalStateOptions.platform ?? process.platform;
  const currentUid = platform === 'win32'
    ? null
    : (protectedLocalStateOptions.expectedUid
      ?? (typeof process.getuid === 'function' ? process.getuid() : null));
  if (!isPrivateConnectedServiceMaterializedRootStat(rootStat, currentUid, platform)) {
    throw new Error('connected_account_request_auth_capability_path_unsafe');
  }

  const path = resolveConnectedAccountRequestAuthCapabilityPath(rootDir);
  await withCapabilityMutationLock(rootDir, async () => {
    try {
      await verifyProtectedLocalStatePath(rootDir, 'directory', protectedLocalStateOptions);
    } catch {
      throw new Error('connected_account_request_auth_capability_path_unsafe');
    }
    await writeProtectedLocalStateFileAtomic(
      path,
      `${JSON.stringify(document)}\n`,
      protectedLocalStateOptions,
    );
  });

  return Object.freeze({
    path,
    materializationId,
    subjectScopeDigest,
    capabilityDigest: digestConnectedAccountRequestAuthCapability(capability),
  });
}

export async function verifyConnectedAccountRequestAuthCapabilityFile(input: Readonly<{
  path: string;
  materializedRootDir: string;
  materializationId: string;
  subjectScopeDigest: string;
  capabilityDigest: string;
  protectedLocalStateOptions?: ProtectedLocalStateOptions;
}>): Promise<ConnectedAccountRequestAuthCapabilityDescriptor | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const rootDir = resolve(input.materializedRootDir);
    const canonicalPath = resolveConnectedAccountRequestAuthCapabilityPath(rootDir);
    if (resolve(input.path) !== canonicalPath) return null;
    const capabilityDir = dirname(canonicalPath);
    const protectedLocalStateOptions = input.protectedLocalStateOptions ?? {};
    const platform = protectedLocalStateOptions.platform ?? process.platform;
    const currentUid = platform === 'win32'
      ? null
      : (protectedLocalStateOptions.expectedUid
        ?? (typeof process.getuid === 'function' ? process.getuid() : null));
    await Promise.all([
      verifyProtectedLocalStatePath(rootDir, 'directory', protectedLocalStateOptions),
      verifyProtectedLocalStatePath(capabilityDir, 'directory', protectedLocalStateOptions),
      verifyProtectedLocalStatePath(canonicalPath, 'file', protectedLocalStateOptions),
    ]);
    const [rootStat, directoryStat, pathStat] = await Promise.all([
      lstat(rootDir),
      lstat(capabilityDir),
      lstat(canonicalPath),
    ]);
    const realRoot = await realpath(rootDir);
    const expectedCapabilityDir = join(realRoot, dirname(CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_RELATIVE_PATH));
    const expectedRealPath = join(realRoot, CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_RELATIVE_PATH);
    if (
      !isPrivateConnectedServiceMaterializedRootStat(rootStat, currentUid, platform)
      || !isPrivateConnectedServiceMaterializedRootStat(directoryStat, currentUid, platform)
      || pathStat.isSymbolicLink()
      || !pathStat.isFile()
      || await realpath(capabilityDir) !== expectedCapabilityDir
      || await realpath(canonicalPath) !== expectedRealPath
    ) {
      return null;
    }

    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    handle = await open(canonicalPath, constants.O_RDONLY | noFollow);
    const fileStat = await handle.stat();
    if (
      !fileStat.isFile()
      || (platform !== 'win32' && (fileStat.mode & 0o777) !== 0o600)
      || (pathStat.dev !== 0 && fileStat.dev !== 0 && pathStat.dev !== fileStat.dev)
      || (pathStat.ino !== 0 && fileStat.ino !== 0 && pathStat.ino !== fileStat.ino)
    ) {
      return null;
    }
    if (currentUid !== null && fileStat.uid !== currentUid) return null;

    const document = parseConnectedAccountRequestAuthCapabilityDocument(
      JSON.parse(await handle.readFile({ encoding: 'utf8' })),
    );
    if (!document) return null;
    const [finalRootStat, finalDirectoryStat, finalPathStat] = await Promise.all([
      lstat(rootDir),
      lstat(capabilityDir),
      lstat(canonicalPath),
    ]);
    if (
      !isPrivateConnectedServiceMaterializedRootStat(finalRootStat, currentUid, platform)
      || !isPrivateConnectedServiceMaterializedRootStat(finalDirectoryStat, currentUid, platform)
      || finalPathStat.isSymbolicLink()
      || !finalPathStat.isFile()
      || (rootStat.dev !== 0 && finalRootStat.dev !== 0 && rootStat.dev !== finalRootStat.dev)
      || (rootStat.ino !== 0 && finalRootStat.ino !== 0 && rootStat.ino !== finalRootStat.ino)
      || (directoryStat.dev !== 0 && finalDirectoryStat.dev !== 0
        && directoryStat.dev !== finalDirectoryStat.dev)
      || (directoryStat.ino !== 0 && finalDirectoryStat.ino !== 0
        && directoryStat.ino !== finalDirectoryStat.ino)
      || await realpath(canonicalPath) !== expectedRealPath
      || (finalPathStat.dev !== 0 && fileStat.dev !== 0 && finalPathStat.dev !== fileStat.dev)
      || (finalPathStat.ino !== 0 && fileStat.ino !== 0 && finalPathStat.ino !== fileStat.ino)
    ) {
      return null;
    }
    await Promise.all([
      verifyProtectedLocalStatePath(rootDir, 'directory', protectedLocalStateOptions),
      verifyProtectedLocalStatePath(capabilityDir, 'directory', protectedLocalStateOptions),
      verifyProtectedLocalStatePath(canonicalPath, 'file', protectedLocalStateOptions),
    ]);

    const materializationId = input.materializationId;
    const subjectScopeDigest = input.subjectScopeDigest;
    const expectedCapabilityDigest = input.capabilityDigest;
    const capabilityDigest = digestConnectedAccountRequestAuthCapability(document.capability);
    if (
      document.materializationId !== materializationId
      || !fixedDigestEquals(document.subjectScopeDigest, subjectScopeDigest)
      || !fixedDigestEquals(capabilityDigest, expectedCapabilityDigest)
    ) {
      return null;
    }
    return Object.freeze({
      path: canonicalPath,
      materializationId,
      subjectScopeDigest,
      capabilityDigest,
    });
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * The daemon-side recovery path verifies the root and capability directory before
 * calling this helper; it verifies the secret-bearing file itself.
 */
export async function readConnectedAccountRequestAuthCapabilityFile(
  path: string,
  protectedLocalStateOptions: ProtectedLocalStateOptions = {},
) {
  try {
    return parseConnectedAccountRequestAuthCapabilityDocument(
      JSON.parse(await readProtectedLocalStateFile(path, protectedLocalStateOptions)),
    );
  } catch {
    return null;
  }
}

/**
 * Reads only the non-secret facts needed to prove daemon-replacement recovery.
 * The temporary capability value never leaves this owner and is used solely to
 * drive the existing strict, symlink-safe verifier over the exact same file.
 */
export async function inspectConnectedAccountRequestAuthCapabilityFile(input: Readonly<{
  path: string;
  materializedRootDir: string;
  protectedLocalStateOptions?: ProtectedLocalStateOptions;
}>): Promise<ConnectedAccountRequestAuthCapabilityRecoveryFacts | null> {
  try {
    const rootDir = resolve(input.materializedRootDir);
    const canonicalPath = resolveConnectedAccountRequestAuthCapabilityPath(rootDir);
    if (resolve(input.path) !== canonicalPath) return null;
    const protectedLocalStateOptions = input.protectedLocalStateOptions ?? {};
    await Promise.all([
      verifyProtectedLocalStatePath(rootDir, 'directory', protectedLocalStateOptions),
      verifyProtectedLocalStatePath(dirname(canonicalPath), 'directory', protectedLocalStateOptions),
    ]);
    const document = await readConnectedAccountRequestAuthCapabilityFile(
      canonicalPath,
      protectedLocalStateOptions,
    );
    if (!document) return null;
    const verified = await verifyConnectedAccountRequestAuthCapabilityFile({
      path: canonicalPath,
      materializedRootDir: rootDir,
      materializationId: document.materializationId,
      subjectScopeDigest: document.subjectScopeDigest,
      capabilityDigest: digestConnectedAccountRequestAuthCapability(document.capability),
      protectedLocalStateOptions,
    });
    if (!verified) return null;
    return Object.freeze({
      path: verified.path,
      materializationId: verified.materializationId,
      subjectScopeDigest: verified.subjectScopeDigest,
    });
  } catch {
    return null;
  }
}

export async function removeConnectedAccountRequestAuthCapabilityFile(path: string): Promise<void> {
  await removePrivateBearerFile(path);
}

export async function removeConnectedAccountRequestAuthCapabilityFileIfOwned(
  input: Readonly<{
    descriptor: ConnectedAccountRequestAuthCapabilityDescriptor;
    materializedRootDir: string;
    removeMaterializedRoot?: boolean;
  }>,
): Promise<boolean> {
  const rootDir = resolve(input.materializedRootDir);
  return await withCapabilityMutationLock(rootDir, async () => {
    const current = await verifyConnectedAccountRequestAuthCapabilityFile({
      ...input.descriptor,
      materializedRootDir: rootDir,
    });
    if (!current) return false;
    if (input.removeMaterializedRoot === true) {
      await rm(rootDir, { recursive: true, force: true });
    } else {
      await removePrivateBearerFile(current.path);
    }
    return true;
  });
}
