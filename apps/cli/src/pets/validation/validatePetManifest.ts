import { posix, win32 } from 'node:path';

import {
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

function hasUrlScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

export function isSafePetSpritesheetRelativePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes('\0')) return false;
  if (hasUrlScheme(trimmed)) return false;
  if (posix.isAbsolute(trimmed) || win32.isAbsolute(trimmed)) return false;

  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.some((part) => part === '.' || part === '..')) return false;

  const basename = parts[parts.length - 1]!.toLowerCase();
  return basename.endsWith('.png') || basename.endsWith('.webp');
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

  const rawSpritesheetPath = raw && typeof raw === 'object' && 'spritesheetPath' in raw
    ? (raw as { spritesheetPath?: unknown }).spritesheetPath
    : undefined;
  if (typeof rawSpritesheetPath === 'string' && !isSafePetSpritesheetRelativePath(rawSpritesheetPath)) {
    return { ok: false, issues: [issue('spritesheet_path_unsafe', 'Spritesheet path must be a safe relative PNG or WebP path.')] };
  }

  const parsed = PetPackageManifestV1Schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: [issue('manifest_invalid_shape', 'Manifest does not match the pet package contract.')] };
  }

  return { ok: true, manifest: parsed.data };
}
