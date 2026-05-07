import {
  DaemonPetImportAccountPackageRequestV1Schema,
  DaemonPetImportLocalPackageRequestV1Schema,
  DaemonPetImportRequestV1Schema,
  PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
  type AccountPetCreateRequestV1,
  type AccountPetCreateResponseV1,
  type DaemonPetImportLocalPackageResponseV1,
  type DaemonPetImportResponseV1,
  type PetPackageValidationResultV1,
} from '@happier-dev/protocol';

import type { PetPackageDiscoveryCache } from '../discovery/petPackageDiscoveryCache';
import { importPetPackage } from '../storage/importPetPackage';
import { toImportedLocalPetPackageDto } from './petSourceDto';
import type { PetRpcRateLimiter } from './petRpcRateLimiter';

type ImportPetPackageDeps = Readonly<{
  createAccountPet?: (request: AccountPetCreateRequestV1) => Promise<AccountPetCreateResponseV1>;
  discoveryCache?: PetPackageDiscoveryCache;
  managedRoot?: string;
  companionFeatureEnabled?: boolean;
  petsSyncEnabled?: boolean;
  rateLimiter?: PetRpcRateLimiter;
}>;

function resolvePackagePath(input: Readonly<{
  sourceKey?: string;
  discoveryCache?: PetPackageDiscoveryCache;
}>): string | null {
  if (!input.sourceKey) return null;
  return input.discoveryCache?.get(input.sourceKey)?.packagePath ?? null;
}

function localImportError(input: Readonly<{
  errorCode: string;
  error: string;
  validation?: PetPackageValidationResultV1;
}>): Extract<DaemonPetImportLocalPackageResponseV1, { ok: false }> {
  return {
    ok: false,
    errorCode: input.errorCode === 'validation_failed' || input.errorCode === 'quota_exceeded' ? input.errorCode : 'internal_error',
    error: input.error,
    ...(input.validation ? { validation: input.validation } : {}),
  };
}

export async function handleImportPetPackage(
  raw: unknown,
  deps: ImportPetPackageDeps = {},
): Promise<DaemonPetImportResponseV1> {
  if (deps.companionFeatureEnabled === false) {
    return { ok: false, errorCode: 'feature_disabled', error: 'pets.companion is disabled.' };
  }
  if (deps.rateLimiter?.tryConsume('importPackage') === false) {
    return { ok: false, errorCode: 'rate_limited', error: 'Pet import is rate limited.' };
  }

  const parsed = DaemonPetImportRequestV1Schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errorCode: 'invalid_request', error: 'invalid_request' };
  }

  const packagePath = resolvePackagePath({
    sourceKey: parsed.data.sourceKey,
    discoveryCache: deps.discoveryCache,
  });
  if (!packagePath) {
    return { ok: false, errorCode: 'invalid_request', error: 'Pet package source was not found.' };
  }

  const imported = await importPetPackage({
    target: parsed.data.target,
    packagePath,
    petsSyncEnabled: parsed.data.petsSyncEnabled,
    createAccountPet: deps.createAccountPet,
  });
  if (!imported.ok || imported.target === 'account') {
    return imported;
  }
  if (imported.source.kind !== 'happierManagedLocal') {
    return { ok: false, errorCode: 'internal_error', error: 'Unexpected pet import source.' };
  }
  return {
    ok: true,
    target: 'local',
    importedPet: toImportedLocalPetPackageDto({
      sourceKey: imported.source.sourceKey,
      petId: imported.manifest.id,
      displayName: imported.manifest.displayName,
      description: imported.manifest.description,
      digest: imported.digest,
      sizeBytes: imported.sizeBytes,
      mediaType: imported.mediaType,
      manifest: imported.manifest,
    }),
  };
}

export async function handleImportLocalPetPackage(
  raw: unknown,
  deps: ImportPetPackageDeps = {},
): Promise<DaemonPetImportLocalPackageResponseV1> {
  if (deps.companionFeatureEnabled === false) {
    return { ok: false, errorCode: 'feature_disabled', error: 'pets.companion is disabled.' };
  }
  if (deps.rateLimiter?.tryConsume('importPackage') === false) {
    return { ok: false, errorCode: 'rate_limited', error: 'Pet import is rate limited.' };
  }

  const parsed = DaemonPetImportLocalPackageRequestV1Schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errorCode: 'invalid_request', error: 'invalid_request' };
  }

  const packagePath = resolvePackagePath({
    sourceKey: parsed.data.sourceKey,
    discoveryCache: deps.discoveryCache,
  });
  if (!packagePath) {
    return { ok: false, errorCode: 'not_found', error: 'Pet package source was not found.' };
  }

  const imported = await importPetPackage({
    target: 'local',
    packagePath,
    managedRoot: deps.managedRoot,
  });
  if (!imported.ok) {
    return localImportError({
      errorCode: imported.errorCode,
      error: imported.error,
      validation: imported.validation,
    });
  }
  if (imported.target !== 'local') {
    return { ok: false, errorCode: 'internal_error', error: 'Unexpected pet import target.' };
  }
  if (imported.source.kind !== 'happierManagedLocal') {
    return { ok: false, errorCode: 'internal_error', error: 'Unexpected pet import source.' };
  }

  const sourceKey = imported.source.sourceKey;
  const discovered = {
    sourceKey,
    petId: imported.manifest.id,
    displayName: imported.manifest.displayName,
    packageFormat: PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
    manifest: imported.manifest,
    source: imported.source,
    packagePath: imported.source.packagePath,
    spritesheetPath: imported.manifest.spritesheetPath,
    mediaType: imported.mediaType,
    digest: imported.digest,
    sizeBytes: imported.sizeBytes,
  };
  deps.discoveryCache?.remember([discovered]);

  return {
    importedPet: toImportedLocalPetPackageDto({
      sourceKey,
      petId: imported.manifest.id,
      displayName: imported.manifest.displayName,
      description: imported.manifest.description,
      digest: imported.digest,
      sizeBytes: imported.sizeBytes,
      mediaType: imported.mediaType,
      manifest: imported.manifest,
    }),
  };
}

export async function handleImportAccountPetPackage(
  raw: unknown,
  deps: ImportPetPackageDeps = {},
): Promise<DaemonPetImportResponseV1> {
  if (deps.companionFeatureEnabled === false) {
    return { ok: false, errorCode: 'feature_disabled', error: 'pets.companion is disabled.' };
  }
  if (deps.rateLimiter?.tryConsume('importPackage') === false) {
    return { ok: false, errorCode: 'rate_limited', error: 'Pet import is rate limited.' };
  }

  const parsed = DaemonPetImportAccountPackageRequestV1Schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errorCode: 'invalid_request', error: 'invalid_request' };
  }
  if (deps.petsSyncEnabled === false) {
    return { ok: false, errorCode: 'feature_disabled', error: 'pets.sync is disabled.' };
  }

  const packagePath = resolvePackagePath({
    sourceKey: parsed.data.sourceKey,
    discoveryCache: deps.discoveryCache,
  });
  if (!packagePath) {
    return { ok: false, errorCode: 'invalid_request', error: 'Pet package source was not found.' };
  }

  const imported = await importPetPackage({
    target: 'account',
    packagePath,
    petsSyncEnabled: deps.petsSyncEnabled ?? parsed.data.petsSyncEnabled,
    createAccountPet: deps.createAccountPet,
  });
  if (!imported.ok || imported.target === 'account') {
    return imported;
  }
  return { ok: false, errorCode: 'internal_error', error: 'Unexpected pet import target.' };
}
