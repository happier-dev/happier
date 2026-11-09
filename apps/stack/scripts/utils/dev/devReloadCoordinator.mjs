import { join, relative, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { readSourceComponentBuildInputs } from '../fs/workspaceBuildInputs.mjs';
import { resolveDevReloadPollIntervalMs } from './reloadPollInterval.mjs';
import { inspectDependencyRefresh, resolveDependencyRefreshMarkerPath } from '../proc/dependency_refresh.mjs';
import { ensureDepsInstalled } from '../proc/pm.mjs';
import { diagnoseSourceReloadFailure, emitSourceReloadRefusal, formatSourceReloadRefusal, recordSourceReloadRefusal } from '../../runtime/shared/source_reload_refusal.mjs';

import { watchDebounced } from '../proc/watch.mjs';

export function requestInitialDevRefreshes({
  reloadWatcher,
  dependencyReloadEnabled = false,
  serverReloadEnabled = false,
  daemonReloadEnabled = false,
} = {}) {
  if (!reloadWatcher?.requestReload) return [];
  const pending = [];
  if (dependencyReloadEnabled) pending.push(reloadWatcher.requestReload('dependencies'));
  if (serverReloadEnabled) pending.push(reloadWatcher.requestReload('server'));
  if (daemonReloadEnabled) pending.push(reloadWatcher.requestReload('daemon'));
  return pending;
}
import {
  isDevRuntimeReloadIgnoredPath,
  createWatchSourceObserver,
  readDevReloadWatchChangeSignature,
  readDevReloadWatchChangeSignatureAsync,
} from './watchSignature.mjs';
export { resolveDevReloadPollIntervalMs } from './reloadPollInterval.mjs';
export {
  appendWatchSignatureEntries,
  appendWatchSignatureEntriesAsync,
  isDevRuntimeReloadIgnoredPath,
  readDevReloadWatchChangeSignature,
  readDevReloadWatchChangeSignatureAsync,
} from './watchSignature.mjs';

const RESTART_ORDER = ['dependencies', 'source-runtime', 'server', 'daemon', 'expo'];

export async function createDevDependencyReload({ repoDir, env = process.env }) {
  const { inputPaths } = await inspectDependencyRefresh({ installDir: repoDir, env });
  const paths = [...new Set([...inputPaths, join(repoDir, 'patches')])].filter(path => existsSync(path));
  return {
    descriptor: { id: 'dependencies', target: 'dependencies', paths,
      // Wake for input events, but let the install owner decide what changed.
      // Non-install manifest fields and unregistered patches are source edits.
      invalidatesGeneration: 'signature',
      async readSignatureAsync() {
        return (await inspectDependencyRefresh({ installDir: repoDir, env })).installIdentity;
      },
    },
    executor: {
      target: 'dependencies',
      build: () => ensureDepsInstalled(repoDir, 'development stack', {
        env, quiet: true, prepareComponentOutputs: false,
      }),
    },
  };
}

// Source preparation reports child-build exits or canonical UI admission
// failures. Unknown configuration/OS errors retain their fail-fast behavior.
export function isDevStartupSourceDrift(error, target) {
  if (error?.signal || error?.name === 'AbortError') return false;
  if (error?.trailingPassExhausted) return false;
  // An incomplete installed entry is repaired by the existing dependency
  // completion marker watched by source preparation, even without source edits.
  if (target === 'expo' && error?.code === 'HAPPIER_EXPO_DEPENDENCIES_NOT_READY') return true;
  // Finite producers can compare the actual input bytes. Their negative
  // observation is stronger than a compiler/Metro diagnostic heuristic.
  if (error?.sourceDrift === false) return false;
  if (error?.code === 'HAPPIER_EXPO_CANONICAL_UI_PREFLIGHT_FAILED') {
    return isDevStartupSourceDrift(error.cause, target);
  }
  // Expo's UI preflight wraps its build exits. An unwrapped exit later in
  // Expo startup can be dependency installation or process admission instead.
  // Finite source builders retain this observation from compiler/Metro output.
  // A numeric exit alone also covers admission, dependency and config failures.
  // A missing SHA-1 can follow source churn or incomplete Metro watch roots;
  // the finite producer's explicit observation above takes precedence.
  // A workspace build's child output can report a declared export whose file is still being written.
  if (/EACCES|EPERM|ENOSPC|EADDRINUSE|permission denied/i.test(String(error?.message ?? ''))) return false;
  const sourceDiagnostic = (error?.code === 'EEXIT' || (Number.isInteger(error?.code) && error.code > 0))
    && (/\.go:\d+(?::\d+)?: |SyntaxError:/.test(String(error?.message ?? ''))
      || /Could not resolve ["'](?:\.{1,2}\/|@\/|@happier-dev\/)|Unable to resolve (?:module )?["']?(?:\.{1,2}\/|@\/)|Could not read from file: .*\.[cm]?[jt]sx?|Failed to get the SHA-1 for: .*\.[cm]?[jt]sx?|No matching export in |ERROR: (?:Expected |Unexpected |Unterminated )|error TS(?:1|2|7)\d{3}:|Source runtime (?:requires an explicit source export|workspace owner is missing)|Bundled Plugin UI artifact publication failed for |Staged TypeScript package build is missing declared package export files:/.test(String(error?.message ?? '')));
  return error?.sourceDrift === true || sourceDiagnostic
    // The workspace builder retained its last coherent output after inputs moved.
    || error?.code === 'BUILD_INPUTS_CHANGED'
    || (!error?.code && (
      error instanceof SyntaxError
      || [
        '[ui] patched dependency preflight failed:',
        'UI artifact publication failed for ',
        'Staged TypeScript package build is missing declared package export files:',
        '[local] build completed but expected staged outputs are still missing for ',
      ].some((diagnostic) => String(error?.message ?? '').startsWith(diagnostic))
    ));
}

/** Source preparation and reload observe the same component inputs. */
export async function resolveSourceComponentWatchPaths({ repoDir, target,
  projectDir = join(repoDir, 'apps', target === 'expo' ? 'ui' : target === 'daemon' ? 'cli' : 'server') }) {
  return [...(await readSourceComponentBuildInputs({ repoDir, component: target })).watchPaths,
    resolveDependencyRefreshMarkerPath(repoDir)];
}

export async function prepareSourceComponent({ repoDir, target, prepare, preparation, stackBaseDir, waitForSourceChanges = true,
  signal, env = process.env, logger = console }) {
  const paths = waitForSourceChanges ? await resolveSourceComponentWatchPaths({ repoDir, target }) : [];
  const component = target === 'expo' ? 'ui' : target;
  return await prepareDevComponent({
    enabled: waitForSourceChanges, target, descriptors: [{ id: `source:${target}`, target, paths }],
    async prepare() {
      await preparation?.setPhase({ phase: 'preparing', component });
      try { return await prepare(); }
      catch (error) {
        await diagnoseSourceReloadFailure(error, { component: target, repoDir, env, signal });
        await recordSourceReloadRefusal({ stackBaseDir, error, env });
        if (!signal?.aborted) await preparation?.setPhase({ phase: 'failed', component });
        throw error;
      }
    },
    signal, logger, pollIntervalMs: resolveDevReloadPollIntervalMs(env),
  });
}

export async function prepareDevComponent({
  enabled = false,
  target,
  descriptors,
  prepare,
  signal,
  logger = console,
  debounceMs = 500,
  pollIntervalMs = 0,
} = {}) {
  signal?.throwIfAborted();
  if (!enabled) return await prepare();
  let complete;
  let fail;
  const prepared = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  const coordinator = startDevReloadCoordinator({
    descriptors: descriptors.map((descriptor) => ({ ...descriptor, target })),
    executors: [{
      target,
      async build() {
        try {
          // Preparation may already have admitted a process. Complete here,
          // so a source edit during startup cannot launch that process twice.
          complete(await prepare());
        } catch (error) {
          if (!isDevStartupSourceDrift(error, target)) {
            fail(error);
            return { skipped: true };
          }
          throw error;
        }
      },
    }],
    debounceMs,
    pollIntervalMs,
    isShuttingDown: () => signal?.aborted === true,
    logger,
  });
  if (!coordinator) return await prepare();
  const onAbort = () => fail(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    void coordinator.requestReload(target);
    return await prepared;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await coordinator.close();
  }
}

function normalizeDescriptors(descriptors) {
  const byId = new Map();
  for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
    if (!descriptor?.id || !descriptor?.target) continue;
    const paths = (Array.isArray(descriptor.paths) ? descriptor.paths : []).filter(Boolean);
    const existing = byId.get(descriptor.id);
    if (!existing) {
      byId.set(descriptor.id, {
        ...descriptor,
        paths,
      });
      continue;
    }

    const mergedPaths = Array.from(new Set([...existing.paths, ...paths]));
    byId.set(descriptor.id, {
      ...existing,
      target: existing.target === 'shared' || descriptor.target === 'shared' ? 'shared' : existing.target,
      paths: mergedPaths,
      readSignature: () => readDevReloadWatchChangeSignature(mergedPaths),
      readSignatureAsync: (_descriptor, options) => readDevReloadWatchChangeSignatureAsync(mergedPaths, options),
    });
  }
  return Array.from(byId.values());
}

async function readDescriptorSignaturesAsync(descriptors) {
  // First-party descriptors share the runtime-input traversal policy. This map
  // belongs to one observation, not to the coordinator's lifetime.
  const pathSamples = new Map();
  const pairs = await Promise.all(descriptors.map(async (descriptor) => {
    try {
      const signature = typeof descriptor.readSignatureAsync === 'function'
        ? await descriptor.readSignatureAsync(descriptor, { pathSamples })
        : typeof descriptor.readSignature === 'function'
          ? descriptor.readSignature(descriptor)
          : await readDevReloadWatchChangeSignatureAsync(descriptor.paths, { pathSamples });
      return [descriptor.id, signature ?? null];
    } catch (error) {
      return [descriptor.id, `error:${error instanceof Error ? error.message : String(error)}`];
    }
  }));
  return new Map(pairs);
}

function createSingleFlightSampler(readSample) {
  let inFlight = null;
  return () => {
    if (inFlight) return inFlight;
    const sample = readSample();
    inFlight = sample;
    void sample.then(
      () => {
        if (inFlight === sample) inFlight = null;
      },
      () => {
        if (inFlight === sample) inFlight = null;
      },
    );
    return sample;
  };
}

function serializeDescriptorSignatures(descriptors, signatures) {
  return descriptors.map((descriptor) => `${descriptor.id}\0${signatures.get(descriptor.id) ?? ''}`).join('\n');
}

function serializeGenerationSignatures(descriptors, signatures) {
  return serializeDescriptorSignatures(
    descriptors.filter((descriptor) => descriptor.invalidatesGeneration !== false),
    signatures,
  );
}

function createExecutorMap(executors) {
  const map = new Map();
  for (const executor of Array.isArray(executors) ? executors : []) {
    if (executor?.target && !map.has(executor.target)) {
      map.set(executor.target, executor);
    }
  }
  return map;
}

function descriptorAffectsTarget(descriptor, target) {
  // Metro watches authored workspace sources without replacing its process.
  // Explicit Expo descriptors still participate in cold source preparation.
  return descriptor.target === target || (descriptor.target === 'shared' && target !== 'expo');
}

function createTargetSignatureBaselines({ signatures, descriptors, executorsByTarget }) {
  return new Map(Array.from(executorsByTarget.keys()).map((target) => [
    target,
    new Map(descriptors
      .filter((descriptor) => descriptorAffectsTarget(descriptor, target))
      .map((descriptor) => [descriptor.id, signatures.get(descriptor.id) ?? null])),
  ]));
}

function classifyChangedTargets({ descriptors, previousByTarget, next, executorsByTarget }) {
  const targets = new Set();
  const changedDescriptors = new Set();
  let descriptorEvidenceConclusive = true;
  for (const target of RESTART_ORDER) {
    if (!executorsByTarget.has(target)) continue;
    const previous = previousByTarget.get(target) ?? new Map();
    for (const descriptor of descriptors) {
      if (!descriptorAffectsTarget(descriptor, target)) continue;
      const before = previous.get(descriptor.id) ?? null;
      const after = next.get(descriptor.id) ?? null;
      if (
        typeof before !== 'string'
        || typeof after !== 'string'
        || before.startsWith('error:')
        || after.startsWith('error:')
      ) {
        descriptorEvidenceConclusive = false;
      }
      if (before === after) continue;
      changedDescriptors.add(descriptor.id);
      targets.add(target);
    }
  }
  return {
    targets: RESTART_ORDER.filter((target) => targets.has(target)),
    changedDescriptors: descriptors
      .filter((descriptor) => changedDescriptors.has(descriptor.id))
      .map((descriptor) => descriptor.id),
    descriptorEvidenceConclusive,
  };
}

function formatError(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

export function startDevReloadCoordinator(
  {
    enabled = true,
    descriptors,
    executors,
    debounceMs = 500,
    pollIntervalMs = 0,
    persistent = true,
    observeChanges = true,
    recursive = true,
    indexSources = true,
    ignorePath = isDevRuntimeReloadIgnoredPath,
    isShuttingDown,
    logger = console,
  } = {},
  {
    watchDebouncedImpl = watchDebounced,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = {},
) {
  if (!enabled) return null;

  const executorsByTarget = createExecutorMap(executors);
  const normalizedDescriptors = normalizeDescriptors(descriptors).filter((descriptor) => (
    Array.from(executorsByTarget.keys()).some((target) => descriptorAffectsTarget(descriptor, target))
  ));
  if (!normalizedDescriptors.length || !executorsByTarget.size) return null;

  const watchPaths = Array.from(new Set(
    normalizedDescriptors.flatMap((descriptor) => descriptor.paths).filter(Boolean).map((p) => resolve(p)),
  ));
  if (!watchPaths.length) return null;
  const descriptorIdsByWatchPath = new Map();
  const generationInvalidatingWatchPaths = new Set();
  for (const descriptor of normalizedDescriptors) {
    for (const path of descriptor.paths) {
      const watchPath = resolve(path);
      const ids = descriptorIdsByWatchPath.get(watchPath) ?? new Set();
      ids.add(descriptor.id);
      descriptorIdsByWatchPath.set(watchPath, ids);
      if (descriptor.invalidatesGeneration !== false) {
        generationInvalidatingWatchPaths.add(watchPath);
      }
    }
  }

  const sourceObserver = createWatchSourceObserver(indexSources ? watchPaths : []);
  const sampleSignatures = createSingleFlightSampler(
    () => readDescriptorSignaturesAsync(normalizedDescriptors),
  );
  let lastSignaturesByTarget = null;
  let initialSignaturesPromise = sampleSignatures();
  let inFlight = false;
  let inFlightPromise = null;
  let pending = false;
  const pendingNamedChangeTargets = new Set();
  let cycle = 0;
  let retryTimer = null;
  let retryTimerGeneration = 0;
  let retryEpisodeSignature = null;
  let retryEpisodeState = 'initial';
  let admittedSignature = null;
  const forcedTargets = new Set();
  const signatureInitializationPendingDescriptorIds = new Set();
  let signatureInitializationFallbackAll = false;
  let closed = false;

  const clearSignatureInitializationRecovery = () => {
    signatureInitializationPendingDescriptorIds.clear();
    signatureInitializationFallbackAll = false;
  };

  const commitTargetObservationBaseline = ({ target, signatures, revalidatedSignatures = signatures }) => {
    const targetBaseline = lastSignaturesByTarget.get(target) ?? new Map();
    for (const descriptor of normalizedDescriptors) {
      if (!descriptorAffectsTarget(descriptor, target)) continue;
      targetBaseline.set(
        descriptor.id,
        descriptor.invalidatesGeneration === false
          ? revalidatedSignatures.get(descriptor.id) ?? signatures.get(descriptor.id) ?? null
          : signatures.get(descriptor.id) ?? null,
      );
    }
    lastSignaturesByTarget.set(target, targetBaseline);
  };

  const recordSignatureInitializationEvent = (event) => {
    if (event?.signatureInitializedAtObservation !== false) return;
    const watchPath = typeof event?.watchPath === 'string' && event.watchPath
      ? resolve(event.watchPath)
      : null;
    const descriptorIds = watchPath ? descriptorIdsByWatchPath.get(watchPath) : null;
    if (!descriptorIds?.size) {
      signatureInitializationFallbackAll = true;
      return;
    }
    for (const descriptorId of descriptorIds) {
      signatureInitializationPendingDescriptorIds.add(descriptorId);
    }
  };

  const recordNamedChangeObservation = (event) => {
    if (
      event?.eventType !== 'change'
      && event?.eventType !== 'rename'
    ) return false;
    if (typeof event?.filename !== 'string' || !event.filename.trim()) return false;
    const watchPath = typeof event?.watchPath === 'string' && event.watchPath
      ? resolve(event.watchPath)
      : null;
    if (watchPath && !generationInvalidatingWatchPaths.has(watchPath)) return false;
    const affectedDescriptors = watchPath
      ? normalizedDescriptors.filter((descriptor) => descriptorIdsByWatchPath.get(watchPath)?.has(descriptor.id))
      : normalizedDescriptors;
    for (const descriptor of affectedDescriptors) {
      // Ordinary source edits queue catch-up without discarding completed output.
      // Only explicit safety inputs can revoke an admitted activation plan.
      // Signature-only publications ignore raw events and compare their owned key.
      if (descriptor.invalidatesGeneration !== true) continue;
      for (const target of executorsByTarget.keys()) {
        if (descriptorAffectsTarget(descriptor, target)) pendingNamedChangeTargets.add(target);
      }
    }
    return true;
  };

  const clearScheduledRetry = () => {
    if (!retryTimer) return;
    clearTimeoutImpl(retryTimer);
    retryTimer = null;
    retryTimerGeneration += 1;
  };

  // Drift is intrinsically retryable even during cold preparation, which has
  // no server process to retain. Reuse this owner's normal coalescing delay
  // and single retry episode rather than requiring another filesystem edit.
  const readRetryDelayMs = (error) => Number(error?.reloadRetryAfterMs
    ?? (error?.code === 'BUILD_INPUTS_CHANGED' && error?.trailingPassExhausted !== true ? debounceMs : null));
  const scheduleRetry = (error) => {
    const delayMs = readRetryDelayMs(error);
    if (
      !Number.isFinite(delayMs)
      || delayMs <= 0
      || retryTimer
      || retryEpisodeState !== 'initial'
      || closed
      || isShuttingDown?.()
    ) return false;
    const scheduledEpisodeSignature = retryEpisodeSignature;
    const scheduledGeneration = retryTimerGeneration + 1;
    retryTimerGeneration = scheduledGeneration;
    retryTimer = setTimeoutImpl(() => {
      if (
        scheduledGeneration !== retryTimerGeneration
        || scheduledEpisodeSignature !== retryEpisodeSignature
        || closed
      ) return undefined;
      retryTimer = null;
      retryEpisodeState = 'retrying';
      return onChange({ eventType: 'retry', filename: null });
    }, Math.trunc(delayMs));
    retryTimer?.unref?.();
    retryEpisodeState = 'scheduled';
    logger.warn?.(`[local] watch: reload will retry in ${Math.trunc(delayMs)}ms without waiting for another edit.`);
    return true;
  };

  const sampleCurrentSignatures = async () => {
    if (sourceObserver.hasObservations()) await sourceObserver.reconcile();
    return await sampleSignatures();
  };

  const runCycle = async () => {
    if (closed || isShuttingDown?.()) return;
    if (!lastSignaturesByTarget) {
      const initialSignatures = await initialSignaturesPromise;
      lastSignaturesByTarget = createTargetSignatureBaselines({
        signatures: initialSignatures,
        descriptors: normalizedDescriptors,
        executorsByTarget,
      });
      initialSignaturesPromise = null;
      if (closed || isShuttingDown?.()) return;
    }
    const nextSignatures = forcedTargets.size ? await sampleCurrentSignatures() : await sampleSignatures();
    if (closed || isShuttingDown?.()) return;
    const forcedTargetsForCycle = new Set(forcedTargets);
    forcedTargets.clear();
    const preserveForcedTargetsForTrailingCycle = (targetsToPreserve) => {
      for (const target of targetsToPreserve) {
        if (forcedTargetsForCycle.has(target) && executorsByTarget.has(target)) {
          forcedTargets.add(target);
        }
      }
    };
    let { targets, changedDescriptors, descriptorEvidenceConclusive } = classifyChangedTargets({
      descriptors: normalizedDescriptors,
      previousByTarget: lastSignaturesByTarget,
      next: nextSignatures,
      executorsByTarget,
    });
    if (forcedTargetsForCycle.size) {
      const targetSet = new Set(targets);
      for (const target of forcedTargetsForCycle) targetSet.add(target);
      targets = RESTART_ORDER.filter((target) => targetSet.has(target));
    }
    if (signatureInitializationFallbackAll || signatureInitializationPendingDescriptorIds.size) {
      descriptorEvidenceConclusive = false;
      const forcedDescriptors = signatureInitializationFallbackAll
        ? normalizedDescriptors
        : normalizedDescriptors.filter((descriptor) => (
          signatureInitializationPendingDescriptorIds.has(descriptor.id)
        ));
      const changedDescriptorIds = new Set(changedDescriptors);
      const changedTargets = new Set(targets);
      for (const descriptor of forcedDescriptors) {
        changedDescriptorIds.add(descriptor.id);
        if (descriptor.target === 'shared') {
          for (const target of RESTART_ORDER) {
            if (executorsByTarget.has(target)) changedTargets.add(target);
          }
        } else if (executorsByTarget.has(descriptor.target)) {
          changedTargets.add(descriptor.target);
        }
      }
      targets = RESTART_ORDER.filter((target) => changedTargets.has(target));
      changedDescriptors = normalizedDescriptors
        .filter((descriptor) => changedDescriptorIds.has(descriptor.id))
        .map((descriptor) => descriptor.id);
    }
    if (!targets.length) {
      return;
    }

    const episodeSignature = serializeDescriptorSignatures(normalizedDescriptors, nextSignatures);
    if (retryEpisodeState === 'immediate') {
      retryEpisodeSignature = episodeSignature;
      retryEpisodeState = 'retrying';
    } else if (retryEpisodeSignature !== episodeSignature) {
      clearScheduledRetry();
      retryEpisodeSignature = episodeSignature;
      retryEpisodeState = 'initial';
    } else if (retryEpisodeState === 'scheduled' || retryEpisodeState === 'consumed') {
      return;
    }
    admittedSignature = episodeSignature;
    const signatureInitializationFallbackAllAtAdmission = signatureInitializationFallbackAll;
    const signatureInitializationDescriptorIdsAtAdmission = new Set(signatureInitializationPendingDescriptorIds);

    cycle += 1;
    const context = {
      cycle,
      generation: cycle,
      targets,
      changedDescriptors,
      descriptorEvidenceConclusive,
      signatures: nextSignatures,
      reloadPlans: {},
    };
    const transitionEmitter = targets
      .map((target) => executorsByTarget.get(target))
      .find((executor) => typeof executor?.emitTransitionEvent === 'function');
    try {
      transitionEmitter?.emitTransitionEvent('source_generation_admitted', {
        generation: context.generation,
        changedDescriptors: [...changedDescriptors],
        targets: [...targets],
      });
    } catch {
      // Observability must not become reload authority.
    }
    let staleGenerationLogged = false;
    let lastRevalidatedSignatures = nextSignatures;
    const revalidateGeneration = async (target) => {
      if (closed || isShuttingDown?.()) return false;
      const currentSignatures = await sampleCurrentSignatures();
      lastRevalidatedSignatures = currentSignatures;
      const targetDescriptors = normalizedDescriptors.filter((descriptor) => descriptorAffectsTarget(descriptor, target));
      if (serializeGenerationSignatures(targetDescriptors, currentSignatures)
        !== serializeGenerationSignatures(targetDescriptors, nextSignatures)) {
        pending = true;
      }
      // A successful build owns a coherent captured output. Fresh source is work
      // for the trailing cycle, not a reason to starve activation. Preserve only
      // inputs whose producer explicitly says the admitted plan requires currency
      // (Prisma migration evidence or dependency-publication admission).
      const activationDescriptors = targetDescriptors.filter(descriptor => (
        descriptor.invalidatesGeneration === true || descriptor.invalidatesGeneration === 'signature'
      ));
      const signatureInitializationChangedSinceAdmission = (
        (!signatureInitializationFallbackAllAtAdmission && signatureInitializationFallbackAll)
        || targetDescriptors.some((descriptor) => (
          signatureInitializationPendingDescriptorIds.has(descriptor.id)
          && !signatureInitializationDescriptorIdsAtAdmission.has(descriptor.id)
        ))
      );
      const current = !closed
        && !isShuttingDown?.()
        && !forcedTargets.has(target)
        && !pendingNamedChangeTargets.has(target)
        && !signatureInitializationChangedSinceAdmission
        && serializeGenerationSignatures(activationDescriptors, currentSignatures)
          === serializeGenerationSignatures(activationDescriptors, nextSignatures);
      if (!current) {
        pending = true;
        if (!staleGenerationLogged) {
          staleGenerationLogged = true;
          logger.log?.(`[local] watch: reload generation ${context.generation} became stale; replanning.`);
        }
      }
      return current;
    };
    const contextForTarget = (target) => ({
      ...context,
      revalidateGeneration: () => revalidateGeneration(target),
    });

    for (const target of targets) {
      const executor = executorsByTarget.get(target);
      const plan = executor?.createPlan?.(contextForTarget(target));
      if (plan) context.reloadPlans[target] = plan;
      await executor?.publishLifecycle?.({ phase: 'planned', plan });
    }

    const requestedFollowupTargets = new Set();
    let hadFailure = false;
    const publishIdleForTargets = async (targetsToIdle) => {
      for (const target of targetsToIdle) {
        try {
          await executorsByTarget.get(target)?.publishLifecycle?.({ phase: 'idle' });
        } catch (projectionError) {
          logger.error?.(
            `[local] watch: reload generation ${context.generation} was superseded, ` +
              `but the ${target} idle lifecycle projection needs attention.`,
          );
          logger.error?.(formatError(projectionError));
        }
      }
    };
    const handleTargetFailure = async ({ target, error, stage, retainedBuild = false }) => {
      hadFailure = true;
      emitSourceReloadRefusal(error);
      const executor = executorsByTarget.get(target);
      const plan = context.reloadPlans?.[target] ?? null;
      const observedSignatures = stage === 'build' && !retainedBuild && isDevStartupSourceDrift(error, target)
        ? await sampleCurrentSignatures() : nextSignatures;
      const targetDescriptors = normalizedDescriptors.filter(descriptor => descriptorAffectsTarget(descriptor, target));
      const retryImmediately = retryEpisodeState === 'initial'
        && serializeGenerationSignatures(targetDescriptors, observedSignatures)
          !== serializeGenerationSignatures(targetDescriptors, nextSignatures);
      if (retryImmediately) {
        // Carry the same bounded episode across the new observation. A second
        // failed capture consumes it even when source moves during that retry.
        retryEpisodeSignature = serializeDescriptorSignatures(normalizedDescriptors, observedSignatures);
        retryEpisodeState = 'immediate';
        pending = true;
      }
      const retryScheduled = retryImmediately || scheduleRetry(error);
      if (retryScheduled) {
        if (!retryImmediately) retryEpisodeState = 'scheduled';
        forcedTargets.add(target);
      } else if (!retryTimer && retryEpisodeState !== 'immediate') {
        retryEpisodeState = 'consumed';
      }
      if (!retryScheduled) {
        // Consume only the inputs this generation captured. A post-failure
        // observation may already contain the edit that repairs its build.
        commitTargetObservationBaseline({
          target,
          signatures: nextSignatures,
          revalidatedSignatures: stage === 'build' ? nextSignatures : lastRevalidatedSignatures,
        });
      }
      const retryAfterMs = retryImmediately ? 0 : retryScheduled ? Math.trunc(readRetryDelayMs(error)) : null;
      try {
        if (stage === 'restart' && typeof executor?.publishFailureDisposition === 'function') {
          await executor.publishFailureDisposition({ error, plan, retryScheduled, retryAfterMs });
        } else {
          await executor?.publishLifecycle?.({
            phase: retryScheduled ? 'retry-scheduled' : 'blocked',
            plan,
            ...(retryScheduled
              ? { retryAfterMs }
              : retainedBuild
                ? { phase: 'idle' }
                : { disposition: { code: stage === 'build' ? 'build_failed' : 'restart_failed' } }),
          });
        }
      } catch (projectionError) {
        logger.error?.(
          `[local] watch: ${retryScheduled ? 'retry is scheduled' : 'reload failure is terminal'}, ` +
            `but the ${target} lifecycle projection needs attention.`,
        );
        logger.error?.(formatError(projectionError));
      }
      logger.error?.(
        (retainedBuild
          ? `[local] watch: ${target} build inputs drifted; activated retained coherent output `
          : `[local] watch: ${target} reload ${stage} failed; `) +
          (retryImmediately ? '(retrying changed captured inputs immediately).'
            : retryScheduled ? '(bounded retry scheduled).' : '(will retry when affected inputs change).') + formatSourceReloadRefusal(error),
      );
      logger.error?.(formatError(error));
    };

    for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      const target = targets[targetIndex];
      if (closed || isShuttingDown?.()) return;
      const executor = executorsByTarget.get(target);
      const targetContext = contextForTarget(target);
      let buildResult;
      try {
        buildResult = await executor?.build?.(targetContext);
      } catch (error) {
        if (closed || isShuttingDown?.()) return;
        try {
          // The component owner must prove its retained closure usable; a drift
          // code alone does not certify cold or damaged output.
          buildResult = await executor?.recoverBuildFailure?.(error, targetContext);
        } catch (recoveryError) {
          await handleTargetFailure({ target, error: recoveryError, stage: 'build' });
          continue;
        }
        if (!buildResult) {
          await handleTargetFailure({ target, error, stage: 'build' });
          continue;
        }
      }
      if (buildResult?.requestFollowup === true) {
        requestedFollowupTargets.add(target);
      }

      const mayActivateSuperseded = (
        buildResult?.allowSupersededActivation === true
        && buildResult?.skipped !== true
      );
      if (!await targetContext.revalidateGeneration()) {
        await publishIdleForTargets([target]);
        preserveForcedTargetsForTrailingCycle([target]);
        continue;
      }

      if (buildResult?.skipped !== true) {
        try {
          const result = await executor?.restart?.({
            ...targetContext,
            allowSupersededActivation: mayActivateSuperseded,
          });
          if (result?.skipped === true && result?.reason === 'backoff') {
            const remainingMs = Number(result.retryAfterMs);
            const backoffError = new Error(`[local] watch: ${target} reload remains deferred by its failure backoff.`);
            backoffError.code = 'ERELOADBACKOFF';
            if (Number.isFinite(remainingMs) && remainingMs > 0) {
              backoffError.reloadRetryAfterMs = remainingMs;
            }
            throw backoffError;
          }
        } catch (error) {
          if (closed || isShuttingDown?.()) return;
          await handleTargetFailure({ target, error, stage: 'restart' });
          continue;
        }
      }

      if (!await targetContext.revalidateGeneration()) {
        preserveForcedTargetsForTrailingCycle([target]);
        continue;
      }

      commitTargetObservationBaseline({
        target,
        signatures: nextSignatures,
        revalidatedSignatures: lastRevalidatedSignatures,
      });
      if (buildResult?.retainedBuildError) {
        // Arm refresh after activation/revalidation: marking this target forced
        // earlier would invalidate the very generation starting its service.
        await handleTargetFailure({ target, error: buildResult.retainedBuildError, stage: 'build', retainedBuild: true });
      }
    }

    clearSignatureInitializationRecovery();
    if (!hadFailure) {
      clearScheduledRetry();
      retryEpisodeSignature = null;
      retryEpisodeState = 'initial';
    }
    if (requestedFollowupTargets.size) {
      for (const target of requestedFollowupTargets) forcedTargets.add(target);
      pending = true;
    }
  };

  const shouldObserve = (event) => (
    !ignorePath(event?.filename)
    && !(event?.eventType === 'poll' && event?.signature === admittedSignature)
  );

  const onChange = (event) => {
    if (closed || isShuttingDown?.()) return;
    if (!shouldObserve(event)) return;
    if (['recrawl', 'change', 'rename'].includes(event?.eventType)) sourceObserver.observe(event);
    if (executorsByTarget.has(event?.forcedTarget)) forcedTargets.add(event.forcedTarget);
    recordSignatureInitializationEvent(event);
    if (inFlight) {
      if (event?.observationHandled !== true) {
        if (recordNamedChangeObservation(event)) pending = true;
      }
      return;
    }

    inFlight = true;
    inFlightPromise = (async () => {
      try {
        do {
          pending = false;
          pendingNamedChangeTargets.clear();
          await runCycle();
        } while (pending && !closed && !isShuttingDown?.());
      } catch (error) {
        logger.error?.('[local] watch: unexpected reload coordinator error (continuing):');
        logger.error?.(formatError(error));
      } finally {
        inFlight = false;
        inFlightPromise = null;
      }
    })();
    return inFlightPromise;
  };

  const onObservation = (event) => {
    if (closed || isShuttingDown?.()) return false;
    if (event?.eventType === 'change' || event?.eventType === 'rename') sourceObserver.observe(event);
    if (!shouldObserve(event)) return false;
    recordSignatureInitializationEvent(event);
    if (!inFlight) return false;
    if (recordNamedChangeObservation(event)) pending = true;
    return true;
  };

  let watcher;
  try {
    watcher = observeChanges ? watchDebouncedImpl({
      persistent,
      recursive,
      paths: watchPaths,
      debounceMs,
      ignorePath,
      logger,
      shouldObserve,
      onObservation,
      onChange,
      pollIntervalMs,
      onSourceEvent: event => sourceObserver.observe(event),
      recoverSignature: async () => {
        await sourceObserver.reconcile();
        return serializeDescriptorSignatures(normalizedDescriptors, await sampleSignatures());
      },
      // Completion discovers catch-up work and revalidates activation safety.
      // Native observations queue edits while build/admission is pending;
      // another recovery check cannot advance that same operation.
      shouldPoll: () => !inFlight,
      readSignature: async () => serializeDescriptorSignatures(
        normalizedDescriptors,
        await sampleSignatures(),
      ),
    }) : { close() {} };
  } catch (error) {
    sourceObserver.close();
    throw error;
  }
  if (!watcher) { sourceObserver.close(); return null; }
  for (const [target, executor] of executorsByTarget) {
    executor?.setUnexpectedExitHandler?.(async (event) => {
      try {
        await executor?.recoverUnexpectedExit?.(event);
      } catch (error) {
        logger.error?.(`[local] watch: ${target} prior-runtime recovery failed; continuing with source refresh.`);
        logger.error?.(formatError(error));
      }
      return onChange({
        eventType: 'active-exit',
        filename: null,
        forcedTarget: target,
        activeExit: event,
      });
    });
  }
  return {
    ...watcher,
    requestReload(target) {
      if (closed || !executorsByTarget.has(target)) return Promise.resolve();
      return onChange({
        eventType: 'requested',
        filename: null,
        forcedTarget: target,
      });
    },
    async close() {
      if (closed) return await inFlightPromise;
      closed = true;
      clearScheduledRetry();
      forcedTargets.clear();
      for (const executor of executorsByTarget.values()) executor?.setUnexpectedExitHandler?.(null);
      retryEpisodeSignature = null;
      retryEpisodeState = 'initial';
      signatureInitializationPendingDescriptorIds.clear();
      signatureInitializationFallbackAll = false;
      watcher.close?.();
      await inFlightPromise;
      sourceObserver.close();
    },
  };
}
