import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { readdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { getRepoDir, resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { parseArgs } from '../utils/cli/args.mjs';
import {
  resolveStackComponentArtifactDir,
  resolveStackRuntimePaths,
  validateRuntimeArtifactFingerprint,
  validateRuntimeSnapshotId,
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
import { parseBuildSelection, parseRuntimeBuildTarget } from './build_targets.mjs';
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
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import * as componentArtifacts from '@happier-dev/cli-common/componentArtifacts';
import { createWorkspaceBuildWaitNotifier } from '../utils/proc/workspaceBuildWaitNotifier.mjs';
import { isPidAlive } from '../utils/proc/pids.mjs';
import { readRuntimeManifest, RUNTIME_SNAPSHOT_COMPONENTS, validateRuntimeManifest, validateRuntimeTarget } from '../runtime/shared/runtime_manifest.mjs';
import { readJsonIfExists, writeJsonAtomic } from '../utils/fs/json.mjs';
import { WORKSPACE_BUILD_MODE_ENV } from '../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';

export { assertSelectedBuildPrerequisites, collectRuntimeBuildToolchainInputs } from './runtime_artifact_identity.mjs';

export async function prepareBundledPluginPublicationInputs({
  rootDir,
  selection,
  env,
  runCanonicalBundledPluginArtifactPublisherImpl,
  syncDaemonRuntimeDependenciesImpl,
  generateBundledPluginUiArtifactsImpl,
}) {
  // Server code and support are independent of the bundled CLI/UI artifacts.
  if (selection?.components
    && selection.components.web !== true
    && selection.components.daemon !== true) return;
  const publish = runCanonicalBundledPluginArtifactPublisherImpl
    ?? (await import('../../../cli/scripts/buildSharedDeps.mjs')).runCanonicalBundledPluginArtifactPublisher;
  const generateUiArtifacts = generateBundledPluginUiArtifactsImpl
    ?? (await import('../../../ui/scripts/generateBundledPluginUiArtifacts.mjs')).generateBundledPluginUiArtifacts;
  const repoRoot = getRepoDir(rootDir, env);
  if (selection?.components?.daemon === true) {
    const syncDaemonRuntimeDependencies = syncDaemonRuntimeDependenciesImpl
      ?? (await import('../../../cli/scripts/buildSharedDeps.mjs')).main;
    await syncDaemonRuntimeDependencies({
      repoRoot,
      env,
      quiet: true,
      progress: true,
      mode: 'runtime',
      publicationMode: 'live',
      onWait: createWorkspaceBuildWaitNotifier({ env, label: 'daemon runtime dependency publication', kind: 'lock' }),
    });
  } else {
    await publish({
      repoRoot,
      env,
      quiet: true,
      progress: true,
      mode: 'write',
      publicationMode: 'live',
    });
  }
  const uiArtifacts = await generateUiArtifacts({ repoRoot, mode: 'write' });
  if ((uiArtifacts?.pluginFailures?.length ?? 0) > 0) {
    await publish({
      repoRoot,
      env,
      quiet: true,
      progress: true,
      mode: 'write',
      publicationMode: 'live',
      pluginFailures: uiArtifacts.pluginFailures,
    });
  }
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

export function resolveRuntimePublicationRequiredComponents({ target, requestedComponents }) {
  return target.platform === process.platform && target.arch === process.arch
    ? RUNTIME_SNAPSHOT_COMPONENTS : normalizeRequestedRuntimeComponents(requestedComponents);
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

function isStartedSeq(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Capture demand before asynchronous dispatch. An unavailable observation cannot join. */
export function captureRuntimePublicationStartedSeq({ authority }) {
  const { runtimeDir } = resolveStackRuntimePaths({ stackBaseDir: authority.producerStackBaseDir });
  try {
    const record = JSON.parse(readFileSync(join(runtimeDir, 'publication-started.json'), 'utf8'));
    return isStartedSeq(record?.startedSeq) ? record.startedSeq : null;
  } catch {
    return null;
  }
}

/** All producer publication and retention writers share this admission boundary. */
export async function withRuntimePublicationAdmission({
  authority, env = process.env, publish, withWorkspaceBundleLockImpl = withWorkspaceBundleLock,
}) {
  const { runtimeDir } = resolveStackRuntimePaths({ stackBaseDir: authority.producerStackBaseDir });
  return await withWorkspaceBundleLockImpl(publish, {
    lockPath: join(runtimeDir, 'publication.lock'),
    errorLabel: 'runtime publication flight lock',
    timeoutMs: Number(env.HAPPIER_STACK_RUNTIME_BUILD_LOCK_TIMEOUT_MS) || undefined,
    onWait: createWorkspaceBuildWaitNotifier({ env, label: 'runtime publication flight', kind: 'lock' }),
  });
}

function runtimePublicationDemandSatisfied({ demand, successes, currentStartedSeq }) {
  if (!isStartedSeq(currentStartedSeq) || !demand.components?.length) return false;
  const observed = demand.observedStartedSeq;
  // A missing initial counter cannot reuse old success. A merged flight can
  // still explicitly acknowledge that it built this registered request.
  const fulfilled = !isStartedSeq(observed) && isStartedSeq(demand.fulfilledSeq) ? demand.fulfilledSeq : null;
  return demand.components.every(component => {
    const seq = successes?.[component]?.seq;
    return isStartedSeq(seq) && seq <= currentStartedSeq
      && (isStartedSeq(observed) ? seq > observed : fulfilled !== null && seq >= fulfilled);
  });
}

async function readLiveRuntimePublicationDemands(demandDir) {
  const entries = await readdir(demandDir);
  const demands = [];
  const processFingerprints = new Map();
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const path = join(demandDir, entry);
    const demand = await readJsonIfExists(path);
    if (!demand) continue;
    const alive = isPidAlive(demand.pid);
    const expectedFingerprint = String(demand.processInstanceFingerprint ?? '').trim();
    if (alive && expectedFingerprint && !processFingerprints.has(demand.pid)) {
      processFingerprints.set(demand.pid, readProcessInstanceFingerprintSync(demand.pid));
    }
    const observedFingerprint = processFingerprints.get(demand.pid);
    if (!alive || (expectedFingerprint && observedFingerprint && expectedFingerprint !== observedFingerprint)) {
      await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
      continue;
    }
    demands.push({ path, demand });
  }
  return demands;
}

async function readSuccessfulRuntimePublicationArtifact({ authority, component, success, target }) {
  const fingerprint = validateRuntimeArtifactFingerprint(success?.artifactFingerprint);
  if (!fingerprint.ok) return null;
  const artifactDir = resolveStackComponentArtifactDir({
    stackBaseDir: authority.producerStackBaseDir, component, fingerprint: fingerprint.artifactFingerprint,
  });
  const manifest = await readReusableArtifactManifest({ artifactDir, artifactFingerprint: fingerprint.artifactFingerprint });
  return manifest && manifest.component === component && validateRuntimeTarget(manifest, target).ok
    ? { artifactDir, manifest } : null;
}

/** One producer admission covers preparation, identity resolution and publication.
 * The short snapshot commit lock remains separate for pointer writers/readers.
 * Only a successful flight started after the request can satisfy that demand.
 */
export async function withRuntimePublicationFlight({
  authority,
  selection,
  target = { platform: process.platform, arch: process.arch },
  observedStartedSeq = captureRuntimePublicationStartedSeq({ authority }),
  env = process.env,
  publish,
  selectConsumer = false,
}) {
  const components = selectedRuntimeComponents(selection);
  const { runtimeDir } = resolveStackRuntimePaths({ stackBaseDir: authority.producerStackBaseDir });
  const resultPath = join(runtimeDir, 'publication-success.json');
  const targetKey = `${target.platform}/${target.arch}`;
  const demandDir = join(runtimeDir, 'publication-demands');
  const demandPath = join(demandDir, `${randomUUID()}.json`);
  const demand = { pid: process.pid, processInstanceFingerprint: readProcessInstanceFingerprintSync(process.pid),
    target, components, observedStartedSeq,
    activateRuntime: selection.activateRuntime === true, selectConsumer, forceRebuild: selection.forceRebuild === true };
  const statePath = join(authority.producerStackBaseDir, 'stack.runtime.json');
  const recordStatus = async (phase, error = null, statusComponents = components, artifacts = {}) => recordStackRuntimeUpdate(statePath, {
    runtimePublication: {
      components: Object.fromEntries(statusComponents.map(component => {
        const stalePackages = artifacts[component]?.manifest?.stalePackages ?? [];
        return [component, { phase: phase === 'current' && stalePackages.length ? 'stale' : phase, error,
          ...(artifacts[component] ? { stalePackages } : {}) }];
      })),
    },
  });
  const finish = async (result) => {
    const stalePackages = [...new Map(Object.values(result.artifacts ?? {}).flatMap(value => value.manifest?.stalePackages ?? [])
      .map(value => [value.packageName, value])).values()];
    if (stalePackages.length) {
      result = { ...result, stalePackages };
      process.stderr.write(`[build] publicationFlight=${result.publicationFlight}: QA degradation for ${stalePackages.map(value => value.packageName).join(', ')}\n`);
    }
    return selectConsumer ? await selectRuntimePublicationForConsumer({ result, authority, selection, target, env }) : result;
  };
  await writeJsonAtomic(demandPath, demand);
  try {
    return await withRuntimePublicationAdmission({ authority, env, publish: async ({ assertOwned }) => {
      const previous = await readJsonIfExists(resultPath);
      const currentStartedSeq = captureRuntimePublicationStartedSeq({ authority });
      const successes = previous?.targets?.[targetKey]?.components ?? {};
      const liveDemands = await readLiveRuntimePublicationDemands(demandDir);
      const ownDemand = liveDemands.find(entry => entry.path === demandPath)?.demand ?? demand;
      if (runtimePublicationDemandSatisfied({ demand: ownDemand, successes, currentStartedSeq })) {
        const artifacts = {};
        for (const component of components) {
          const artifact = await readSuccessfulRuntimePublicationArtifact({ authority, component, success: successes[component], target });
          if (artifact) artifacts[component] = artifact;
        }
        let snapshotId = null;
        let paths = null;
        let snapshot = null;
        const orderedSuccesses = Object.values(successes).filter(value => isStartedSeq(value?.seq))
          .sort((left, right) => right.seq - left.seq);
        for (const success of orderedSuccesses) {
          const candidateId = validateRuntimeSnapshotId(success.snapshotId, { allowEmpty: true });
          if (!candidateId.ok || !candidateId.snapshotId) continue;
          const candidatePaths = resolveStackRuntimePaths({ stackBaseDir: authority.producerStackBaseDir, snapshotId: candidateId.snapshotId });
          const candidate = validateRuntimeManifest(await readRuntimeManifest({ manifestPath: candidatePaths.manifestPath }), {
            requiredComponents: resolveRuntimePublicationRequiredComponents({ target, requestedComponents: components }),
          });
          if (candidate.ok && validateRuntimeTarget(candidate.manifest, target).ok && candidate.manifest.snapshotId === candidateId.snapshotId
            && components.every(component => artifacts[component]
              && candidate.manifest.components[component]?.artifactFingerprint === artifacts[component].manifest.artifactFingerprint)) {
            snapshotId = candidateId.snapshotId;
            paths = candidatePaths;
            snapshot = candidate;
            break;
          }
        }
        if (components.every(component => artifacts[component])) {
          // Reuse a retained snapshot that contains the exact successful vector.
          // When separate completions have no shared snapshot, compose their valid
          // artifacts through the canonical publisher without rebuilding them.
          const promoting = !snapshot && (selection.activateRuntime || selectConsumer || orderedSuccesses.some(success => success.snapshotId));
          if (promoting) {
            for (const component of normalizeRequestedRuntimeComponents(Object.keys(successes))) {
              if (artifacts[component]) continue;
              const artifact = await readSuccessfulRuntimePublicationArtifact({ authority, component, success: successes[component], target });
              if (artifact) artifacts[component] = artifact;
            }
          }
          const coveredComponents = normalizeRequestedRuntimeComponents(Object.keys(artifacts));
          const sourceMetadata = snapshot?.manifest?.source ?? artifacts[components[0]].manifest.source ?? null;
          let publication = {};
          if (promoting) {
            await recordStatus('publishing', null, coveredComponents);
            try {
              publication = await publishBuiltRepositoryRuntimeSnapshot({
                authority, selection, target, requestedComponents: components, sourceMetadata, artifacts, env,
                retentionPolicy: resolveRuntimeRetentionPolicy({ env }),
              });
              await recordStatus('current', null, coveredComponents, artifacts);
              assertOwned();
              await writeJsonAtomic(resultPath, { ...previous, targets: { ...previous.targets,
                [targetKey]: { components: Object.fromEntries(Object.entries(successes).map(([component, success]) => [
                  component, artifacts[component] ? { ...success, snapshotId: publication.snapshotId } : success,
                ])) },
              } });
            } catch (error) {
              await recordStatus('failed', error instanceof Error ? error.message : String(error), coveredComponents);
              throw error;
            }
          }
          return await finish({
            ok: true,
            requestedComponents: components,
            components,
            producerStackName: authority.producerStackName,
            producerStackBaseDir: authority.producerStackBaseDir,
            artifacts: Object.fromEntries(components.map(component => [component, artifacts[component]])),
            source: sourceMetadata,
            snapshotId,
            snapshotPath: paths?.snapshotDir || null,
            changed: false,
            ...publication,
            reused: true,
            selected: false,
            runtime: null,
            publicationFlight: 'joined',
          });
        }
      }

      const pendingDemands = liveDemands.filter(({ demand: waiting }) =>
        waiting.target?.platform === target.platform && waiting.target?.arch === target.arch
        && !runtimePublicationDemandSatisfied({ demand: waiting, successes, currentStartedSeq }));
      const mergedComponents = normalizeRequestedRuntimeComponents([
        ...components, ...pendingDemands.flatMap(({ demand: waiting }) => waiting.components ?? []),
      ]);
      const mergedSelection = { ...selection,
        components: { ...selection.components, ...Object.fromEntries(mergedComponents.map(component => [component, true])) },
        activateRuntime: selection.activateRuntime === true || pendingDemands.some(({ demand: waiting }) => waiting.activateRuntime),
        forceRebuild: selection.forceRebuild === true || pendingDemands.some(({ demand: waiting }) => waiting.forceRebuild),
      };

      // Failed flights still advance admission order, but never replace success.
      const seq = Math.max(currentStartedSeq ?? 0, isStartedSeq(previous?.seq) ? previous.seq : 0) + 1;
      if (!isStartedSeq(seq)) throw new Error('[build] runtime publication sequence is not representable.');
      assertOwned();
      await writeJsonAtomic(join(runtimeDir, 'publication-started.json'), { startedSeq: seq });
      await recordStatus('publishing', null, mergedComponents);
      process.stderr.write(`[build] ${authority.producerStackName}: preparing ${mergedComponents.join(', ')} runtime artifacts.\n`);
      let result;
      try {
        result = await publish({ selection: mergedSelection,
          selectConsumer: selectConsumer || pendingDemands.some(({ demand: waiting }) => waiting.selectConsumer) });
        for (const component of mergedComponents) {
          if (!result?.artifacts?.[component]?.manifest?.artifactFingerprint) {
            throw new Error(`[build] requested ${component} build returned no artifact identity.`);
          }
        }
        await recordStatus(result.snapshotId ? 'current' : 'stale', null, mergedComponents, result.artifacts);
        assertOwned();
        // Readers also hold this flight lock; no second record transaction is needed.
        await writeJsonAtomic(resultPath, {
          seq,
          targets: { ...previous?.targets, [targetKey]: { components: { ...successes,
            ...Object.fromEntries(mergedComponents.map(component => [component, {
              seq, artifactFingerprint: result.artifacts[component].manifest.artifactFingerprint,
              snapshotId: result.snapshotId ?? null,
            }])),
          } } },
        });
        for (const { path, demand: waiting } of pendingDemands) {
          if (!isStartedSeq(waiting.observedStartedSeq)) await writeJsonAtomic(path, { ...waiting, fulfilledSeq: seq });
        }
      } catch (error) {
        await recordStatus('failed', error instanceof Error ? error.message : String(error), mergedComponents);
        throw error;
      }
      // Selection installs the consumer's retention reference before admission
      // releases any publisher/pruner. A selection error does not fail publication.
      return await finish({ ...result, publicationFlight: 'built' });
    } });
  } finally {
    await unlink(demandPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
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
    requiredComponents: resolveRuntimePublicationRequiredComponents({ target, requestedComponents: selectedRuntimeComponents(selection) }),
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
  readCliBinaryArtifactWorkspacePublicationImpl = componentArtifacts.readCliBinaryArtifactWorkspacePublication,
  prepareBundledPluginPublicationInputsImpl = prepareBundledPluginPublicationInputs,
  pruneComponentArtifactsImpl = pruneComponentArtifacts,
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
    const existing = component === 'daemon'
      ? await readReusableArtifactManifest({ artifactDir, artifactFingerprint })
      : null;
    const preparedWorkspacePublication = component === 'daemon' && !existing
      ? await readCliBinaryArtifactWorkspacePublicationImpl({ repoRoot: sourceMetadata.repoDir })
      : null;
    const artifact = await builder({
      rootDir,
      stackBaseDir,
      artifactDir,
      artifactFingerprint,
      sourceMetadata,
      target,
      stalePackages: buildRequest.stalePackagesByComponent?.[component] ?? [],
      forceRebuild: selection.forceRebuild,
      env,
      ...(buildRequest.supportArtifactFingerprints?.[component]
        ? { supportArtifactFingerprint: buildRequest.supportArtifactFingerprints[component] }
        : {}),
      ...(component === 'daemon' && buildRequest.componentSourceFingerprints?.daemon
        ? { requiredCliDistInputFingerprint: buildRequest.componentSourceFingerprints.daemon }
        : {}),
      ...(component === 'daemon' && buildRequest.daemonWorkspaceSourceFingerprint
        ? { workspaceSourceFingerprint: buildRequest.daemonWorkspaceSourceFingerprint }
        : {}),
      ...builderOptions,
      ...(component === 'daemon' && preparedWorkspacePublication ? { preparedWorkspacePublication } : {}),
    });
    await retainBuiltRuntimeArtifacts({ stackBaseDir, artifacts: { [component]: artifact }, env, retentionPolicy, pruneComponentArtifactsImpl });
    return artifact;
  };

  const artifacts = await buildSelectedStackArtifactsImpl({ selection, buildComponent });
  return { artifacts, buildRequest, sourceMetadata };
}

// Imported and locally constructed payloads use the same producer retention
// graph, including references held by other named consumer stacks.
export async function retainBuiltRuntimeArtifacts({ stackBaseDir, artifacts, env, retentionPolicy, pruneComponentArtifactsImpl = pruneComponentArtifacts }) {
  for (const [component, artifact] of Object.entries(artifacts)) {
    const support = readComponentArtifactSupportReference(artifact?.manifest);
    for (const retainedComponent of [component, ...(support ? [support.supportComponent] : [])]) {
      await pruneComponentArtifactsImpl({
        stackBaseDir, component: retainedComponent,
        keepCount: retentionPolicy.artifactKeepCount,
        runtimeSnapshotKeepCount: retentionPolicy.runtimeSnapshotKeepCount,
        externalReferenceStorageRoot: getStacksStorageRoot(env),
      });
    }
  }
}

/**
 * Project caller demand and the current snapshot. Input preparation and
 * currentness decisions are performed only inside the publication flight.
 */
export async function resolveRepositoryRuntimePublicationComponents({
  authority,
  requestedComponents,
  target = { platform: process.platform, arch: process.arch },
  inspectActiveRuntimeSnapshotImpl = inspectLatestPublishedRuntimeSnapshot,
}) {
  const components = normalizeRequestedRuntimeComponents(requestedComponents);
  const inspection = await inspectActiveRuntimeSnapshotImpl({
    stackBaseDir: authority.producerStackBaseDir,
    target,
    requiredComponents: resolveRuntimePublicationRequiredComponents({ target, requestedComponents: components }),
  });
  const currentSnapshotId = inspection.valid ? inspection.snapshot?.snapshotId ?? null : null;
  if (components.length === 0) return { components, currentSnapshotId };

  // This caller-side projection must not prepare or decide input currentness.
  // The admitted publisher resolves identities and each artifact owner reuses
  // unchanged bytes under the producer flight.
  return {
    components,
    currentSnapshotId,
  };
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
  const requiredComponents = resolveRuntimePublicationRequiredComponents({ target, requestedComponents });
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
    if (target.platform === process.platform && target.arch === process.arch) await selectRuntimeSnapshotImpl({
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

/**
 * Canonical repository-authority publisher for source development. It advances
 * only the producer pointer; consumer selection remains an explicit caller
 * action. Empty requests are a cheap current-snapshot reconciliation.
 */
export async function publishRepositoryRuntimeSnapshot({
  rootDir,
  authority,
  requestedComponents,
  target = { platform: process.platform, arch: process.arch },
  env = process.env,
  observedStartedSeq = captureRuntimePublicationStartedSeq({ authority }),
  buildRuntimeArtifactComponentsImpl = buildRuntimeArtifactComponents,
  inspectActiveRuntimeSnapshotImpl = inspectLatestPublishedRuntimeSnapshot,
  publishBuiltRepositoryRuntimeSnapshotImpl = publishBuiltRepositoryRuntimeSnapshot,
}) {
  const components = normalizeRequestedRuntimeComponents(requestedComponents);
  const currentInspection = await inspectActiveRuntimeSnapshotImpl({
    stackBaseDir: authority.producerStackBaseDir,
    target,
  });
  if (components.length === 0) {
    return noOpRepositoryPublicationResult({
      authority,
      currentInspection,
      requestedComponents: components,
    });
  }

  const selection = createRuntimePublicationSelection(components);
  return await withRuntimePublicationFlight({
    authority, selection, target, observedStartedSeq, env,
    publish: ({ selection }) => buildRuntimePublication({
      rootDir, authority, selection, target, env,
      buildRuntimeArtifactComponentsImpl,
      publishBuiltRepositoryRuntimeSnapshotImpl,
    }),
  });
}

export async function buildStackArtifacts({ rootDir, argv = [], env = process.env, authority = null, observedStartedSeq }) {
  const selection = parseBuildSelection({ argv });
  const target = parseRuntimeBuildTarget({ argv });
  const resolvedAuthority = authority ?? resolveRuntimeBuildAuthority({
    rootDir, consumerStackName: assertNamedStack(env), env,
  });
  const observation = observedStartedSeq === undefined
    ? captureRuntimePublicationStartedSeq({ authority: resolvedAuthority }) : observedStartedSeq;
  const { flags } = parseArgs(argv);
  if (flags.has('--tauri')) {
    throw new Error('[build] tauri artifact builds are not supported in named-stack runtime snapshots.');
  }
  return await withRuntimePublicationFlight({
    authority: resolvedAuthority, selection, target, observedStartedSeq: observation, env, selectConsumer: true,
    publish: ({ selection }) => buildRuntimePublication({ rootDir, selection, target, env, authority: resolvedAuthority }),
  });
}

async function buildRuntimePublication({
  rootDir, selection, target, env, authority,
  buildRuntimeArtifactComponentsImpl = buildRuntimeArtifactComponents,
  publishBuiltRepositoryRuntimeSnapshotImpl = publishBuiltRepositoryRuntimeSnapshot,
}) {
  const retentionPolicy = resolveRuntimeRetentionPolicy({ env });
  const { buildRuntimeArtifactComponentsAtPlacement } = await import('./remote_runtime_build.mjs');
  const { artifacts, sourceMetadata, buildPlacement } = await buildRuntimeArtifactComponentsAtPlacement({
    rootDir,
    stackBaseDir: authority.producerStackBaseDir,
    selection,
    target,
    env,
    retentionPolicy,
    buildLocal: buildRuntimeArtifactComponentsImpl,
  });
  if (buildPlacement?.mode === 'target') {
    await retainBuiltRuntimeArtifacts({ stackBaseDir: authority.producerStackBaseDir, artifacts, env, retentionPolicy });
  }
  // Publication advances the producer for every successful component build.
  // activateRuntime controls only whether this consumer adopts the result.
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
