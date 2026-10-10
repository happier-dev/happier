import { join } from 'node:path';

import { getRepoDir, resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { parseArgs } from '../utils/cli/args.mjs';
import {
  resolveStackComponentArtifactDir,
  resolveStackRuntimePaths,
} from '../runtime/shared/runtime_paths.mjs';
import { readComponentArtifactSupportReference, readReusableArtifactManifest } from '../runtime/shared/artifact_manifest.mjs';
import { collectBuildSourceMetadata } from './collect_build_source_metadata.mjs';
import { buildWebArtifact } from './build_web_artifact.mjs';
import { buildDaemonArtifact } from './build_daemon_artifact.mjs';
import { buildServerArtifact } from './build_server_artifact.mjs';
import {
  composeRuntimePublicationResult,
  inspectLatestPublishedRuntimeSnapshot,
  publishRuntimeSnapshot,
  selectRuntimeSnapshot,
} from './activate_runtime_snapshot.mjs';
import { parseBuildSelection, resolveRuntimeBuildTargetGroups } from './build_targets.mjs';
import {
  pruneComponentArtifacts,
  pruneRuntimeSnapshots,
  resolveRuntimeRetentionPolicy,
} from './runtime_retention.mjs';
import { ensureStackRuntimeModePrefer } from '../runtime/shared/ensureStackRuntimeModePrefer.mjs';
import { recordStackRuntimeUpdate } from '../utils/stack/runtime_state.mjs';
import { createRuntimeSnapshotId } from '../runtime/shared/runtime_snapshot_identity.mjs';
import { resolveRuntimeBuildAuthority } from '../runtime/shared/runtime_build_authority.mjs';
import { getStacksStorageRoot } from '../utils/paths/paths.mjs';
import {
  assertSelectedBuildPrerequisites,
  collectRuntimeBuildToolchainInputs,
} from './runtime_artifact_identity.mjs';
import { resolveRuntimeBuildRequestIdentity } from './runtime_build_request_identity.mjs';
import { withWorkspaceBundleLock } from '@happier-dev/cli-common/workspaceBundleLock';
import { createWorkspaceBuildWaitNotifier } from '../utils/proc/workspaceBuildWaitNotifier.mjs';
import { RUNTIME_SNAPSHOT_COMPONENTS } from '../runtime/shared/runtime_manifest.mjs';
import { WORKSPACE_BUILD_MODE_ENV, resolveWorkspaceBuildMode } from '../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';

export { assertSelectedBuildPrerequisites, collectRuntimeBuildToolchainInputs } from './runtime_artifact_identity.mjs';

export async function prepareBundledPluginPublicationInputs({
  rootDir,
  selection,
  env,
}) {
  // Server code and support are independent of the bundled CLI/UI artifacts.
  if (selection?.components
    && selection.components.web !== true
    && selection.components.daemon !== true) return;
  const { runCanonicalBundledPluginArtifactPublisher: publish } = await import('../../../cli/scripts/buildSharedDeps.mjs');
  const repoRoot = getRepoDir(rootDir, env);
  await publish({ repoRoot, env, quiet: true, progress: true, mode: 'check', scope: 'projections' });
}

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

const RUNTIME_COMPONENTS = RUNTIME_SNAPSHOT_COMPONENTS;
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

export function resolveRuntimePublicationRequiredComponents({ target, requestedComponents, selection }) {
  if (selection?.publicationRequiredComponents) return normalizeRequestedRuntimeComponents(selection.publicationRequiredComponents);
  return target.platform === process.platform && target.arch === process.arch
    ? RUNTIME_SNAPSHOT_COMPONENTS : normalizeRequestedRuntimeComponents(requestedComponents);
}


function runtimeBuildLockOptions({ runtimePaths, env }) {
  return {
    lockPath: runtimePaths.lockPath,
    errorLabel: 'runtime snapshot build lock',
    timeoutMs: Number(env.HAPPIER_STACK_RUNTIME_BUILD_LOCK_TIMEOUT_MS) || undefined,
    onWait: createWorkspaceBuildWaitNotifier({ env, label: 'runtime snapshot publication', kind: 'lock' }),
  };
}

function snapshotArtifactFingerprints({ artifacts, currentInspection, requiredComponents = RUNTIME_COMPONENTS }) {
  const componentFingerprints = {};
  for (const component of RUNTIME_COMPONENTS) {
    const artifactFingerprint = String(
      artifacts?.[component]?.manifest?.artifactFingerprint
      ?? (currentInspection?.valid ? currentInspection.manifest?.components?.[component]?.artifactFingerprint : '')
      ?? '',
    ).trim();
    if (!artifactFingerprint) {
      if (!requiredComponents.includes(component)) continue;
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

/** Short final-output publication and explicit selection transaction. */
export async function withRuntimePublicationAdmission({
  authority, env = process.env, publish, withWorkspaceBundleLockImpl = withWorkspaceBundleLock,
}) {
  const { runtimeDir } = resolveStackRuntimePaths({ stackBaseDir: authority.producerStackBaseDir });
  return await withWorkspaceBundleLockImpl(publish, {
    lockPath: join(runtimeDir, 'publication.lock'),
    errorLabel: 'runtime publication lock',
    timeoutMs: Number(env.HAPPIER_STACK_RUNTIME_BUILD_LOCK_TIMEOUT_MS) || undefined,
    onWait: createWorkspaceBuildWaitNotifier({ env, label: 'runtime publication', kind: 'lock' }),
  });
}

/** Every explicit invocation constructs only its requested components. */
export async function withRuntimeBuildPublication({
  authority, selection, target = { platform: process.platform, arch: process.arch },
  env = process.env, publish, selectConsumer = false,
  admitExecution = async ({ run }) => run({}),
}) {
  const components = selectedRuntimeComponents(selection);
  const statePath = join(authority.producerStackBaseDir, 'stack.runtime.json');
  const recordStatus = (phase, error = null, artifacts = {}) => recordStackRuntimeUpdate(statePath, {
    runtimePublication: { components: Object.fromEntries(components.map(component => [
      component, { phase, error, ...(artifacts[component] ? { stalePackages: artifacts[component].manifest?.stalePackages ?? [] } : {}) },
    ])) },
  });
  await recordStatus('publishing');
  try {
    const result = await admitExecution({ selection, run: execution => publish({
      selection, execution, selectConsumer,
      withPublication: commit => withRuntimePublicationAdmission({ authority, env, publish: commit }),
    }) });
    for (const component of components) {
      if (!result?.artifacts?.[component]?.manifest?.artifactFingerprint) {
        throw new Error(`[build] requested ${component} build returned no artifact identity.`);
      }
    }
    await recordStatus(result.snapshotId ? 'current' : 'stale', null, result.artifacts);
    return selectConsumer ? await selectRuntimePublicationForConsumer({ result, authority, selection, target, env }) : result;
  } catch (error) {
    await recordStatus('failed', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function selectRuntimePublicationForConsumer({ result, authority, selection, target, env }) {
  const consumerResult = {
    ...result,
    ok: true,
    stackName: authority.consumerStackName,
    consumerStackName: authority.consumerStackName,
    consumerStackBaseDir: authority.consumerStackBaseDir,
    producerStackName: authority.producerStackName,
    producerStackBaseDir: authority.producerStackBaseDir,
    stackBaseDir: authority.producerStackBaseDir,
    selected: false,
    runtime: null,
  };
  if (!selection.activateRuntime) return consumerResult;
  const selectedRuntime = await withWorkspaceBundleLock(() => selectRuntimeSnapshot({
    consumerStackBaseDir: authority.consumerStackBaseDir,
    producerStackBaseDir: authority.producerStackBaseDir,
    producerStackName: authority.producerStackName,
    snapshotId: result.snapshotId,
    target,
    requiredComponents: resolveRuntimePublicationRequiredComponents({ target, requestedComponents: selectedRuntimeComponents(selection), selection }),
  }), runtimeBuildLockOptions({ runtimePaths: resolveStackRuntimePaths({ stackBaseDir: authority.producerStackBaseDir }), env }));
  const { envPath } = resolveStackEnvPath(assertNamedStack(env), env);
  await ensureStackRuntimeModePrefer({ envPath });
  return {
    ...consumerResult,
    selected: true,
    runtime: composeRuntimePublicationResult({
      consumerStackName: authority.consumerStackName,
      producerStackName: authority.producerStackName,
      published: result,
      selectedRuntime,
    }),
  };
}


export async function buildRuntimeArtifactComponents({
  rootDir,
  stackBaseDir,
  selection,
  target = { platform: process.platform, arch: process.arch },
  env = process.env,
  retentionPolicy = resolveRuntimeRetentionPolicy({ env }),
  assertSelectedBuildPrerequisitesImpl = assertSelectedBuildPrerequisites,
  collectBuildSourceMetadataImpl = collectBuildSourceMetadata,
  resolveRuntimeBuildRequestIdentityImpl = resolveRuntimeBuildRequestIdentity,
  buildSelectedStackArtifactsImpl = buildSelectedStackArtifacts,
  prepareBundledPluginPublicationInputsImpl = prepareBundledPluginPublicationInputs,
}) {
  env = { ...env, [WORKSPACE_BUILD_MODE_ENV]: 'qa-runtime' };
  assertSelectedBuildPrerequisitesImpl({ selection, env });
  let initialSourceMetadata = await collectBuildSourceMetadataImpl({ rootDir, env });
  let buildRequest = await resolveRuntimeBuildRequestIdentityImpl({
    rootDir,
    producerStackBaseDir: stackBaseDir,
    selection,
    target,
    sourceMetadata: initialSourceMetadata,
    env,
  });
  const missingComponents = [];
  for (const component of selectedRuntimeComponents(selection)) {
    const artifactFingerprint = buildRequest.artifactFingerprints?.[component];
    const existing = artifactFingerprint && !selection.forceRebuild
      ? await readReusableArtifactManifest({
          artifactDir: resolveStackComponentArtifactDir({ stackBaseDir, component, fingerprint: artifactFingerprint }),
          artifactFingerprint,
        })
      : null;
    if (!existing || existing.component !== component) missingComponents.push(component);
  }
  if (missingComponents.includes('web') || missingComponents.includes('daemon')) {
    // A projection write for one component can change another selected
    // component's generated inputs. Keep the canonical selected preparation
    // closure on misses instead of granting this probe a second closure policy.
    await prepareBundledPluginPublicationInputsImpl({ rootDir, selection, env });
    // Preparation owns generated compiler/projection inputs. On a miss derive
    // the final identity again after those writes; the first identity is only
    // an admission probe and must never label bytes built after preparation.
    initialSourceMetadata = await collectBuildSourceMetadataImpl({ rootDir, env });
    buildRequest = await resolveRuntimeBuildRequestIdentityImpl({
      rootDir, producerStackBaseDir: stackBaseDir, selection, target, sourceMetadata: initialSourceMetadata, env,
    });
  }
  const sourceMetadata = buildRequest.sourceMetadata;
  const buildComponent = async (component, builder, builderOptions = {}) => {
    const artifactFingerprint = String(buildRequest.artifactFingerprints?.[component] ?? '').trim();
    if (!artifactFingerprint) {
      throw new Error(`[build] missing ${component} artifact identity for the selected build.`);
    }
    const artifactDir = resolveStackComponentArtifactDir({ stackBaseDir, component, fingerprint: artifactFingerprint });
    const artifact = await builder({
      rootDir,
      stackBaseDir,
      artifactDir,
      artifactFingerprint,
      sourceMetadata,
      target,
      forceRebuild: selection.forceRebuild,
      env,
      ...(buildRequest.supportArtifactFingerprints?.[component]
        ? { supportArtifactFingerprint: buildRequest.supportArtifactFingerprints[component] }
        : {}),
      ...builderOptions,
    });
    return artifact;
  };

  const artifacts = await buildSelectedStackArtifactsImpl({ selection, buildComponent });
  return { artifacts, buildRequest, sourceMetadata };
}

// Imported and locally constructed payloads use the same producer retention
// graph, including references held by other named consumer stacks.
export async function retainBuiltRuntimeArtifacts({ stackBaseDir, artifacts, target, env, retentionPolicy, unusedArtifactProcRoot, pruneComponentArtifactsImpl = pruneComponentArtifacts }) {
  for (const [component, artifact] of Object.entries(artifacts)) {
    const support = readComponentArtifactSupportReference(artifact?.manifest);
    for (const retainedComponent of [component, ...(support ? [support.supportComponent] : [])]) {
      await pruneComponentArtifactsImpl({
        stackBaseDir, component: retainedComponent,
        keepCount: retentionPolicy.artifactKeepCount,
        runtimeSnapshotKeepCount: retentionPolicy.runtimeSnapshotKeepCount,
        externalReferenceStorageRoot: getStacksStorageRoot(env),
        ...(unusedArtifactProcRoot ? { unusedArtifactProcRoot } : {}),
      });
    }
  }
}


export async function publishBuiltRepositoryRuntimeSnapshot({
  authority,
  selection,
  requestedComponents,
  sourceMetadata,
  artifacts,
  target = { platform: process.platform, arch: process.arch },
  env,
  retentionPolicy,
  withWorkspaceBundleLockImpl = withWorkspaceBundleLock,
  inspectActiveRuntimeSnapshotImpl = inspectLatestPublishedRuntimeSnapshot,
  publishRuntimeSnapshotImpl = publishRuntimeSnapshot,
  selectRuntimeSnapshotImpl = selectRuntimeSnapshot,
  pruneRuntimeSnapshotsImpl = pruneRuntimeSnapshots,
}) {
  const stackBaseDir = authority.producerStackBaseDir;
  const runtimePaths = resolveStackRuntimePaths({ stackBaseDir });
  const requiredComponents = resolveRuntimePublicationRequiredComponents({ target, requestedComponents, selection });
  const publication = await withWorkspaceBundleLockImpl(async () => {
    const currentInspection = await inspectActiveRuntimeSnapshotImpl({ stackBaseDir, target,
      requiredComponents: requiredComponents.filter(component => !artifacts[component]) });
    const componentFingerprints = snapshotArtifactFingerprints({ artifacts, currentInspection, requiredComponents });
    const snapshotId = createRuntimeSnapshotId({ sourceMetadata, componentFingerprints, ...target });
    const published = await publishRuntimeSnapshotImpl({
      producerStackBaseDir: stackBaseDir,
      snapshotId,
      sourceMetadata,
      artifacts,
      requiredComponents,
      ...target,
      runtimeSnapshotKeepCount: retentionPolicy.runtimeSnapshotKeepCount,
      externalReferenceStorageRoot: getStacksStorageRoot(env),
      pruneAfterPublish: false,
    });
    if (selection?.activateRuntime === true && target.platform === process.platform && target.arch === process.arch
      && RUNTIME_COMPONENTS.every(component => componentFingerprints[component])) await selectRuntimeSnapshotImpl({
      consumerStackBaseDir: stackBaseDir,
      producerStackBaseDir: stackBaseDir,
      producerStackName: authority.producerStackName,
      snapshotId: published.snapshotId,
      target,
    });
    return {
      currentSnapshotId: currentInspection.valid ? currentInspection.snapshot?.snapshotId ?? null : null,
      published,
    };
  }, runtimeBuildLockOptions({ runtimePaths, env }));

  const snapshotId = publication?.published?.snapshotId ?? null;
  const snapshotPath = publication?.published?.snapshotPath ?? null;
  const previousSnapshotId = publication?.currentSnapshotId ?? null;
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
    reused: publication?.published?.reused ?? false,
    selected: false,
    runtime: null,
  };
}


export async function buildStackArtifacts({ rootDir, argv = [], env = process.env, authority = null, runtimeBuildTransport }) {
  const selection = parseBuildSelection({ argv });
  const resolvedAuthority = authority ?? resolveRuntimeBuildAuthority({
    rootDir, consumerStackName: assertNamedStack(env), env,
  });
  const { flags } = parseArgs(argv);
  if (flags.has('--tauri')) {
    throw new Error('[build] tauri artifact builds are not supported in named-stack runtime snapshots.');
  }
  const { loadDevTargetsConfig, resolveDevTargetExecutionPolicy } = await import('../utils/dev_targets/config.mjs');
  const { resolveDevTargetServicePlans } = await import('../utils/dev_targets/service_placement.mjs');
  const { config } = await loadDevTargetsConfig({ path: join(resolvedAuthority.consumerStackBaseDir, 'dev-targets.json'), env,
    ...(resolvedAuthority.consumerStackBaseDir !== resolvedAuthority.producerStackBaseDir
      ? { buildPlacementOwnerPath: join(resolvedAuthority.producerStackBaseDir, 'dev-targets.json') } : {}),
  });
  const servicePlans = resolveDevTargetServicePlans({ targets: config.targets,
    policy: resolveDevTargetExecutionPolicy(config),
    requested: { server: selection.components.server, daemon: selection.components.daemon, expo: false },
  });
  const placedTargets = servicePlans.targets.filter(plan => plan.services.server || plan.services.daemon).map(plan => plan.target);
  const observedTargets = placedTargets.length
    ? (await (await import('../utils/dev_targets/doctor.mjs')).runDevTargetsDoctor({ targets: placedTargets, env })).targets
    : [];
  const { groups, componentTargets } = resolveRuntimeBuildTargetGroups({ argv, selection, config, observedTargets });
  const { withAdmittedRuntimeBuildPlacement } = await import('./remote_runtime_build.mjs');
  const targetResults = await Promise.all(groups.map(async ({ target, selection: groupSelection }) => ({ target,
    ...await withRuntimeBuildPublication({
      authority: resolvedAuthority, selection: groupSelection, target, env, selectConsumer: true,
      admitExecution: request => withAdmittedRuntimeBuildPlacement({ rootDir, stackBaseDir: resolvedAuthority.producerStackBaseDir, target, env, transport: runtimeBuildTransport, ...request }),
      publish: ({ selection, withPublication, execution }) => buildRuntimePublication({ rootDir, selection, target, env, authority: resolvedAuthority, withPublication, execution }),
    }),
  })));
  if (targetResults.length === 1) {
    const { target, ...result } = targetResults[0];
    return { ...result, componentTargets };
  }
  const primary = targetResults.find(result => result.target.platform === process.platform && result.target.arch === process.arch) ?? targetResults[0];
  return { ...primary,
    components: selectedRuntimeComponents(selection), requestedComponents: selectedRuntimeComponents(selection),
    artifacts: Object.assign({}, ...targetResults.filter(result => result !== primary).map(result => result.artifacts), primary.artifacts),
    componentTargets, targetResults,
  };
}

async function buildRuntimePublication({
  rootDir, selection, target, env, authority,
  withPublication, execution,
  publishBuiltRepositoryRuntimeSnapshotImpl = publishBuiltRepositoryRuntimeSnapshot,
}) {
  const retentionPolicy = resolveRuntimeRetentionPolicy({ env });
  const { sourceMetadata, buildPlacement, publishArtifacts } = await execution.buildComponents({
    rootDir,
    stackBaseDir: authority.producerStackBaseDir,
    selection,
    target,
    env,
    retentionPolicy,
  });
  // Publication advances the producer for every successful component build.
  // activateRuntime controls only whether this consumer adopts the result.
  const { artifacts, publication } = await withPublication(async () => {
    const artifacts = await publishArtifacts();
    const publication = await publishBuiltRepositoryRuntimeSnapshotImpl({
      authority,
      selection,
      requestedComponents: selectedRuntimeComponents(selection),
      sourceMetadata,
      artifacts,
      target,
      env,
      retentionPolicy,
    });
    await retainBuiltRuntimeArtifacts({
      stackBaseDir: authority.producerStackBaseDir, artifacts, target, env, retentionPolicy,
    });
    return { artifacts, publication };
  });
  return {
    ok: true,
    ...publication,
    producerStackName: authority.producerStackName,
    producerStackBaseDir: authority.producerStackBaseDir,
    source: sourceMetadata,
    artifacts: serializeArtifacts(artifacts),
    ...(buildPlacement ? { buildPlacement } : {}),
  };
}
