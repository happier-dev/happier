import { resolve } from 'node:path';

import { watchDebounced } from '../proc/watch.mjs';

export function requestInitialDevRefreshes({
  reloadWatcher,
  serverReloadEnabled = false,
  daemonReloadEnabled = false,
} = {}) {
  if (!reloadWatcher?.requestReload) return [];
  const pending = [];
  if (serverReloadEnabled) pending.push(reloadWatcher.requestReload('server'));
  if (daemonReloadEnabled) pending.push(reloadWatcher.requestReload('daemon'));
  return pending;
}
import {
  isDevRuntimeReloadIgnoredPath,
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

const RESTART_ORDER = ['server', 'daemon'];

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
      readSignatureAsync: () => readDevReloadWatchChangeSignatureAsync(mergedPaths),
    });
  }
  return Array.from(byId.values());
}

async function readDescriptorSignaturesAsync(descriptors) {
  const pairs = await Promise.all(descriptors.map(async (descriptor) => {
    try {
      const signature = typeof descriptor.readSignatureAsync === 'function'
        ? await descriptor.readSignatureAsync(descriptor)
        : typeof descriptor.readSignature === 'function'
          ? descriptor.readSignature(descriptor)
          : await readDevReloadWatchChangeSignatureAsync(descriptor.paths);
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
  return descriptor.target === 'shared' || descriptor.target === target;
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

  const normalizedDescriptors = normalizeDescriptors(descriptors);
  const executorsByTarget = createExecutorMap(executors);
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

  const sampleSignatures = createSingleFlightSampler(
    () => readDescriptorSignaturesAsync(normalizedDescriptors),
  );
  let lastSignaturesByTarget = null;
  let initialSignaturesPromise = sampleSignatures();
  let inFlight = false;
  let inFlightPromise = null;
  let pending = false;
  let pendingNamedChange = false;
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
    pendingNamedChange = true;
    return true;
  };

  const clearScheduledRetry = () => {
    if (!retryTimer) return;
    clearTimeoutImpl(retryTimer);
    retryTimer = null;
    retryTimerGeneration += 1;
  };

  const scheduleRetry = (error) => {
    const delayMs = Number(error?.reloadRetryAfterMs);
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
    const nextSignatures = await sampleSignatures();
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
    if (retryEpisodeSignature !== episodeSignature) {
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
    context.revalidateGeneration = async () => {
      if (closed || isShuttingDown?.()) return false;
      const currentSignatures = await sampleSignatures();
      lastRevalidatedSignatures = currentSignatures;
      const signatureInitializationChangedSinceAdmission = (
        (!signatureInitializationFallbackAllAtAdmission && signatureInitializationFallbackAll)
        || Array.from(signatureInitializationPendingDescriptorIds).some((descriptorId) => (
          !signatureInitializationDescriptorIdsAtAdmission.has(descriptorId)
        ))
      );
      const current = !closed
        && !isShuttingDown?.()
        && forcedTargets.size === 0
        && !pendingNamedChange
        && !signatureInitializationChangedSinceAdmission
        && serializeGenerationSignatures(normalizedDescriptors, currentSignatures)
          === serializeGenerationSignatures(normalizedDescriptors, nextSignatures);
      if (!current) {
        pending = true;
        if (!staleGenerationLogged) {
          staleGenerationLogged = true;
          logger.log?.(`[local] watch: reload generation ${context.generation} became stale; replanning.`);
        }
      }
      return current;
    };

    for (const target of targets) {
      const executor = executorsByTarget.get(target);
      const plan = executor?.createPlan?.(context);
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
    const handleTargetFailure = async ({ target, error, stage }) => {
      hadFailure = true;
      const executor = executorsByTarget.get(target);
      const plan = context.reloadPlans?.[target] ?? null;
      const retryScheduled = scheduleRetry(error);
      if (retryScheduled) {
        retryEpisodeState = 'scheduled';
        forcedTargets.add(target);
      } else if (!retryTimer) {
        retryEpisodeState = 'consumed';
      }
      if (!retryScheduled) {
        commitTargetObservationBaseline({
          target,
          signatures: nextSignatures,
          revalidatedSignatures: lastRevalidatedSignatures,
        });
      }
      const retryAfterMs = retryScheduled ? Math.trunc(Number(error?.reloadRetryAfterMs)) : null;
      try {
        if (stage === 'restart' && typeof executor?.publishFailureDisposition === 'function') {
          await executor.publishFailureDisposition({ error, plan, retryScheduled, retryAfterMs });
        } else {
          await executor?.publishLifecycle?.({
            phase: retryScheduled ? 'retry-scheduled' : 'blocked',
            plan,
            ...(retryScheduled
              ? { retryAfterMs }
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
        `[local] watch: ${target} reload ${stage} failed; keeping existing services running ` +
          (retryScheduled ? '(bounded retry scheduled).' : '(will retry when affected inputs change).'),
      );
      logger.error?.(formatError(error));
    };

    for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      const target = targets[targetIndex];
      if (closed || isShuttingDown?.()) return;
      const executor = executorsByTarget.get(target);
      let buildResult;
      try {
        buildResult = await executor?.build?.(context);
      } catch (error) {
        if (closed || isShuttingDown?.()) return;
        await handleTargetFailure({ target, error, stage: 'build' });
        continue;
      }
      if (buildResult?.requestFollowup === true) {
        requestedFollowupTargets.add(target);
      }

      const mayActivateSuperseded = (
        buildResult?.allowSupersededActivation === true
        && buildResult?.skipped !== true
      );
      if (!await context.revalidateGeneration() && !mayActivateSuperseded) {
        const canceledTargets = targets.slice(targetIndex);
        await publishIdleForTargets(canceledTargets);
        preserveForcedTargetsForTrailingCycle(canceledTargets);
        return;
      }

      if (buildResult?.skipped !== true) {
        try {
          const result = await executor?.restart?.({
            ...context,
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

      if (!await context.revalidateGeneration()) {
        await publishIdleForTargets(targets.slice(targetIndex + 1));
        preserveForcedTargetsForTrailingCycle(targets.slice(targetIndex + 1));
        return;
      }

      commitTargetObservationBaseline({
        target,
        signatures: nextSignatures,
        revalidatedSignatures: lastRevalidatedSignatures,
      });
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
    !isDevRuntimeReloadIgnoredPath(event?.filename)
    && !(event?.eventType === 'poll' && event?.signature === admittedSignature)
  );

  const onChange = (event) => {
    if (closed || isShuttingDown?.()) return;
    if (!shouldObserve(event)) return;
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
          pendingNamedChange = false;
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
    if (!shouldObserve(event)) return false;
    recordSignatureInitializationEvent(event);
    if (!inFlight) return false;
    if (recordNamedChangeObservation(event)) pending = true;
    return true;
  };

  const watcher = watchDebouncedImpl({
    paths: watchPaths,
    debounceMs,
    shouldObserve,
    onObservation,
    onChange,
    pollIntervalMs,
    readSignature: async () => serializeDescriptorSignatures(
      normalizedDescriptors,
      await sampleSignatures(),
    ),
  });
  if (!watcher) return null;
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
    },
  };
}
