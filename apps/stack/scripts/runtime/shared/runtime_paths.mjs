import { join } from 'node:path';

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
  const snapshotDir = snapshotId ? join(buildsDir, snapshotId) : '';

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
