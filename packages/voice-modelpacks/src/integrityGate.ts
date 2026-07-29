/**
 * Integrity preconditions for a model-pack install (SD-M3).
 *
 * Before a downloaded pack may be promoted to the live location, EVERY file in
 * the manifest must declare a verifiable identity: a 64-hex sha256 digest and a
 * positive byte size. A manifest that omits either is refused up front — we never
 * promote bytes we cannot verify.
 *
 * This is intentionally stricter than the protocol schema (which permits
 * `sizeBytes: 0`): a zero-length required model file is not a real install, so it
 * is rejected here rather than silently promoted.
 */

import type { ModelPackManifest } from '@happier-dev/protocol';

export class ModelPackIntegrityError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'ModelPackIntegrityError';
  }
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Assert each manifest file carries a digest + positive size. Throws
 * `model_pack_missing_digest` / `model_pack_missing_size` so the installer
 * refuses to promote an unverifiable archive.
 */
export function assertManifestIntegrityVerifiable(manifest: ModelPackManifest): void {
  if (manifest.files.length === 0) {
    throw new ModelPackIntegrityError('model_pack_no_files');
  }
  for (const file of manifest.files) {
    const sha = file.sha256.trim().toLowerCase();
    if (!SHA256_HEX_RE.test(sha)) {
      throw new ModelPackIntegrityError('model_pack_missing_digest');
    }
    if (!Number.isFinite(file.sizeBytes) || Math.trunc(file.sizeBytes) <= 0) {
      throw new ModelPackIntegrityError('model_pack_missing_size');
    }
  }
}
