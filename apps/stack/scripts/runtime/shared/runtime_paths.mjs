import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import { pathExists } from '../../utils/fs/fs.mjs';

export function validateRuntimeSnapshotId(value, { allowEmpty = false } = {}) {
  const snapshotId = String(value ?? '').trim();
  if (!snapshotId) {
    return allowEmpty
      ? { ok: true, snapshotId: '', error: null }
      : { ok: false, snapshotId: '', error: '[runtime] snapshot id is required.' };
  }
  if (snapshotId === '.' || snapshotId === '..' || /[\\/\u0000]/.test(snapshotId)) {
    return {
      ok: false,
      snapshotId,
      error: '[runtime] snapshot id must be a single path segment.',
    };
  }
  return { ok: true, snapshotId, error: null };
}

export function assertRuntimeSnapshotId(value, options) {
  const validation = validateRuntimeSnapshotId(value, options);
  if (!validation.ok) throw new Error(validation.error);
  return validation.snapshotId;
}

export function resolveStackArtifactsDir({ stackBaseDir }) {
  return join(String(stackBaseDir ?? '').trim(), 'artifacts');
}

export function resolveStackComponentArtifactDir({ stackBaseDir, component, fingerprint }) {
  return join(resolveStackArtifactsDir({ stackBaseDir }), String(component ?? '').trim(), String(fingerprint ?? '').trim());
}

export function resolveStackRuntimePaths({ stackBaseDir, snapshotId = '' }) {
  const runtimeDir = join(String(stackBaseDir ?? '').trim(), 'runtime');
  const buildsDir = join(runtimeDir, 'builds');
  const currentDir = join(runtimeDir, 'current');
  const currentPath = join(runtimeDir, 'current.json');
  const currentManifestPath = join(currentDir, 'manifest.json');
  const lockPath = join(runtimeDir, 'build.lock');
  const normalizedSnapshotId = assertRuntimeSnapshotId(snapshotId, { allowEmpty: true });
  const snapshotDir = normalizedSnapshotId ? join(buildsDir, normalizedSnapshotId) : '';

  return {
    runtimeDir,
    buildsDir,
    currentDir,
    currentPath,
    currentManifestPath,
    lockPath,
    snapshotDir,
    manifestPath: snapshotDir ? join(snapshotDir, 'manifest.json') : '',
  };
}

function isWithinPhysicalDirectory({ parentPath, childPath }) {
  const relativePath = relative(parentPath, childPath);
  return (
    !isAbsolute(relativePath)
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
  );
}

export async function getRuntimeSnapshotPhysicalContainmentError({ buildsDir, snapshotDir }) {
  if (!(await pathExists(snapshotDir))) return null;

  try {
    const [physicalBuildsDir, physicalSnapshotDir] = await Promise.all([
      realpath(buildsDir),
      realpath(snapshotDir),
    ]);
    return isWithinPhysicalDirectory({ parentPath: physicalBuildsDir, childPath: physicalSnapshotDir })
      ? null
      : '[runtime] runtime snapshot resolves outside the producer runtime builds directory.';
  } catch {
    return '[runtime] runtime snapshot physical path could not be resolved.';
  }
}
