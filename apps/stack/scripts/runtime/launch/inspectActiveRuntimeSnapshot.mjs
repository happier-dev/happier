import { join, resolve } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

import { getFirstPartyComponentCatalogEntry } from '@happier-dev/cli-common/firstPartyRuntime';

import { pathExists } from '../../utils/fs/fs.mjs';
import { readJsonIfExists } from '../../utils/fs/json.mjs';
import {
  artifactPayloadDir,
  readArtifactManifest,
  resolveComponentArtifactSupportReference,
  validateArtifactManifest,
} from '../shared/artifact_manifest.mjs';
import {
  isRetainedLegacyRuntimeSnapshotComponentReference,
  readRuntimeManifest,
  readRuntimePointer,
  resolveRuntimeManifestEntrypoint,
  validateRuntimeTarget,
  validateRuntimeManifest,
} from '../shared/runtime_manifest.mjs';
import {
  getRuntimeSnapshotPhysicalContainmentError,
  resolveStackComponentArtifactDir,
  resolveStackRuntimePaths,
  validateRuntimeSnapshotId,
} from '../shared/runtime_paths.mjs';
import { resolveStackBaseDir } from '../../utils/paths/paths.mjs';
import { assertCanonicalManagedStackName } from '../../utils/stack/names.mjs';

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

function resolveSnapshotComponentDirectoryName(component) {
  return component === 'web' ? 'ui' : component === 'server' ? 'server' : 'cli';
}

async function collectSnapshotComponentReferenceErrors({
  snapshotPath,
  producerStackBaseDir,
  manifest,
}) {
  const errors = [];
  for (const component of ['web', 'server', 'daemon']) {
    const artifactFingerprint = String(manifest?.components?.[component]?.artifactFingerprint ?? '').trim();
    if (!artifactFingerprint) continue;
    const componentPath = join(snapshotPath, resolveSnapshotComponentDirectoryName(component));
    const artifactDir = resolveStackComponentArtifactDir({
      stackBaseDir: producerStackBaseDir,
      component,
      fingerprint: artifactFingerprint,
    });
    const artifactManifest = await readArtifactManifest({ artifactDir });
    const artifactValidation = validateArtifactManifest(artifactManifest);
    const componentStats = await lstat(componentPath).catch(() => null);
    const retainedLegacyReference = componentStats?.isSymbolicLink()
      && await isRetainedLegacyRuntimeSnapshotComponentReference({
        producerStackBaseDir,
        componentPath,
        component,
        reusedSnapshotIds: manifest?.reusedSnapshotIds,
      });
    if (retainedLegacyReference) continue;
    if (!artifactValidation.ok || artifactValidation.manifest.component !== component) {
      if (componentStats?.isSymbolicLink()) {
        errors.push(`[runtime] active runtime snapshot ${component} artifact reference is missing or invalid.`);
      }
      continue;
    }
    // Physical component directories are the released v1 self-contained
    // snapshot shape. Only new symlink/junction references require a live
    // canonical artifact (and its optional owner-local support object).
    if (!componentStats?.isSymbolicLink()) continue;
    try {
      await resolveComponentArtifactSupportReference({
        stackBaseDir: producerStackBaseDir,
        manifest: artifactValidation.manifest,
      });
      const [actualPath, expectedPath] = await Promise.all([
        realpath(componentPath),
        realpath(artifactPayloadDir(artifactDir)),
      ]);
      if (actualPath !== expectedPath) {
        errors.push(`[runtime] active runtime snapshot ${component} reference does not match its canonical artifact payload.`);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
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

export async function inspectActiveRuntimeSnapshot({ stackBaseDir, env = process.env }) {
  const runtimePaths = resolveStackRuntimePaths({ stackBaseDir });
  const pointer = await readRuntimePointer({ currentPath: runtimePaths.currentPath });
  const snapshotIdValidation = validateRuntimeSnapshotId(pointer?.snapshotId, { allowEmpty: true });
  const activeSnapshotId = snapshotIdValidation.snapshotId || null;
  const pointerSnapshotPath = String(pointer?.snapshotPath ?? '').trim();
  const producerStackName = String(pointer?.producerStackName ?? '').trim() || null;

  if (!snapshotIdValidation.ok) {
    return {
      missing: false,
      valid: false,
      errors: [snapshotIdValidation.error],
      activeSnapshotId: snapshotIdValidation.snapshotId || null,
      snapshotPath: pointerSnapshotPath ? resolve(pointerSnapshotPath) : null,
      sourceFingerprint: String(pointer?.sourceFingerprint ?? '').trim() || null,
      manifest: null,
      snapshot: null,
      producerStackName,
      producerStackBaseDir: stackBaseDir,
    };
  }

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
      producerStackName,
    };
  }

  let producerStackNameError = null;
  if (producerStackName) {
    try {
      assertCanonicalManagedStackName(producerStackName, 'producer');
    } catch (error) {
      producerStackNameError = error instanceof Error ? error.message : String(error);
    }
  }
  const producerStackNameValid = producerStackNameError === null;
  const producerStackBaseDir = producerStackName && producerStackNameValid
    ? resolveStackBaseDir(producerStackName, env).baseDir
    : stackBaseDir;
  const producerSnapshotPaths = resolveStackRuntimePaths({
    stackBaseDir: producerStackBaseDir,
    snapshotId: activeSnapshotId,
  });
  const normalizedExpectedSnapshotPath = resolve(producerSnapshotPaths.snapshotDir);
  const normalizedPointerSnapshotPath = resolve(pointerSnapshotPath);
  const physicalSnapshotContainmentError = await getRuntimeSnapshotPhysicalContainmentError({
    buildsDir: producerSnapshotPaths.buildsDir,
    snapshotDir: producerSnapshotPaths.snapshotDir,
  });
  if (physicalSnapshotContainmentError) {
    return {
      missing: false,
      valid: false,
      errors: [physicalSnapshotContainmentError],
      activeSnapshotId,
      snapshotPath: normalizedPointerSnapshotPath,
      launchPath: normalizedExpectedSnapshotPath,
      sourceFingerprint: String(pointer?.sourceFingerprint ?? '').trim() || null,
      daemonDistClosureFingerprint: null,
      manifest: null,
      snapshot: null,
      producerStackName,
      producerStackBaseDir,
    };
  }

  const manifestPath = producerSnapshotPaths.manifestPath;
  const manifest = await readRuntimeManifest({ manifestPath });
  const validation = validateRuntimeManifest(manifest);
  const errors = [];

  if (!producerStackNameValid) {
    errors.push(producerStackNameError);
  }

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
    const targetValidation = validateRuntimeTarget(validation.manifest);
    if (!targetValidation.ok) {
      errors.push(`[runtime] active runtime snapshot target is incompatible: ${targetValidation.errors.join('; ')}`);
    }
    errors.push(
      ...(await collectSnapshotEntrypointErrors({
        snapshotPath: normalizedExpectedSnapshotPath,
        manifest: validation.manifest,
      })),
      ...(await collectSnapshotComponentReferenceErrors({
        snapshotPath: normalizedExpectedSnapshotPath,
        producerStackBaseDir,
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
          producerStackName,
          producerStackBaseDir,
        }
      : null,
    producerStackName,
    producerStackBaseDir,
  };
}
