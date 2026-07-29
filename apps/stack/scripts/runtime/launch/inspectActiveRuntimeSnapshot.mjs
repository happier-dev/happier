import { resolve } from 'node:path';

import { getFirstPartyComponentCatalogEntry } from '@happier-dev/cli-common/firstPartyRuntime';

import { pathExists } from '../../utils/fs/fs.mjs';
import { readJsonIfExists } from '../../utils/fs/json.mjs';
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

async function collectSnapshotRuntimePayloadErrors({ snapshotPath }) {
  const daemonComponent = getFirstPartyComponentCatalogEntry('happier-daemon');
  if (!daemonComponent.nodeEntrypointRelativePath) {
    return [];
  }

  const daemonNodeEntrypoint = resolve(snapshotPath, 'cli', daemonComponent.nodeEntrypointRelativePath);
  return (await pathExists(daemonNodeEntrypoint))
    ? []
    : [`[runtime] active runtime snapshot is incomplete: missing daemon node entrypoint (${daemonNodeEntrypoint}).`];
}

async function inspectDaemonDistClosure({ snapshotPath }) {
  const daemonComponent = getFirstPartyComponentCatalogEntry('happier-daemon');
  if (!daemonComponent.nodeEntrypointRelativePath) {
    return { fingerprint: null, errors: ['[runtime] daemon runtime has no node entrypoint identity.'] };
  }
  const daemonNodeEntrypoint = resolve(snapshotPath, 'cli', daemonComponent.nodeEntrypointRelativePath);
  const buildManifestPath = resolve(daemonNodeEntrypoint, '..', '.build-manifest.json');
  const buildManifest = await readJsonIfExists(buildManifestPath, { defaultValue: null });
  const fingerprint = String(buildManifest?.fingerprint ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{16}$/.test(fingerprint)) {
    return {
      fingerprint: null,
      errors: [`[runtime] active runtime daemon has an invalid dist closure fingerprint (${buildManifestPath}).`],
    };
  }
  return { fingerprint, errors: [] };
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

  if (Number(pointer?.version) !== 1) {
    errors.push('[runtime] active runtime pointer version must be 1.');
  }
  if (normalizedPointerSnapshotPath !== normalizedExpectedSnapshotPath) {
    errors.push('[runtime] active runtime snapshot points outside the stack runtime builds dir.');
  }
  if (!validation.ok) {
    errors.push(`[runtime] invalid active runtime snapshot: ${validation.errors.join('; ')}`);
  }
  if (validation.ok) {
    if (validation.manifest.snapshotId !== activeSnapshotId) {
      errors.push('[runtime] active runtime pointer and manifest snapshot identity do not match.');
    }
    const pointerSourceFingerprint = String(pointer?.sourceFingerprint ?? '').trim();
    if (
      !pointerSourceFingerprint
      || pointerSourceFingerprint !== validation.manifest.sourceFingerprint
    ) {
      errors.push('[runtime] active runtime pointer and manifest source fingerprint do not match.');
    }
    errors.push(
      ...(await collectSnapshotEntrypointErrors({
        snapshotPath: normalizedExpectedSnapshotPath,
        manifest: validation.manifest,
      })),
      ...(await collectSnapshotRuntimePayloadErrors({
        snapshotPath: normalizedExpectedSnapshotPath,
      })),
    );
  }

  const daemonDistClosure = validation.ok
    ? await inspectDaemonDistClosure({ snapshotPath: normalizedExpectedSnapshotPath })
    : { fingerprint: null, errors: [] };
  errors.push(...daemonDistClosure.errors);

  const sourceFingerprint =
    String(pointer?.sourceFingerprint ?? '').trim() || validation.manifest?.sourceFingerprint || null;
  const valid = errors.length === 0 && Boolean(validation.manifest);
  const launchPath = normalizedExpectedSnapshotPath;

  return {
    missing: false,
    valid,
    errors,
    activeSnapshotId,
    snapshotPath: normalizedPointerSnapshotPath,
    launchPath,
    sourceFingerprint,
    daemonDistClosureFingerprint: daemonDistClosure.fingerprint,
    manifest: validation.manifest,
    snapshot: valid
      ? {
          snapshotId: activeSnapshotId,
          snapshotPath: normalizedExpectedSnapshotPath,
          launchPath,
          sourceFingerprint,
          daemonDistClosureFingerprint: daemonDistClosure.fingerprint,
          manifest: validation.manifest,
        }
      : null,
  };
}
