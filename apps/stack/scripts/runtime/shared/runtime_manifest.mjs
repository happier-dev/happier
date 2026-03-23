import { join, posix } from 'node:path';

import { readJsonIfExists, writeJsonAtomic } from '../../utils/fs/json.mjs';

function normalizeManifestEntrypoint(entrypoint) {
  const trimmed = String(entrypoint ?? '').trim().replaceAll('\\', '/');
  if (!trimmed) return '';

  const normalized = posix.normalize(trimmed);
  if (!normalized || normalized === '.' || posix.isAbsolute(normalized)) return '';
  if (normalized === '..' || normalized.startsWith('../')) return '';
  return normalized;
}

function normalizeComponentEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const artifactFingerprint = String(raw.artifactFingerprint ?? '').trim();
  const entrypoint = normalizeManifestEntrypoint(raw.entrypoint);
  if (!artifactFingerprint && !entrypoint) return null;
  return { artifactFingerprint, entrypoint };
}

export async function writeRuntimeManifest({ manifestPath, manifest }) {
  await writeJsonAtomic(manifestPath, manifest);
}

export async function readRuntimeManifest({ manifestPath }) {
  return await readJsonIfExists(manifestPath, { defaultValue: null });
}

export async function writeRuntimePointer({ currentPath, pointer }) {
  await writeJsonAtomic(currentPath, pointer);
}

export async function readRuntimePointer({ currentPath }) {
  return await readJsonIfExists(currentPath, { defaultValue: null });
}

export function validateRuntimeManifest(manifest) {
  const errors = [];
  const version = Number(manifest?.version);
  const snapshotId = String(manifest?.snapshotId ?? '').trim();
  const sourceFingerprint = String(manifest?.sourceFingerprint ?? '').trim();
  const components = manifest?.components && typeof manifest.components === 'object' ? manifest.components : {};
  const web = normalizeComponentEntry(components.web);
  const server = normalizeComponentEntry(components.server);
  const daemon = normalizeComponentEntry(components.daemon);
  const rawWebEntrypoint = String(components.web?.entrypoint ?? '').trim();
  const rawServerEntrypoint = String(components.server?.entrypoint ?? '').trim();
  const rawDaemonEntrypoint = String(components.daemon?.entrypoint ?? '').trim();

  if (version !== 1) errors.push('runtime manifest version must be 1');
  if (!snapshotId) errors.push('runtime manifest snapshotId is required');
  if (!sourceFingerprint) errors.push('runtime manifest sourceFingerprint is required');
  if (!web?.entrypoint) errors.push('runtime manifest web entrypoint is required');
  if (!server?.entrypoint) errors.push('runtime manifest server entrypoint is required');
  if (!daemon?.entrypoint) errors.push('runtime manifest daemon entrypoint is required');
  if (rawWebEntrypoint && !web?.entrypoint) errors.push('runtime manifest web entrypoint must stay within the snapshot root');
  if (rawServerEntrypoint && !server?.entrypoint) errors.push('runtime manifest server entrypoint must stay within the snapshot root');
  if (rawDaemonEntrypoint && !daemon?.entrypoint) errors.push('runtime manifest daemon entrypoint must stay within the snapshot root');

  return {
    ok: errors.length === 0,
    errors,
    manifest: errors.length === 0
      ? {
          version,
          snapshotId,
          sourceFingerprint,
          source: manifest?.source && typeof manifest.source === 'object' ? { ...manifest.source } : null,
          components: {
            web,
            server,
            daemon,
          },
        }
      : null,
  };
}

export function resolveRuntimeManifestEntrypoint({ snapshotPath, manifest, component }) {
  const entrypoint = normalizeManifestEntrypoint(manifest?.components?.[component]?.entrypoint ?? '');
  if (!entrypoint) return '';
  return join(snapshotPath, entrypoint);
}
