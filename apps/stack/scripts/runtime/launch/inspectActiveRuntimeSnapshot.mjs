import { resolve } from 'node:path';

import { pathExists } from '../../utils/fs/fs.mjs';
import {
  readRuntimeManifest,
  readRuntimePointer,
  resolveRuntimeManifestEntrypoint,
  validateRuntimeManifest,
} from '../shared/runtime_manifest.mjs';
import { resolveStackRuntimePaths } from '../shared/runtime_paths.mjs';

async function collectSnapshotEntrypointErrors({ snapshotPath, manifest }) {
  const missing = [];
  for (const component of ['web', 'server', 'daemon']) {
    const entrypoint = resolveRuntimeManifestEntrypoint({ snapshotPath, manifest, component });
    if (!entrypoint || !(await pathExists(entrypoint))) {
      missing.push(component);
    }
  }
  return missing.length > 0
    ? [`[runtime] active runtime snapshot is incomplete: missing ${missing.join(', ')} entrypoints.`]
    : [];
}

export async function inspectActiveRuntimeSnapshot({ stackBaseDir }) {
  const runtimePaths = resolveStackRuntimePaths({ stackBaseDir });
  const pointer = await readRuntimePointer({ currentPath: runtimePaths.currentPath });
  const activeSnapshotId = String(pointer?.snapshotId ?? '').trim() || null;
  const pointerSnapshotPath = String(pointer?.snapshotPath ?? '').trim();

  if (!activeSnapshotId || !pointerSnapshotPath) {
    return {
      missing: true,
      valid: false,
      errors: [],
      activeSnapshotId: activeSnapshotId ?? null,
      snapshotPath: pointerSnapshotPath ? resolve(pointerSnapshotPath) : null,
      sourceFingerprint: String(pointer?.sourceFingerprint ?? '').trim() || null,
      manifest: null,
      snapshot: null,
    };
  }

  const expectedSnapshotPath = resolveStackRuntimePaths({
    stackBaseDir,
    snapshotId: activeSnapshotId,
  }).snapshotDir;
  const normalizedExpectedSnapshotPath = resolve(expectedSnapshotPath);
  const normalizedPointerSnapshotPath = resolve(pointerSnapshotPath);
  const manifestPath = resolveStackRuntimePaths({
    stackBaseDir,
    snapshotId: activeSnapshotId,
  }).manifestPath;
  const manifest = await readRuntimeManifest({ manifestPath });
  const validation = validateRuntimeManifest(manifest);
  const errors = [];

  if (normalizedPointerSnapshotPath !== normalizedExpectedSnapshotPath) {
    errors.push('[runtime] active runtime snapshot points outside the stack runtime builds dir.');
  }
  if (!validation.ok) {
    errors.push(`[runtime] invalid active runtime snapshot: ${validation.errors.join('; ')}`);
  }
  if (validation.ok) {
    errors.push(
      ...(await collectSnapshotEntrypointErrors({
        snapshotPath: normalizedExpectedSnapshotPath,
        manifest: validation.manifest,
      })),
    );
  }

  const sourceFingerprint =
    String(pointer?.sourceFingerprint ?? '').trim() || validation.manifest?.sourceFingerprint || null;
  const valid = errors.length === 0 && Boolean(validation.manifest);
  let launchPath = normalizedExpectedSnapshotPath;
  if (valid) {
    const currentDirErrors = await collectSnapshotEntrypointErrors({
      snapshotPath: runtimePaths.currentDir,
      manifest: validation.manifest,
    });
    if (currentDirErrors.length === 0) {
      launchPath = runtimePaths.currentDir;
    }
  }

  return {
    missing: false,
    valid,
    errors,
    activeSnapshotId,
    snapshotPath: normalizedPointerSnapshotPath,
    launchPath,
    sourceFingerprint,
    manifest: validation.manifest,
    snapshot: valid
      ? {
          snapshotId: activeSnapshotId,
          snapshotPath: normalizedExpectedSnapshotPath,
          launchPath,
          sourceFingerprint,
          manifest: validation.manifest,
        }
      : null,
  };
}
