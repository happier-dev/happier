import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { readAuthenticationStatus } from '@/api/client/httpStatusError';
import { logger } from '@/ui/logger';
import {
  DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS,
  waitForSessionMetadataRetryBackoff,
} from '@/agent/runtime/sessionMetadataWaitRetryBackoff';

import type {
  ActiveTurnPendingPumpOptions,
  DrainPendingOptions,
  DrainPendingResult,
  MessageBatch,
  PendingForegroundSteerability,
  PendingQueueDeliveryTiming,
  PendingMaterializationReconcileWhenEmpty,
  PendingMaterializationResult,
  SessionProviderInputConsumer,
} from './types';
import { PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE } from './pendingQueueDrainPolicy';
import { readPendingLocalId } from '@happier-dev/protocol';
import type { RuntimeActivitySnapshotTail } from '@/api/session/mutations/createSessionMutationOutbox';

const PENDING_INPUT_SLOW_PHASE_DIAGNOSTIC_MS = 30_000;

export class PendingQueueMaterializationAuthError extends Error {
  constructor() {
    super('Pending queue materialization stopped after supervisor authentication failure');
    this.name = 'PendingQueueMaterializationAuthError';
  }
}

export interface SessionProviderInputConsumerSession {
  materializeNextPendingMessageSafely: (opts?: {
    expectedPendingVersion?: number;
    reconcileWhenEmpty?: PendingMaterializationReconcileWhenEmpty;
    activeTurnSteerability?: PendingForegroundSteerability;
    pendingQueueDeliveryTiming?: PendingQueueDeliveryTiming;
    expectedRuntimeActivityRevision?: number;
  }) => Promise<PendingMaterializationResult>;
  shouldAttemptPendingMaterialization?: ((opts?: {
    activeTurnSteerability?: PendingForegroundSteerability;
    pendingQueueDeliveryTiming?: PendingQueueDeliveryTiming;
  }) => boolean) | undefined;
  reconcilePendingQueueState?: ((opts: { force: boolean }) => unknown | Promise<unknown>) | undefined;
  blockPendingMessageDelivery?: ((params: Readonly<{
    localIds: readonly string[];
    reason: 'unknown';
  }>) => Promise<boolean>) | undefined;
  waitForPendingEligibilityUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
  readRuntimeActivitySnapshotTail?: (() => RuntimeActivitySnapshotTail) | undefined;
  waitForRuntimeActivitySnapshotTailChange?: ((sequence: number, signal?: AbortSignal) => Promise<boolean>) | undefined;
}

export interface SessionProviderInputConsumerOptions<Mode, Message> {
  messageQueue: MessageQueue2<Mode, Message>;
  session: SessionProviderInputConsumerSession;
  onMetadataUpdate?: ((abortSignal: AbortSignal) => void | Promise<void>) | null | undefined;
  reconcileWhenEmpty?: PendingMaterializationReconcileWhenEmpty | undefined;
  activeTurnSteerability?: PendingForegroundSteerability | undefined;
  resolveActiveTurnSteerability?: (() => PendingForegroundSteerability) | undefined;
  pendingQueueDeliveryTiming?: PendingQueueDeliveryTiming | undefined;
  resolvePendingQueueDeliveryTiming?: (() => PendingQueueDeliveryTiming | undefined) | undefined;
  metadataWaitRetryBackoffMs?: number | undefined;
  pendingDrainMaxPopPerWake?: number | undefined;
}

type WakeWinner =
  | { kind: 'queue'; hasMessages: boolean }
  | { kind: 'meta'; ok: boolean };

function buildMaterializeOptions(
  reconcileWhenEmpty: PendingMaterializationReconcileWhenEmpty,
  activeTurnSteerability: PendingForegroundSteerability | undefined,
  pendingQueueDeliveryTiming: PendingQueueDeliveryTiming | undefined,
  expectedRuntimeActivityRevision?: number,
): {
  expectedPendingVersion?: number;
  reconcileWhenEmpty: PendingMaterializationReconcileWhenEmpty;
  activeTurnSteerability?: PendingForegroundSteerability;
  pendingQueueDeliveryTiming?: PendingQueueDeliveryTiming;
  expectedRuntimeActivityRevision?: number;
} {
  return {
    reconcileWhenEmpty,
    ...(activeTurnSteerability ? { activeTurnSteerability } : {}),
    ...(pendingQueueDeliveryTiming ? { pendingQueueDeliveryTiming } : {}),
    ...(expectedRuntimeActivityRevision !== undefined ? { expectedRuntimeActivityRevision } : {}),
  };
}

function readCommittedIdleRuntimeActivityRevision(
  tail: RuntimeActivitySnapshotTail,
): number | undefined {
  const settlement = tail.settlement;
  if (tail.custody !== null || settlement === null) return undefined;
  if (
    typeof settlement.identity.mutationKey !== 'string'
    || settlement.identity.mutationKey.trim().length === 0
    || !Number.isSafeInteger(settlement.identity.admissionOrder)
    || settlement.identity.admissionOrder <= 0
    || (settlement.result !== 'applied' && settlement.result !== 'unchanged')
    || settlement.desiredValue.state !== 'idle'
    || settlement.desiredValue.activeCount !== 0
    || settlement.committedProjection.state !== 'idle'
    || settlement.committedProjection.activeCount !== 0
    || !Number.isSafeInteger(settlement.committedRevision)
    || settlement.committedRevision < 0
    || settlement.committedProjection.revision !== settlement.committedRevision
  ) return undefined;
  return settlement.committedRevision;
}

async function materializeWithRuntimeActivityTail(
  session: SessionProviderInputConsumerSession,
  options: ReturnType<typeof buildMaterializeOptions>,
  abortSignal: AbortSignal,
): Promise<PendingMaterializationResult> {
  const first = await observePendingInputPhase(
    'materialize',
    async () => await session.materializeNextPendingMessageSafely(options),
  );
  if (
    options.pendingQueueDeliveryTiming !== 'after_runtime_idle'
    || first.type !== 'deferred'
    || first.reason !== 'runtime_activity_unknown'
  ) return first;

  while (!abortSignal.aborted) {
    const tail = session.readRuntimeActivitySnapshotTail?.();
    if (!tail) return first;
    const expectedRuntimeActivityRevision = readCommittedIdleRuntimeActivityRevision(tail);
    if (expectedRuntimeActivityRevision !== undefined) {
      return await observePendingInputPhase(
        'materialize_runtime_tail_retry',
        async () => await session.materializeNextPendingMessageSafely({
          ...options,
          expectedRuntimeActivityRevision,
        }),
      );
    }
    if (tail.custody === null || !session.waitForRuntimeActivitySnapshotTailChange) return first;
    if (!await session.waitForRuntimeActivitySnapshotTailChange(tail.sequence, abortSignal)) return first;
  }
  return first;
}

function readActiveTurnSteerability(opts: {
  activeTurnSteerability?: PendingForegroundSteerability | undefined;
  resolveActiveTurnSteerability?: (() => PendingForegroundSteerability) | undefined;
}): PendingForegroundSteerability | undefined {
  return opts.resolveActiveTurnSteerability?.() ?? opts.activeTurnSteerability;
}

function readPendingQueueDeliveryTiming(opts: {
  pendingQueueDeliveryTiming?: PendingQueueDeliveryTiming | undefined;
  resolvePendingQueueDeliveryTiming?: (() => PendingQueueDeliveryTiming | undefined) | undefined;
}): PendingQueueDeliveryTiming | undefined {
  return opts.resolvePendingQueueDeliveryTiming?.() ?? opts.pendingQueueDeliveryTiming;
}

function buildAttemptOptions(
  activeTurnSteerability: PendingForegroundSteerability | undefined,
  pendingQueueDeliveryTiming: PendingQueueDeliveryTiming | undefined,
): {
  activeTurnSteerability?: PendingForegroundSteerability;
  pendingQueueDeliveryTiming?: PendingQueueDeliveryTiming;
} {
  return {
    ...(activeTurnSteerability ? { activeTurnSteerability } : {}),
    ...(pendingQueueDeliveryTiming ? { pendingQueueDeliveryTiming } : {}),
  };
}

function logInputConsumerMaterializationDecision(opts: {
  source: 'waitForNextInput' | 'drainPending';
  reconcileWhenEmpty: PendingMaterializationReconcileWhenEmpty;
  activeTurnSteerability: PendingForegroundSteerability | undefined;
  result: PendingMaterializationResult;
}): void {
  logger.debug('[pendingQueue] input consumer materialization decision', {
    source: opts.source,
    reconcileWhenEmpty: opts.reconcileWhenEmpty,
    activeTurnSteerability: opts.activeTurnSteerability ?? 'unsteerable',
    resultType: opts.result.type,
    ...(opts.result.type === 'materialized'
      ? {
          localId: opts.result.localId,
          seq: opts.result.seq,
        }
      : {}),
    ...(opts.result.type === 'deferred' ? { deferredReason: opts.result.reason } : {}),
  });
}

function readPendingDeliveryLocalIdsFromError(error: unknown): string[] {
  if (!error || typeof error !== 'object') return [];
  const record = error as {
    localId?: unknown;
    localIds?: unknown;
    userMessageLocalIds?: unknown;
  };
  const rawValues = [
    record.localId,
    ...(Array.isArray(record.localIds) ? record.localIds : []),
    ...(Array.isArray(record.userMessageLocalIds) ? record.userMessageLocalIds : []),
  ];
  const seen = new Set<string>();
  const localIds: string[] = [];
  for (const rawValue of rawValues) {
    const localId = readPendingLocalId(rawValue) ?? '';
    if (!localId || seen.has(localId)) continue;
    seen.add(localId);
    localIds.push(localId);
  }
  return localIds;
}

export function createSessionProviderInputConsumer<Mode, Message>(
  opts: SessionProviderInputConsumerOptions<Mode, Message>,
): SessionProviderInputConsumer<Mode, Message> {
  let waitForNextInputTurn: Promise<void> = Promise.resolve();
  let drainPendingTurn: Promise<void> = Promise.resolve();
  let providerInputAdmissionOpen = true;
  let activeProviderInputDispatches = 0;
  let activePendingMaterializationRequests = 0;
  let providerInputBatchReserved = false;
  const activeProviderInputAdmissionWorkDrainWaiters = new Set<() => void>();

  const notifyProviderInputAdmissionWorkDrained = (): void => {
    if (activeProviderInputDispatches > 0 || activePendingMaterializationRequests > 0) return;
    for (const notify of [...activeProviderInputAdmissionWorkDrainWaiters]) {
      activeProviderInputAdmissionWorkDrainWaiters.delete(notify);
      notify();
    }
  };

  const waitForActiveProviderInputAdmissionWork = async (): Promise<void> => {
    while (activeProviderInputDispatches > 0 || activePendingMaterializationRequests > 0) {
      await new Promise<void>((resolve) => activeProviderInputAdmissionWorkDrainWaiters.add(resolve));
    }
  };

  const runProviderInputDispatch = async <Value>(dispatchOpts: Readonly<{
    abortSignal: AbortSignal;
    dispatch: () => Promise<Value>;
  }>): Promise<Readonly<{ status: 'dispatched'; value: Value }> | Readonly<{ status: 'cancelled' }>> => {
    if (!providerInputAdmissionOpen || dispatchOpts.abortSignal.aborted) {
      return { status: 'cancelled' };
    }
    // This increment and closeProviderInputAdmissionAndWaitForDispatches's flag write are
    // synchronous, establishing the one event-loop order for replacement versus dispatch.
    providerInputBatchReserved = false;
    activeProviderInputDispatches += 1;
    try {
      return { status: 'dispatched', value: await dispatchOpts.dispatch() };
    } finally {
      activeProviderInputDispatches -= 1;
      notifyProviderInputAdmissionWorkDrained();
    }
  };

  const admissionTrackedSession: SessionProviderInputConsumerSession = {
    materializeNextPendingMessageSafely: async (materializeOpts) => {
      if (!providerInputAdmissionOpen) return { type: 'no_pending' };
      activePendingMaterializationRequests += 1;
      try {
        const result = await opts.session.materializeNextPendingMessageSafely(materializeOpts);
        if (!providerInputAdmissionOpen && result.type === 'materialized') {
          const localId = readPendingLocalId(result.localId);
          if (localId && opts.session.blockPendingMessageDelivery) {
            await opts.session.blockPendingMessageDelivery({
              localIds: [localId],
              reason: 'unknown',
            });
          }
          return { type: 'no_pending' };
        }
        return result;
      } finally {
        activePendingMaterializationRequests -= 1;
        notifyProviderInputAdmissionWorkDrained();
      }
    },
    waitForPendingEligibilityUpdate: (abortSignal) => opts.session.waitForPendingEligibilityUpdate(abortSignal),
    ...(opts.session.readRuntimeActivitySnapshotTail
      ? { readRuntimeActivitySnapshotTail: () => opts.session.readRuntimeActivitySnapshotTail!() }
      : {}),
    ...(opts.session.waitForRuntimeActivitySnapshotTailChange
      ? {
          waitForRuntimeActivitySnapshotTailChange: (sequence, signal) =>
            opts.session.waitForRuntimeActivitySnapshotTailChange!(sequence, signal),
        }
      : {}),
    ...(opts.session.shouldAttemptPendingMaterialization
      ? {
          shouldAttemptPendingMaterialization: (attemptOpts) =>
            opts.session.shouldAttemptPendingMaterialization!(attemptOpts),
        }
      : {}),
    ...(opts.session.reconcilePendingQueueState
      ? {
          reconcilePendingQueueState: (reconcileOpts) =>
            opts.session.reconcilePendingQueueState!(reconcileOpts),
        }
      : {}),
    ...(opts.session.blockPendingMessageDelivery
      ? {
          blockPendingMessageDelivery: (params) =>
            opts.session.blockPendingMessageDelivery!(params),
        }
      : {}),
  };

  const reconcileReservedProviderInputBatch = async (): Promise<void> => {
    if (
      !providerInputBatchReserved
      || !opts.session.reconcilePendingQueueState
      || !opts.session.shouldAttemptPendingMaterialization
    ) {
      return;
    }

    try {
      await opts.session.reconcilePendingQueueState({ force: false });
    } catch (error) {
      logger.debug('[pendingQueue] reserved provider-input reconciliation deferred', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const activeTurnSteerability = readActiveTurnSteerability(opts);
    const pendingQueueDeliveryTiming = readPendingQueueDeliveryTiming(opts);
    if (
      opts.session.shouldAttemptPendingMaterialization(
        buildAttemptOptions(activeTurnSteerability, pendingQueueDeliveryTiming),
      )
    ) {
      providerInputBatchReserved = false;
    }
  };

  const drainPending = async (drainOpts?: DrainPendingOptions): Promise<DrainPendingResult> => {
    const previousTurn = drainPendingTurn;
    let releaseTurn: () => void = () => {};
    const currentTurn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    drainPendingTurn = previousTurn.catch(() => undefined).then(() => currentTurn);

    try {
      const abortSignal = drainOpts?.abortSignal ?? new AbortController().signal;
      const canStart = await waitForSerializedWaitTurn(previousTurn, abortSignal);
      if (!canStart) {
        return { materialized: 0, stoppedReason: 'aborted' };
      }
      if (opts.messageQueue.size() > 0) {
        return { materialized: 0, stoppedReason: 'drain_disallowed' };
      }
      // A provider loop normally releases this reservation by dispatching the returned batch or
      // requesting its next input. If the exact durable row is instead resolved/discarded outside
      // that loop, reuse the session client's authoritative localId reconciliation before letting
      // the anonymous local reservation hide later Pending work.
      await reconcileReservedProviderInputBatch();
      if (providerInputBatchReserved) {
        return { materialized: 0, stoppedReason: 'drain_disallowed' };
      }
      const callerShouldContinue = drainOpts?.shouldContinue;
      return await drainPendingMessages(withDefaultDrainOptions(
        admissionTrackedSession,
        opts.pendingDrainMaxPopPerWake,
        opts.activeTurnSteerability,
        opts.resolveActiveTurnSteerability,
        opts.pendingQueueDeliveryTiming,
        opts.resolvePendingQueueDeliveryTiming,
        {
          ...drainOpts,
          shouldContinue: () => (
            providerInputAdmissionOpen
            && (callerShouldContinue?.() ?? true)
          ),
        },
      ));
    } finally {
      releaseTurn();
    }
  };

  return {
    runProviderInputDispatch,
    async closeProviderInputAdmissionAndWaitForDispatches() {
      providerInputAdmissionOpen = false;
      await waitForActiveProviderInputAdmissionWork();
    },
    async waitForNextInput(waitOpts) {
      const previousTurn = waitForNextInputTurn;
      let releaseTurn: () => void = () => {};
      const currentTurn = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      waitForNextInputTurn = previousTurn.catch(() => undefined).then(() => currentTurn);

      try {
        const canStart = await waitForSerializedWaitTurn(previousTurn, waitOpts.abortSignal);
        if (!canStart || waitOpts.abortSignal.aborted || !providerInputAdmissionOpen) {
          return null;
        }
        // Requesting the next input is the provider loop's acknowledgement that the previously
        // returned batch has left the dequeue-to-invocation gap. This is the completion signal
        // for long-lived provider dispatches that consume multiple batches within one dispatch.
        providerInputBatchReserved = false;
        const batch = await waitForNextInput({
          ...opts,
          session: admissionTrackedSession,
          abortSignal: waitOpts.abortSignal,
          isProviderInputAdmissionOpen: () => providerInputAdmissionOpen,
        });
        if (
          batch?.pendingProviderAction !== undefined
          && batch.userMessageLocalIds?.length === 1
        ) {
          // The queue no longer exposes this batch, but the provider has not accepted it yet.
          // Reserve local custody across the dequeue-to-dispatch gap.
          providerInputBatchReserved = true;
        }
        return batch;
      } finally {
        releaseTurn();
      }
    },
    drainPending,
    async pumpPendingWhileActive(pumpOpts) {
      await pumpPendingWhileActive({
        ...pumpOpts,
        waitForPendingEligibilityUpdate: admissionTrackedSession.waitForPendingEligibilityUpdate,
        drainPending,
      });
    },
  };
}

async function pumpPendingWhileActive(
  opts: ActiveTurnPendingPumpOptions & Readonly<{
    waitForPendingEligibilityUpdate: SessionProviderInputConsumerSession['waitForPendingEligibilityUpdate'];
    drainPending: (drainOpts?: DrainPendingOptions) => Promise<DrainPendingResult>;
  }>,
): Promise<void> {
  while (!opts.abortSignal.aborted && (opts.shouldContinue?.() ?? true)) {
    const wakeController = new AbortController();
    const onAbort = () => wakeController.abort(opts.abortSignal.reason);
    opts.abortSignal.addEventListener('abort', onAbort, { once: true });
    if (opts.abortSignal.aborted) wakeController.abort(opts.abortSignal.reason);

    let passDirty = false;
    const armedWake = opts.waitForPendingEligibilityUpdate(wakeController.signal).then(
      (updated) => {
        if (updated) passDirty = true;
        return updated;
      },
      () => false,
    );

    try {
      const result = await opts.drainPending({
        ...opts,
        abortSignal: opts.abortSignal,
      });
      if (
        opts.abortSignal.aborted
        || !(opts.shouldContinue?.() ?? true)
        || result.stoppedReason === 'aborted'
        || result.stoppedReason === 'auth_failure'
      ) return;
      if (passDirty) continue;
      const didWake = await armedWake || (
        !opts.abortSignal.aborted
        && await opts.waitForPendingEligibilityUpdate(opts.abortSignal).catch(() => false)
      );
      if (!didWake) return;
    } finally {
      opts.abortSignal.removeEventListener('abort', onAbort);
      wakeController.abort('active-turn-pending-pass-complete');
    }
  }
}

async function waitForSerializedWaitTurn(previousTurn: Promise<void>, abortSignal: AbortSignal): Promise<boolean> {
  if (abortSignal.aborted) {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    let done = false;

    const finish = (canStart: boolean) => {
      if (done) return;
      done = true;
      abortSignal.removeEventListener('abort', onAbort);
      resolve(canStart);
    };

    const onAbort = () => finish(false);
    abortSignal.addEventListener('abort', onAbort, { once: true });

    previousTurn.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

async function waitForNextInput<Mode, Message>(
  opts: SessionProviderInputConsumerOptions<Mode, Message> & {
    abortSignal: AbortSignal;
    isProviderInputAdmissionOpen: () => boolean;
  },
): Promise<MessageBatch<Mode, Message> | null> {
  const metadataWaitRetryBackoffMs = opts.metadataWaitRetryBackoffMs ?? DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS;
  let timedMaterializationRejoinConsumed = false;

  while (true) {
    if (opts.abortSignal.aborted || !opts.isProviderInputAdmissionOpen()) {
      return null;
    }
    // Arm ordinary wakes before the complete reconcile/materialize pass. A wake at any awaited
    // phase marks this pass dirty and forces a full re-run; it never materializes directly.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.abortSignal.addEventListener('abort', onAbort, { once: true });
    if (opts.abortSignal.aborted) controller.abort();
    let passDirty = false;
    const wakePromise = waitForWakeSignal({
      messageQueue: opts.messageQueue,
      waitForPendingEligibilityUpdate: opts.session.waitForPendingEligibilityUpdate,
      controller,
      metadataWaitRetryBackoffMs,
    }).then((winner) => {
      passDirty = true;
      return winner;
    });

    const existingBatch = await collectQueuedBatch(opts.messageQueue, opts.abortSignal);
    if (existingBatch) {
      controller.abort('sessionProviderInputConsumer-batch');
      opts.abortSignal.removeEventListener('abort', onAbort);
      if (!opts.isProviderInputAdmissionOpen()) return null;
      await callMetadataUpdate(opts.onMetadataUpdate, opts.abortSignal);
      if (opts.abortSignal.aborted) {
        return null;
      }
      return existingBatch;
    }

    const materializationRetryAfterMs = await materializePendingMessage(opts);
    if (!opts.isProviderInputAdmissionOpen()) return null;

    const materializedBatch = await collectQueuedBatch(opts.messageQueue, opts.abortSignal);
    if (materializedBatch) {
      controller.abort('sessionProviderInputConsumer-materialized');
      opts.abortSignal.removeEventListener('abort', onAbort);
      await callMetadataUpdate(opts.onMetadataUpdate, opts.abortSignal);
      if (opts.abortSignal.aborted) {
        return null;
      }
      return materializedBatch;
    }

    if (materializationRetryAfterMs !== null && !timedMaterializationRejoinConsumed) {
      timedMaterializationRejoinConsumed = true;
      const retryOrWake = await Promise.race([
        wakePromise.then((winner) => ({ kind: 'wake' as const, winner })),
        waitForSessionMetadataRetryBackoff({
          abortSignal: controller.signal,
          backoffMs: materializationRetryAfterMs,
        }).then(() => ({ kind: 'retry' as const })),
      ]);
      controller.abort('sessionProviderInputConsumer-materialization-retry');
      opts.abortSignal.removeEventListener('abort', onAbort);
      if (opts.abortSignal.aborted || !opts.isProviderInputAdmissionOpen()) return null;
      if (retryOrWake.kind === 'wake') {
        if (retryOrWake.winner.kind === 'queue' && !retryOrWake.winner.hasMessages) return null;
        if (retryOrWake.winner.kind === 'meta' && retryOrWake.winner.ok) {
          await callMetadataUpdate(opts.onMetadataUpdate, opts.abortSignal);
        }
      }
      continue;
    }

    try {
      if (opts.messageQueue.size() > 0 || passDirty || !opts.isProviderInputAdmissionOpen()) {
        controller.abort('sessionProviderInputConsumer-dirty-pass');
        if (!opts.isProviderInputAdmissionOpen()) return null;
        if (passDirty) {
          const dirtyWinner = await wakePromise;
          if (dirtyWinner.kind === 'meta' && dirtyWinner.ok) {
            await callMetadataUpdate(opts.onMetadataUpdate, opts.abortSignal);
          }
        }
        continue;
      }

      const winner = await wakePromise;

      if (winner.kind === 'meta' && !winner.ok) {
        controller.abort('sessionProviderInputConsumer-meta-false');

        if (opts.abortSignal.aborted) {
          return null;
        }

        continue;
      }

      controller.abort('sessionProviderInputConsumer');

      if (winner.kind === 'queue' && !winner.hasMessages) return null;
      if (winner.kind === 'meta' && winner.ok) {
        await callMetadataUpdate(opts.onMetadataUpdate, opts.abortSignal);
      }
      controller.abort('sessionProviderInputConsumer-rerun');
      continue;
    } finally {
      opts.abortSignal.removeEventListener('abort', onAbort);
    }
  }
}

async function collectQueuedBatch<Mode, Message>(
  messageQueue: MessageQueue2<Mode, Message>,
  abortSignal: AbortSignal,
): Promise<MessageBatch<Mode, Message> | null> {
  if (messageQueue.size() <= 0) {
    return null;
  }
  return await messageQueue.waitForMessagesAndGetAsString(abortSignal);
}

async function materializePendingMessage<Mode, Message>(
  opts: SessionProviderInputConsumerOptions<Mode, Message> & {
    abortSignal: AbortSignal;
    isProviderInputAdmissionOpen: () => boolean;
  },
): Promise<number | null> {
  const reconcileWhenEmpty = opts.reconcileWhenEmpty ?? 'skip';
  let activeTurnSteerability = readActiveTurnSteerability(opts);
  let result: PendingMaterializationResult;
  try {
    if (!opts.isProviderInputAdmissionOpen()) return null;
    activeTurnSteerability = readActiveTurnSteerability(opts);
    const pendingQueueDeliveryTiming = readPendingQueueDeliveryTiming(opts);
    result = await materializeWithRuntimeActivityTail(
      opts.session,
      buildMaterializeOptions(
        reconcileWhenEmpty,
        activeTurnSteerability,
        pendingQueueDeliveryTiming,
      ),
      opts.abortSignal,
    );
  } catch (error) {
    if (
      opts.abortSignal.aborted
      && error instanceof Error
      && error.name === 'AbortError'
    ) return null;
    if (readAuthenticationStatus(error) !== null) {
      throw new PendingQueueMaterializationAuthError();
    }
    logger.debug('[pendingQueue] input consumer materialization failed (non-fatal)', error);
    const localIds = readPendingDeliveryLocalIdsFromError(error);
    if (localIds.length === 1 && opts.session.blockPendingMessageDelivery) {
      await opts.session.blockPendingMessageDelivery({
        localIds,
        reason: 'unknown',
      });
    }
    return null;
  }
  logInputConsumerMaterializationDecision({
    source: 'waitForNextInput',
    reconcileWhenEmpty,
    activeTurnSteerability,
    result,
  });
  if (result.type === 'materialized') {
    // The transcript update path owns queue delivery; do not synthesize a provider batch from the pending payload.
    return null;
  }
  if (result.type === 'auth_failure') {
    throw new PendingQueueMaterializationAuthError();
  }
  if (result.type === 'deferred' && result.reason === 'supervisor_auth_failed') {
    throw new PendingQueueMaterializationAuthError();
  }
  if (result.type !== 'retryable_transport') return null;

  // A transport retry without a server-provided delay can otherwise consume the only
  // eligibility wake and then wait forever for another event. Reuse the session client's
  // authoritative reconciliation hook before one bounded local retry; connection recovery
  // remains responsible for publishing subsequent wakes, so this is not a polling loop.
  if (opts.session.reconcilePendingQueueState) {
    await Promise.resolve(opts.session.reconcilePendingQueueState({ force: true })).catch((error: unknown) => {
      logger.debug('[pendingQueue] retryable transport reconciliation failed (non-fatal)', error);
    });
  }
  return result.retryAfterMs
    ?? opts.metadataWaitRetryBackoffMs
    ?? DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS;
}

function withDefaultDrainOptions(
  session: SessionProviderInputConsumerSession,
  defaultMaxPopPerWake: number | undefined,
  defaultActiveTurnSteerability: PendingForegroundSteerability | undefined,
  defaultResolveActiveTurnSteerability: (() => PendingForegroundSteerability) | undefined,
  defaultPendingQueueDeliveryTiming: PendingQueueDeliveryTiming | undefined,
  defaultResolvePendingQueueDeliveryTiming: (() => PendingQueueDeliveryTiming | undefined) | undefined,
  drainOpts: DrainPendingOptions | undefined,
): DrainPendingOptions & { session: SessionProviderInputConsumerSession } {
  const steerabilityOverride = drainOpts?.activeTurnSteerability !== undefined;
  const deliveryTimingOverride = drainOpts?.pendingQueueDeliveryTiming !== undefined;

  return {
    ...(drainOpts ?? {}),
    session,
    maxPopPerWake: drainOpts?.maxPopPerWake ?? defaultMaxPopPerWake,
    activeTurnSteerability: drainOpts?.activeTurnSteerability ?? defaultActiveTurnSteerability,
    resolveActiveTurnSteerability: drainOpts?.resolveActiveTurnSteerability
      ?? (steerabilityOverride ? undefined : defaultResolveActiveTurnSteerability),
    pendingQueueDeliveryTiming: drainOpts?.pendingQueueDeliveryTiming ?? defaultPendingQueueDeliveryTiming,
    resolvePendingQueueDeliveryTiming: drainOpts?.resolvePendingQueueDeliveryTiming
      ?? (deliveryTimingOverride ? undefined : defaultResolvePendingQueueDeliveryTiming),
  };
}

async function drainPendingMessages(
  opts: DrainPendingOptions & { session: SessionProviderInputConsumerSession },
): Promise<DrainPendingResult> {
  // A materialized row has already left durable server custody and may be replaced locally by a
  // later isolate/control prompt. Keep the claim boundary one row wide regardless of legacy
  // drain-all configuration; the provider loop must consume this invocation before another claim.
  const maxPopPerWake = PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE;
  let materialized = 0;

  for (let i = 0; i < maxPopPerWake; i += 1) {
    try {
      if (opts.abortSignal?.aborted) {
        return { materialized, stoppedReason: 'aborted' };
      }
      if (opts.shouldContinue && !opts.shouldContinue()) {
        return { materialized, stoppedReason: 'drain_disallowed' };
      }

      const activeTurnSteerability = readActiveTurnSteerability(opts);
      const pendingQueueDeliveryTiming = readPendingQueueDeliveryTiming(opts);
      const attemptOpts = buildAttemptOptions(activeTurnSteerability, pendingQueueDeliveryTiming);
      const canMaterialize = opts.session.shouldAttemptPendingMaterialization?.(attemptOpts) ?? true;
      if (!canMaterialize) {
        await opts.session.reconcilePendingQueueState?.({ force: true });
        if (opts.abortSignal?.aborted) {
          return { materialized, stoppedReason: 'aborted' };
        }
        if (!(opts.session.shouldAttemptPendingMaterialization?.(attemptOpts) ?? true)) {
          return { materialized, stoppedReason: 'materialization_blocked' };
        }
      }

      const result = await materializeNextPendingForDrain(
        opts.session,
        opts,
      );
      if (result === 'materialized') {
        materialized += 1;
        continue;
      }
      return { materialized, stoppedReason: result };
    } catch (error) {
      return { materialized, stoppedReason: readDrainErrorStoppedReason(error, opts) };
    }
  }

  return { materialized, stoppedReason: 'max_pop_per_wake' };
}

async function materializeNextPendingForDrain(
  session: SessionProviderInputConsumerSession,
  opts: DrainPendingOptions,
): Promise<Exclude<DrainPendingResult['stoppedReason'], 'aborted' | 'drain_disallowed' | 'materialization_blocked' | 'max_pop_per_wake'> | 'materialized'> {
  try {
    const reconcileWhenEmpty = 'force';
    let activeTurnSteerability = readActiveTurnSteerability(opts);
    if (opts.shouldContinue && !opts.shouldContinue()) return 'no_pending';
    activeTurnSteerability = readActiveTurnSteerability(opts);
    const pendingQueueDeliveryTiming = readPendingQueueDeliveryTiming(opts);
    const result = await materializeWithRuntimeActivityTail(
      session,
      buildMaterializeOptions(
        reconcileWhenEmpty,
        activeTurnSteerability,
        pendingQueueDeliveryTiming,
      ),
      opts.abortSignal ?? new AbortController().signal,
    );
    logInputConsumerMaterializationDecision({
      source: 'drainPending',
      reconcileWhenEmpty,
      activeTurnSteerability,
      result,
    });
    if (result.type === 'materialized') {
      return 'materialized';
    }
    if (result.type === 'deferred') {
      if (result.reason === 'supervisor_auth_failed') {
        logTerminalAuthDrainStop(opts, null);
        return 'auth_failure';
      }
      return 'deferred';
    }
    if (result.type === 'auth_failure') {
      logTerminalAuthDrainStop(opts, result.statusCode);
      return 'auth_failure';
    }
    if (result.type === 'retryable_transport') return 'error';
    return 'no_pending';
  } catch (error) {
    return readDrainErrorStoppedReason(error, opts);
  }
}

function readDrainErrorStoppedReason(error: unknown, opts: DrainPendingOptions): 'auth_failure' | 'error' {
  const terminalAuthStatus = readAuthenticationStatus(error);
  if (terminalAuthStatus !== null) {
    logTerminalAuthDrainStop(opts, terminalAuthStatus);
    return 'auth_failure';
  }
  return 'error';
}

function logTerminalAuthDrainStop(opts: DrainPendingOptions, status: 401 | 403 | null): void {
  logger.debug(`${opts.logPrefix ?? '[INPUT-CONSUMER]'} Stopping pending queue drain after terminal auth failure`, {
    ...(status !== null ? { status } : {}),
    ...(opts.reason ? { reason: opts.reason } : {}),
  });
}

async function waitForWakeSignal<Mode, Message>(opts: {
  messageQueue: MessageQueue2<Mode, Message>;
  waitForPendingEligibilityUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
  controller: AbortController;
  metadataWaitRetryBackoffMs: number;
}): Promise<WakeWinner> {
  const queueWait = opts.messageQueue
    .waitForMessagesSignal(opts.controller.signal)
    .then((hasMessages) => ({ kind: 'queue' as const, hasMessages }));
  try {
    while (true) {
      if (opts.controller.signal.aborted) {
        return { kind: 'meta', ok: false };
      }

      const metaWait = opts.waitForPendingEligibilityUpdate(opts.controller.signal)
        .then(
          (ok) => ({ kind: 'meta' as const, ok }),
          () => ({ kind: 'meta' as const, ok: false }),
        );

      const winner = await Promise.race([queueWait, metaWait]);
      if (winner.kind !== 'meta' || winner.ok || opts.controller.signal.aborted) {
        return winner;
      }

      const queueIdleOrBackoffWinner = await Promise.race([
        queueWait,
        waitForSessionMetadataRetryBackoff({
          abortSignal: opts.controller.signal,
          backoffMs: opts.metadataWaitRetryBackoffMs,
        }).then(() => null),
      ]);
      if (queueIdleOrBackoffWinner) {
        return queueIdleOrBackoffWinner;
      }
    }
  } finally {
    // The caller owns the controller and aborts losing waits after each pass.
  }
}

async function callMetadataUpdate(
  onMetadataUpdate: ((abortSignal: AbortSignal) => void | Promise<void>) | null | undefined,
  abortSignal: AbortSignal,
): Promise<void> {
  if (!onMetadataUpdate || abortSignal.aborted) return;

  let releaseAbort: (() => void) | undefined;
  const aborted = new Promise<'aborted'>((resolve) => {
    const onAbort = () => resolve('aborted');
    abortSignal.addEventListener('abort', onAbort, { once: true });
    releaseAbort = () => abortSignal.removeEventListener('abort', onAbort);
  });
  const reconciled = Promise.resolve()
    .then(async () => await observePendingInputPhase(
      'metadata_reconcile',
      async () => await onMetadataUpdate(abortSignal),
    ))
    .then(
      () => 'reconciled' as const,
      () => 'failed' as const,
    );

  try {
    await Promise.race([reconciled, aborted]);
  } finally {
    releaseAbort?.();
  }
}

async function observePendingInputPhase<T>(
  phase: 'materialize' | 'materialize_runtime_tail_retry' | 'metadata_reconcile',
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  let slowDiagnosticEmitted = false;
  const timer = setTimeout(() => {
    slowDiagnosticEmitted = true;
    logger.infoFile('[pendingQueue] input consumer phase remains unsettled', {
      elapsedMs: Date.now() - startedAt,
      phase,
    });
  }, PENDING_INPUT_SLOW_PHASE_DIAGNOSTIC_MS);
  timer.unref?.();

  try {
    return await operation();
  } finally {
    clearTimeout(timer);
    if (slowDiagnosticEmitted) {
      logger.infoFile('[pendingQueue] input consumer slow phase settled', {
        elapsedMs: Date.now() - startedAt,
        phase,
      });
    }
  }
}
