import { DaemonPetValidatePackageRequestV1Schema } from '@happier-dev/protocol/pets/daemonRpc';
import { PET_PACKAGE_LIMITS_V1 } from '@happier-dev/protocol/pets/constants';
import type { DaemonPetValidatePackageResponseV1, PetPackageValidationIssueV1, PetPackageValidationResultV1 } from '@happier-dev/protocol';

import { validatePetPackage } from '../validation/validatePetPackage';
import { createPetSourceKey } from '../discovery/createPetSourceKey';
import type { PetPackageDiscoveryCache } from '../discovery/petPackageDiscoveryCache';
import { resolvePetPackagePath } from '../discovery/petPackageDiscoveryCache';
import type { PetRpcRateLimiter } from './petRpcRateLimiter';

function clampValidationByteLimit(value: number | undefined, max: number): number {
  if (value === undefined) return max;
  return Math.min(value, max);
}

function sanitizeValidationIssue(issue: PetPackageValidationIssueV1): PetPackageValidationIssueV1 {
  const { path: _path, ...sanitizedIssue } = issue;
  return sanitizedIssue;
}

function sanitizeValidationResult(validation: PetPackageValidationResultV1): PetPackageValidationResultV1 {
  if (!validation.ok) {
    return {
      ...validation,
      issues: validation.issues.map(sanitizeValidationIssue),
    };
  }
  return {
    ...validation,
    spritesheetPath: validation.manifest.spritesheetPath,
  };
}

export async function handleValidatePetPackage(
  raw: unknown,
  deps: Readonly<{
    companionFeatureEnabled?: boolean;
    rateLimiter?: PetRpcRateLimiter;
    discoveryCache?: PetPackageDiscoveryCache;
  }> = {},
): Promise<DaemonPetValidatePackageResponseV1> {
  if (deps.companionFeatureEnabled === false) {
    return { ok: false, errorCode: 'feature_disabled', error: 'pets.companion is disabled.' };
  }
  if (deps.rateLimiter?.tryConsume('validatePackage') === false) {
    return { ok: false, errorCode: 'rate_limited', error: 'Pet validation is rate limited.' };
  }

  const parsed = DaemonPetValidatePackageRequestV1Schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errorCode: 'invalid_request', error: 'invalid_request' };
  }

  const packagePath = resolvePetPackagePath({ ...parsed.data, discoveryCache: deps.discoveryCache });
  if (!packagePath) return { ok: false, errorCode: 'invalid_request', error: 'Pet package source was not found.' };
  const validation = await validatePetPackage({
    packagePath,
    maxManifestBytes: clampValidationByteLimit(parsed.data.maxManifestBytes, PET_PACKAGE_LIMITS_V1.maxManifestBytes),
    maxSpritesheetBytes: clampValidationByteLimit(parsed.data.maxSpritesheetBytes, PET_PACKAGE_LIMITS_V1.maxCanonicalSpritesheetBytes),
    strict: parsed.data.strict,
  });
  if (validation.ok && deps.discoveryCache) {
    const sourceKey = createPetSourceKey(['validatedPackage', packagePath, validation.digest]);
    deps.discoveryCache.remember([{
      sourceKey,
      petId: validation.manifest.id,
      displayName: validation.manifest.displayName,
      packageFormat: validation.packageFormat,
      manifest: validation.manifest,
      mediaType: validation.mediaType,
      digest: validation.digest,
      sizeBytes: validation.sizeBytes,
      packagePath,
      spritesheetPath: validation.spritesheetPath,
    }]);
    return { ok: true, validation: sanitizeValidationResult(validation), previewHandle: { kind: 'daemonSourceKey', sourceKey } };
  }
  return { ok: true, validation: sanitizeValidationResult(validation) };
}
