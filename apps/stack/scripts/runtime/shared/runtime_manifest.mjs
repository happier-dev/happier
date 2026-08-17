import { lstat, readlink, realpath } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';

import { readJsonIfExists, writeJsonAtomic } from '../../utils/fs/json.mjs';
import {
  getRuntimeSnapshotPhysicalContainmentError,
  resolveStackRuntimePaths,
  validateRuntimeArtifactFingerprint,
  validateRuntimeSnapshotId,
} from './runtime_paths.mjs';

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

function normalizeRuntimeTarget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const platform = String(raw.platform ?? '').trim();
  const arch = String(raw.arch ?? '').trim();
  return platform && arch ? { platform, arch } : null;
}

function normalizeReusedSnapshotIds(rawValue) {
  if (!Array.isArray(rawValue)) return [];
  return [...new Set(rawValue
    .map((value) => validateRuntimeSnapshotId(value, { allowEmpty: true }))
    .filter((validation) => validation.ok && validation.snapshotId)
    .map((validation) => validation.snapshotId))];
}

export function validateRuntimeTarget(
  manifest,
  { platform = process.platform, arch = process.arch } = {},
) {
  const rawTarget = manifest?.target;
  if (rawTarget == null) return { ok: true, legacy: true, target: null, errors: [] };
  const target = normalizeRuntimeTarget(rawTarget);
  if (!target) {
    return { ok: false, legacy: false, target: null, errors: ['runtime manifest target requires platform and arch'] };
  }
  if (target.platform !== platform || target.arch !== arch) {
    return {
      ok: false,
      legacy: false,
      target,
      errors: [`runtime snapshot targets ${target.platform}/${target.arch}, current host is ${platform}/${arch}`],
    };
  }
  return { ok: true, legacy: false, target, errors: [] };
}

export async function writeRuntimeManifest({ manifestPath, manifest }) {
  await writeJsonAtomic(manifestPath, manifest);
}

export async function readRuntimeManifest({ manifestPath }) {
  return await readJsonIfExists(manifestPath, { defaultValue: null });
}

function resolveRuntimeSnapshotComponentDirectoryName(component) {
  return component === 'web' ? 'ui' : component === 'server' ? 'server' : 'cli';
}

async function resolveRuntimeSnapshotComponentLinkTarget(componentPath) {
  const linkTarget = await readlink(componentPath).catch(() => '');
  return linkTarget ? resolve(dirname(componentPath), linkTarget) : '';
}

async function resolveContainedRuntimeSnapshot({ producerStackBaseDir, snapshotId }) {
  const paths = resolveStackRuntimePaths({
    stackBaseDir: producerStackBaseDir,
    snapshotId,
  });
  if (await getRuntimeSnapshotPhysicalContainmentError({
    buildsDir: paths.buildsDir,
    snapshotDir: paths.snapshotDir,
  })) {
    return null;
  }
  const manifest = await readRuntimeManifest({ manifestPath: paths.manifestPath });
  const validation = validateRuntimeManifest(manifest);
  if (!validation.ok || validation.manifest.snapshotId !== snapshotId) return null;
  return { paths, manifest: validation.manifest };
}

/**
 * A reference-only snapshot may retain a component through a chain of v1
 * partial snapshots. Every hop must be a declared, contained producer
 * snapshot component, and the chain may terminate only at a physical v1
 * component directory. This keeps legacy reads compatible without making an
 * arbitrary symlink target trusted.
 */
export async function isRetainedLegacyRuntimeSnapshotComponentReference({
  producerStackBaseDir,
  componentPath,
  component,
  reusedSnapshotIds,
}) {
  const terminalComponentPath = await realpath(componentPath).catch(() => '');
  if (!terminalComponentPath) return false;

  const pendingSnapshotIds = normalizeReusedSnapshotIds(reusedSnapshotIds);
  const visitedSnapshotIds = new Set();
  const directoryName = resolveRuntimeSnapshotComponentDirectoryName(component);

  while (pendingSnapshotIds.length > 0) {
    const snapshotId = pendingSnapshotIds.shift();
    if (visitedSnapshotIds.has(snapshotId)) continue;
    visitedSnapshotIds.add(snapshotId);

    const snapshot = await resolveContainedRuntimeSnapshot({
      producerStackBaseDir,
      snapshotId,
    });
    if (!snapshot) continue;

    const candidatePath = join(snapshot.paths.snapshotDir, directoryName);
    const candidateStats = await lstat(candidatePath).catch(() => null);
    if (!candidateStats) continue;
    const candidatePhysicalPath = await realpath(candidatePath).catch(() => '');
    if (!candidatePhysicalPath) continue;

    if (!candidateStats.isSymbolicLink()) {
      if (candidatePhysicalPath === terminalComponentPath) return true;
      continue;
    }

    const candidateLinkTargetPath = await resolveRuntimeSnapshotComponentLinkTarget(candidatePath);
    if (!candidateLinkTargetPath) continue;

    for (const reusedSnapshotId of snapshot.manifest.reusedSnapshotIds) {
      if (visitedSnapshotIds.has(reusedSnapshotId)) continue;
      const reusedSnapshot = await resolveContainedRuntimeSnapshot({
        producerStackBaseDir,
        snapshotId: reusedSnapshotId,
      });
      if (!reusedSnapshot) continue;
      const reusedComponentPath = join(reusedSnapshot.paths.snapshotDir, directoryName);
      if (candidateLinkTargetPath !== reusedComponentPath) continue;
      if (!(await lstat(reusedComponentPath).catch(() => null))) continue;
      const reusedComponentPhysicalPath = await realpath(reusedComponentPath).catch(() => '');
      if (candidatePhysicalPath === reusedComponentPhysicalPath) {
        pendingSnapshotIds.push(reusedSnapshotId);
      }
    }
  }
  return false;
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
  const snapshotIdValidation = validateRuntimeSnapshotId(manifest?.snapshotId);
  const snapshotId = snapshotIdValidation.snapshotId;
  const sourceFingerprint = String(manifest?.sourceFingerprint ?? '').trim();
  const components = manifest?.components && typeof manifest.components === 'object' ? manifest.components : {};
  const web = normalizeComponentEntry(components.web);
  const server = normalizeComponentEntry(components.server);
  const daemon = normalizeComponentEntry(components.daemon);
  const rawWebEntrypoint = String(components.web?.entrypoint ?? '').trim();
  const rawServerEntrypoint = String(components.server?.entrypoint ?? '').trim();
  const rawDaemonEntrypoint = String(components.daemon?.entrypoint ?? '').trim();
  const webArtifactFingerprint = validateRuntimeArtifactFingerprint(components.web?.artifactFingerprint, { allowEmpty: true });
  const serverArtifactFingerprint = validateRuntimeArtifactFingerprint(components.server?.artifactFingerprint, { allowEmpty: true });
  const daemonArtifactFingerprint = validateRuntimeArtifactFingerprint(components.daemon?.artifactFingerprint, { allowEmpty: true });
  const target = normalizeRuntimeTarget(manifest?.target);
  const reusedSnapshotIds = normalizeReusedSnapshotIds(manifest?.reusedSnapshotIds);

  if (version !== 1) errors.push('runtime manifest version must be 1');
  if (!snapshotId) {
    errors.push('runtime manifest snapshotId is required');
  } else if (!snapshotIdValidation.ok) {
    errors.push(snapshotIdValidation.error);
  }
  if (!sourceFingerprint) errors.push('runtime manifest sourceFingerprint is required');
  if (!web?.entrypoint) errors.push('runtime manifest web entrypoint is required');
  if (!server?.entrypoint) errors.push('runtime manifest server entrypoint is required');
  if (!daemon?.entrypoint) errors.push('runtime manifest daemon entrypoint is required');
  if (rawWebEntrypoint && !web?.entrypoint) errors.push('runtime manifest web entrypoint must stay within the snapshot root');
  if (rawServerEntrypoint && !server?.entrypoint) errors.push('runtime manifest server entrypoint must stay within the snapshot root');
  if (rawDaemonEntrypoint && !daemon?.entrypoint) errors.push('runtime manifest daemon entrypoint must stay within the snapshot root');
  for (const [component, validation] of [
    ['web', webArtifactFingerprint],
    ['server', serverArtifactFingerprint],
    ['daemon', daemonArtifactFingerprint],
  ]) {
    if (!validation.ok) {
      errors.push(`runtime manifest ${component} ${validation.error.replace(/^\[runtime\] /, '')}`);
    }
  }
  if (manifest?.target != null && !target) errors.push('runtime manifest target requires platform and arch');

  return {
    ok: errors.length === 0,
    errors,
    manifest: errors.length === 0
      ? {
          version,
          snapshotId,
          sourceFingerprint,
          target,
          source: manifest?.source && typeof manifest.source === 'object' ? { ...manifest.source } : null,
          reusedSnapshotIds,
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
