/**
 * Canonical filesystem-safety helpers for voice model packs.
 *
 * Owned by protocol so UI installer paths and the CLI daemon worker share one
 * regex, bound, and traversal-rejection policy.
 */

import { readPortablePathSegmentViolation } from '../../filesystem/portablePathSegment.js';

const PACK_ID_FILESYSTEM_SAFE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const PACK_ID_MAX_LENGTH = 256;
const PORTABLE_PATH_ASCII_SEGMENT = /^[\x20-\x7e]+$/;
const MODEL_PACK_HOST_OWNED_ROOT_PATH_ALIAS_KEYS = new Set(['pack.json', '.resume-plan.json']);

/**
 * Split a relative model-pack file path into trimmed segments, rejecting unsafe
 * paths (absolute, backslash-bearing, traversal, NUL, or empty) with
 * `model_pack_invalid_path`.
 */
export function filePathParts(path: string): string[] {
  const raw = path.trim();
  if (!raw) throw new Error('model_pack_invalid_path');
  if (raw.startsWith('/') || raw.startsWith('\\')) throw new Error('model_pack_invalid_path');
  if (raw.includes('\\')) throw new Error('model_pack_invalid_path');
  if (raw.includes('\0')) throw new Error('model_pack_invalid_path');

  const parts = raw
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error('model_pack_invalid_path');
  for (const p of parts) {
    if (p === '.' || p === '..') throw new Error('model_pack_invalid_path');
  }
  return parts;
}

/**
 * Validate one manifest path against the cross-platform file ABI used by both
 * daemon and native installers. This rejects names with filesystem-specific
 * meaning (for example NTFS alternate streams and reserved device names).
 */
export function assertModelPackFilePathPortable(path: string): readonly string[] {
  const parts = filePathParts(path);
  if (parts.join('/') !== path) throw new Error('model_pack_invalid_path');
  for (const part of parts) {
    if (
      !PORTABLE_PATH_ASCII_SEGMENT.test(part)
      || readPortablePathSegmentViolation(part) !== null
    ) {
      throw new Error('model_pack_invalid_path');
    }
  }
  return parts;
}

function modelPackPathAliasKey(path: string): string {
  return assertModelPackFilePathPortable(path)
    .map((part) => part.toLowerCase())
    .join('/');
}

/**
 * Validate that a pack id is safe to use as a filesystem path segment and return
 * its trimmed form. Throws (via `onInvalid`, default `Error`) when unsafe.
 */
export function assertPackIdFilesystemSafe(
  packId: string,
  onInvalid: () => Error = () => new Error('model_pack_invalid_pack_id'),
): string {
  const normalized = packId.trim();
  if (
    normalized.length === 0
    || normalized.length > PACK_ID_MAX_LENGTH
    || normalized === '.'
    || normalized === '..'
    || !PACK_ID_FILESYSTEM_SAFE_RE.test(normalized)
  ) {
    throw onInvalid();
  }
  return normalized;
}

/**
 * Assert that every file path in a manifest-like value is safe. Accepts any value
 * exposing a `files` array of `{ path }` so both the protocol manifest type and
 * test fixtures can be validated.
 */
export function assertManifestPathsSafe(manifest: Readonly<{ files: readonly Readonly<{ path: string }>[] }>): void {
  const paths = manifest.files.map((file) => file.path);
  if (paths.some((path) => MODEL_PACK_HOST_OWNED_ROOT_PATH_ALIAS_KEYS.has(path.toLowerCase()))) {
    throw new Error('model_pack_reserved_path');
  }
  const aliasKeys = paths.map(modelPackPathAliasKey);
  if (new Set(aliasKeys).size !== aliasKeys.length) {
    throw new Error('model_pack_path_alias');
  }
  const sorted = [...aliasKeys].sort();
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const current = sorted[index]!;
    const next = sorted[index + 1]!;
    if (next.startsWith(`${current}/`)) {
      throw new Error('model_pack_path_file_directory_conflict');
    }
  }
}
