import {
  isCanonicalPetSpritesheetPathV1,
  PET_PACKAGE_LIMITS_V1,
  PetPackageManifestV1Schema,
  type PetPackageManifestV1,
  type PetPackageValidationIssueV1,
} from '@happier-dev/protocol';

export type PetManifestValidationResult =
  | Readonly<{ ok: true; manifest: PetPackageManifestV1 }>
  | Readonly<{ ok: false; issues: PetPackageValidationIssueV1[] }>;

function issue(code: PetPackageValidationIssueV1['code'], message: string): PetPackageValidationIssueV1 {
  return { code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function isSafePetSpritesheetRelativePath(value: unknown): value is string {
  return isCanonicalPetSpritesheetPathV1(value);
}

export function splitSafePetSpritesheetRelativePath(value: string): string[] {
  if (!isSafePetSpritesheetRelativePath(value)) return [];
  return value.trim().split(/[\\/]+/).filter(Boolean);
}

export function validatePetManifestBytes(
  bytes: Buffer,
  options: Readonly<{ maxManifestBytes?: number }> = {},
): PetManifestValidationResult {
  const maxManifestBytes = options.maxManifestBytes ?? PET_PACKAGE_LIMITS_V1.maxManifestBytes;
  if (bytes.byteLength > maxManifestBytes) {
    return { ok: false, issues: [issue('manifest_too_large', 'Manifest exceeds maximum size.')] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, issues: [issue('manifest_invalid_json', 'Manifest is not valid JSON.')] };
  }

  if (isRecord(raw) && typeof raw.spritesheetPath === 'string' && !isSafePetSpritesheetRelativePath(raw.spritesheetPath)) {
    return { ok: false, issues: [issue('spritesheet_path_unsafe', 'Spritesheet path must be a canonical top-level PNG or WebP filename.')] };
  }

  const parsed = PetPackageManifestV1Schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: [issue('manifest_invalid_shape', 'Manifest does not match the pet package contract.')] };
  }

  if (!isSafePetSpritesheetRelativePath(parsed.data.spritesheetPath)) {
    return { ok: false, issues: [issue('spritesheet_path_unsafe', 'Spritesheet path must be a safe relative PNG or WebP path.')] };
  }

  return { ok: true, manifest: parsed.data };
}
