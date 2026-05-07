import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
  PET_PACKAGE_LIMITS_V1,
  type PetPackageValidationIssueV1,
  type PetPackageValidationResultV1,
} from '@happier-dev/protocol';

import { splitSafePetSpritesheetRelativePath, validatePetManifestBytes } from './validatePetManifest';
import { type PetImageInfoDecoder, validatePetAtlasBytes } from './validatePetAtlas';

function issue(code: PetPackageValidationIssueV1['code'], message: string, path?: string): PetPackageValidationIssueV1 {
  return path ? { code, message, path } : { code, message };
}

function abortedResult(): PetPackageValidationResultV1 {
  return { ok: false, issues: [issue('internal_error', 'Pet package validation was aborted.')] };
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const rel = relative(rootPath, targetPath);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sha256Digest(parts: readonly Buffer[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return `sha256:${hash.digest('hex')}`;
}

export async function validatePetPackage(input: Readonly<{
  packagePath: string;
  maxManifestBytes?: number;
  maxSpritesheetBytes?: number;
  maxPackageBytes?: number;
  strict?: boolean;
  decoder?: PetImageInfoDecoder;
  signal?: AbortSignal;
}>): Promise<PetPackageValidationResultV1> {
  if (isAborted(input.signal)) return abortedResult();

  const packagePath = resolve(input.packagePath);
  let packageRoot: string;
  try {
    const packageStats = await stat(packagePath);
    if (isAborted(input.signal)) return abortedResult();
    if (!packageStats.isDirectory()) {
      return { ok: false, issues: [issue('package_path_unsafe', 'Pet package path must be a directory.', packagePath)] };
    }
    packageRoot = await realpath(packagePath);
    if (isAborted(input.signal)) return abortedResult();
  } catch {
    return { ok: false, issues: [issue('package_path_unsafe', 'Pet package path is not readable.', packagePath)] };
  }

  const manifestPath = join(packageRoot, 'pet.json');
  let manifestBytes: Buffer;
  try {
    const manifestLinkStats = await lstat(manifestPath);
    if (isAborted(input.signal)) return abortedResult();
    if (manifestLinkStats.isSymbolicLink()) {
      return { ok: false, issues: [issue('symlink_escape', 'Pet manifest must not be a symlink.', manifestPath)] };
    }
    const manifestRealPath = await realpath(manifestPath);
    if (!isWithinRoot(manifestRealPath, packageRoot)) {
      return { ok: false, issues: [issue('symlink_escape', 'Pet manifest resolves outside the package root.', manifestPath)] };
    }
    const manifestStats = await stat(manifestPath);
    if (isAborted(input.signal)) return abortedResult();
    const maxManifestBytes = input.maxManifestBytes ?? PET_PACKAGE_LIMITS_V1.maxManifestBytes;
    if (manifestStats.size > maxManifestBytes) {
      return { ok: false, issues: [issue('manifest_too_large', 'Manifest exceeds maximum size.', manifestPath)] };
    }
    manifestBytes = await readFile(manifestPath);
    if (isAborted(input.signal)) return abortedResult();
  } catch {
    return { ok: false, issues: [issue('manifest_missing', 'Pet manifest is missing.', manifestPath)] };
  }

  const manifest = validatePetManifestBytes(manifestBytes, { maxManifestBytes: input.maxManifestBytes });
  if (!manifest.ok) {
    return { ok: false, issues: manifest.issues };
  }

  const spritesheetParts = splitSafePetSpritesheetRelativePath(manifest.manifest.spritesheetPath);
  if (spritesheetParts.length === 0) {
    return { ok: false, issues: [issue('spritesheet_path_unsafe', 'Spritesheet path is unsafe.')] };
  }

  const spritesheetPath = resolve(packageRoot, ...spritesheetParts);
  let spritesheetRealPath: string;
  try {
    spritesheetRealPath = await realpath(spritesheetPath);
    if (isAborted(input.signal)) return abortedResult();
  } catch {
    return { ok: false, issues: [issue('spritesheet_missing', 'Spritesheet is missing.', spritesheetPath)] };
  }

  if (!isWithinRoot(spritesheetRealPath, packageRoot)) {
    return { ok: false, issues: [issue('symlink_escape', 'Spritesheet resolves outside the package root.', spritesheetPath)] };
  }

  const linkStats = await lstat(spritesheetPath).catch(() => null);
  if (isAborted(input.signal)) return abortedResult();
  if (linkStats?.isSymbolicLink()) {
    return { ok: false, issues: [issue('symlink_escape', 'Spritesheet must not be a symlink.', spritesheetPath)] };
  }

  const spritesheetStats = await stat(spritesheetRealPath).catch(() => null);
  if (isAborted(input.signal)) return abortedResult();
  if (!spritesheetStats?.isFile()) {
    return { ok: false, issues: [issue('spritesheet_missing', 'Spritesheet is not a readable file.', spritesheetPath)] };
  }

  const maxSpritesheetBytes = input.maxSpritesheetBytes ?? PET_PACKAGE_LIMITS_V1.maxCanonicalSpritesheetBytes;
  if (spritesheetStats.size > maxSpritesheetBytes) {
    return { ok: false, issues: [issue('spritesheet_too_large', 'Spritesheet exceeds maximum size.', spritesheetPath)] };
  }

  const maxPackageBytes = input.maxPackageBytes ?? PET_PACKAGE_LIMITS_V1.maxCanonicalPackageBytes;
  if (manifestBytes.byteLength + spritesheetStats.size > maxPackageBytes) {
    return { ok: false, issues: [issue('package_too_large', 'Pet package exceeds maximum size.', packageRoot)] };
  }

  const spritesheetBytes = await readFile(spritesheetRealPath);
  if (isAborted(input.signal)) return abortedResult();
  const atlas = await validatePetAtlasBytes({
    bytes: spritesheetBytes,
    filename: basename(spritesheetRealPath),
    strict: input.strict,
    decoder: input.decoder,
    signal: input.signal,
  });
  if (isAborted(input.signal)) return abortedResult();
  if (!atlas.ok) {
    return { ok: false, issues: atlas.issues };
  }

  const digest = sha256Digest([manifestBytes, spritesheetBytes]);
  return {
    ok: true,
    packageFormat: PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
    manifest: manifest.manifest,
    spritesheetPath: spritesheetRealPath,
    mediaType: atlas.mediaType,
    width: atlas.width,
    height: atlas.height,
    digest,
    sizeBytes: manifestBytes.byteLength + spritesheetBytes.byteLength,
  };
}
