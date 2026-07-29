import { setTimeout as delay } from 'node:timers/promises';
import { listListenPids, listListenPidsWithStatus } from '../net/ports.mjs';
import { getProcessGroupId, isPidOwnedByStack, resolvePidStackOwnership } from '../proc/ownership.mjs';

const DEFAULT_LISTENER_DISCOVERY_ATTEMPT_TIMEOUT_MS = 1000;

function inconclusiveListenerError(observation) {
  const error = new Error(`listener discovery is inconclusive: ${observation?.reason ?? observation?.status ?? 'error'}`);
  error.code = 'ELISTENERDISCOVERYINCONCLUSIVE';
  error.observation = observation;
  return error;
}

function createObservationImpl({ listListenPidsImpl, listListenPidsWithStatusImpl }) {
  // `listListenPids` is the legacy best-effort compatibility surface and maps
  // typed inconclusive evidence to an empty list. Production observation scopes
  // must keep the typed owner; only an explicitly injected alternate legacy
  // implementation should opt into the array-shaped adapter below.
  if (typeof listListenPidsImpl !== 'function' || listListenPidsImpl === listListenPids) {
    return { observeImpl: listListenPidsWithStatusImpl, supportsProcessGroupFilter: true };
  }
  const observeImpl = async (port, options) => {
    try {
      const pids = await listListenPidsImpl(port, options);
      return { status: 'ok', supported: true, pids: Array.isArray(pids) ? pids : [] };
    } catch (error) {
      return error?.observation ?? {
        status: 'error',
        supported: true,
        pids: [],
        reason: 'listener-discovery-error',
      };
    }
  };
  return { observeImpl, supportsProcessGroupFilter: false };
}

export function createListenerOwnershipObservationScope({
  totalTimeoutMs = 750,
  // The scope deadline remains authoritative; this only avoids repeatedly aborting a loaded lsof at 250ms.
  attemptTimeoutMs = DEFAULT_LISTENER_DISCOVERY_ATTEMPT_TIMEOUT_MS,
  processGroupAttemptTimeoutMs = DEFAULT_LISTENER_DISCOVERY_ATTEMPT_TIMEOUT_MS,
  retryDelayMs = 25,
  retryInconclusive = true,
  listListenPidsImpl,
  listListenPidsWithStatusImpl = listListenPidsWithStatus,
  nowImpl = Date.now,
  delayImpl = delay,
  resolvePidStackOwnershipImpl,
} = {}) {
  const deadline = nowImpl() + Math.max(1, Number(totalTimeoutMs) || 1);
  const observations = new Map();
  const ownershipVerdicts = new Map();
  const processIdentityVerdicts = new Map();
  const { observeImpl, supportsProcessGroupFilter } = createObservationImpl({
    listListenPidsImpl,
    listListenPidsWithStatusImpl,
  });
  const remainingMs = () => Math.max(0, deadline - nowImpl());

  const observeFresh = async (
    port,
    observationOptions = {},
    {
      retryInconclusiveForObservation = retryInconclusive,
      attemptTimeoutCapMs = attemptTimeoutMs,
      attemptTimeoutMsForObservation = attemptTimeoutMs,
      observationTimeoutMs = Number.POSITIVE_INFINITY,
    } = {},
  ) => {
    const observationDeadline = Math.min(
      deadline,
      nowImpl() + Math.max(1, Number(observationTimeoutMs) || 1),
    );
    const observationRemainingMs = () => Math.max(
      0,
      Math.min(remainingMs(), observationDeadline - nowImpl()),
    );
    let last = { status: 'error', supported: true, pids: [], reason: 'listener-discovery-error' };
    let attempted = false;
    while (observationRemainingMs() > 0) {
      const timeoutMs = Math.max(1, Math.min(
        observationRemainingMs(),
        Math.max(1, Number(attemptTimeoutMsForObservation) || 1),
        Math.max(1, Number(attemptTimeoutCapMs) || 1),
      ));
      const controller = new AbortController();
      let timer;
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' });
        }, timeoutMs);
      });
      // eslint-disable-next-line no-await-in-loop
      last = await Promise.race([
        Promise.resolve(observeImpl(port, {
          ...observationOptions,
          timeoutMs,
          signal: controller.signal,
        })).catch((error) => (
          error?.observation ?? { status: 'error', supported: true, pids: [], reason: 'listener-discovery-error' }
        )),
        timedOut,
      ]);
      attempted = true;
      clearTimeout(timer);
      if (
        last?.status === 'ok'
        || last?.status === 'unsupported'
        || !retryInconclusiveForObservation
      ) return last;
      const remaining = observationRemainingMs();
      if (remaining <= 0) break;
      const pauseMs = Math.min(remaining, Math.max(0, Number(retryDelayMs) || 0));
      if (pauseMs > 0) {
        // eslint-disable-next-line no-await-in-loop
        await delayImpl(pauseMs);
      } else if (retryDelayMs <= 0) {
        // Injected/test observations can complete without advancing a synthetic clock.
        if (nowImpl === Date.now) await delayImpl(0);
      }
    }
    return attempted
      ? last
      : { status: 'timeout', supported: true, pids: [], reason: 'listener-discovery-timeout' };
  };

  return {
    resolvePidStackOwnershipImpl,
    remainingMs,
    observe(port, observationOptions = {}) {
      const serverPort = Number(port);
      const candidatePids = Array.from(new Set(
        (Array.isArray(observationOptions?.candidatePids) ? observationOptions.candidatePids : [])
          .map((pid) => Number(pid))
          .filter((pid) => Number.isInteger(pid) && pid > 1),
      )).sort((a, b) => a - b);
      const key = candidatePids.length > 0
        ? `pids:${candidatePids.join(',')}:port:${serverPort}`
        : serverPort;
      if (!observations.has(key)) {
        observations.set(key, observeFresh(serverPort, {
          ...observationOptions,
          ...(candidatePids.length > 0 ? { candidatePids } : {}),
        }));
      }
      return observations.get(key);
    },
    observeProcessGroup(port, processGroupId) {
      const pgid = Number(processGroupId);
      if (!supportsProcessGroupFilter || !Number.isInteger(pgid) || pgid <= 1) {
        return Promise.resolve({
          status: 'unsupported',
          supported: false,
          pids: [],
          reason: 'process-group-listener-discovery-unsupported',
        });
      }
      const key = `pgid:${pgid}:port:${Number(port)}`;
      if (!observations.has(key)) {
        // Prefer the strongest positive proof while reserving the final third
        // of the command scope for broad listener evidence. A one-second
        // attempt matches the underlying listener command's normal budget and
        // avoids rejecting a just-ready server after one 250ms lsof timeout.
        const observationTimeoutMs = Math.max(1, Math.floor((remainingMs() * 2) / 3));
        const attemptTimeoutCapMs = Math.max(1, Math.min(
          Math.max(1, Number(processGroupAttemptTimeoutMs) || 1),
          observationTimeoutMs,
        ));
        observations.set(key, observeFresh(
          Number(port),
          { processGroupId: pgid },
          {
            retryInconclusiveForObservation: true,
            attemptTimeoutCapMs,
            attemptTimeoutMsForObservation: attemptTimeoutCapMs,
            observationTimeoutMs,
          },
        ));
      }
      return observations.get(key);
    },
    resolveOwnership(key, resolveImpl) {
      const normalizedKey = String(key);
      if (!ownershipVerdicts.has(normalizedKey)) ownershipVerdicts.set(normalizedKey, Promise.resolve().then(resolveImpl));
      return ownershipVerdicts.get(normalizedKey);
    },
    resolveProcessIdentity(key, resolveImpl) {
      const normalizedKey = String(key);
      if (!processIdentityVerdicts.has(normalizedKey)) {
        processIdentityVerdicts.set(normalizedKey, Promise.resolve().then(resolveImpl));
      }
      return processIdentityVerdicts.get(normalizedKey);
    },
  };
}

export async function resolveStackPidOwnership(
  { pid, stackName, envPath },
  {
    observationScope,
    resolvePidStackOwnershipImpl,
    retryDelayMs = 25,
  } = {},
) {
  const scope = observationScope ?? createListenerOwnershipObservationScope();
  const identityImpl = resolvePidStackOwnershipImpl ?? scope.resolvePidStackOwnershipImpl ?? resolvePidStackOwnership;
  return await scope.resolveProcessIdentity(`pid:${pid}:${stackName}:${envPath}`, async () => {
    let ownership;
    do {
      const attemptBudgetMs = scope.remainingMs();
      if (attemptBudgetMs <= 0) {
        return {
          status: 'inconclusive',
          owned: null,
          reason: 'process-identity-timeout',
        };
      }
      const timeoutMs = Math.max(1, attemptBudgetMs);
      const controller = new AbortController();
      let timer;
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({
            status: 'inconclusive',
            owned: null,
            reason: 'process-identity-timeout',
          });
        }, timeoutMs);
      });
      // The parent race owns the deadline even when a system adapter ignores timeout/signal.
      // eslint-disable-next-line no-await-in-loop
      ownership = await Promise.race([
        Promise.resolve().then(() => identityImpl(
          pid,
          { stackName, envPath },
          { timeoutMs, signal: controller.signal },
        )).catch((error) => ({
          status: 'inconclusive',
          owned: null,
          reason: error?.code === 'ETIMEDOUT' || error?.code === 'ABORT_ERR'
            ? 'process-identity-timeout'
            : 'process-identity-unavailable',
        })),
        timedOut,
      ]);
      if (ownership?.status == null && typeof ownership?.owned === 'boolean') {
        ownership = {
          ...ownership,
          status: ownership.owned ? 'owned' : 'not_owned',
        };
      }
      clearTimeout(timer);
      if (ownership?.status !== 'inconclusive') return ownership;
      if (ownership?.reason === 'process-identity-timeout' && scope.remainingMs() <= 0) return ownership;
      const remaining = scope.remainingMs();
      if (remaining <= 0) break;
      // eslint-disable-next-line no-await-in-loop
      await delay(Math.min(Math.max(0, retryDelayMs), remaining));
    } while (scope.remainingMs() > 0);
    return ownership ?? { status: 'inconclusive', owned: null, reason: 'process-identity-inconclusive' };
  });
}

export function createListenerOwnershipCommandScope(options = {}) {
  return createListenerOwnershipObservationScope({
    totalTimeoutMs: 4_000,
    attemptTimeoutMs: 4_000,
    retryInconclusive: false,
    ...options,
  });
}

export async function resolveSpawnedProcessGroupListenPid(
  { port, spawnedPid },
  {
    listListenPidsImpl = listListenPids,
    listListenPidsWithStatusImpl = listListenPidsWithStatus,
    getProcessGroupIdImpl = getProcessGroupId,
    observationScope,
    listenerOwnershipTimeoutMs = 3_000,
    listenerOwnershipRetryDelayMs = 25,
  } = {},
) {
  const serverPort = Number(port);
  const rootPid = Number(spawnedPid);
  const scope = observationScope ?? createListenerOwnershipObservationScope({
    totalTimeoutMs: listenerOwnershipTimeoutMs,
    retryDelayMs: listenerOwnershipRetryDelayMs,
    listListenPidsImpl,
    listListenPidsWithStatusImpl,
  });
  const attemptedProcessGroups = new Set();
  const observeProcessGroup = async (processGroupId) => {
    const pgid = Number(processGroupId);
    if (!Number.isInteger(pgid) || pgid <= 1 || attemptedProcessGroups.has(pgid)) return null;
    attemptedProcessGroups.add(pgid);
    const result = await scope.observeProcessGroup(serverPort, pgid);
    return result.status === 'ok' && result.pids.length > 0 ? Number(result.pids[0]) : null;
  };

  const spawnedGroupListenerPid = await observeProcessGroup(rootPid);
  if (spawnedGroupListenerPid) return spawnedGroupListenerPid;

  let rootPgid = await getProcessGroupIdImpl(spawnedPid, {
    timeoutMs: Math.max(1, Math.min(250, Math.floor(scope.remainingMs() / 2))),
  }).catch(() => null);
  if (rootPgid) {
    const processGroupListenerPid = await observeProcessGroup(rootPgid);
    if (processGroupListenerPid) return processGroupListenerPid;
  }

  const listenResult = await scope.observe(serverPort);
  if (listenResult.status !== 'ok') {
    const error = new Error(
      `[local] server readiness ownership could not be proven on port ${serverPort}: ` +
        `${listenResult.reason ?? listenResult.status}`,
    );
    error.code = 'ELISTENERDISCOVERYINCONCLUSIVE';
    error.observation = listenResult;
    throw error;
  }

  const listenPids = listenResult.pids;
  if (!listenPids.length) {
    throw new Error(
      `[local] server readiness ownership could not be proven on port ${serverPort}: no listener PID was discovered`,
    );
  }

  for (const listenPid of listenPids) {
    if (Number(listenPid) === rootPid) continue;
    if (!rootPgid) {
      // eslint-disable-next-line no-await-in-loop
      rootPgid = await getProcessGroupIdImpl(spawnedPid, {
        timeoutMs: Math.max(1, scope.remainingMs()),
      }).catch(() => null);
      if (!rootPgid) {
        throw new Error(
          `[local] server readiness ownership could not be proven on port ${serverPort}: ` +
            `process group unavailable for pid=${spawnedPid}, listeners=${listenPids.join(', ')}`,
        );
      }
    }
    // eslint-disable-next-line no-await-in-loop
    const listenPgid = await getProcessGroupIdImpl(listenPid, {
      timeoutMs: Math.max(1, scope.remainingMs()),
    }).catch(() => null);
    if (!listenPgid || listenPgid !== rootPgid) {
      throw new Error(
        `[local] server readiness was answered by another process on port ${serverPort}; ` +
          `spawned pid=${spawnedPid}, listeners=${listenPids.join(', ')}`,
      );
    }
  }

  return Number(listenPids[0]);
}

export async function resolveStackOwnedListenPid(
  { port, stackName, envPath },
  {
    listListenPidsImpl,
    listListenPidsWithStatusImpl = listListenPidsWithStatus,
    observationScope,
    listenerTotalTimeoutMs = 750,
    listenerAttemptTimeoutMs = DEFAULT_LISTENER_DISCOVERY_ATTEMPT_TIMEOUT_MS,
    listenerRetryDelayMs = 25,
    isPidOwnedByStackImpl = isPidOwnedByStack,
    getProcessGroupIdImpl = getProcessGroupId,
    resolvePidStackOwnershipImpl,
    candidatePids,
  } = {},
) {
  const serverPort = Number(port);
  if (!Number.isFinite(serverPort) || serverPort <= 0) return null;

  const scope = observationScope ?? createListenerOwnershipObservationScope({
    totalTimeoutMs: listenerTotalTimeoutMs,
    attemptTimeoutMs: listenerAttemptTimeoutMs,
    retryDelayMs: listenerRetryDelayMs,
    listListenPidsImpl,
    listListenPidsWithStatusImpl,
  });
  const normalizedCandidatePids = Array.from(new Set(
    (Array.isArray(candidatePids) ? candidatePids : [])
      .map((pid) => Number(pid))
      .filter((pid) => Number.isInteger(pid) && pid > 1),
  )).sort((a, b) => a - b);
  const candidateKey = normalizedCandidatePids.length > 0 ? normalizedCandidatePids.join(',') : 'all';
  return await scope.resolveOwnership(`stack:${serverPort}:${stackName}:${envPath}:${candidateKey}`, async () => {
    const observation = await scope.observe(serverPort, {
      ...(normalizedCandidatePids.length > 0 ? { candidatePids: normalizedCandidatePids } : {}),
    });
    if (observation?.status !== 'ok') {
      throw inconclusiveListenerError(observation);
    }

    const listenPids = Array.isArray(observation.pids) ? observation.pids : [];
    if (!listenPids.length) return null;

    let expectedPgid = null;
    for (const pid of listenPids) {
      const ownershipImpl = typeof resolvePidStackOwnershipImpl === 'function'
        ? resolvePidStackOwnershipImpl
        : isPidOwnedByStackImpl !== isPidOwnedByStack
          ? async (candidatePid, context) => ({
              status: (await isPidOwnedByStackImpl(candidatePid, context)) ? 'owned' : 'not_owned',
            })
          : undefined;
      // eslint-disable-next-line no-await-in-loop
      const ownership = await resolveStackPidOwnership(
        { pid, stackName, envPath },
        { observationScope: scope, resolvePidStackOwnershipImpl: ownershipImpl },
      );

      if (ownership?.status === 'inconclusive') {
        throw inconclusiveListenerError({
          status: 'error',
          supported: true,
          pids: listenPids,
          reason: ownership.reason ?? 'process-identity-inconclusive',
        });
      }
      if (ownership?.status !== 'owned') {
        return null;
      }

      // eslint-disable-next-line no-await-in-loop
      const pgid = await getProcessGroupIdImpl(pid).catch(() => null);
      if (!pgid) {
        if (listenPids.length > 1) {
          return null;
        }
        continue;
      }
      if (!expectedPgid) {
        expectedPgid = pgid;
      } else if (pgid !== expectedPgid) {
        return null;
      }
    }

    return listenPids[0] ?? null;
  });
}
