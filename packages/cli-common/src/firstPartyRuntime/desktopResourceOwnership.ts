import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, win32 } from 'node:path';

import { isWin32ShapedAbsolutePath } from '../path/pathShape.js';
import { withFirstPartyPayloadMutationLock } from './withFirstPartyPayloadMutationLock.js';

export type DesktopResourceOwnership = Readonly<{
  version: 1;
  createdByDesktop: true;
  consumers: readonly string[];
  /** Exact service definition this creation claim describes; directory resources have none. */
  resourceDigest?: string;
}>;

/** Attribution (`AssociatedBundleIdentifiers`/managedBy) never grants removal authority. */
export function validateDesktopBundleId(value: string): string {
  const bundleId = value.trim();
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId)) {
    throw new Error('Desktop bundle id must be a reverse-DNS identifier');
  }
  return bundleId;
}

export function resolveDesktopResourceOwnershipPath(resourcePath: string): string {
  return `${resourcePath}.desktop-ownership.json`;
}

export async function readDesktopResourceOwnership(resourcePath: string): Promise<DesktopResourceOwnership | null> {
  const path = resolveDesktopResourceOwnershipPath(resourcePath);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
    || !('createdByDesktop' in value) || value.createdByDesktop !== true
    || !('consumers' in value) || !Array.isArray(value.consumers) || value.consumers.length === 0
    || !value.consumers.every((item): item is string => typeof item === 'string' && validateDesktopBundleId(item) === item)
    || new Set(value.consumers).size !== value.consumers.length) {
    throw new Error(`Desktop resource ownership is not recognized: ${path}`);
  }
  const resourceDigest = 'resourceDigest' in value ? value.resourceDigest : undefined;
  if (resourceDigest !== undefined && (typeof resourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(resourceDigest))) {
    throw new Error(`Desktop resource identity is not recognized: ${path}`);
  }
  try {
    if (await readResourceDigest(resourcePath) !== resourceDigest) {
      throw new Error(`Desktop resource definition changed outside its owner: ${resourcePath}`);
    }
  } catch (error) {
    // A previous teardown may have removed the payload/definition before a later cleanup failed.
    // Keep its claim retryable; present replacement bytes must still match their recorded identity.
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return { version: 1, createdByDesktop: true, consumers: value.consumers, ...(resourceDigest ? { resourceDigest } : {}) };
}

async function readResourceDigest(resourcePath: string): Promise<string | undefined> {
  const entry = await lstat(resourcePath);
  if (entry.isDirectory()) return undefined;
  if (entry.isFile()) return createHash('sha256').update(await readFile(resourcePath)).digest('hex');
  throw new Error(`Desktop resource is not a recognized file or directory: ${resourcePath}`);
}

async function writeOwnership(resourcePath: string, record: DesktopResourceOwnership): Promise<void> {
  const path = resolveDesktopResourceOwnershipPath(resourcePath);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const resourceDigest = await readResourceDigest(resourcePath);
  try {
    const value = { version: record.version, createdByDesktop: record.createdByDesktop, consumers: record.consumers, ...(resourceDigest ? { resourceDigest } : {}) };
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function withOwnershipLock<T>(resourcePath: string, operation: () => Promise<T>): Promise<T> {
  const path = resolveDesktopResourceOwnershipPath(resourcePath);
  return await withFirstPartyPayloadMutationLock({
    installRoot: path,
    lockParentDir: isWin32ShapedAbsolutePath(path) ? win32.dirname(path) : dirname(path),
    operation,
  });
}

function addConsumer(record: DesktopResourceOwnership | null, bundleId: string, created: boolean): DesktopResourceOwnership | null {
  if (!record && !created) return null;
  return {
    version: 1, createdByDesktop: true,
    consumers: [...new Set([...(record?.consumers ?? []), bundleId])].sort(),
  };
}

/** `created` is supplied only by the resource's mutation owner, from its pre-install observation. */
export async function recordDesktopResourceUse(params: Readonly<{
  resourcePath: string; bundleId: string; created: boolean;
}>): Promise<void> {
  const bundleId = validateDesktopBundleId(params.bundleId);
  await withOwnershipLock(params.resourcePath, async () => {
    const record = addConsumer(await readDesktopResourceOwnership(params.resourcePath), bundleId, params.created);
    if (record) await writeOwnership(params.resourcePath, record);
  });
}

/** Serializes actual creation/adoption/rewrite against bundle removal, retaining metadata on failure. */
export async function withDesktopResourceOwnership<T>(params: Readonly<{
  resourcePath: string;
  bundleId?: string;
  preserve?: boolean;
  operation: () => Promise<Readonly<{ value: T; created: boolean }>>;
}>): Promise<T> {
  const bundleId = params.bundleId === undefined ? undefined : validateDesktopBundleId(params.bundleId);
  return await withOwnershipLock(params.resourcePath, async () => {
    const previous = bundleId || params.preserve ? await readDesktopResourceOwnership(params.resourcePath) : null;
    const result = await params.operation();
    if (bundleId) {
      const next = addConsumer(previous, bundleId, result.created);
      if (next) await writeOwnership(params.resourcePath, next);
    } else if (params.preserve && previous) {
      await writeOwnership(params.resourcePath, previous);
    } else if (!params.preserve) {
      await rm(resolveDesktopResourceOwnershipPath(params.resourcePath), { force: true });
    }
    return result.value;
  });
}

export async function releaseDesktopResourceUse(params: Readonly<{
  resourcePath: string;
  bundleId: string;
  remove: () => Promise<void>;
  /** A surviving non-Desktop dependency makes this a shared resource, retaining its bytes. */
  retainResource?: boolean;
}>): Promise<'retained' | 'removed'> {
  const bundleId = validateDesktopBundleId(params.bundleId);
  return await withOwnershipLock(params.resourcePath, async () => {
    const record = await readDesktopResourceOwnership(params.resourcePath);
    if (!record || !record.consumers.includes(bundleId)) return 'retained';
    const consumers = record.consumers.filter((consumer) => consumer !== bundleId);
    if (consumers.length > 0) {
      await writeOwnership(params.resourcePath, { ...record, consumers });
      return 'retained';
    }
    if (params.retainResource) {
      await rm(resolveDesktopResourceOwnershipPath(params.resourcePath), { force: true });
      return 'retained';
    }
    // Keep the original last-consumer record until the owner's teardown succeeds, so a denied
    // unregister is observable and retryable rather than becoming an orphaned unowned service.
    await params.remove();
    await rm(resolveDesktopResourceOwnershipPath(params.resourcePath), { force: true });
    return 'removed';
  });
}
