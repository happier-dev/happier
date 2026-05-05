import {
  DaemonPetImportAccountPackageRequestV1Schema,
  DaemonPetImportLocalPackageRequestV1Schema,
  DaemonPetImportRequestV1Schema,
  PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
  type AccountPetCreateRequestV1,
  type AccountPetCreateResponseV1,
  type DaemonPetImportLocalPackageResponseV1,
  type DaemonPetImportResponseV1,
  type FeatureDecision,
  type PetPackageValidationResultV1,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { resolveCliFeatureDecisionForServer } from '@/features/featureDecisionService';

import type { PetPackageDiscoveryCache } from '../discovery/petPackageDiscoveryCache';
import { importPetPackage } from '../storage/importPetPackage';
import type { PetRpcRateLimiter } from './petRpcRateLimiter';

type ImportPetPackageDeps = Readonly<{
  createAccountPet?: (request: AccountPetCreateRequestV1) => Promise<AccountPetCreateResponseV1>;
  discoveryCache?: PetPackageDiscoveryCache;
  managedRoot?: string;
  resolvePetsSyncDecision?: () => Promise<FeatureDecision>;
  companionFeatureEnabled?: boolean;
  rateLimiter?: PetRpcRateLimiter;
}>;

function resolvePackagePath(input: Readonly<{
  packagePath?: string;
  sourceKey?: string;
  discoveryCache?: PetPackageDiscoveryCache;
}>): string | null {
  if (input.packagePath) return input.packagePath;
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
    errorCode: input.errorCode === 'validation_failed'
      ? 'validation_failed'
      : input.errorCode === 'quota_exceeded'
        ? 'quota_exceeded'
        : 'internal_error',
    error: input.error,
    ...(input.validation ? { validation: input.validation } : {}),
  };
}

async function resolveActiveServerPetsSyncDecision(): Promise<FeatureDecision> {
  const resolved = await resolveCliFeatureDecisionForServer({
    featureId: 'pets.sync',
    env: process.env,
    serverUrl: configuration.serverUrl,
  });
  return resolved.decision;
}

async function resolvePetsSyncEnabled(deps: ImportPetPackageDeps): Promise<boolean> {
  const decision = await (deps.resolvePetsSyncDecision ?? resolveActiveServerPetsSyncDecision)();
  return decision.state === 'enabled';
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

  return importPetPackage({
    target: parsed.data.target,
    packagePath: parsed.data.packagePath,
    petsSyncEnabled: parsed.data.target === 'account'
      ? await resolvePetsSyncEnabled(deps)
      : parsed.data.petsSyncEnabled,
    createAccountPet: deps.createAccountPet,
    managedRoot: deps.managedRoot,
  });
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
    packagePath: parsed.data.packagePath,
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
    importedPet: {
      sourceKey,
      petId: imported.manifest.id,
      displayName: imported.manifest.displayName,
      digest: imported.digest,
      sizeBytes: imported.sizeBytes,
      mediaType: imported.mediaType,
      source: imported.source,
      manifest: imported.manifest,
    },
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

  const packagePath = resolvePackagePath({
    packagePath: parsed.data.packagePath,
    sourceKey: parsed.data.sourceKey,
    discoveryCache: deps.discoveryCache,
  });
  if (!packagePath) {
    return { ok: false, errorCode: 'invalid_request', error: 'Pet package source was not found.' };
  }

  return importPetPackage({
    target: 'account',
    packagePath,
    petsSyncEnabled: await resolvePetsSyncEnabled(deps),
    createAccountPet: deps.createAccountPet,
  });
}
