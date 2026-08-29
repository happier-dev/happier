import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_MAX_SERIALIZED_UTF8_BYTES,
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_RELATIVE_PATH,
  parseConnectedAccountRequestAuthCapabilityDocument,
  resolveConnectedAccountRequestAuthCapabilityPath,
  type ConnectedAccountRequestAuthCapabilityDocumentV2,
} from '@happier-dev/agents/request-auth';
import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION,
} from '@happier-dev/protocol/connect/connected-account-request-auth';

import {
  constantTimeEqualUtf8,
  hashPrivateBearer,
} from '@/daemon/privateBearerFile';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import {
  readProtectedLocalStateFile,
  removeProtectedLocalStateFile,
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
  const verified = await openAndVerifyConnectedAccountRequestAuthCapabilityFile(input);
  if (!verified) return null;
  const { document } = verified;
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
    path: verified.canonicalPath,
    materializationId,
    subjectScopeDigest,
    capabilityDigest,
  });
}

/**
 * The one safe-open verification: it reads the capability document exactly once
 * (O_NOFOLLOW open over the canonical path, with the pre-open `lstat` retained
 * only as the identity baseline the post-read check compares against) and then
 * performs the hostile re-inspection a single time, after the canonical strict-JSON
 * snapshot exists. Every unique guard is retained — symlink refusal (O_NOFOLLOW),
 * 0600/owner/file-type facts, canonical real-path containment, identity stability
 * across the read, the named carrier byte bound, and the exact five-field document
 * parser — but the former double read and its duplicated pre-open inspection round
 * are gone: the bytes the caller reasons about are the bytes the single read
 * returned, and the digest binding plus post-snapshot inspection prove that file.
 */
async function openAndVerifyConnectedAccountRequestAuthCapabilityFile(input: Readonly<{
  path: string;
  materializedRootDir: string;
  protectedLocalStateOptions?: ProtectedLocalStateOptions;
}>): Promise<Readonly<{ document: ConnectedAccountRequestAuthCapabilityDocumentV2; canonicalPath: string }> | null> {
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
    const realRoot = await realpath(rootDir);
    const expectedCapabilityDir = join(realRoot, dirname(CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_RELATIVE_PATH));
    const expectedRealPath = join(realRoot, CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_RELATIVE_PATH);
    const [rootStat, directoryStat, pathStat] = await Promise.all([
      lstat(rootDir),
      lstat(capabilityDir),
      lstat(canonicalPath),
    ]);
    if (
      !isPrivateConnectedServiceMaterializedRootStat(rootStat, currentUid, platform)
      || !isPrivateConnectedServiceMaterializedRootStat(directoryStat, currentUid, platform)
      || pathStat.isSymbolicLink()
      || !pathStat.isFile()
    ) {
      return null;
    }

    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    handle = await open(canonicalPath, constants.O_RDONLY | noFollow);
    const fileStat = await handle.stat({ bigint: true });
    if (
      !fileStat.isFile()
      || (platform !== 'win32' && (fileStat.mode & 0o777n) !== 0o600n)
      // Carrier byte bound: refuse an oversized document before its bytes are read.
      || fileStat.size > BigInt(CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_MAX_SERIALIZED_UTF8_BYTES)
      || (pathStat.dev !== 0 && fileStat.dev !== 0n && BigInt(pathStat.dev) !== fileStat.dev)
      || (pathStat.ino !== 0 && fileStat.ino !== 0n && BigInt(pathStat.ino) !== fileStat.ino)
    ) {
      return null;
    }
    if (currentUid !== null && fileStat.uid !== BigInt(currentUid)) return null;

    const snapshot = await handle.readFile();
    const postReadFileStat = await handle.stat({ bigint: true });
    if (
      snapshot.byteLength > CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_MAX_SERIALIZED_UTF8_BYTES
      || fileStat.dev !== postReadFileStat.dev
      || fileStat.ino !== postReadFileStat.ino
      || fileStat.size !== postReadFileStat.size
      || fileStat.mtimeNs !== postReadFileStat.mtimeNs
      || fileStat.ctimeNs !== postReadFileStat.ctimeNs
    ) {
      return null;
    }
    const document = parseConnectedAccountRequestAuthCapabilityDocument(
      JSON.parse(snapshot.toString('utf8')),
    );
    if (!document) return null;

    // Hostile re-inspection happens exactly once, against the file the canonical
    // snapshot was read from, so the verified facts cannot describe different bytes.
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
      || await realpath(capabilityDir) !== expectedCapabilityDir
      || (finalPathStat.dev !== 0 && fileStat.dev !== 0n && BigInt(finalPathStat.dev) !== fileStat.dev)
      || (finalPathStat.ino !== 0 && fileStat.ino !== 0n && BigInt(finalPathStat.ino) !== fileStat.ino)
    ) {
      return null;
    }
    await Promise.all([
      verifyProtectedLocalStatePath(rootDir, 'directory', protectedLocalStateOptions),
      verifyProtectedLocalStatePath(capabilityDir, 'directory', protectedLocalStateOptions),
      verifyProtectedLocalStatePath(canonicalPath, 'file', protectedLocalStateOptions),
    ]);

    return Object.freeze({ document, canonicalPath });
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Reads only the non-secret facts needed to prove daemon-replacement recovery.
 * It derives them from the same single safe-open canonical snapshot the strict
 * verifier admits — one read, one hostile re-inspection — instead of reading the
 * secret-bearing file twice.
 */
export async function inspectConnectedAccountRequestAuthCapabilityFile(input: Readonly<{
  path: string;
  materializedRootDir: string;
  protectedLocalStateOptions?: ProtectedLocalStateOptions;
}>): Promise<ConnectedAccountRequestAuthCapabilityRecoveryFacts | null> {
  const verified = await openAndVerifyConnectedAccountRequestAuthCapabilityFile(input);
  if (!verified) return null;
  const { document, canonicalPath } = verified;
  return Object.freeze({
    path: canonicalPath,
    materializationId: document.materializationId,
    subjectScopeDigest: document.subjectScopeDigest,
  });
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

export async function removeConnectedAccountRequestAuthCapabilityFile(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await removeProtectedLocalStateFile(path);
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
      await removeProtectedLocalStateFile(current.path);
    }
    return true;
  });
}
