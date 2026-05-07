import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { PetPackageSourceV1 } from '@happier-dev/protocol';
import { z } from 'zod';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import { createPetSourceKey } from '../discovery/createPetSourceKey';
import { validatePetPackage } from '../validation/validatePetPackage';
import { resolveManagedPetRoot } from './resolveManagedPetRoot';

export const MANAGED_LOCAL_PET_REGISTRY_FILE = '.managed-local-pet-registry-v1.json';

type ManagedLocalPetSource = Extract<PetPackageSourceV1, { kind: 'happierManagedLocal' }>;

type ManagedLocalPetRegistryEntry = Readonly<{
  kind: 'happierManagedLocal';
  sourceKey: string;
  packagePath: string;
}>;

type ManagedLocalPetRegistryLookupResult =
  | Readonly<{ ok: true; source: ManagedLocalPetSource }>
  | Readonly<{ ok: false; errorCode: 'not_found' | 'validation_failed' | 'unsupported_source' | 'internal_error'; error: string }>;

type ManagedLocalPetRegistryWriteResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; errorCode: 'validation_failed' | 'unsupported_source' | 'internal_error'; error: string }>;

export type ManagedLocalPetStorageUsage = Readonly<{
  petCount: number;
  sizeBytes: number;
}>;

type ManagedLocalPetRegistryForgetResult =
  | Readonly<{ ok: true; sourceKey: string }>
  | Readonly<{ ok: false; errorCode: 'not_found' | 'validation_failed' | 'unsupported_source' | 'internal_error'; error: string }>;

const PetSourceKeySchema = z.string().regex(/^pet:[a-f0-9]{32}$/u);

const ManagedLocalPetRegistryEntrySchema = z.object({
  kind: z.literal('happierManagedLocal'),
  sourceKey: PetSourceKeySchema,
  packagePath: z.string().min(1).max(10_000),
}).strip();

const ManagedLocalPetRegistryFileSchema = z.object({
  version: z.literal(1),
  pets: z.record(z.string(), z.unknown()),
}).strip();

function registryPath(managedRoot: string): string {
  return join(managedRoot, MANAGED_LOCAL_PET_REGISTRY_FILE);
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const rel = relative(rootPath, targetPath);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function readRegistryJson(managedRoot: string): Promise<unknown | null> {
  const path = registryPath(managedRoot);
  const stats = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stats) return null;
  if (stats.isSymbolicLink() || !stats.isFile()) return null;

  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function readRegistryEntry(input: Readonly<{
  sourceKey: string;
  managedRoot: string;
}>): Promise<'missing' | 'invalid' | ManagedLocalPetRegistryEntry> {
  if (!PetSourceKeySchema.safeParse(input.sourceKey).success) return 'invalid';

  const raw = await readRegistryJson(input.managedRoot);
  if (!raw) return 'missing';
  const registry = ManagedLocalPetRegistryFileSchema.safeParse(raw);
  if (!registry.success) return 'invalid';

  const rawEntry = registry.data.pets[input.sourceKey];
  if (rawEntry === undefined) return 'missing';

  const entry = ManagedLocalPetRegistryEntrySchema.safeParse(rawEntry);
  if (!entry.success) return 'invalid';
  if (entry.data.sourceKey !== input.sourceKey) return 'invalid';
  return entry.data;
}

async function readValidRegistryEntries(managedRoot: string): Promise<Record<string, ManagedLocalPetRegistryEntry>> {
  const raw = await readRegistryJson(managedRoot);
  const registry = ManagedLocalPetRegistryFileSchema.safeParse(raw);
  if (!registry.success) return {};

  const entries: Record<string, ManagedLocalPetRegistryEntry> = {};
  for (const [sourceKey, rawEntry] of Object.entries(registry.data.pets)) {
    const entry = ManagedLocalPetRegistryEntrySchema.safeParse(rawEntry);
    if (!entry.success) continue;
    if (sourceKey !== entry.data.sourceKey) continue;
    entries[sourceKey] = entry.data;
  }
  return entries;
}

export async function readManagedLocalPetStorageUsage(input: Readonly<{
  managedRoot?: string;
  excludeSourceKey?: string;
}> = {}): Promise<ManagedLocalPetStorageUsage> {
  const managedRoot = input.managedRoot ?? resolveManagedPetRoot();
  let petCount = 0;
  let sizeBytes = 0;

  const entries = await readdir(managedRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const packagePath = join(managedRoot, entry.name);
    const validation = await validatePetPackage({ packagePath });
    if (!validation.ok) continue;
    const sourceKey = createPetSourceKey(['happierManagedLocal', packagePath, validation.digest]);
    if (sourceKey === input.excludeSourceKey) continue;
    petCount += 1;
    sizeBytes += validation.sizeBytes;
  }

  return { petCount, sizeBytes };
}

async function forgetRegistryEntry(input: Readonly<{
  sourceKey: string;
  managedRoot: string;
}>): Promise<void> {
  const entries = await readValidRegistryEntries(input.managedRoot);
  delete entries[input.sourceKey];
  await writeJsonAtomic(registryPath(input.managedRoot), {
    version: 1,
    pets: entries,
  });
}

async function resolveSafeManagedEntrySource(input: Readonly<{
  entry: ManagedLocalPetRegistryEntry;
  managedRoot: string;
}>): Promise<ManagedLocalPetRegistryLookupResult> {
  if (!isAbsolute(input.entry.packagePath)) {
    return { ok: false, errorCode: 'unsupported_source', error: 'Managed pet package path must be absolute.' };
  }

  const managedRootPath = resolve(input.managedRoot);
  const managedRootRealPath = await realpath(managedRootPath).catch(() => null);
  if (!managedRootRealPath) {
    return { ok: false, errorCode: 'not_found', error: 'Managed pet import root was not found.' };
  }

  const packagePath = resolve(input.entry.packagePath);
  const packageStats = await lstat(packagePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!packageStats) {
    return { ok: false, errorCode: 'not_found', error: 'Managed pet package was not found.' };
  }
  if (packageStats.isSymbolicLink() || !packageStats.isDirectory()) {
    return { ok: false, errorCode: 'unsupported_source', error: 'Managed pet package path is unsafe.' };
  }

  const packageRealPath = await realpath(packagePath).catch(() => null);
  if (!packageRealPath) {
    return { ok: false, errorCode: 'not_found', error: 'Managed pet package was not found.' };
  }
  if (!isWithinRoot(packageRealPath, managedRootRealPath)) {
    return { ok: false, errorCode: 'unsupported_source', error: 'Managed pet package is outside the import root.' };
  }

  const validation = await validatePetPackage({ packagePath });
  if (!validation.ok) {
    return { ok: false, errorCode: 'validation_failed', error: 'Managed pet package failed validation.' };
  }

  const expectedSourceKey = createPetSourceKey(['happierManagedLocal', packagePath, validation.digest]);
  if (input.entry.sourceKey !== expectedSourceKey) {
    return { ok: false, errorCode: 'unsupported_source', error: 'Managed pet source key does not match the package.' };
  }

  return {
    ok: true,
    source: {
      kind: 'happierManagedLocal',
      packagePath,
      sourceKey: input.entry.sourceKey,
    },
  };
}

export async function rememberManagedLocalPetSource(input: Readonly<{
  source: ManagedLocalPetSource;
  managedRoot?: string;
}>): Promise<ManagedLocalPetRegistryWriteResult> {
  const managedRoot = input.managedRoot ?? resolveManagedPetRoot();
  const entry: ManagedLocalPetRegistryEntry = {
    kind: 'happierManagedLocal',
    sourceKey: input.source.sourceKey,
    packagePath: input.source.packagePath,
  };
  const safeSource = await resolveSafeManagedEntrySource({ entry, managedRoot });
  if (!safeSource.ok) {
    return {
      ok: false,
      errorCode: safeSource.errorCode === 'not_found' ? 'unsupported_source' : safeSource.errorCode,
      error: safeSource.error,
    };
  }

  try {
    const entries = await readValidRegistryEntries(managedRoot);
    entries[entry.sourceKey] = entry;
    await writeJsonAtomic(registryPath(managedRoot), {
      version: 1,
      pets: entries,
    });
    return { ok: true };
  } catch {
    return { ok: false, errorCode: 'internal_error', error: 'Managed pet registry could not be written.' };
  }
}

export async function resolveManagedLocalPetSourceBySourceKey(input: Readonly<{
  sourceKey: string;
  managedRoot?: string;
}>): Promise<ManagedLocalPetRegistryLookupResult> {
  const managedRoot = input.managedRoot ?? resolveManagedPetRoot();
  const entry = await readRegistryEntry({ sourceKey: input.sourceKey, managedRoot });
  if (entry === 'missing') {
    return { ok: false, errorCode: 'not_found', error: 'Managed pet source was not found.' };
  }
  if (entry === 'invalid') {
    return { ok: false, errorCode: 'unsupported_source', error: 'Managed pet registry entry is invalid.' };
  }
  return resolveSafeManagedEntrySource({ entry, managedRoot });
}

export async function forgetManagedLocalPetSource(input: Readonly<{
  sourceKey: string;
  managedRoot?: string;
}>): Promise<ManagedLocalPetRegistryForgetResult> {
  const managedRoot = input.managedRoot ?? resolveManagedPetRoot();
  const entry = await readRegistryEntry({ sourceKey: input.sourceKey, managedRoot });
  if (entry === 'missing') {
    return { ok: false, errorCode: 'not_found', error: 'Managed pet source was not found.' };
  }
  if (entry === 'invalid') {
    return { ok: false, errorCode: 'unsupported_source', error: 'Managed pet registry entry is invalid.' };
  }

  const safeSource = await resolveSafeManagedEntrySource({ entry, managedRoot });
  if (!safeSource.ok && safeSource.errorCode !== 'not_found') {
    return safeSource;
  }

  try {
    if (safeSource.ok) {
      await rm(safeSource.source.packagePath, { recursive: true, force: true });
    }
    await forgetRegistryEntry({ sourceKey: input.sourceKey, managedRoot });
    return { ok: true, sourceKey: input.sourceKey };
  } catch {
    return { ok: false, errorCode: 'internal_error', error: 'Managed pet source could not be removed.' };
  }
}
