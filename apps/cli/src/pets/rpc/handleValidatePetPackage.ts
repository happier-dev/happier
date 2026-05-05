import {
  DaemonPetValidatePackageRequestV1Schema,
  PET_PACKAGE_LIMITS_V1,
  type DaemonPetValidatePackageResponseV1,
  type PetPackageValidationIssueV1,
  type PetPackageValidationResultV1,
} from '@happier-dev/protocol';

import { validatePetPackage } from '../validation/validatePetPackage';
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

  const validation = await validatePetPackage({
    packagePath: parsed.data.packagePath,
    maxManifestBytes: clampValidationByteLimit(parsed.data.maxManifestBytes, PET_PACKAGE_LIMITS_V1.maxManifestBytes),
    maxSpritesheetBytes: clampValidationByteLimit(parsed.data.maxSpritesheetBytes, PET_PACKAGE_LIMITS_V1.maxCanonicalSpritesheetBytes),
    strict: parsed.data.strict,
  });
  return { ok: true, validation: sanitizeValidationResult(validation) };
}
