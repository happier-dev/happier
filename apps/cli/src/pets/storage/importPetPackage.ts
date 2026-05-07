import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import type {
  AccountPetCreateRequestV1,
  AccountPetCreateResponseV1,
  DaemonPetImportResponseV1,
  PetAssetMediaTypeV1,
  PetPackageManifestV1,
  PetPackageSourceV1,
} from '@happier-dev/protocol';
import { PET_PACKAGE_LIMITS_V1 } from '@happier-dev/protocol';

import { createPetSourceKey } from '../discovery/createPetSourceKey';
import { splitSafePetSpritesheetRelativePath } from '../validation/validatePetManifest';
import { validatePetPackage } from '../validation/validatePetPackage';
import {
  readManagedLocalPetStorageUsage,
  rememberManagedLocalPetSource,
  resolveManagedLocalPetSourceBySourceKey,
} from './managedLocalPetRegistry';
import { resolveManagedPetRoot } from './resolveManagedPetRoot';

export { forgetManagedLocalPetSource } from './managedLocalPetRegistry';

type ManagedLocalPetImportSuccess = Readonly<{
  ok: true;
  target: 'local';
  source: Extract<PetPackageSourceV1, { kind: 'happierManagedLocal' }>;
  manifest: PetPackageManifestV1;
  digest: string;
  sizeBytes: number;
  mediaType: PetAssetMediaTypeV1;
}>;

type AccountPetImportSuccess = Extract<DaemonPetImportResponseV1, { ok: true; target: 'account' }>;
type PetImportFailure = Extract<DaemonPetImportResponseV1, { ok: false }>;

export type ImportPetPackageResult = ManagedLocalPetImportSuccess | AccountPetImportSuccess | PetImportFailure;

function sha256Digest(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function cleanupCreatedDestination(input: Readonly<{
  destination: string;
  destinationExisted: boolean;
}>): Promise<void> {
  if (input.destinationExisted) return;
  await rm(input.destination, { recursive: true, force: true }).catch(() => undefined);
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const rel = relative(rootPath, targetPath);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function prepareManagedLocalImportDestination(input: Readonly<{
  managedRoot: string;
  destination: string;
}>): Promise<Readonly<{ ok: true; destinationExisted: boolean }> | Readonly<{ ok: false }>> {
  await mkdir(input.managedRoot, { recursive: true });
  const managedRootRealPath = await realpath(input.managedRoot);
  const existing = await lstat(input.destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });

  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) return { ok: false };
    const destinationRealPath = await realpath(input.destination);
    if (!isWithinRoot(destinationRealPath, managedRootRealPath)) return { ok: false };
    return { ok: true, destinationExisted: true };
  }

  try {
    await mkdir(input.destination);
  } catch {
    return { ok: false };
  }
  const destinationRealPath = await realpath(input.destination);
  if (!isWithinRoot(destinationRealPath, managedRootRealPath)) {
    await rm(input.destination, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false };
  }
  return { ok: true, destinationExisted: false };
}

export async function importPetPackage(input: Readonly<{
  target: 'local' | 'account';
  packagePath: string;
  managedRoot?: string;
  petsSyncEnabled?: boolean;
  maxImportedPetsPerDevice?: number;
  maxImportedPetBytesPerDevice?: number;
  createAccountPet?: (request: AccountPetCreateRequestV1) => Promise<AccountPetCreateResponseV1>;
}>): Promise<ImportPetPackageResult> {
  if (input.target === 'account' && input.petsSyncEnabled !== true) {
    return { ok: false, errorCode: 'feature_disabled', error: 'pets.sync is disabled.' };
  }

  const validation = await validatePetPackage({ packagePath: input.packagePath, strict: true });
  if (!validation.ok) {
    return { ok: false, errorCode: 'validation_failed', error: 'Pet package validation failed.', validation };
  }

  if (input.target === 'account') {
    if (!input.createAccountPet) {
      return { ok: false, errorCode: 'account_upload_unavailable', error: 'Account pet upload is unavailable.' };
    }
    const spritesheetBytes = await readFile(validation.spritesheetPath);
    const account = await input.createAccountPet({
      manifest: validation.manifest,
      spritesheet: {
        mediaType: validation.mediaType,
        encoding: 'base64',
        data: spritesheetBytes.toString('base64'),
        sizeBytes: spritesheetBytes.byteLength,
        digest: sha256Digest(spritesheetBytes),
      },
      origin: { kind: 'manualImport' },
    });
    if (!account.ok) {
      return {
        ok: false,
        errorCode: account.errorCode,
        error: account.error,
      };
    }
    return { ok: true, target: 'account', account };
  }

  const managedRoot = input.managedRoot ?? resolveManagedPetRoot();
  const digestSuffix = validation.digest.replace(/^sha256:/, '').slice(0, 16);
  const safeId = validation.manifest.id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'pet';
  const destination = join(managedRoot, `${safeId}-${digestSuffix}`);
  const spritesheetParts = splitSafePetSpritesheetRelativePath(validation.manifest.spritesheetPath);
  if (spritesheetParts.length === 0) {
    return { ok: false, errorCode: 'validation_failed', error: 'Pet package validation failed.', validation };
  }
  const destinationSpritesheetPath = join(destination, ...spritesheetParts);
  const sourceKey = createPetSourceKey(['happierManagedLocal', destination, validation.digest]);
  const existingSource = await resolveManagedLocalPetSourceBySourceKey({ sourceKey, managedRoot });
  if (existingSource.ok) {
    return {
      ok: true,
      target: 'local',
      source: existingSource.source,
      manifest: validation.manifest,
      digest: validation.digest,
      sizeBytes: validation.sizeBytes,
      mediaType: validation.mediaType,
    };
  }

  const usage = await readManagedLocalPetStorageUsage({ managedRoot, excludeSourceKey: sourceKey });
  const maxImportedPetsPerDevice = input.maxImportedPetsPerDevice ?? PET_PACKAGE_LIMITS_V1.maxImportedPetsPerDevice;
  if (usage.petCount + 1 > maxImportedPetsPerDevice) {
    return { ok: false, errorCode: 'quota_exceeded', error: 'Managed local pet count quota exceeded.' };
  }
  const maxImportedPetBytesPerDevice = input.maxImportedPetBytesPerDevice ?? PET_PACKAGE_LIMITS_V1.maxImportedPetBytesPerDevice;
  if (usage.sizeBytes + validation.sizeBytes > maxImportedPetBytesPerDevice) {
    return { ok: false, errorCode: 'quota_exceeded', error: 'Managed local pet byte quota exceeded.' };
  }

  const preparedDestination = await prepareManagedLocalImportDestination({ managedRoot, destination }).catch(() => ({ ok: false as const }));
  if (!preparedDestination.ok) {
    return { ok: false, errorCode: 'internal_error', error: 'Managed local pet package destination is unsafe.' };
  }
  const destinationExisted = preparedDestination.destinationExisted;
  try {
    await copyFile(join(input.packagePath, 'pet.json'), join(destination, 'pet.json'));
    await mkdir(dirname(destinationSpritesheetPath), { recursive: true });
    await copyFile(validation.spritesheetPath, destinationSpritesheetPath);
  } catch {
    await cleanupCreatedDestination({ destination, destinationExisted });
    return { ok: false, errorCode: 'internal_error', error: 'Managed local pet package could not be copied.' };
  }

  const source = {
    kind: 'happierManagedLocal' as const,
    packagePath: destination,
    sourceKey,
  };
  const registry = await rememberManagedLocalPetSource({
    source,
    managedRoot,
  });
  if (!registry.ok) {
    await cleanupCreatedDestination({ destination, destinationExisted });
    return {
      ok: false,
      errorCode: registry.errorCode === 'validation_failed' ? 'validation_failed' : 'internal_error',
      error: registry.error,
    };
  }

  return {
    ok: true,
    target: 'local',
    source,
    manifest: validation.manifest,
    digest: validation.digest,
    sizeBytes: validation.sizeBytes,
    mediaType: validation.mediaType,
  };
}
