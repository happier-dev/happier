import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_RELATIVE_PATH,
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION,
  parseConnectedAccountRequestAuthCapabilityDocument,
  readConnectedAccountRequestAuthCapabilityFile,
  resolveConnectedAccountRequestAuthCapabilityPath,
} from '@happier-dev/plugin-sdk/experimental/cloud/request-auth';

import {
  constantTimeEqualUtf8,
  hashPrivateBearer,
  removePrivateBearerFile,
  replacePrivateBearerFile,
} from '@/daemon/privateBearerFile';

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

function isPrivateDirectoryStat(
  stat: Readonly<{
    isSymbolicLink: () => boolean;
    isDirectory: () => boolean;
    mode: number;
    uid: number;
  }>,
  currentUid: number | null,
): boolean {
  return !stat.isSymbolicLink()
    && stat.isDirectory()
    && (
      process.platform === 'win32'
      || (
        (stat.mode & 0o777) === 0o700
        && (currentUid === null || stat.uid === currentUid)
      )
    );
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
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!isPrivateDirectoryStat(rootStat, currentUid)) {
    throw new Error('connected_account_request_auth_capability_path_unsafe');
  }

  const path = resolveConnectedAccountRequestAuthCapabilityPath(rootDir);
  await replacePrivateBearerFile({
    path,
    contents: `${JSON.stringify(document)}\n`,
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
}>): Promise<ConnectedAccountRequestAuthCapabilityDescriptor | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const rootDir = resolve(input.materializedRootDir);
    const canonicalPath = resolveConnectedAccountRequestAuthCapabilityPath(rootDir);
    if (resolve(input.path) !== canonicalPath) return null;
    const capabilityDir = dirname(canonicalPath);
    const [rootStat, directoryStat, pathStat] = await Promise.all([
      lstat(rootDir),
      lstat(capabilityDir),
      lstat(canonicalPath),
    ]);
    const realRoot = await realpath(rootDir);
    const expectedCapabilityDir = join(realRoot, dirname(CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_RELATIVE_PATH));
    const expectedRealPath = join(realRoot, CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_RELATIVE_PATH);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (
      !isPrivateDirectoryStat(rootStat, currentUid)
      || !isPrivateDirectoryStat(directoryStat, currentUid)
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
      || (process.platform !== 'win32' && (fileStat.mode & 0o777) !== 0o600)
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
      !isPrivateDirectoryStat(finalRootStat, currentUid)
      || !isPrivateDirectoryStat(finalDirectoryStat, currentUid)
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
 * Reads only the non-secret facts needed to prove daemon-replacement recovery.
 * The temporary capability value never leaves this owner and is used solely to
 * drive the existing strict, symlink-safe verifier over the exact same file.
 */
export async function inspectConnectedAccountRequestAuthCapabilityFile(input: Readonly<{
  path: string;
  materializedRootDir: string;
}>): Promise<ConnectedAccountRequestAuthCapabilityRecoveryFacts | null> {
  try {
    const document = await readConnectedAccountRequestAuthCapabilityFile(input.path);
    if (!document) return null;
    const verified = await verifyConnectedAccountRequestAuthCapabilityFile({
      path: input.path,
      materializedRootDir: input.materializedRootDir,
      materializationId: document.materializationId,
      subjectScopeDigest: document.subjectScopeDigest,
      capabilityDigest: digestConnectedAccountRequestAuthCapability(document.capability),
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

export { readConnectedAccountRequestAuthCapabilityFile };
