import { copyFile, lstat, mkdir, readdir, readlink, realpath, stat, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';

import { getFirstPartyComponentCatalogEntry } from '@happier-dev/cli-common/firstPartyRuntime/componentCatalog';
import { withWorkspaceBundleLock } from '@happier-dev/cli-common/workspaceBundleLock';

import { buildIntoTempThenReplace } from '../utils/fs/atomic_dir_swap.mjs';
import {
  artifactPayloadDir,
  assertArtifactPayload,
  readArtifactManifest,
  readReusableArtifactManifest,
  resolveComponentArtifactSupportReference,
  validateArtifactManifest,
} from '../runtime/shared/artifact_manifest.mjs';
import {
  isRetainedLegacyRuntimeSnapshotComponentReference,
  readRuntimeManifest,
  RUNTIME_SNAPSHOT_COMPONENTS,
  resolveRuntimeManifestEntrypoint,
  validateRuntimeTarget,
  validateRuntimeManifest,
  writeRuntimeManifest,
  writeRuntimePointer,
} from '../runtime/shared/runtime_manifest.mjs';
import {
  getRuntimeSnapshotPhysicalContainmentError,
  resolveStackComponentArtifactDir,
  resolveStackRuntimePaths,
} from '../runtime/shared/runtime_paths.mjs';
import { pathExists } from '../utils/fs/fs.mjs';
import { assertCanonicalManagedStackName } from '../utils/stack/names.mjs';
import { pruneRuntimeSnapshots } from './runtime_retention.mjs';
import { createRuntimeSnapshotSourceMetadata } from '../runtime/shared/runtime_snapshot_identity.mjs';
import { collectSnapshotRuntimePayloadErrors, inspectDaemonDistClosure } from '../runtime/launch/inspectActiveRuntimeSnapshot.mjs';

function resolveComponentDirectoryName(component) {
  return component === 'web' ? 'ui' : component === 'server' ? 'server' : 'cli';
}

async function materializeRuntimeComponent({ targetDir, sourceDir }) {
  await symlink(process.platform === 'win32' ? sourceDir : relative(dirname(targetDir), sourceDir), targetDir,
    process.platform === 'win32' ? 'junction' : 'dir');
}

async function validateRuntimeArtifact({ stackBaseDir, component, artifact, target }) {
  const validation = validateArtifactManifest(artifact?.manifest);
  if (!validation.ok) {
    throw new Error(`[build] invalid ${component} artifact manifest: ${validation.errors.join('; ')}`);
  }
  if (validation.manifest.component !== component) {
    throw new Error(`[build] invalid ${component} artifact manifest: component identity does not match.`);
  }
  const targetValidation = validateRuntimeTarget(artifact.manifest, target);
  if (!targetValidation.ok) {
    throw new Error(`[build] ${component} artifact target is incompatible: ${targetValidation.errors.join('; ')}`);
  }

  const canonicalArtifactDir = resolveStackComponentArtifactDir({
    stackBaseDir,
    component,
    fingerprint: validation.manifest.artifactFingerprint,
  });
  const [actualArtifactDir, expectedArtifactDir] = await Promise.all([
    realpath(artifact.artifactDir).catch(() => ''),
    realpath(canonicalArtifactDir).catch(() => ''),
  ]);
  if (!actualArtifactDir || !expectedArtifactDir || actualArtifactDir !== expectedArtifactDir) {
    throw new Error(`[build] ${component} artifact must resolve to its canonical producer artifact path.`);
  }

  const entrypointPath = join(artifactPayloadDir(artifact.artifactDir), validation.manifest.entrypoint);
  if (!(await pathExists(entrypointPath))) {
    throw new Error(`[build] ${component} artifact entrypoint is missing: ${entrypointPath}`);
  }

  if (component === 'daemon') {
    const daemonComponent = getFirstPartyComponentCatalogEntry('happier-daemon');
    const nodeEntrypointRelativePath = daemonComponent.nodeEntrypointRelativePath;
    if (!nodeEntrypointRelativePath) {
      throw new Error('[build] daemon artifact catalog has no node entrypoint identity');
    }
    const nodeEntrypointPath = join(
      artifactPayloadDir(artifact.artifactDir),
      nodeEntrypointRelativePath,
    );
    if (!(await pathExists(nodeEntrypointPath))) {
      throw new Error(`[build] daemon artifact node entrypoint is missing: ${nodeEntrypointPath}`);
    }
  }

  await resolveComponentArtifactSupportReference({
    stackBaseDir,
    manifest: validation.manifest,
  });

  if (!(await readReusableArtifactManifest({
    stackBaseDir, artifactDir: artifact.artifactDir, artifactFingerprint: validation.manifest.artifactFingerprint,
  }))) {
    throw new Error(`[build] ${component} artifact payload is incomplete.`);
  }

  return validation.manifest;
}

function readServerFlavor(value) {
  const serverComponent = String(value ?? '').trim();
  return serverComponent === 'happier-server' || serverComponent === 'happier-server-light'
    ? serverComponent
    : '';
}

function assertCompatibleServerFlavor({ sourceMetadata, reuseSource, sourceLabel }) {
  const expectedServerFlavor = readServerFlavor(sourceMetadata?.serverComponent);
  const actualServerFlavor = readServerFlavor(reuseSource?.serverComponent);
  if (!expectedServerFlavor || !actualServerFlavor || expectedServerFlavor === actualServerFlavor) {
    return;
  }

  throw new Error(
    `[build] cannot reuse the ${sourceLabel} across server flavors: stack expects ${expectedServerFlavor}, but the runtime snapshot has ${actualServerFlavor}. Build/activate the server artifact for the requested flavor first.`,
  );
}

function resolveComponentArtifactEntrypoint(component, entrypoint) {
  const componentDirectoryName = resolveComponentDirectoryName(component);
  return componentDirectoryName + '/' + entrypoint;
}

async function resolveCanonicalCurrentComponentSource({
  stackBaseDir,
  component,
  currentSnapshot,
}) {
  const artifactFingerprint = String(
    currentSnapshot?.manifest?.components?.[component]?.artifactFingerprint ?? '',
  ).trim();
  if (!artifactFingerprint) return null;

  const artifactDir = resolveStackComponentArtifactDir({
    stackBaseDir,
    component,
    fingerprint: artifactFingerprint,
  });
  const artifactManifest = await readReusableArtifactManifest({
    artifactDir,
    artifactFingerprint,
  });
  if (!artifactManifest || artifactManifest.component !== component) return null;

  const currentComponentDir = join(
    currentSnapshot.snapshotPath,
    resolveComponentDirectoryName(component),
  );
  const canonicalPayloadDir = artifactPayloadDir(artifactDir);
  const [currentComponentPath, canonicalPayloadPath] = await Promise.all([
    realpath(currentComponentDir).catch(() => ''),
    realpath(canonicalPayloadDir).catch(() => ''),
  ]);
  if (!currentComponentPath || currentComponentPath !== canonicalPayloadPath) return null;

  await resolveComponentArtifactSupportReference({
    stackBaseDir,
    manifest: artifactManifest,
  });

  return {
    artifactFingerprint: artifactManifest.artifactFingerprint,
    stalePackages: artifactManifest.stalePackages ?? [],
    sourceDir: canonicalPayloadDir,
    entrypoint: resolveComponentArtifactEntrypoint(component, artifactManifest.entrypoint),
    reusedSnapshotId: null,
  };
}

async function resolveComponentSource({ stackBaseDir, component, artifact, currentSnapshot, sourceMetadata, target }) {
  const componentDirName = resolveComponentDirectoryName(component);
  if (artifact) {
    const manifest = await validateRuntimeArtifact({ stackBaseDir, component, artifact, target });
    if (component === 'server') {
      assertCompatibleServerFlavor({
        sourceMetadata,
        reuseSource: manifest.source,
        sourceLabel: 'server artifact',
      });
    }
    return {
      artifactFingerprint: manifest.artifactFingerprint,
      stalePackages: manifest.stalePackages ?? [],
      sourceDir: artifactPayloadDir(artifact.artifactDir),
      entrypoint: resolveComponentArtifactEntrypoint(component, manifest.entrypoint),
      reusedSnapshotId: null,
    };
  }

  if (!currentSnapshot?.manifest?.components?.[component]?.entrypoint) {
    throw new Error(`[build] cannot activate runtime: missing ${component} artifact and no valid active runtime snapshot to reuse.`);
  }

  if (component === 'server') {
    assertCompatibleServerFlavor({
      sourceMetadata,
      reuseSource: currentSnapshot.manifest.source,
      sourceLabel: 'active runtime server artifact',
    });
  }

  await validatePublishedRuntimeComponentReference({
    producerStackBaseDir: stackBaseDir,
    componentPath: join(currentSnapshot.snapshotPath, componentDirName),
    component,
    manifest: currentSnapshot.manifest,
    reusableSnapshotIds: currentSnapshot.manifest.reusedSnapshotIds,
  });

  const canonicalCurrentSource = await resolveCanonicalCurrentComponentSource({
    stackBaseDir,
    component,
    currentSnapshot,
  });
  if (canonicalCurrentSource) return canonicalCurrentSource;

  return {
    artifactFingerprint: String(currentSnapshot.manifest.components[component].artifactFingerprint ?? '').trim(),
    stalePackages: currentSnapshot.manifest.components[component].stalePackages ?? [],
    sourceDir: join(currentSnapshot.snapshotPath, componentDirName),
    entrypoint: String(currentSnapshot.manifest.components[component].entrypoint ?? '').trim(),
    reusedSnapshotId: currentSnapshot.snapshotId,
  };
}

async function isPublishedRuntimeSnapshotReusable({
  stackBaseDir,
  runtimePaths,
  snapshotId,
  sourceMetadata,
  sources,
  platform,
  arch,
}) {
  const manifest = await readRuntimeManifest({ manifestPath: runtimePaths.manifestPath });
  const validation = validateRuntimeManifest(manifest, { requiredComponents: Object.keys(sources) });
  if (!validation.ok || validation.manifest.snapshotId !== snapshotId) return false;
  if (validation.manifest.sourceFingerprint !== sourceMetadata.sourceFingerprint) return false;
  const targetValidation = validateRuntimeTarget(validation.manifest, { platform, arch });
  if (!targetValidation.ok || targetValidation.legacy) return false;

  for (const [component, source] of Object.entries(sources)) {
    if (validation.manifest.components[component]?.artifactFingerprint !== source.artifactFingerprint) return false;
    const componentPath = join(runtimePaths.snapshotDir, resolveComponentDirectoryName(component));
    if (process.platform !== 'win32' && isAbsolute(await readlink(componentPath).catch(() => ''))) return false;
    try {
      await validatePublishedRuntimeComponentReference({
        producerStackBaseDir: stackBaseDir,
        componentPath,
        component,
        manifest: validation.manifest,
        reusableSnapshotIds: validation.manifest.reusedSnapshotIds,
      });
    } catch {
      return false;
    }
  }
  const daemonComponent = getFirstPartyComponentCatalogEntry('happier-daemon');
  if (
    sources.daemon && daemonComponent.nodeEntrypointRelativePath
    && !(await pathExists(join(runtimePaths.snapshotDir, 'cli', daemonComponent.nodeEntrypointRelativePath)))
  ) {
    return false;
  }
  return true;
}

export async function publishRuntimeSnapshot({
  producerStackBaseDir,
  snapshotId,
  sourceMetadata,
  artifacts,
  runtimeSnapshotKeepCount = 2,
  externalReferenceStorageRoot = '',
  platform = process.platform,
  arch = process.arch,
  pruneAfterPublish = true,
  requiredComponents = RUNTIME_SNAPSHOT_COMPONENTS,
}) {
  const stackBaseDir = producerStackBaseDir;
  const runtimeSourceMetadata = createRuntimeSnapshotSourceMetadata({ sourceMetadata, snapshotId });
  const runtimePaths = resolveStackRuntimePaths({ stackBaseDir, snapshotId });
  await mkdir(runtimePaths.buildsDir, { recursive: true });
  const currentInspection = await inspectLatestPublishedRuntimeSnapshot({ stackBaseDir, target: { platform, arch },
    requiredComponents: requiredComponents.filter(component => !artifacts[component]) });
  const currentSnapshot = currentInspection.snapshot;
  if (!currentSnapshot && requiredComponents.some(component => !artifacts[component]) && currentInspection.failure) {
    throw currentInspection.failure;
  }
  const components = RUNTIME_SNAPSHOT_COMPONENTS.filter(component => requiredComponents.includes(component)
    || artifacts[component] || currentSnapshot?.manifest.components[component]);
  const sources = {};
  for (const component of components) {
    sources[component] = await resolveComponentSource({ stackBaseDir, component, artifact: artifacts[component], currentSnapshot,
      sourceMetadata: runtimeSourceMetadata, target: { platform, arch } });
  }
  const reusedSnapshotIds = [...new Set(Object.values(sources).map(source => source.reusedSnapshotId)
    .filter((value) => typeof value === 'string' && value.trim() && value !== snapshotId))];

  if (await isPublishedRuntimeSnapshotReusable({
    stackBaseDir,
    runtimePaths,
    snapshotId,
    sourceMetadata: runtimeSourceMetadata,
    sources,
    platform,
    arch,
  })) {
    if (pruneAfterPublish) {
      await pruneRuntimeSnapshots({
        stackBaseDir,
        keepCount: runtimeSnapshotKeepCount,
        preserveSnapshotIds: [snapshotId],
        externalReferenceStorageRoot,
      });
    }
    return {
      snapshotId,
      snapshotPath: runtimePaths.snapshotDir,
      manifestPath: runtimePaths.manifestPath,
      reused: true,
    };
  }

  await buildIntoTempThenReplace(runtimePaths.snapshotDir, async (tmpSnapshotDir) => {
    for (const [component, source] of Object.entries(sources)) {
      await materializeRuntimeComponent({ sourceDir: source.sourceDir,
        targetDir: join(tmpSnapshotDir, resolveComponentDirectoryName(component)) });
    }

    await writeRuntimeManifest({
      manifestPath: join(tmpSnapshotDir, 'manifest.json'),
      manifest: {
        version: 1,
        snapshotId,
        sourceFingerprint: runtimeSourceMetadata.sourceFingerprint,
        target: { platform, arch },
        createdAt: runtimeSourceMetadata.builtAt,
        source: runtimeSourceMetadata,
        reusedSnapshotIds,
        components: Object.fromEntries(Object.entries(sources).map(([component, source]) => [component, {
          artifactFingerprint: source.artifactFingerprint,
          ...(source.stalePackages?.length ? { stalePackages: source.stalePackages } : {}),
          entrypoint: source.entrypoint,
        }])),
      },
    });
  });

  if (pruneAfterPublish) {
    await pruneRuntimeSnapshots({
      stackBaseDir,
      keepCount: runtimeSnapshotKeepCount,
      preserveSnapshotIds: [snapshotId],
      externalReferenceStorageRoot,
    });
  }

  return {
    snapshotId,
    snapshotPath: runtimePaths.snapshotDir,
    manifestPath: runtimePaths.manifestPath,
    reused: false,
  };
}

export async function validatePublishedRuntimeSnapshot({ producerStackBaseDir, snapshotId, target, requiredComponents = RUNTIME_SNAPSHOT_COMPONENTS }) {
  const producerPaths = resolveStackRuntimePaths({ stackBaseDir: producerStackBaseDir, snapshotId });
  const physicalSnapshotContainmentError = await getRuntimeSnapshotPhysicalContainmentError({
    buildsDir: producerPaths.buildsDir,
    snapshotDir: producerPaths.snapshotDir,
  });
  if (physicalSnapshotContainmentError) {
    throw new Error(physicalSnapshotContainmentError);
  }
  const manifest = await readRuntimeManifest({ manifestPath: producerPaths.manifestPath });
  const validation = validateRuntimeManifest(manifest, { requiredComponents });
  if (!validation.ok) {
    throw new Error(`[runtime] cannot select invalid runtime snapshot: ${validation.errors.join('; ')}`);
  }
  if (validation.manifest.snapshotId !== snapshotId) {
    throw new Error('[runtime] cannot select runtime snapshot whose manifest identity does not match.');
  }
  const targetValidation = validateRuntimeTarget(validation.manifest, target);
  if (!targetValidation.ok) {
    throw new Error(`[runtime] cannot select runtime snapshot: ${targetValidation.errors.join('; ')}`);
  }
  for (const [component, directoryName] of [
    ['web', 'ui'],
    ['server', 'server'],
    ['daemon', 'cli'],
  ]) {
    if (!validation.manifest.components[component]) continue;
    const componentPath = join(producerPaths.snapshotDir, directoryName);
    if (!(await pathExists(componentPath))) {
      throw new Error(`[runtime] cannot select incomplete runtime snapshot: missing ${directoryName}.`);
    }
    await validatePublishedRuntimeComponentReference({
      producerStackBaseDir,
      componentPath,
      component,
      manifest: validation.manifest,
      reusableSnapshotIds: validation.manifest.reusedSnapshotIds,
    });
  }
  const closure = validation.manifest.components.daemon
    ? await inspectDaemonDistClosure({ snapshotPath: producerPaths.snapshotDir }) : { fingerprint: null, errors: [] };
  const payloadErrors = await collectSnapshotRuntimePayloadErrors({ snapshotPath: producerPaths.snapshotDir,
    components: Object.keys(validation.manifest.components) });
  if (payloadErrors.length || closure.errors.length) throw new Error(payloadErrors[0] ?? closure.errors[0]);
  return { manifest: validation.manifest, producerPaths };
}

async function validatePublishedRuntimeComponentReference({
  producerStackBaseDir,
  componentPath,
  component,
  manifest,
  reusableSnapshotIds = [],
}) {
  const entrypoint = resolveRuntimeManifestEntrypoint({
    snapshotPath: join(componentPath, '..'), manifest, component,
  });
  await assertArtifactPayload({
    stackBaseDir: producerStackBaseDir,
    payloadDir: componentPath,
    manifest: { component, entrypoint: relative(componentPath, entrypoint) },
  });
  const artifactFingerprint = String(manifest?.components?.[component]?.artifactFingerprint ?? '').trim();
  if (!artifactFingerprint) return;
  const artifactDir = resolveStackComponentArtifactDir({
    stackBaseDir: producerStackBaseDir,
    component,
    fingerprint: artifactFingerprint,
  });
  const artifactManifest = await readArtifactManifest({ artifactDir });
  const artifactValidation = validateArtifactManifest(artifactManifest);
  if (artifactValidation.ok && artifactManifest.target && manifest.target) {
    const targetValidation = validateRuntimeTarget(artifactManifest, manifest.target);
    if (!targetValidation.ok) throw new Error(`[runtime] ${component} artifact target is incompatible: ${targetValidation.errors.join('; ')}`);
  }
  const componentStats = await lstat(componentPath).catch(() => null);
  const retainedLegacyReference = componentStats?.isSymbolicLink()
    && await isRetainedLegacyRuntimeSnapshotComponentReference({
      producerStackBaseDir,
      componentPath,
      component,
      reusedSnapshotIds: reusableSnapshotIds,
    });

  if (retainedLegacyReference) return;

  if (!artifactValidation.ok || artifactValidation.manifest.component !== component
    || artifactValidation.manifest.artifactFingerprint !== artifactFingerprint) {
    if (componentStats?.isSymbolicLink()) {
      throw new Error(
        `[runtime] cannot select incomplete runtime snapshot: ${component} artifact reference is missing or invalid.`,
      );
    }
    // v1 snapshots published before reference-only assembly contain their own
    // payload. They remain readable until ordinary retention removes them.
    return;
  }

  // A v1 snapshot owns a physical, self-contained component directory. Its
  // manifest can happen to name an artifact which exists today, but that does
  // not retroactively turn its payload into a reference. Keep that released
  // shape readable; only the symlink/junction shape published by this owner
  // must resolve back to the canonical artifact object.
  if (!componentStats?.isSymbolicLink()) return;

  await assertArtifactPayload({
    stackBaseDir: producerStackBaseDir,
    payloadDir: artifactPayloadDir(artifactDir),
    manifest: artifactValidation.manifest,
  });

  const [snapshotComponentPath, artifactPayloadPath] = await Promise.all([
    realpath(componentPath),
    realpath(artifactPayloadDir(artifactDir)),
  ]);
  if (snapshotComponentPath !== artifactPayloadPath) {
    throw new Error(
      `[runtime] cannot select runtime snapshot: ${component} component reference does not match its canonical artifact payload.`,
    );
  }
}

export async function selectRuntimeSnapshot({
  consumerStackBaseDir,
  producerStackBaseDir,
  producerStackName = '',
  snapshotId,
  target = { platform: process.platform, arch: process.arch },
  requiredComponents = RUNTIME_SNAPSHOT_COMPONENTS,
}) {
  const normalizedProducerStackName = String(producerStackName ?? '').trim();
  if (normalizedProducerStackName) {
    assertCanonicalManagedStackName(normalizedProducerStackName, 'producer');
  }
  const { manifest, producerPaths } = await validatePublishedRuntimeSnapshot({
    producerStackBaseDir,
    snapshotId,
    target,
    requiredComponents,
  });
  const consumerPaths = resolveStackRuntimePaths({ stackBaseDir: consumerStackBaseDir });
  await mkdir(consumerPaths.runtimeDir, { recursive: true });

  await buildIntoTempThenReplace(consumerPaths.currentDir, async (tmpCurrentDir) => {
    for (const component of Object.keys(manifest.components)) {
      const directory = resolveComponentDirectoryName(component);
      await symlink(join(producerPaths.snapshotDir, directory), join(tmpCurrentDir, directory), process.platform === 'win32' ? 'junction' : 'dir');
    }
    await copyFile(
      join(producerPaths.snapshotDir, 'manifest.json'),
      join(tmpCurrentDir, 'manifest.json'),
    );
  });

  await writeRuntimePointer({
    currentPath: consumerPaths.currentPath,
    pointer: {
      version: 1,
      snapshotId,
      snapshotPath: producerPaths.snapshotDir,
      ...(normalizedProducerStackName
        ? { producerStackName: normalizedProducerStackName }
        : {}),
      sourceFingerprint: manifest.sourceFingerprint,
      updatedAt: manifest.source?.builtAt ?? new Date().toISOString(),
    },
  });

  return {
    snapshotId,
    snapshotPath: producerPaths.snapshotDir,
    currentPath: consumerPaths.currentPath,
    producerStackName: normalizedProducerStackName || null,
  };
}

/** Published manifests are the target-specific authority; current.json is a consumer pin. */
export async function inspectLatestPublishedRuntimeSnapshot({ stackBaseDir, target = { platform: process.platform, arch: process.arch }, requiredComponents = RUNTIME_SNAPSHOT_COMPONENTS }) {
  const { buildsDir } = resolveStackRuntimePaths({ stackBaseDir });
  const entries = await readdir(buildsDir, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const snapshotPath = join(buildsDir, entry.name);
    const manifest = await readRuntimeManifest({ manifestPath: join(snapshotPath, 'manifest.json') });
    const validation = validateRuntimeManifest(manifest, { requiredComponents });
    if (!validation.ok || validation.manifest.snapshotId !== entry.name) continue;
    const targetValidation = validateRuntimeTarget(validation.manifest, target);
    if (!targetValidation.ok) continue;
    candidates.push({ snapshotId: entry.name,
      createdAt: manifest.createdAt || (await stat(snapshotPath)).mtime.toISOString() });
  }
  candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.snapshotId.localeCompare(a.snapshotId));
  const errors = [];
  let failure = null;
  for (const candidate of candidates) {
    try {
      const { manifest, producerPaths } = await validatePublishedRuntimeSnapshot({ producerStackBaseDir: stackBaseDir, snapshotId: candidate.snapshotId, target, requiredComponents });
      const closure = manifest.components.daemon ? await inspectDaemonDistClosure({ snapshotPath: producerPaths.snapshotDir }) : { fingerprint: null };
      return { valid: true, missing: false, errors: [], manifest,
        snapshot: { snapshotId: candidate.snapshotId, snapshotPath: producerPaths.snapshotDir, manifest, producerStackBaseDir: stackBaseDir,
          daemonDistClosureFingerprint: closure.fingerprint } };
    } catch (error) {
      failure ??= error;
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { valid: false, missing: candidates.length === 0, errors, failure, manifest: null, snapshot: null };
}

export async function selectActiveProducerRuntimeSnapshot({
  consumerStackBaseDir,
  producerStackBaseDir,
  producerStackName,
  consumerStackName = '',
  target = { platform: process.platform, arch: process.arch },
  snapshotId = '',
  requiredComponents = RUNTIME_SNAPSHOT_COMPONENTS,
}) {
  return await withWorkspaceBundleLock(() => selectProducerRuntimeSnapshot({
    consumerStackBaseDir, producerStackBaseDir, producerStackName, consumerStackName, target, snapshotId, requiredComponents,
  }), { lockPath: resolveStackRuntimePaths({ stackBaseDir: producerStackBaseDir }).lockPath,
    errorLabel: 'runtime snapshot selection lock' });
}

async function selectProducerRuntimeSnapshot({
  consumerStackBaseDir, producerStackBaseDir, producerStackName, consumerStackName, target, snapshotId, requiredComponents,
}) {
  await assertDistinctRuntimeSelection({
    consumerStackBaseDir,
    producerStackBaseDir,
    consumerStackName,
    producerStackName,
  });

  if (snapshotId) return await selectRuntimeSnapshot({ consumerStackBaseDir, producerStackBaseDir, producerStackName, snapshotId, target, requiredComponents });

  const inspection = await inspectLatestPublishedRuntimeSnapshot({ stackBaseDir: producerStackBaseDir, target, requiredComponents });
  if (!inspection.valid || !inspection.snapshot) {
    const reason = inspection.missing
      ? `has no complete runtime snapshot for ${target.platform}/${target.arch}`
      : `has no valid complete runtime snapshot for ${target.platform}/${target.arch}${inspection.errors[0] ? `: ${inspection.errors[0]}` : ''}`;
    const buildConsumerName = String(consumerStackName ?? '').trim() || '<consumer>';
    throw new Error(
      `[runtime] producer ${producerStackName} ${reason}. Publish through the repository authority with `
      + `hstack stack build ${buildConsumerName} --all --activate-runtime --target=${target.platform === 'win32' ? 'windows' : target.platform}-${target.arch}. These commands do not restart the producer or consumer.`,
    );
  }

  const resolvedProducerStackBaseDir = inspection.snapshot.producerStackBaseDir;
  const resolvedProducerStackName = inspection.snapshot.producerStackName ?? producerStackName;
  await assertDistinctRuntimeSelection({
    consumerStackBaseDir,
    producerStackBaseDir: resolvedProducerStackBaseDir,
    consumerStackName,
    producerStackName: resolvedProducerStackName,
  });

  return await selectRuntimeSnapshot({
    consumerStackBaseDir,
    producerStackBaseDir: resolvedProducerStackBaseDir,
    producerStackName: resolvedProducerStackName,
    snapshotId: inspection.snapshot.snapshotId,
    target,
    requiredComponents,
  });
}

async function assertDistinctRuntimeSelection({
  consumerStackBaseDir,
  producerStackBaseDir,
  consumerStackName,
  producerStackName,
}) {
  if ((await pathExists(consumerStackBaseDir)) && (await pathExists(producerStackBaseDir))) {
    const [consumerPhysicalPath, producerPhysicalPath] = await Promise.all([
      realpath(consumerStackBaseDir),
      realpath(producerStackBaseDir),
    ]);
    if (consumerPhysicalPath === producerPhysicalPath) {
      throw new Error(
        `[runtime] ${consumerStackName || producerStackName} is the runtime producer and already owns the active snapshot; select is for a separate consumer stack.`,
      );
    }
  }
}

export function composeRuntimePublicationResult({
  consumerStackName,
  producerStackName,
  published,
  selectedRuntime,
}) {
  if (!published || !selectedRuntime) {
    throw new Error('[runtime] cannot report runtime publication before publication and selection complete.');
  }
  if (
    published.snapshotId !== selectedRuntime.snapshotId
    || published.snapshotPath !== selectedRuntime.snapshotPath
  ) {
    throw new Error('[runtime] published and selected runtime snapshot identities do not match.');
  }
  return {
    consumerStackName: String(consumerStackName ?? '').trim(),
    producerStackName: String(producerStackName ?? '').trim(),
    snapshotId: selectedRuntime.snapshotId,
    snapshotPath: selectedRuntime.snapshotPath,
    currentPath: selectedRuntime.currentPath,
    reused: published.reused === true,
    selected: true,
  };
}

export async function activateRuntimeSnapshot({
  stackBaseDir,
  snapshotId,
  sourceMetadata,
  artifacts,
  runtimeSnapshotKeepCount = 2,
  platform = process.platform,
  arch = process.arch,
}) {
  const published = await publishRuntimeSnapshot({
    producerStackBaseDir: stackBaseDir,
    snapshotId,
    sourceMetadata,
    artifacts,
    runtimeSnapshotKeepCount,
    platform,
    arch,
  });
  return await selectRuntimeSnapshot({
    consumerStackBaseDir: stackBaseDir,
    producerStackBaseDir: stackBaseDir,
    snapshotId: published.snapshotId,
    target: { platform, arch },
  });
}
