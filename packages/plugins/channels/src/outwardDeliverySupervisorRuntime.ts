import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { ConversationOutwardDeliverySupervisorOptions, ConversationOutwardDeliverySupervisor, ConversationOutwardRetentionSweepState } from './outwardDeliverySupervisor.js';
import { CHANNEL_STATE_COLLECTION, CHANNEL_STATE_INDEX_ID, CHANNEL_STATE_RECORD_KIND, CHANNEL_DELIVERIES_COLLECTION, CHANNEL_DELIVERIES_INDEX_ID } from './collections.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';
import { createSupervisorWake } from './supervisorWake.js';
import { createOutwardBindingObservation } from './outwardBindingObservation.js';
import { createChannelsCollectionAccess } from './collectionUpdateRequired.js';
import { classifySupervisorFailure, isInactiveSupervisorCollectionFailure } from './supervisorFailure.js';
import { createSessionStatusProjection } from './sessionStatusProjection.js';
import { publishSessionStatus } from './sessionStatusProviderAction.js';
import { readCurrentProviderContributionForPersistedSelection } from './providerContributions.js';

type Clock = NonNullable<ConversationOutwardDeliverySupervisorOptions['clock']>;

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Outward delivery supervisor was cancelled.'));
      return;
    }
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      globalThis.clearTimeout(timer);
      reject(signal.reason ?? new Error('Outward delivery supervisor was cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const DEFAULT_CLOCK: Clock = Object.freeze({
  now: () => Date.now(),
  sleep: defaultSleep,
});

function positiveDelay(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function logOutwardDeliverySupervisorCycleFailure(
  context: BackgroundServiceContext,
  error: unknown,
): void {
  if (isInactiveSupervisorCollectionFailure(error)) return;
  context.services.logger.warn('[Channels] outward delivery supervisor cycle failed', {
    boundary: 'cycle',
    ...(classifySupervisorFailure(error) ?? {}),
  });
}

/**
 * One activation-owned runner drives projection and retained custody. It owns
 * no Account cache or durable queue: restart simply starts from Collection
 * state, while a transient keyset cursor prevents one hot row from starving a
 * later retained row during this generation.
 */
export function createConversationOutwardDeliverySupervisorRuntime(
  options: ConversationOutwardDeliverySupervisorOptions & Required<Pick<ConversationOutwardDeliverySupervisorOptions, 'runCycle' | 'reconciliationIntervalMs'>>,
): ConversationOutwardDeliverySupervisor {
  const clock = options.clock ?? DEFAULT_CLOCK;
  const reconciliationIntervalMs = positiveDelay(
    options.reconciliationIntervalMs,
    'Outward delivery reconciliation interval',
  );
  const runCycle = options.runCycle;
  let controller: AbortController | null = null;
  let running: Promise<void> | null = null;
  let disposed = false;
  let updateRequired = false;

  const run = async (context: BackgroundServiceContext): Promise<void> => {
    if (disposed) throw new Error('Outward delivery supervisor is disposed.');
    if (running !== null) throw new Error('Outward delivery supervisor is already running.');
    if (updateRequired) return;
    const supervisorController = new AbortController();
    controller = supervisorController;
    const abortFromContext = (): void => supervisorController.abort(context.signal.reason);
    if (context.signal.aborted) abortFromContext();
    else context.signal.addEventListener('abort', abortFromContext, { once: true });
    let deliveryCursor: string | undefined;
    let deliveryDeadline: number | undefined;
    let retentionSweep: ConversationOutwardRetentionSweepState | undefined;
    const wake = createSupervisorWake(supervisorController.signal);
    const observations: Array<{ dispose(): void }> = [];
    const inFlightWork = new Map<string, { bindingId?: string; pending: Promise<void>; rescan: boolean }>();
    const pendingIngressObservations = new Map<string, { dispose(): void }>();
    let discoverBindings = true;
    const changedBindingIds = new Set<string>();
    const retryBindingIds = new Set<string>();
    const sessions = createOutwardBindingObservation({ ...context, signal: supervisorController.signal }, bindingIds => {
      for (const bindingId of bindingIds) changedBindingIds.add(bindingId);
      wake.wake();
    });
    const sessionStatus = createSessionStatusProjection(async (target, status, messageId) => {
      try {
        const result = await publishSessionStatus({ ...context, signal: supervisorController.signal }, target, status, messageId);
        if (result.kind !== 'delivered' && !(result.kind === 'notReady' && result.reason === 'unsupported')) {
          context.services.logger.warn('[Channels] Session status unavailable', {
            bindingId: target.source.bindingId, outcome: result.kind,
            ...(result.kind === 'notReady' ? { reason: result.reason } : {}),
          });
        }
        return result;
      } catch (error) {
        context.services.logger.warn('[Channels] Session status unavailable', {
          bindingId: target.source.bindingId, ...(classifySupervisorFailure(error) ?? {}),
        });
        return { kind: 'outcomeUnknown' };
      }
    });
    let discoveryInvalidated = false;
    let retentionInvalidated = false;
    const invalidate = () => {
      discoveryInvalidated = true;
      wake.wake();
    };
    running = (async () => {
      try {
        const access = createChannelsCollectionAccess(requireChannelsAccountStorage(context), (status, error) => {
          updateRequired = true;
          context.services.logger.warn('[Channels] Account Collection requires an update', status);
          supervisorController.abort(error);
        });
        context = { ...context, services: { ...context.services, storage: {
          ...context.services.storage, account: access.storage,
        } } };
        const account = access.storage;
        // Only structural changes require binding discovery. Input publication
        // uses its Session selector; projection-frontier writes are our output.
        observations.push(account.collection(CHANNEL_STATE_COLLECTION).watch({
          index: CHANNEL_STATE_INDEX_ID.byKind,
          prefixes: [CHANNEL_STATE_RECORD_KIND.connection, CHANNEL_STATE_RECORD_KIND.binding].map(kind => [kind]),
          order: 'asc',
        }, () => { discoverBindings = true; invalidate(); }));
        observations.push(account.collection(CHANNEL_DELIVERIES_COLLECTION).watch({ kind: 'collection' }, invalidate));
        observations.push(account.collection(CHANNEL_DELIVERIES_COLLECTION).watch({
          index: CHANNEL_DELIVERIES_INDEX_ID.byTerminalUpdatedAt, prefix: [true], order: 'asc',
        }, () => { retentionInvalidated = true; invalidate(); }));
        while (!supervisorController.signal.aborted) {
          // Retirement and delivery writes emit the same hints as foreign
          // changes. Finish the current keyset pass before replaying them,
          // otherwise each written page restarts discovery at the same prefix.
          // The fresh pass still discovers changes behind either cursor.
          if (discoveryInvalidated && deliveryCursor === undefined && retentionSweep?.cursor === undefined) {
            discoveryInvalidated = false;
            if (retryBindingIds.size === 0) deliveryDeadline = undefined;
            // Delivery writes discover live work, but cannot make existing
            // terminal rows cross their already-known retention deadline.
            if (retentionInvalidated && retentionSweep?.notBefore === undefined) retentionSweep = undefined;
            retentionInvalidated = false;
          }
          const fullBindingDiscovery = discoverBindings;
          discoverBindings = false;
          const bindingIds = new Set(changedBindingIds);
          changedBindingIds.clear();
          if (fullBindingDiscovery) {
            // A structural change may remove an active binding from discovery.
            // Rejoin its current target after the admitted predecessor drains.
            for (const work of inFlightWork.values()) {
              if (work.bindingId !== undefined) changedBindingIds.add(work.bindingId);
            }
          }
          if (deliveryDeadline !== undefined && deliveryDeadline <= clock.now()) {
            for (const bindingId of retryBindingIds) bindingIds.add(bindingId);
            retryBindingIds.clear();
            deliveryDeadline = undefined;
          }
          wake.reset();
          const observedBindings = new Map<string, string>();
          const observedDiscussions = new Map<string, string>();
          const observedPendingIngress = new Set<string>();
          let nextWakeAt: number | undefined;
          let continuationStalled = false;
          const workerContext = {
            ...context,
            signal: supervisorController.signal,
          } satisfies BackgroundServiceContext;
          try {
            if (deliveryCursor === undefined && retryBindingIds.size === 0) deliveryDeadline = undefined;
            const cycle = await runCycle({
              context: workerContext,
              now: clock.now,
              sessionStatus,
              sessionActivity: sessions.activity,
              scheduleWork: (key, work, projectBinding) => {
                const workKey = JSON.stringify(key);
                const bindingId = key[0] === 'binding' ? key[1] : undefined;
                const active = inFlightWork.get(workKey);
                if (active !== undefined) {
                  if (projectBinding && bindingId !== undefined) changedBindingIds.add(bindingId);
                  else active.rescan = true;
                  return;
                }
                // Register before running so synchronous completion cannot leave
                // a phantom attempt. The generation owns cancellation and drain.
                const pending = Promise.resolve().then(work).then(result => {
                  if (result.nextBindingIds === 'all') discoverBindings = true;
                  else for (const id of result.nextBindingIds ?? []) retryBindingIds.add(id);
                  if (result.nextWakeAt !== undefined) {
                    deliveryDeadline = Math.min(deliveryDeadline ?? Infinity, result.nextWakeAt);
                  }
                  if (bindingId !== undefined && (projectBinding
                    || observedBindings.has(bindingId) || observedDiscussions.has(bindingId))) {
                    sessions.reconcile(observedBindings, observedDiscussions, { bindingId });
                    sessionStatus.reconcile(new Set(observedBindings.keys()), bindingId);
                  }
                }).catch(error => {
                  if (supervisorController.signal.aborted) return;
                  logOutwardDeliverySupervisorCycleFailure(workerContext, error);
                  if (bindingId !== undefined) retryBindingIds.add(bindingId);
                  deliveryDeadline = Math.min(deliveryDeadline ?? Infinity, clock.now() + reconciliationIntervalMs);
                }).finally(() => {
                  const rescan = inFlightWork.get(workKey)?.rescan;
                  inFlightWork.delete(workKey);
                  if (rescan) invalidate();
                  if (discoverBindings || changedBindingIds.size > 0 || deliveryDeadline !== undefined) wake.wake();
                });
                inFlightWork.set(workKey, { bindingId, pending, rescan: false });
              },
              ...(fullBindingDiscovery ? {} : { bindingIds: [...bindingIds] }),
              observeSession: async (sessionId, bindingId, target) => {
                observedBindings.set(bindingId, sessionId);
                const provider = target?.connection.providerAction;
                const contribution = provider === undefined ? undefined : await readCurrentProviderContributionForPersistedSelection({
                  context: { targetedContributions: context.services.targetedContributions, signal: supervisorController.signal },
                  providerPluginId: provider.providerPluginId, providerContributionSelection: provider.providerContributionSelection,
                });
                await sessions.observe(sessionId, bindingId, contribution?.operations.sessionStatus !== undefined);
              },
              observeDiscussion: (discussionId, bindingId) => {
                observedDiscussions.set(bindingId, discussionId);
                sessions.observeDiscussion(discussionId, bindingId);
              },
              observePendingIngress: rowId => {
                observedPendingIngress.add(rowId);
                if (pendingIngressObservations.has(rowId)) return;
                pendingIngressObservations.set(rowId, account.collection(CHANNEL_STATE_COLLECTION).watch({
                  kind: 'row', rowId,
                }, invalidate));
                // The finalizer read this blocker before subscribing. Rejoin
                // once under observation, then park until its owner settles it.
                invalidate();
              },
              ...(deliveryCursor === undefined ? {} : { deliveryCursor }),
              ...(retentionSweep === undefined ? {} : { retentionSweep }),
            });
            const advancedContinuation = (cycle.nextDeliveryCursor !== undefined && cycle.nextDeliveryCursor !== deliveryCursor)
              || (cycle.nextRetentionSweep?.cursor !== undefined && cycle.nextRetentionSweep.cursor !== retentionSweep?.cursor);
            continuationStalled = (cycle.nextDeliveryCursor !== undefined && cycle.nextDeliveryCursor === deliveryCursor)
              || (cycle.nextRetentionSweep?.cursor !== undefined && cycle.nextRetentionSweep.cursor === retentionSweep?.cursor);
            deliveryCursor = cycle.nextDeliveryCursor;
            retentionSweep = cycle.nextRetentionSweep;
            nextWakeAt = cycle.nextWakeAt;
            if (cycle.nextBindingIds === 'all') discoverBindings = true;
            else for (const bindingId of cycle.nextBindingIds ?? []) retryBindingIds.add(bindingId);
            if (nextWakeAt !== undefined) deliveryDeadline = Math.min(deliveryDeadline ?? Infinity, nextWakeAt);
            nextWakeAt = deliveryDeadline;
            if (advancedContinuation || (discoveryInvalidated && !continuationStalled)) nextWakeAt = clock.now();
            else if (retentionSweep?.notBefore !== undefined) {
              nextWakeAt = Math.min(nextWakeAt ?? Infinity, retentionSweep.notBefore);
            }
            if (fullBindingDiscovery && cycle.nextBindingIds !== 'all') {
              const pendingBindingIds = new Set([...inFlightWork.values()]
                .flatMap(work => work.bindingId === undefined ? [] : [work.bindingId]));
              sessions.reconcile(observedBindings, observedDiscussions, { preserveBindingIds: pendingBindingIds });
              sessionStatus.reconcile(new Set([...observedBindings.keys(), ...pendingBindingIds]));
            }
            for (const [rowId, observation] of pendingIngressObservations) {
              if (observedPendingIngress.has(rowId)) continue;
              observation.dispose();
              pendingIngressObservations.delete(rowId);
            }
          } catch (error) {
            // Leave the cursor unchanged so a transient failure cannot skip
            // a durable row. The next wake repeats canonical discovery.
            if (!supervisorController.signal.aborted) {
              logOutwardDeliverySupervisorCycleFailure(workerContext, error);
              if (fullBindingDiscovery) discoverBindings = true;
              else for (const bindingId of bindingIds) retryBindingIds.add(bindingId);
              nextWakeAt = clock.now() + reconciliationIntervalMs;
              deliveryDeadline = Math.min(deliveryDeadline ?? Infinity, nextWakeAt);
              continuationStalled = true;
            }
          }
          if (supervisorController.signal.aborted) break;
          try {
            // The pending hint is retained above. Do not let its wake bit
            // bypass a failed page's recovery. Healthy exhausted scans still
            // replay hints immediately, independently of unrelated deadlines.
            if (continuationStalled && discoveryInvalidated && nextWakeAt !== undefined && nextWakeAt > clock.now()) wake.reset();
            await wake.wait(clock, nextWakeAt);
          } catch {
            if (!supervisorController.signal.aborted) {
              throw new Error('Outward delivery supervisor wait failed.');
            }
          }
        }
      } finally {
        supervisorController.abort();
        await Promise.allSettled([...inFlightWork.values()].map(work => work.pending));
        for (const observation of observations) observation.dispose();
        for (const observation of pendingIngressObservations.values()) observation.dispose();
        pendingIngressObservations.clear();
        sessions.dispose();
        wake.dispose();
        context.signal.removeEventListener('abort', abortFromContext);
        controller = null;
      }
    })();
    try {
      await running;
    } finally {
      running = null;
    }
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    controller?.abort(new Error('Outward delivery supervisor was disposed.'));
    await running;
  };

  return Object.freeze({ run, dispose });
}
