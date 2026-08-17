import { join } from 'node:path';

import { resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { parseArgs } from '../utils/cli/args.mjs';
import {
  resolveStackComponentArtifactDir,
  resolveStackComponentArtifactLockPath,
  resolveStackRuntimePaths,
} from '../runtime/shared/runtime_paths.mjs';
import { readComponentArtifactSupportReference } from '../runtime/shared/artifact_manifest.mjs';
import { collectBuildSourceMetadata } from './collect_build_source_metadata.mjs';
import { buildWebArtifact } from './build_web_artifact.mjs';
import { buildDaemonArtifact } from './build_daemon_artifact.mjs';
import { buildServerArtifact } from './build_server_artifact.mjs';
import {
  composeRuntimePublicationResult,
  publishRuntimeSnapshot,
  selectRuntimeSnapshot,
} from './activate_runtime_snapshot.mjs';
import { parseBuildSelection } from './build_targets.mjs';
import {
  pruneComponentArtifacts,
  pruneRuntimeSnapshots,
  resolveRuntimeRetentionPolicy,
} from './runtime_retention.mjs';
import { ensureStackRuntimeModePrefer } from '../runtime/shared/ensureStackRuntimeModePrefer.mjs';
import { createRuntimeSnapshotId } from '../runtime/shared/runtime_snapshot_identity.mjs';
import { resolveRuntimeBuildAuthority } from '../runtime/shared/runtime_build_authority.mjs';
import { getStacksStorageRoot } from '../utils/paths/paths.mjs';
import {
  assertSelectedBuildPrerequisites,
  collectRuntimeBuildToolchainInputs,
} from './runtime_artifact_identity.mjs';
import { resolveRuntimeBuildRequestIdentity } from './runtime_build_request_identity.mjs';
import { withWorkspaceBundleLock } from '@happier-dev/cli-common/workspaceBundleLock';
import { inspectActiveRuntimeSnapshot } from '../runtime/launch/inspectActiveRuntimeSnapshot.mjs';
import {
  captureRuntimeBuildStoreState,
  resolveCompletedRuntimeBuildAfterWait,
} from './runtime_build_store_state.mjs';

export { assertSelectedBuildPrerequisites, collectRuntimeBuildToolchainInputs } from './runtime_artifact_identity.mjs';

function assertNamedStack(env) {
  const stackName = String(env.HAPPIER_STACK_STACK ?? '').trim() || 'main';
  if (stackName === 'main') {
    throw new Error('[build] runtime artifact builds are supported for named consumer stacks only.');
  }
  return stackName;
}

export async function buildSelectedStackArtifacts({
  selection,
  buildComponent,
}) {
  const artifacts = {};
  if (selection.components.web) {
    artifacts.web = await buildComponent('web', buildWebArtifact);
  }

  if (selection.components.server) {
    artifacts.server = await buildComponent('server', buildServerArtifact);
  }

  if (selection.components.daemon) {
    artifacts.daemon = await buildComponent('daemon', buildDaemonArtifact);
  }
  return artifacts;
}

const RUNTIME_COMPONENTS = Object.freeze(['web', 'server', 'daemon']);
const RUNTIME_COMPONENT_SET = new Set(RUNTIME_COMPONENTS);

function selectedRuntimeComponents(selection) {
  return RUNTIME_COMPONENTS.filter((component) => selection?.components?.[component] === true);
}

function normalizeRequestedRuntimeComponents(requestedComponents) {
  const requested = new Set(
    (Array.isArray(requestedComponents) ? requestedComponents : [])
      .map((component) => String(component ?? '').trim())
      .filter((component) => RUNTIME_COMPONENT_SET.has(component)),
  );
  return RUNTIME_COMPONENTS.filter((component) => requested.has(component));
}

function createRuntimePublicationSelection(requestedComponents) {
  const selected = new Set(normalizeRequestedRuntimeComponents(requestedComponents));
  return {
    components: {
      web: selected.has('web'),
      server: selected.has('server'),
      daemon: selected.has('daemon'),
      tauri: false,
    },
    activateRuntime: true,
    forceRebuild: false,
    explicitComponentSelection: true,
  };
}

function runtimeBuildLockOptions({ runtimePaths, env, tryResolveWaiter }) {
  return {
    lockPath: runtimePaths.lockPath,
    errorLabel: 'runtime snapshot build lock',
    timeoutMs: Number(env.HAPPIER_STACK_RUNTIME_BUILD_LOCK_TIMEOUT_MS) || undefined,
    ...(tryResolveWaiter ? { tryResolveWaiter } : {}),
  };
}

function snapshotArtifactFingerprints({ artifacts, currentInspection }) {
  const componentFingerprints = {};
  for (const component of RUNTIME_COMPONENTS) {
    const artifactFingerprint = String(
      artifacts?.[component]?.manifest?.artifactFingerprint
      ?? (currentInspection?.valid ? currentInspection.manifest?.components?.[component]?.artifactFingerprint : '')
      ?? '',
    ).trim();
    if (!artifactFingerprint) {
      throw new Error(
        `[build] cannot publish a complete runtime snapshot: ${component} has no selected or current artifact.`,
      );
    }
    componentFingerprints[component] = artifactFingerprint;
  }
  return componentFingerprints;
}

function serializeArtifacts(artifacts) {
  return Object.fromEntries(
    Object.entries(artifacts ?? {}).map(([component, value]) => [
      component,
      {
        artifactDir: value.artifactDir,
        manifest: value.manifest,
      },
    ]),
  );
}

function noOpRepositoryPublicationResult({ authority, sourceMetadata, currentInspection, requestedComponents }) {
  const snapshot = currentInspection?.snapshot;
  return {
    ok: true,
    requestedComponents,
    components: requestedComponents,
    changed: false,
    snapshotId: snapshot?.snapshotId ?? null,
    snapshotPath: snapshot?.snapshotPath ?? null,
    producerStackName: authority.producerStackName,
    producerStackBaseDir: authority.producerStackBaseDir,
    source: sourceMetadata ?? null,
    artifacts: {},
    runtime: null,
  };
}

/**
 * The one component lock is deliberately adjacent to the immutable artifact
 * path. The component builder still owns its reuse/staging verification; this
 * lock only prevents two publishers from doing the same expensive work.
 */
export async function buildComponentArtifactWithIdentityLock({
  stackBaseDir,
  component,
  artifactFingerprint,
  buildArtifact,
  env = process.env,
  withWorkspaceBundleLockImpl = withWorkspaceBundleLock,
}) {
  const lockPath = resolveStackComponentArtifactLockPath({
    stackBaseDir,
    component,
    fingerprint: artifactFingerprint,
  });
  return await withWorkspaceBundleLockImpl(
    async () => await buildArtifact(),
    {
      lockPath,
      errorLabel: `${component} runtime artifact identity lock`,
      timeoutMs: Number(env.HAPPIER_STACK_RUNTIME_BUILD_LOCK_TIMEOUT_MS) || undefined,
    },
  );
}

export async function buildRuntimeArtifactComponents({
  rootDir,
  stackBaseDir,
  selection,
  env = process.env,
  retentionPolicy = resolveRuntimeRetentionPolicy({ env }),
  assertSelectedBuildPrerequisitesImpl = assertSelectedBuildPrerequisites,
  collectBuildSourceMetadataImpl = collectBuildSourceMetadata,
  resolveRuntimeBuildRequestIdentityImpl = resolveRuntimeBuildRequestIdentity,
  buildSelectedStackArtifactsImpl = buildSelectedStackArtifacts,
  buildComponentArtifactWithIdentityLockImpl = buildComponentArtifactWithIdentityLock,
  withWorkspaceBundleLockImpl = withWorkspaceBundleLock,
  pruneComponentArtifactsImpl = pruneComponentArtifacts,
}) {
  assertSelectedBuildPrerequisitesImpl({ selection, env });
  const initialSourceMetadata = await collectBuildSourceMetadataImpl({ rootDir, env });
  const buildRequest = await resolveRuntimeBuildRequestIdentityImpl({
    rootDir,
    producerStackBaseDir: stackBaseDir,
    selection,
    sourceMetadata: initialSourceMetadata,
    env,
  });
  const sourceMetadata = buildRequest.sourceMetadata;
  const buildComponent = async (component, builder, builderOptions = {}) => {
    const artifactFingerprint = String(buildRequest.artifactFingerprints?.[component] ?? '').trim();
    if (!artifactFingerprint) {
      throw new Error(`[build] missing ${component} artifact identity for the selected build.`);
    }
    const artifactDir = resolveStackComponentArtifactDir({ stackBaseDir, component, fingerprint: artifactFingerprint });
    const artifact = await buildComponentArtifactWithIdentityLockImpl({
      stackBaseDir,
      component,
      artifactFingerprint,
      env,
      withWorkspaceBundleLockImpl,
      buildArtifact: async () => await builder({
        rootDir,
        stackBaseDir,
        artifactDir,
        artifactFingerprint,
        sourceMetadata,
        forceRebuild: selection.forceRebuild,
        env,
        ...(buildRequest.supportArtifactFingerprints?.[component]
          ? { supportArtifactFingerprint: buildRequest.supportArtifactFingerprints[component] }
          : {}),
        ...builderOptions,
      }),
    });
    await pruneComponentArtifactsImpl({
      stackBaseDir,
      component,
      keepCount: retentionPolicy.artifactKeepCount,
      runtimeSnapshotKeepCount: retentionPolicy.runtimeSnapshotKeepCount,
      externalReferenceStorageRoot: getStacksStorageRoot(env),
    });
    const supportReference = readComponentArtifactSupportReference(artifact?.manifest);
    if (supportReference) {
      await pruneComponentArtifactsImpl({
        stackBaseDir,
        component: supportReference.supportComponent,
        keepCount: retentionPolicy.artifactKeepCount,
        runtimeSnapshotKeepCount: retentionPolicy.runtimeSnapshotKeepCount,
        externalReferenceStorageRoot: getStacksStorageRoot(env),
      });
    }
    return artifact;
  };

  const artifacts = await buildSelectedStackArtifactsImpl({ selection, buildComponent });
  return { artifacts, buildRequest, sourceMetadata };
}

/**
 * Resolve only the requested component identities against the current producer
 * snapshot. This gives source development a narrow, producer-owned answer
 * without giving it artifact or pointer authority.
 */
export async function resolveRepositoryRuntimePublicationComponents({
  rootDir,
  authority,
  requestedComponents,
  env = process.env,
  inspectActiveRuntimeSnapshotImpl = inspectActiveRuntimeSnapshot,
  resolveRuntimeBuildRequestIdentityImpl = resolveRuntimeBuildRequestIdentity,
}) {
  const components = normalizeRequestedRuntimeComponents(requestedComponents);
  const inspection = await inspectActiveRuntimeSnapshotImpl({
    stackBaseDir: authority.producerStackBaseDir,
  });
  const currentSnapshotId = inspection.valid ? inspection.snapshot?.snapshotId ?? null : null;
  if (components.length === 0) return { components, currentSnapshotId };

  const selection = createRuntimePublicationSelection(components);
  const buildRequest = await resolveRuntimeBuildRequestIdentityImpl({
    rootDir,
    producerStackBaseDir: authority.producerStackBaseDir,
    selection,
    env,
  });
  return {
    components: components.filter((component) => (
      String(inspection.manifest?.components?.[component]?.artifactFingerprint ?? '').trim()
      !== String(buildRequest.artifactFingerprints?.[component] ?? '').trim()
    )),
    currentSnapshotId,
  };
}

export async function publishBuiltRepositoryRuntimeSnapshot({
  authority,
  selection,
  requestedComponents,
  sourceMetadata,
  artifacts,
  env,
  retentionPolicy,
  baselineStoreState = null,
  expectedArtifactFingerprints = {},
  selectConsumer = false,
  withWorkspaceBundleLockImpl = withWorkspaceBundleLock,
  inspectActiveRuntimeSnapshotImpl = inspectActiveRuntimeSnapshot,
  publishRuntimeSnapshotImpl = publishRuntimeSnapshot,
  selectRuntimeSnapshotImpl = selectRuntimeSnapshot,
  resolveCompletedRuntimeBuildAfterWaitImpl = resolveCompletedRuntimeBuildAfterWait,
  pruneRuntimeSnapshotsImpl = pruneRuntimeSnapshots,
}) {
  const stackBaseDir = authority.producerStackBaseDir;
  const runtimePaths = resolveStackRuntimePaths({ stackBaseDir });
  const resolveWaitedPublication = async () => {
    if (!baselineStoreState) return null;
    return await resolveCompletedRuntimeBuildAfterWaitImpl({
      authority,
      selection,
      baselineStoreState,
      expectedArtifactFingerprints,
      selectConsumer,
      selectRuntimeSnapshotImpl,
    });
  };

  const publication = await withWorkspaceBundleLockImpl(async ({ waited }) => {
    if (waited) {
      const completed = await resolveWaitedPublication();
      if (completed) return { completed };
    }

    const currentInspection = await inspectActiveRuntimeSnapshotImpl({ stackBaseDir });
    const componentFingerprints = snapshotArtifactFingerprints({ artifacts, currentInspection });
    const snapshotId = createRuntimeSnapshotId({ sourceMetadata, componentFingerprints });
    const published = await publishRuntimeSnapshotImpl({
      producerStackBaseDir: stackBaseDir,
      snapshotId,
      sourceMetadata,
      artifacts,
      runtimeSnapshotKeepCount: retentionPolicy.runtimeSnapshotKeepCount,
      externalReferenceStorageRoot: getStacksStorageRoot(env),
      pruneAfterPublish: false,
    });
    await selectRuntimeSnapshotImpl({
      consumerStackBaseDir: stackBaseDir,
      producerStackBaseDir: stackBaseDir,
      producerStackName: authority.producerStackName,
      snapshotId: published.snapshotId,
    });
    const selectedRuntime = selectConsumer
      ? await selectRuntimeSnapshotImpl({
          consumerStackBaseDir: authority.consumerStackBaseDir,
          producerStackBaseDir: stackBaseDir,
          producerStackName: authority.producerStackName,
          snapshotId: published.snapshotId,
        })
      : null;
    return {
      completed: null,
      currentSnapshotId: currentInspection.valid ? currentInspection.snapshot?.snapshotId ?? null : null,
      published,
      runtime: selectedRuntime
        ? composeRuntimePublicationResult({
            consumerStackName: authority.consumerStackName,
            producerStackName: authority.producerStackName,
            published,
            selectedRuntime,
          })
        : null,
    };
  }, runtimeBuildLockOptions({ runtimePaths, env }));

  const completed = publication?.completed;
  const snapshotId = completed?.snapshotId ?? publication?.published?.snapshotId ?? null;
  const snapshotPath = completed?.snapshotPath ?? publication?.published?.snapshotPath ?? null;
  const previousSnapshotId = publication?.currentSnapshotId ?? baselineStoreState?.snapshotId ?? null;
  await pruneRuntimeSnapshotsImpl({
    stackBaseDir,
    keepCount: retentionPolicy.runtimeSnapshotKeepCount,
    preserveSnapshotIds: snapshotId ? [snapshotId] : [],
    externalReferenceStorageRoot: getStacksStorageRoot(env),
  });
  return {
    requestedComponents,
    components: requestedComponents,
    changed: Boolean(snapshotId && snapshotId !== previousSnapshotId),
    snapshotId,
    snapshotPath,
    reused: completed?.reused ?? publication?.published?.reused ?? false,
    selected: completed?.selected ?? publication?.runtime?.selected ?? false,
    runtime: completed?.runtime ?? publication?.runtime ?? null,
  };
}

/**
 * Canonical repository-authority publisher for source development. It advances
 * only the producer pointer; consumer selection remains an explicit caller
 * action. Empty requests are a cheap current-snapshot reconciliation.
 */
export async function publishRepositoryRuntimeSnapshot({
  rootDir,
  authority,
  requestedComponents,
  env = process.env,
  buildRuntimeArtifactComponentsImpl = buildRuntimeArtifactComponents,
  captureRuntimeBuildStoreStateImpl = captureRuntimeBuildStoreState,
  inspectActiveRuntimeSnapshotImpl = inspectActiveRuntimeSnapshot,
  publishBuiltRepositoryRuntimeSnapshotImpl = publishBuiltRepositoryRuntimeSnapshot,
}) {
  const components = normalizeRequestedRuntimeComponents(requestedComponents);
  const currentInspection = await inspectActiveRuntimeSnapshotImpl({
    stackBaseDir: authority.producerStackBaseDir,
  });
  if (components.length === 0) {
    return noOpRepositoryPublicationResult({
      authority,
      currentInspection,
      requestedComponents: components,
    });
  }

  const selection = createRuntimePublicationSelection(components);
  const retentionPolicy = resolveRuntimeRetentionPolicy({ env });
  const baselineStoreState = await captureRuntimeBuildStoreStateImpl({ authority, selection });
  const { artifacts, buildRequest, sourceMetadata } = await buildRuntimeArtifactComponentsImpl({
    rootDir,
    stackBaseDir: authority.producerStackBaseDir,
    selection,
    env,
    retentionPolicy,
  });
  const publication = await publishBuiltRepositoryRuntimeSnapshotImpl({
    authority,
    selection,
    requestedComponents: components,
    sourceMetadata,
    artifacts,
    env,
    retentionPolicy,
    baselineStoreState,
    expectedArtifactFingerprints: buildRequest.artifactFingerprints,
    selectConsumer: false,
  });
  return {
    ok: true,
    ...publication,
    producerStackName: authority.producerStackName,
    producerStackBaseDir: authority.producerStackBaseDir,
    source: sourceMetadata,
    artifacts: serializeArtifacts(artifacts),
  };
}

export async function buildStackArtifacts({ rootDir, argv = [], env = process.env, authority = null }) {
  const { flags } = parseArgs(argv);
  const selection = parseBuildSelection({ argv });
  const stackName = assertNamedStack(env);
  if (flags.has('--tauri')) {
    throw new Error('[build] tauri artifact builds are not supported in named-stack runtime snapshots.');
  }
  const resolvedAuthority = authority ?? resolveRuntimeBuildAuthority({
    rootDir,
    consumerStackName: stackName,
    env,
  });
  const stackBaseDir = resolvedAuthority.producerStackBaseDir;

  if (selection.activateRuntime) {
    const requestedComponents = selectedRuntimeComponents(selection);
    const retentionPolicy = resolveRuntimeRetentionPolicy({ env });
    const baselineStoreState = await captureRuntimeBuildStoreState({
      authority: resolvedAuthority,
      selection,
    });
    const { artifacts, buildRequest, sourceMetadata } = await buildRuntimeArtifactComponents({
      rootDir,
      stackBaseDir,
      selection,
      env,
      retentionPolicy,
    });
    const publication = await publishBuiltRepositoryRuntimeSnapshot({
      authority: resolvedAuthority,
      selection,
      requestedComponents,
      sourceMetadata,
      artifacts,
      env,
      retentionPolicy,
      baselineStoreState,
      expectedArtifactFingerprints: buildRequest.artifactFingerprints,
      selectConsumer: true,
    });
    const { envPath } = resolveStackEnvPath(stackName, env);
    await ensureStackRuntimeModePrefer({ envPath });
    return {
      ok: true,
      stackName,
      consumerStackName: resolvedAuthority.consumerStackName,
      consumerStackBaseDir: resolvedAuthority.consumerStackBaseDir,
      producerStackName: resolvedAuthority.producerStackName,
      producerStackBaseDir: stackBaseDir,
      stackBaseDir,
      snapshotId: publication.snapshotId,
      snapshotPath: publication.snapshotPath,
      reused: publication.reused,
      selected: publication.selected,
      source: sourceMetadata,
      artifacts: serializeArtifacts(artifacts),
      runtime: publication.runtime,
    };
  }

  const { artifacts, sourceMetadata } = await buildRuntimeArtifactComponents({
    rootDir,
    stackBaseDir,
    selection,
    env,
  });
  return {
    ok: true,
    stackName,
    consumerStackName: resolvedAuthority.consumerStackName,
    consumerStackBaseDir: resolvedAuthority.consumerStackBaseDir,
    producerStackName: resolvedAuthority.producerStackName,
    producerStackBaseDir: stackBaseDir,
    stackBaseDir,
    snapshotId: null,
    snapshotPath: null,
    reused: null,
    selected: false,
    source: sourceMetadata,
    artifacts: serializeArtifacts(artifacts),
    runtime: null,
  };
}
