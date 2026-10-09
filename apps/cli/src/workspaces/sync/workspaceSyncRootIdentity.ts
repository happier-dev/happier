import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';

export type WorkspaceSyncRootObjectIdentityV1 = Readonly<{
  v: 1;
  device: string;
  inode: string;
  /** Creation evidence is included when the platform exposes it. */
  birthtimeMs: string | null;
}>;

export function isWorkspaceSyncRootObjectIdentityV1(value: unknown): value is WorkspaceSyncRootObjectIdentityV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).sort().join('\0') === ['birthtimeMs', 'device', 'inode', 'v'].sort().join('\0')
    && candidate.v === 1
    && typeof candidate.device === 'string'
    && /^\d+$/u.test(candidate.device)
    && typeof candidate.inode === 'string'
    && /^[1-9]\d*$/u.test(candidate.inode)
    && (candidate.birthtimeMs === null
      || (typeof candidate.birthtimeMs === 'string' && /^\d+(?:\.\d+)?$/u.test(candidate.birthtimeMs)));
}

/** One identity projection for both pathname admission and retained directory handles. */
export function workspaceSyncRootObjectIdentityFromStat(objectStat: Stats): WorkspaceSyncRootObjectIdentityV1 {
  if (objectStat.isSymbolicLink() || !objectStat.isDirectory()
    || !Number.isSafeInteger(objectStat.dev) || objectStat.dev < 0
    || !Number.isSafeInteger(objectStat.ino) || objectStat.ino <= 0) {
    throw Object.assign(new Error('Workspace root filesystem identity is unavailable'), { code: 'root_changed' });
  }
  return Object.freeze({
    v: 1,
    device: String(objectStat.dev),
    inode: String(objectStat.ino),
    birthtimeMs: Number.isFinite(objectStat.birthtimeMs) && objectStat.birthtimeMs > 0
      ? String(objectStat.birthtimeMs)
      : null,
  });
}

/** Path-independent identity for one real filesystem object. */
export async function readWorkspaceSyncRootObjectIdentity(path: string): Promise<WorkspaceSyncRootObjectIdentityV1> {
  return workspaceSyncRootObjectIdentityFromStat(await lstat(path));
}

export function workspaceSyncRootObjectIdentitiesEqual(
  left: WorkspaceSyncRootObjectIdentityV1,
  right: WorkspaceSyncRootObjectIdentityV1,
): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.birthtimeMs === right.birthtimeMs;
}

/** Stable identity for the filesystem object currently occupying one canonical root. */
export async function computeWorkspaceSyncRootFingerprint(canonicalRoot: string): Promise<string> {
  const rootIdentity = await readWorkspaceSyncRootObjectIdentity(canonicalRoot);
  const identity = `${rootIdentity.device}:${rootIdentity.inode}:${rootIdentity.birthtimeMs ?? '0'}`;
  return createHash('sha256')
    .update('workspace-root-v1\0')
    .update(process.platform)
    .update('\0')
    .update(canonicalRoot)
    .update('\0')
    .update(identity)
    .digest('hex');
}

/**
 * Stable identity for a canonical root that currently holds no filesystem
 * object. It never collides with a present root's fingerprint, so an approval
 * stamped against an absent destination cannot be replayed once something
 * occupies that path.
 */
export function computeWorkspaceSyncAbsentRootFingerprint(canonicalRoot: string): string {
  return createHash('sha256')
    .update('workspace-root-absent-v1\0')
    .update(process.platform)
    .update('\0')
    .update(canonicalRoot)
    .digest('hex');
}
