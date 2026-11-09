import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  listenAddressCoversEndpoint,
  parseServerStartupReceiptText,
  waitForServerStartupReceipt,
} from '@happier-dev/cli-common/firstPartyRuntime/serverStartupReceipt';
import {
  isVerifiedProcessAncestry,
  observeProcessInstanceFingerprint,
  observeWindowsProcessAncestry,
  processInstanceFingerprintMatches,
} from '@happier-dev/cli-common/processInstance';
import { listListenPids, listListenPidsWithStatus, probeTcpPortBinding } from '../net/ports.mjs';
import { getProcessGroupId, isPidOwnedByStack, resolvePidStackOwnership } from '../proc/ownership.mjs';
import { runCapture } from '../proc/proc.mjs';
import { fetchExactServerReadyIdentity } from './server.mjs';

const DEFAULT_SPAWNED_LISTENER_OWNERSHIP_TIMEOUT_MS = 60_000;
const MAX_SPAWNED_LISTENER_OWNERSHIP_TIMEOUT_MS = 10 * 60_000;

export function resolveSpawnedListenerOwnershipTimeoutMs(env = process.env) {
  const configured = Number.parseInt(
    String(env?.HAPPIER_STACK_LISTENER_OWNERSHIP_TIMEOUT_MS ?? '').trim(),
    10,
  );
  return Number.isFinite(configured) && configured >= 100
    ? Math.min(configured, MAX_SPAWNED_LISTENER_OWNERSHIP_TIMEOUT_MS)
    : DEFAULT_SPAWNED_LISTENER_OWNERSHIP_TIMEOUT_MS;
}

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
  attemptTimeoutMs = 250,
  processGroupAttemptTimeoutMs = Number.POSITIVE_INFINITY,
  retryDelayMs = 25,
  retryInconclusive = true,
  listListenPidsImpl,
  listListenPidsWithStatusImpl = listListenPidsWithStatus,
  nowImpl = Date.now,
  delayImpl = delay,
  probeTcpPortBindingImpl = probeTcpPortBinding,
  resolvePidStackOwnershipImpl,
} = {}) {
  let deadline = nowImpl() + Math.max(1, Number(totalTimeoutMs) || 1);
  const observations = new Map();
  const ownershipVerdicts = new Map();
  const processIdentityVerdicts = new Map();
  const portAvailabilityVerdicts = new Map();
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
        // of the command scope for broad listener evidence. By default, one
        // in-flight discovery can consume that reserved subdeadline; callers
        // can inject a smaller cap when retries are preferable.
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
    /**
     * One bounded broad look after a process-group proof. It takes a share of what remains, not a
     * retry loop to the deadline, so a stalled query cannot starve the work that follows.
     */
    observeBroadCorroboration(port) {
      const key = `corroboration:port:${Number(port)}`;
      if (!observations.has(key)) {
        const observationTimeoutMs = Math.max(1, Math.floor(remainingMs() / 3));
        observations.set(key, observeFresh(Number(port), {}, {
          retryInconclusiveForObservation: false,
          attemptTimeoutCapMs: observationTimeoutMs,
          attemptTimeoutMsForObservation: observationTimeoutMs,
          observationTimeoutMs,
        }));
      }
      return observations.get(key);
    },
    resolveOwnership(key, resolveImpl) {
      const normalizedKey = String(key);
      if (!ownershipVerdicts.has(normalizedKey)) ownershipVerdicts.set(normalizedKey, Promise.resolve().then(resolveImpl));
      return ownershipVerdicts.get(normalizedKey);
    },
    /**
     * Waiting for a slow but healthy start is not ownership work, and readiness has its own
     * deadline. Time spent in `wait` does not count against this scope's one deadline.
     */
    async excludeFromBudget(wait) {
      const startedAt = nowImpl();
      try {
        return await wait();
      } finally {
        deadline += Math.max(0, nowImpl() - startedAt);
      }
    },
    /**
     * Runs one abortable probe inside what remains of this scope. An exhausted or cancelled scope
     * starts nothing, and the deadline here wins even if a probe ignores its abort, so a probe can
     * neither outlive its owner nor pass a "no limit" budget along.
     */
    async withProcessProbeBudget(probe, { signal: callerSignal } = {}) {
      if (callerSignal?.aborted) return { status: 'inconclusive', reason: 'process-identity-cancelled' };
      const timeoutMs = remainingMs();
      if (timeoutMs <= 0) return { status: 'inconclusive', reason: 'process-identity-timeout' };
      const controller = new AbortController();
      const cancel = () => controller.abort();
      let deadlineReached = false;
      const timer = setTimeout(() => {
        deadlineReached = true;
        controller.abort();
      }, timeoutMs);
      callerSignal?.addEventListener('abort', cancel, { once: true });
      const cutOff = new Promise((resolve) => {
        controller.signal.addEventListener('abort', () => resolve({
          status: 'inconclusive',
          reason: 'process-identity-cancelled',
        }), { once: true });
      });
      try {
        const result = await Promise.race([probe({ timeoutMs, signal: controller.signal }), cutOff]);
        return deadlineReached && result?.reason === 'process-identity-cancelled'
          ? { ...result, reason: 'process-identity-timeout' }
          : result;
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', cancel);
      }
    },
    resolveProcessIdentity(key, resolveImpl) {
      const normalizedKey = String(key);
      if (!processIdentityVerdicts.has(normalizedKey)) {
        processIdentityVerdicts.set(normalizedKey, Promise.resolve().then(resolveImpl));
      }
      return processIdentityVerdicts.get(normalizedKey);
    },
    checkPortFree(port, { host = '127.0.0.1' } = {}) {
      const key = `${host}:${Number(port)}`;
      if (!portAvailabilityVerdicts.has(key)) {
        portAvailabilityVerdicts.set(key, (async () => {
          const observation = await this.observe(port);
          if (observation.status !== 'ok') {
            return { status: 'inconclusive', observation };
          }
          if (observation.pids.length > 0) return { status: 'in_use', observation };
          const remaining = remainingMs();
          if (remaining <= 0) return { status: 'inconclusive', observation };
          const controller = new AbortController();
          let timer;
          const binding = await Promise.race([
            Promise.resolve(probeTcpPortBindingImpl(port, {
              host,
              timeoutMs: remaining,
              signal: controller.signal,
            })).catch(() => ({ status: 'error', reason: 'port-bind-error' })),
            new Promise((resolve) => {
              timer = setTimeout(() => {
                controller.abort();
                resolve({ status: 'timeout', reason: 'port-bind-timeout' });
              }, remaining);
            }),
          ]);
          clearTimeout(timer);
          if (binding.status === 'free') return { status: 'free', observation, binding };
          if (binding.status === 'in_use') return { status: 'in_use', observation, binding };
          return { status: 'inconclusive', observation, binding };
        })());
      }
      return portAvailabilityVerdicts.get(key);
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
    listenerOwnershipTimeoutMs = resolveSpawnedListenerOwnershipTimeoutMs(),
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

  // A group query sees only its own group, so it proves ownership but not that nothing else can
  // answer on this port. Only conclusive broad evidence shows that, so without it the listener
  // stays unproven, however slow the host is.
  const rejectForeignListeners = async (ownedPid, ownedGroupId) => {
    const broad = await scope.observeBroadCorroboration(serverPort);
    if (broad.status !== 'ok') throw inconclusiveListenerError(broad);
    for (const listenPid of broad.pids) {
      if (Number(listenPid) === ownedPid || Number(listenPid) === rootPid) continue;
      // eslint-disable-next-line no-await-in-loop
      const listenPgid = await getProcessGroupIdImpl(listenPid, {
        timeoutMs: Math.max(1, scope.remainingMs()),
      }).catch(() => null);
      if (Number(listenPgid) !== Number(ownedGroupId)) {
        throw new Error(
          `[local] server readiness was answered by another process on port ${serverPort}; ` +
            `spawned pid=${spawnedPid}, listeners=${broad.pids.join(', ')}`,
        );
      }
    }
    return ownedPid;
  };

  const spawnedGroupListenerPid = await observeProcessGroup(rootPid);
  if (spawnedGroupListenerPid) return await rejectForeignListeners(spawnedGroupListenerPid, rootPid);

  let rootPgid = await getProcessGroupIdImpl(spawnedPid, {
    timeoutMs: Math.max(1, Math.min(250, Math.floor(scope.remainingMs() / 2))),
  }).catch(() => null);
  if (rootPgid) {
    const processGroupListenerPid = await observeProcessGroup(rootPgid);
    if (processGroupListenerPid) return await rejectForeignListeners(processGroupListenerPid, rootPgid);
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

function hasSpawnedChildExited(child) {
  return child?.exitCode != null || child?.signalCode != null;
}

/**
 * The lifetime of one spawned server's ownership proof, started right after spawn. It owns the only
 * observation scope and cancellation for the root identity capture and the proof that follows, so
 * a shutdown or server exit stops both and neither gets a budget of its own.
 */
export function trackSpawnedServerProcess(child, {
  signal,
  observationScope,
  runCaptureImpl = runCapture,
  platform = process.platform,
} = {}) {
  const scope = observationScope ?? createListenerOwnershipObservationScope({
    totalTimeoutMs: resolveSpawnedListenerOwnershipTimeoutMs(),
  });
  const lifetime = new AbortController();
  const stop = () => lifetime.abort();
  if (signal?.aborted || hasSpawnedChildExited(child)) stop();
  signal?.addEventListener('abort', stop, { once: true });
  child?.once?.('exit', stop);
  return {
    pid: child.pid,
    child,
    observationScope: scope,
    signal: lifetime.signal,
    identity: scope.withProcessProbeBudget(
      (budget) => observeProcessInstanceFingerprint(child.pid, { ...budget, runCaptureImpl, platform }),
      { signal: lifetime.signal },
    ),
    close() {
      signal?.removeEventListener('abort', stop);
      child?.off?.('exit', stop);
      stop();
    },
  };
}

async function readRootFingerprint({ spawned, fail, stoppedReason }) {
  const root = await spawned.identity;
  if (root?.status === 'ok') return root.fingerprint;
  return fail(stoppedReason() ?? root?.reason ?? 'process-identity-unavailable');
}

async function assertSpawnedProcessOwnsReceipt(receipt, rootFingerprint, listenerFingerprint, {
  spawned,
  exactProcess,
  platform,
  fail,
  withBudget,
  runCaptureImpl,
  getProcessGroupIdImpl,
}) {
  if (exactProcess) {
    if (!processInstanceFingerprintMatches(rootFingerprint, listenerFingerprint)) fail('process-instance-mismatch');
    return;
  }
  if (platform === 'win32') {
    const ancestry = await withBudget((budget) => observeWindowsProcessAncestry(receipt.pid, {
      ...budget,
      stopAtPid: spawned.pid,
      runCaptureImpl,
    }));
    if (ancestry.status !== 'ok') fail(ancestry.reason);
    const verified = isVerifiedProcessAncestry(ancestry.rows, {
      leafPid: receipt.pid,
      ancestorPid: spawned.pid,
      ancestorFingerprint: rootFingerprint,
    });
    if (!verified || !processInstanceFingerprintMatches(listenerFingerprint, ancestry.rows[0].fingerprint)) {
      fail('process-ancestry-unverified');
    }
    return;
  }
  const groups = await withBudget((budget) => Promise.all(
    [receipt.pid, spawned.pid].map((pid) => getProcessGroupIdImpl(pid, budget)),
  ));
  if (!Array.isArray(groups) || !groups[0] || groups[0] !== groups[1]) fail('process-ancestry-unverified');
}

async function assertListenerEvidenceAgrees(receipt, { endpoint, spawned, scope, platform, fail, getProcessGroupIdImpl }) {
  if (platform === 'win32') {
    // Some Windows hosts cannot list a real listener, so absence is not evidence here; only a
    // row for another process, or a failed discovery, contradicts the API identity.
    const observation = await scope.observe(endpoint.port);
    if (observation.status !== 'ok') fail('listener-discovery-inconclusive');
    if (observation.pids.some((pid) => Number(pid) !== receipt.pid)) fail('listener-contradiction');
    return;
  }
  const listenerPid = await resolveSpawnedProcessGroupListenPid(
    { port: endpoint.port, spawnedPid: spawned.pid },
    { observationScope: scope, getProcessGroupIdImpl },
  ).catch((error) => fail('listener-discovery-inconclusive', error));
  if (listenerPid !== receipt.pid) fail('listener-contradiction');
}

/** Both proofs end here: nothing is verified until the identities are re-read unchanged. */
async function finishProof({ spawned, fail, stoppedReason, readFingerprint }, {
  listenerPid,
  listenerFingerprint,
  rootFingerprint,
  proofKind,
  receiptSettled,
  apiInstanceId = null,
}) {
  const finalListenerFingerprint = await readFingerprint(listenerPid);
  const finalRootFingerprint = listenerPid === spawned.pid
    ? finalListenerFingerprint
    : await readFingerprint(spawned.pid);
  if (
    !processInstanceFingerprintMatches(listenerFingerprint, finalListenerFingerprint)
    || !processInstanceFingerprintMatches(rootFingerprint, finalRootFingerprint)
  ) {
    fail('process-instance-changed');
  }
  const stopped = stoppedReason();
  if (stopped) fail(stopped);
  const listenerApiIdentity = apiInstanceId ? { apiInstanceId } : {};
  return {
    listenerPid,
    wrapperPid: spawned.pid,
    proof: proofKind,
    receiptSettled,
    verifiedProcessInstances: {
      serverPid: { pid: listenerPid, fingerprint: listenerFingerprint, ...listenerApiIdentity },
      serverWrapperPid: {
        pid: spawned.pid,
        fingerprint: rootFingerprint,
        ...(listenerPid === spawned.pid ? listenerApiIdentity : {}),
      },
    },
  };
}

async function proveApiIdentity(proof) {
  const {
    endpoint, spawned, attempt, fail, stoppedReason, withBudget, readReadyIdentity, readFingerprint,
  } = proof;
  const receipt = await withBudget((budget) => waitForServerStartupReceipt({
    ...budget,
    path: attempt.path,
    nonce: attempt.nonce,
    requireApi: true,
  }).catch((error) => ({ failure: error?.code ?? 'timeout' })));
  if (!receipt?.api) {
    // A deadline also aborts the wait, so "cancelled" is only real when the proof itself stopped.
    const failure = receipt?.failure === 'cancelled' || !receipt?.failure ? 'timeout' : receipt.failure;
    fail(stoppedReason() ?? `receipt-${failure}`);
  }

  const rootFingerprint = await readRootFingerprint(proof);
  if (proof.exactProcess && receipt.pid !== spawned.pid) fail('receipt-pid-mismatch');
  const listenerFingerprint = await readFingerprint(receipt.pid);
  await assertSpawnedProcessOwnsReceipt(receipt, rootFingerprint, listenerFingerprint, proof);

  if (!listenAddressCoversEndpoint(receipt.api, endpoint)) fail('endpoint-mismatch');
  // Read after the receipt: only this answer ties the attested process to the probed endpoint.
  const ready = await readReadyIdentity();
  if (ready?.status !== 'identity' || ready.instanceId !== receipt.api.instanceId) {
    fail(stoppedReason() ?? 'api-identity-mismatch');
  }

  await assertListenerEvidenceAgrees(receipt, proof);
  return await finishProof(proof, {
    listenerPid: receipt.pid,
    listenerFingerprint,
    rootFingerprint,
    proofKind: 'api_identity',
    receiptSettled: true,
    apiInstanceId: receipt.api.instanceId,
  });
}

/**
 * A healthy server with no identity to give. OS evidence must be conclusive alone, and every other
 * requirement of the API proof still holds. A receipt with API evidence is not legacy at all.
 */
async function proveOlderRuntimeListener(proof) {
  const {
    endpoint, spawned, attempt, exactProcess, scope, fail, stoppedReason, readReadyIdentity, readFingerprint,
    getProcessGroupIdImpl,
  } = proof;
  const rootFingerprint = await readRootFingerprint(proof);
  const listenerPid = await resolveSpawnedProcessGroupListenPid(
    { port: endpoint.port, spawnedPid: spawned.pid },
    { observationScope: scope, getProcessGroupIdImpl },
  );

  // Read after the listener proof, so a receipt written meanwhile is judged too.
  // Only a missing file is an absent receipt. Anything else there is evidence that cannot be read.
  const receiptText = await readFile(attempt.path, 'utf8').catch((error) => (
    error?.code === 'ENOENT' ? null : fail('receipt-unreadable', error)
  ));
  const receipt = receiptText === null ? null : parseServerStartupReceiptText(receiptText);
  if (receiptText !== null && !receipt) fail('receipt-malformed');
  if (receipt?.api) return await proveApiIdentity(proof);
  if (receipt && (receipt.nonce !== attempt.nonce || receipt.pid !== listenerPid)) {
    fail('receipt-contradicts-listener');
  }

  if (exactProcess && listenerPid !== spawned.pid) fail('listener-pid-mismatch');
  const listenerFingerprint = await readFingerprint(listenerPid);
  const ready = await readReadyIdentity();
  if (ready?.status !== 'legacy') fail(stoppedReason() ?? ready?.reason ?? 'ready-changed');
  return await finishProof(proof, {
    listenerPid,
    listenerFingerprint,
    rootFingerprint,
    proofKind: 'os_listener',
    receiptSettled: receipt !== null,
  });
}

/**
 * The single decision that a spawned server, and no other process, answers on `endpoint`.
 *
 * A server with an armed receipt proves itself: its receipt names the process, its identity is
 * read back from the endpoint, and process identity ties that process to the spawn. OS listener
 * discovery can only contradict this, because some Windows hosts do not list real listeners. Only
 * an affirmative legacy `/ready` may use OS evidence instead, which must then be conclusive alone.
 * Everything runs in `spawned`'s scope and lifetime from `trackSpawnedServerProcess`.
 */
export async function proveSpawnedServerOwnership(
  { endpoint, spawned, attempt, exactProcess = false },
  {
    fetchReadyIdentityImpl = fetchExactServerReadyIdentity,
    getProcessGroupIdImpl = getProcessGroupId,
    runCaptureImpl = runCapture,
    platform = process.platform,
  } = {},
) {
  const scope = spawned.observationScope;
  const stoppedReason = () => {
    if (hasSpawnedChildExited(spawned.child)) return 'server-process-exited';
    return spawned.signal.aborted ? 'cancelled' : null;
  };
  const fail = (reason, cause) => {
    const error = new Error(
      `[local] server readiness ownership could not be proven on port ${endpoint.port}: ${reason}`,
      cause ? { cause } : undefined,
    );
    error.code = 'ESERVEROWNERSHIPUNPROVEN';
    error.reason = reason;
    throw error;
  };
  const withBudget = (probe) => scope.withProcessProbeBudget(probe, { signal: spawned.signal });
  const readReadyIdentity = () => withBudget((budget) => fetchReadyIdentityImpl({ ...endpoint, ...budget }));
  const readFingerprint = async (pid) => {
    const observation = await withBudget((budget) => observeProcessInstanceFingerprint(pid, {
      ...budget,
      runCaptureImpl,
      platform,
    }));
    if (observation.status === 'ok') return observation.fingerprint;
    return fail(stoppedReason() ?? observation.reason ?? 'process-not-found');
  };
  const proof = {
    endpoint,
    spawned,
    attempt,
    exactProcess,
    scope,
    platform,
    fail,
    stoppedReason,
    withBudget,
    readReadyIdentity,
    readFingerprint,
    runCaptureImpl,
    getProcessGroupIdImpl,
  };

  const ready = await readReadyIdentity();
  const stopped = stoppedReason();
  if (stopped) fail(stopped);
  if (ready?.status === 'identity') return await proveApiIdentity(proof);
  if (ready?.status === 'legacy') return await proveOlderRuntimeListener(proof);
  return fail(ready?.reason ?? 'ready-unavailable');
}

/**
 * Fresh proof that a server proven at startup still answers on `port`, for when OS discovery
 * concludes but lists no row for it, as some Windows hosts do. Nothing recorded is trusted on its
 * own: the process must still have its recorded identity, and this endpoint must answer now with
 * the API instance proven for it. Read-only, and it never adopts anything else.
 */
export async function proveRecordedServerListener(
  { port, pid, identity, stackName, envPath, cliHomeDir },
  {
    observationScope,
    resolvePidStackOwnershipImpl = resolvePidStackOwnership,
    fetchReadyIdentityImpl = fetchExactServerReadyIdentity,
  } = {},
) {
  const ownership = await observationScope.withProcessProbeBudget((budget) => resolvePidStackOwnershipImpl(
    pid,
    { stackName, envPath, cliHomeDir, processInstanceFingerprint: identity.fingerprint },
    budget,
  ));
  if (ownership?.status === 'inconclusive') return 'inconclusive';
  if (ownership?.owned !== true) return 'contradicted';

  const ready = await observationScope.withProcessProbeBudget((budget) => fetchReadyIdentityImpl({
    host: '127.0.0.1',
    port,
    ...budget,
  }));
  if (ready?.status === 'identity') return ready.instanceId === identity.apiInstanceId ? 'proven' : 'contradicted';
  return ready?.status === 'legacy' ? 'contradicted' : 'inconclusive';
}

export async function resolveStackOwnedListenPid(
  { port, stackName, envPath },
  {
    listListenPidsImpl,
    listListenPidsWithStatusImpl = listListenPidsWithStatus,
    observationScope,
    listenerTotalTimeoutMs = 750,
    listenerAttemptTimeoutMs = 250,
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
