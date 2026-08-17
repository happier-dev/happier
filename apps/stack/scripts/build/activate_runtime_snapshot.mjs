import { copyFile, lstat, mkdir, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { getFirstPartyComponentCatalogEntry } from '@happier-dev/cli-common/firstPartyRuntime';

import { buildIntoTempThenReplace } from '../utils/fs/atomic_dir_swap.mjs';
import {
  artifactPayloadDir,
  readArtifactManifest,
  readReusableArtifactManifest,
  resolveComponentArtifactSupportReference,
  validateArtifactManifest,
} from '../runtime/shared/artifact_manifest.mjs';
import {
  isRetainedLegacyRuntimeSnapshotComponentReference,
  readRuntimeManifest,
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
import { inspectActiveRuntimeSnapshot } from '../runtime/launch/inspectActiveRuntimeSnapshot.mjs';
import { pruneRuntimeSnapshots } from './runtime_retention.mjs';
import { createRuntimeSnapshotSourceMetadata } from '../runtime/shared/runtime_snapshot_identity.mjs';

function resolveComponentDirectoryName(component) {
  return component === 'web' ? 'ui' : component === 'server' ? 'server' : 'cli';
}

async function materializeRuntimeComponent({ targetDir, sourceDir }) {
  await symlink(sourceDir, targetDir, process.platform === 'win32' ? 'junction' : 'dir');
}

async function validateRuntimeArtifact({ stackBaseDir, component, artifact }) {
  const validation = validateArtifactManifest(artifact?.manifest);
  if (!validation.ok) {
    throw new Error(`[build] invalid ${component} artifact manifest: ${validation.errors.join('; ')}`);
  }
  if (validation.manifest.component !== component) {
    throw new Error(`[build] invalid ${component} artifact manifest: component identity does not match.`);
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
    sourceDir: canonicalPayloadDir,
    entrypoint: resolveComponentArtifactEntrypoint(component, artifactManifest.entrypoint),
    reusedSnapshotId: null,
  };
}

async function resolveComponentSource({ stackBaseDir, component, artifact, currentSnapshot, sourceMetadata }) {
  const componentDirName = resolveComponentDirectoryName(component);
  if (artifact) {
    const manifest = await validateRuntimeArtifact({ stackBaseDir, component, artifact });
    if (component === 'server') {
      assertCompatibleServerFlavor({
        sourceMetadata,
        reuseSource: manifest.source,
        sourceLabel: 'server artifact',
      });
    }
    return {
      artifactFingerprint: manifest.artifactFingerprint,
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

  const canonicalCurrentSource = await resolveCanonicalCurrentComponentSource({
    stackBaseDir,
    component,
    currentSnapshot,
  });
  if (canonicalCurrentSource) return canonicalCurrentSource;

  return {
    artifactFingerprint: String(currentSnapshot.manifest.components[component].artifactFingerprint ?? '').trim(),
    sourceDir: join(currentSnapshot.snapshotPath, componentDirName),
    entrypoint: String(currentSnapshot.manifest.components[component].entrypoint ?? '').trim(),
    reusedSnapshotId: currentSnapshot.snapshotId,
  };
}

async function isPublishedRuntimeSnapshotReusable({
  runtimePaths,
  snapshotId,
  sourceMetadata,
  sources,
  platform,
  arch,
}) {
  const manifest = await readRuntimeManifest({ manifestPath: runtimePaths.manifestPath });
  const validation = validateRuntimeManifest(manifest);
  if (!validation.ok || validation.manifest.snapshotId !== snapshotId) return false;
  if (validation.manifest.sourceFingerprint !== sourceMetadata.sourceFingerprint) return false;
  const targetValidation = validateRuntimeTarget(validation.manifest, { platform, arch });
  if (!targetValidation.ok || targetValidation.legacy) return false;

  for (const [component, source] of Object.entries(sources)) {
    if (validation.manifest.components[component]?.artifactFingerprint !== source.artifactFingerprint) return false;
    const entrypoint = resolveRuntimeManifestEntrypoint({
      snapshotPath: runtimePaths.snapshotDir,
      manifest: validation.manifest,
      component,
    });
    if (!entrypoint || !(await pathExists(entrypoint))) return false;
  }
  const daemonComponent = getFirstPartyComponentCatalogEntry('happier-daemon');
  if (
    daemonComponent.nodeEntrypointRelativePath
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
}) {
  const stackBaseDir = producerStackBaseDir;
  const runtimeSourceMetadata = createRuntimeSnapshotSourceMetadata({ sourceMetadata, snapshotId });
  const runtimePaths = resolveStackRuntimePaths({ stackBaseDir, snapshotId });
  await mkdir(runtimePaths.buildsDir, { recursive: true });
  const currentInspection = await inspectActiveRuntimeSnapshot({ stackBaseDir });
  const currentSnapshot = currentInspection.snapshot;
  const webSource = await resolveComponentSource({ stackBaseDir, component: 'web', artifact: artifacts.web, currentSnapshot, sourceMetadata: runtimeSourceMetadata });
  const serverSource = await resolveComponentSource({ stackBaseDir, component: 'server', artifact: artifacts.server, currentSnapshot, sourceMetadata: runtimeSourceMetadata });
  const daemonSource = await resolveComponentSource({ stackBaseDir, component: 'daemon', artifact: artifacts.daemon, currentSnapshot, sourceMetadata: runtimeSourceMetadata });
  const sources = { web: webSource, server: serverSource, daemon: daemonSource };
  const reusedSnapshotIds = [...new Set([
    webSource.reusedSnapshotId,
    serverSource.reusedSnapshotId,
    daemonSource.reusedSnapshotId,
  ].filter((value) => typeof value === 'string' && value.trim() && value !== snapshotId))];

  if (await isPublishedRuntimeSnapshotReusable({
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
    await materializeRuntimeComponent({
      sourceDir: webSource.sourceDir,
      targetDir: join(tmpSnapshotDir, 'ui'),
    });
    await materializeRuntimeComponent({
      sourceDir: serverSource.sourceDir,
      targetDir: join(tmpSnapshotDir, 'server'),
    });
    await materializeRuntimeComponent({
      sourceDir: daemonSource.sourceDir,
      targetDir: join(tmpSnapshotDir, 'cli'),
    });

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
        components: {
          web: {
            artifactFingerprint: webSource.artifactFingerprint,
            entrypoint: webSource.entrypoint,
          },
          server: {
            artifactFingerprint: serverSource.artifactFingerprint,
            entrypoint: serverSource.entrypoint,
          },
          daemon: {
            artifactFingerprint: daemonSource.artifactFingerprint,
            entrypoint: daemonSource.entrypoint,
          },
        },
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

async function validatePublishedRuntimeSnapshot({ producerStackBaseDir, snapshotId }) {
  const producerPaths = resolveStackRuntimePaths({ stackBaseDir: producerStackBaseDir, snapshotId });
  const physicalSnapshotContainmentError = await getRuntimeSnapshotPhysicalContainmentError({
    buildsDir: producerPaths.buildsDir,
    snapshotDir: producerPaths.snapshotDir,
  });
  if (physicalSnapshotContainmentError) {
    throw new Error(physicalSnapshotContainmentError);
  }
  const manifest = await readRuntimeManifest({ manifestPath: producerPaths.manifestPath });
  const validation = validateRuntimeManifest(manifest);
  if (!validation.ok) {
    throw new Error(`[runtime] cannot select invalid runtime snapshot: ${validation.errors.join('; ')}`);
  }
  if (validation.manifest.snapshotId !== snapshotId) {
    throw new Error('[runtime] cannot select runtime snapshot whose manifest identity does not match.');
  }
  const targetValidation = validateRuntimeTarget(validation.manifest);
  if (!targetValidation.ok) {
    throw new Error(`[runtime] cannot select runtime snapshot: ${targetValidation.errors.join('; ')}`);
  }
  for (const [component, directoryName] of [
    ['web', 'ui'],
    ['server', 'server'],
    ['daemon', 'cli'],
  ]) {
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
  return { manifest: validation.manifest, producerPaths };
}

async function validatePublishedRuntimeComponentReference({
  producerStackBaseDir,
  componentPath,
  component,
  manifest,
  reusableSnapshotIds = [],
}) {
  const artifactFingerprint = String(manifest?.components?.[component]?.artifactFingerprint ?? '').trim();
  if (!artifactFingerprint) return;
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
      reusedSnapshotIds: reusableSnapshotIds,
    });

  if (retainedLegacyReference) return;

  if (!artifactValidation.ok || artifactValidation.manifest.component !== component) {
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

  await resolveComponentArtifactSupportReference({
    stackBaseDir: producerStackBaseDir,
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
}) {
  const normalizedProducerStackName = String(producerStackName ?? '').trim();
  if (normalizedProducerStackName) {
    assertCanonicalManagedStackName(normalizedProducerStackName, 'producer');
  }
  const { manifest, producerPaths } = await validatePublishedRuntimeSnapshot({
    producerStackBaseDir,
    snapshotId,
  });
  const consumerPaths = resolveStackRuntimePaths({ stackBaseDir: consumerStackBaseDir });
  await mkdir(consumerPaths.runtimeDir, { recursive: true });

  await buildIntoTempThenReplace(consumerPaths.currentDir, async (tmpCurrentDir) => {
    await symlink(join(producerPaths.snapshotDir, 'ui'), join(tmpCurrentDir, 'ui'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(join(producerPaths.snapshotDir, 'server'), join(tmpCurrentDir, 'server'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(join(producerPaths.snapshotDir, 'cli'), join(tmpCurrentDir, 'cli'), process.platform === 'win32' ? 'junction' : 'dir');
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

export async function selectActiveProducerRuntimeSnapshot({
  consumerStackBaseDir,
  producerStackBaseDir,
  producerStackName,
  consumerStackName = '',
}) {
  await assertDistinctRuntimeSelection({
    consumerStackBaseDir,
    producerStackBaseDir,
    consumerStackName,
    producerStackName,
  });

  const inspection = await inspectActiveRuntimeSnapshot({ stackBaseDir: producerStackBaseDir });
  if (!inspection.valid || !inspection.snapshot) {
    const reason = inspection.missing
      ? 'has no active runtime snapshot'
      : `has an invalid active runtime snapshot${inspection.errors[0] ? `: ${inspection.errors[0]}` : ''}`;
    const buildConsumerName = String(consumerStackName ?? '').trim() || '<consumer>';
    throw new Error(
      `[runtime] producer ${producerStackName} ${reason}. Publish through the repository authority with `
      + `hstack stack build ${buildConsumerName} --server --daemon, then select the complete result with `
      + `hstack stack runtime ${buildConsumerName} activate --all. These commands do not restart the producer or consumer.`,
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
  });
}
