import { join } from 'node:path';

import { readJsonIfExists, writeJsonAtomic } from '../../utils/fs/json.mjs';

export async function readArtifactManifest({ artifactDir }) {
  return await readJsonIfExists(join(artifactDir, 'manifest.json'), { defaultValue: null });
}

export async function writeArtifactManifest({ artifactDir, manifest }) {
  await writeJsonAtomic(join(artifactDir, 'manifest.json'), manifest);
}

export function artifactPayloadDir(artifactDir) {
  return join(artifactDir, 'payload');
}

export function validateArtifactManifest(manifest) {
  const errors = [];
  const version = Number(manifest?.version);
  const component = String(manifest?.component ?? '').trim();
  const artifactFingerprint = String(manifest?.artifactFingerprint ?? '').trim();
  const sourceFingerprint = String(manifest?.sourceFingerprint ?? '').trim();
  const entrypoint = String(manifest?.entrypoint ?? '').trim();
  const payloadDir = String(manifest?.payloadDir ?? '').trim();

  if (version !== 1) errors.push('artifact manifest version must be 1');
  if (!component) errors.push('artifact manifest component is required');
  if (!artifactFingerprint) errors.push('artifact manifest artifactFingerprint is required');
  if (!sourceFingerprint) errors.push('artifact manifest sourceFingerprint is required');
  if (!payloadDir) errors.push('artifact manifest payloadDir is required');
  if (!entrypoint) errors.push('artifact manifest entrypoint is required');

  return {
    ok: errors.length === 0,
    errors,
    manifest: errors.length === 0
      ? {
          ...manifest,
          version,
          component,
          artifactFingerprint,
          sourceFingerprint,
          payloadDir,
          entrypoint,
        }
      : null,
  };
}
