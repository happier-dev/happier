import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  AccountPetCreateRequestV1,
  AccountPetCreateResponseV1,
  DaemonPetImportResponseV1,
} from '@happier-dev/protocol';
import { PET_PACKAGE_LIMITS_V1 } from '@happier-dev/protocol';

import { createPetSourceKey } from '../discovery/createPetSourceKey';
import { splitSafePetSpritesheetRelativePath } from '../validation/validatePetManifest';
import { validatePetPackage } from '../validation/validatePetPackage';
import { readManagedLocalPetStorageUsage, rememberManagedLocalPetSource } from './managedLocalPetRegistry';
import { resolveManagedPetRoot } from './resolveManagedPetRoot';

export { forgetManagedLocalPetSource } from './managedLocalPetRegistry';

function sha256Digest(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function pathExists(path: string): Promise<boolean> {
  return await lstat(path)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
}

async function cleanupCreatedDestination(input: Readonly<{
  destination: string;
  destinationExisted: boolean;
}>): Promise<void> {
  if (input.destinationExisted) return;
  await rm(input.destination, { recursive: true, force: true }).catch(() => undefined);
}

export async function importPetPackage(input: Readonly<{
  target: 'local' | 'account';
  packagePath: string;
  managedRoot?: string;
  petsSyncEnabled?: boolean;
  maxImportedPetsPerDevice?: number;
  maxImportedPetBytesPerDevice?: number;
  createAccountPet?: (request: AccountPetCreateRequestV1) => Promise<AccountPetCreateResponseV1>;
}>): Promise<DaemonPetImportResponseV1> {
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
      return { ok: false, errorCode: account.errorCode, error: account.error };
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
  const usage = await readManagedLocalPetStorageUsage({ managedRoot, excludeSourceKey: sourceKey });
  const maxImportedPetsPerDevice = input.maxImportedPetsPerDevice ?? PET_PACKAGE_LIMITS_V1.maxImportedPetsPerDevice;
  if (usage.petCount + 1 > maxImportedPetsPerDevice) {
    return { ok: false, errorCode: 'quota_exceeded', error: 'Managed local pet count quota exceeded.' };
  }
  const maxImportedPetBytesPerDevice = input.maxImportedPetBytesPerDevice ?? PET_PACKAGE_LIMITS_V1.maxImportedPetBytesPerDevice;
  if (usage.sizeBytes + validation.sizeBytes > maxImportedPetBytesPerDevice) {
    return { ok: false, errorCode: 'quota_exceeded', error: 'Managed local pet byte quota exceeded.' };
  }

  const destinationExisted = await pathExists(destination);
  try {
    await mkdir(destination, { recursive: true });
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
