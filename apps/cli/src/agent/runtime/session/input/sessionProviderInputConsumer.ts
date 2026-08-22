import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { readAuthenticationStatus } from '@/api/client/httpStatusError';
import { logger } from '@/ui/logger';
import {
  isSessionPendingQueueHoldBlockingPendingDrain,
  type SessionPendingQueueDeliveryTiming,
} from '@happier-dev/protocol';
import {
  DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS,
  waitForSessionMetadataRetryBackoff,
} from '@/agent/runtime/session/metadataWaitRetryBackoff';

import type {
  ActiveTurnPendingPumpOptions,
  DrainPendingOptions,
  DrainPendingResult,
  MessageBatch,
  PendingMaterializationReconcileWhenEmpty,
  ProviderInputActionRequiredDisposition,
  SessionProviderInputConsumer,
  SessionProviderInputConsumerSession,
  WaitForNextProviderInputOptions,
} from './_types';
import type {
  MaterializeNextPendingResult,
  RuntimeActivitySnapshotTail,
} from '@/api/session/sessionClientPort';

const PENDING_INPUT_SLOW_PHASE_DIAGNOSTIC_MS = 30_000;

type WakeWinner =
  | { kind: 'queue'; hasMessages: boolean; refreshBeforeReturn?: boolean }
  | { kind: 'meta'; ok: boolean }
  | { kind: 'admission'; changed: boolean };

export class PendingQueueMaterializationAuthError extends Error {
  constructor() {
    super('Pending queue materialization stopped after supervisor authentication failure');
    this.name = 'PendingQueueMaterializationAuthError';
  }
}

export type SessionProviderInputConsumerOptions<Mode, Message> = Readonly<{
  messageQueue: MessageQueue2<Mode, Message>;
  session: SessionProviderInputConsumerSession;
  beforeCollectQueuedBatch?: (() => void | Promise<void>) | null;
  beforePendingMaterialize?: (() => boolean | Promise<boolean>) | null;
  onMetadataUpdate?: ((abortSignal: AbortSignal) => void | Promise<void>) | null;
  reconcileWhenEmpty?: PendingMaterializationReconcileWhenEmpty;
  pendingQueueDeliveryTiming?: SessionPendingQueueDeliveryTiming;
  resolvePendingQueueDeliveryTiming?: () => SessionPendingQueueDeliveryTiming;
  /** @deprecated Wake polling is disabled; provider input wakes only from canonical queue/metadata events. */
  metadataWaitRetryBackoffMs?: number;
  refreshBeforeQueuedBatch?: boolean;
  pendingDrainMaxPopPerWake?: number;
}>;

export function createSessionProviderPendingDrainAdapter(
  session: SessionProviderInputConsumerSession,
  defaults?: Readonly<{
    maxPopPerWake?: number;
    pendingQueueDeliveryTiming?: SessionPendingQueueDeliveryTiming;
  }>,
): Pick<SessionProviderInputConsumer<never, never>, 'drainPending'> {
  return {
    drainPending: async (options) => await drainPendingMessages(
      withDefaultDrainOptions(
        session,
        defaults?.maxPopPerWake,
        defaults?.pendingQueueDeliveryTiming,
        undefined,
        options,
      ),
    ),
  };
}

type WaitForNextInputOptions<Mode, Message> = SessionProviderInputConsumerOptions<Mode, Message> & {
  abortSignal: AbortSignal;
  waitUntilAdmitted: (abortSignal: AbortSignal) => Promise<boolean>;
  waitForAdmissionChange: (abortSignal: AbortSignal) => Promise<boolean>;
  takeReservedBatch: () => MessageBatch<Mode, Message> | null;
  reserveBatch: (batch: MessageBatch<Mode, Message>) => void;
  hasLocalInputCustody: () => boolean;
  isAdmitted: () => boolean;
  readPassSequence: () => number;
  runPendingMaterializationExclusive: <Value>(operation: () => Promise<Value>) => Promise<Value>;
};

function buildMaterializeOptions(
  reconcileWhenEmpty: PendingMaterializationReconcileWhenEmpty,
  pendingQueueDeliveryTiming: SessionPendingQueueDeliveryTiming | undefined,
  expectedRuntimeActivityRevision?: number,
): {
  reconcileWhenEmpty: PendingMaterializationReconcileWhenEmpty;
  deliveryTiming?: SessionPendingQueueDeliveryTiming;
  expectedRuntimeActivityRevision?: number;
} {
  return {
    reconcileWhenEmpty,
    ...(pendingQueueDeliveryTiming ? { deliveryTiming: pendingQueueDeliveryTiming } : {}),
    ...(expectedRuntimeActivityRevision !== undefined ? { expectedRuntimeActivityRevision } : {}),
  };
}

function readExactIdleRuntimeActivityRevision(
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
): Promise<MaterializeNextPendingResult> {
  const first = await observePendingInputPhase(
    'materialize',
    async () => await session.materializeNextPendingMessageSafely?.(options)
      ?? { type: 'retryable_transport' as const },
  );
  if (
    options.deliveryTiming !== 'after_runtime_idle'
    || first.type !== 'deferred'
    || first.reason !== 'runtime_activity_unknown'
  ) return first;

  while (!abortSignal.aborted) {
    const tail = session.readRuntimeActivitySnapshotTail?.();
    if (!tail) return first;
    const committedRevision = readExactIdleRuntimeActivityRevision(tail);
    if (committedRevision !== undefined) {
      return await observePendingInputPhase(
        'materialize_runtime_tail_retry',
        async () => await session.materializeNextPendingMessageSafely?.({
          ...options,
          expectedRuntimeActivityRevision: committedRevision,
        }) ?? { type: 'retryable_transport' as const },
      );
    }
    if (tail.custody === null || !session.waitForRuntimeActivitySnapshotTailChange) return first;
    if (!await session.waitForRuntimeActivitySnapshotTailChange(tail.sequence, abortSignal)) return first;
  }
  return first;
}

export function createSessionProviderInputConsumer<Mode, Message>(
  opts: SessionProviderInputConsumerOptions<Mode, Message>,
): SessionProviderInputConsumer<Mode, Message> {
  let waitForNextInputTurn: Promise<void> = Promise.resolve();
  let pendingMaterializationTurn: Promise<void> = Promise.resolve();
  let reservedBatch: MessageBatch<Mode, Message> | null = null;
  const admissionKey = (scope: ProviderInputActionRequiredDisposition) =>
    `${scope.reason}\u0000${scope.serviceId}\u0000${scope.groupId}`;
  const admissions = new Map<string, ProviderInputActionRequiredDisposition>();
  const readAdmission = (): ProviderInputActionRequiredDisposition | null =>
    admissions.values().next().value ?? null;
  const admissionWaiters = new Set<() => void>();
  let activeProviderInputDispatches = 0;
  const activeDispatchDrainWaiters = new Set<() => void>();
  let activePendingMaterializationTurns = 0;
  const activePendingMaterializationDrainWaiters = new Set<() => void>();
  let passSequence = 0;
  const markPassDirty = (): void => {
    passSequence += 1;
  };

  const hasLocalInputCustody = (): boolean =>
    reservedBatch !== null
    || opts.messageQueue.size() > 0;

  const runPendingMaterializationExclusive = async <Value>(
    operation: () => Promise<Value>,
  ): Promise<Value> => {
    const previousTurn = pendingMaterializationTurn;
    let releaseTurn: () => void = () => {};
    const currentTurn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    pendingMaterializationTurn = previousTurn.catch(() => undefined).then(() => currentTurn);

    activePendingMaterializationTurns += 1;
    try {
      await previousTurn.catch(() => undefined);
      return await operation();
    } finally {
      activePendingMaterializationTurns -= 1;
      if (activePendingMaterializationTurns === 0) {
        for (const notify of [...activePendingMaterializationDrainWaiters]) {
          activePendingMaterializationDrainWaiters.delete(notify);
          notify();
        }
      }
      releaseTurn();
    }
  };

  const notifyAdmissionChanged = (): void => {
    for (const notify of [...admissionWaiters]) notify();
  };

  const waitForAdmissionChange = async (abortSignal: AbortSignal): Promise<boolean> => {
    if (abortSignal.aborted) return false;
    return await new Promise<boolean>((resolve) => {
      const onChanged = () => finish(true);
      const onAbort = () => finish(false);
      const finish = (value: boolean) => {
        admissionWaiters.delete(onChanged);
        abortSignal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      admissionWaiters.add(onChanged);
      abortSignal.addEventListener('abort', onAbort, { once: true });
      if (abortSignal.aborted) onAbort();
    });
  };

  const waitUntilAdmitted = async (abortSignal: AbortSignal): Promise<boolean> => {
    while (readAdmission()) {
      if (!await waitForAdmissionChange(abortSignal)) return false;
    }
    return true;
  };

  const waitForActiveProviderInputDispatches = async (): Promise<void> => {
    while (activeProviderInputDispatches > 0) {
      await new Promise<void>((resolve) => {
        activeDispatchDrainWaiters.add(resolve);
      });
    }
  };

  const waitForActivePendingMaterializationTurns = async (): Promise<void> => {
    while (activePendingMaterializationTurns > 0) {
      await new Promise<void>((resolve) => {
        activePendingMaterializationDrainWaiters.add(resolve);
      });
    }
  };

  const runProviderInputDispatch = async <Value>(dispatchOpts: Readonly<{
    abortSignal: AbortSignal;
    dispatch: () => Promise<Value>;
  }>): Promise<Readonly<{ status: 'dispatched'; value: Value }> | Readonly<{ status: 'cancelled' }>> => {
    while (true) {
      if (dispatchOpts.abortSignal.aborted) {
        return { status: 'cancelled' };
      }
      if (readAdmission()) {
        if (!await waitUntilAdmitted(dispatchOpts.abortSignal)) {
          return { status: 'cancelled' };
        }
        continue;
      }

      // This increment and enforceProviderInputAdmission's admission write are synchronous,
      // establishing the one event-loop order that owns provider-input dispatch eligibility.
      activeProviderInputDispatches += 1;
      try {
        return { status: 'dispatched', value: await dispatchOpts.dispatch() };
      } finally {
        activeProviderInputDispatches -= 1;
        if (activeProviderInputDispatches === 0) {
          for (const notify of [...activeDispatchDrainWaiters]) {
            activeDispatchDrainWaiters.delete(notify);
            notify();
          }
        }
      }
    }
  };

  const runProviderInputDispatchFromAdmission = async <Value>(
    dispatchOpts: Readonly<{
      admission: Extract<
        ProviderInputActionRequiredDisposition,
        { reason: 'generation_pending' }
      >;
      abortSignal: AbortSignal;
      dispatch: () => Promise<Value>;
    }>,
  ): Promise<
    | Readonly<{ status: 'dispatched'; value: Value }>
    | Readonly<{ status: 'cancelled' }>
  > => {
    const key = admissionKey(dispatchOpts.admission);
    const hasExactAdmission = (): boolean => {
      const admission = admissions.get(key);
      return admission?.reason === 'generation_pending'
        && admission.serviceId === dispatchOpts.admission.serviceId
        && admission.groupId === dispatchOpts.admission.groupId
        && admission.epochId === dispatchOpts.admission.epochId;
    };
    const releaseExactAdmission = (): void => {
      if (!hasExactAdmission()) return;
      admissions.delete(key);
      markPassDirty();
      notifyAdmissionChanged();
    };

    while (true) {
      if (!hasExactAdmission()) {
        return { status: 'cancelled' };
      }
      if (dispatchOpts.abortSignal.aborted) {
        releaseExactAdmission();
        return { status: 'cancelled' };
      }
      const hasOtherAdmission = [...admissions.keys()].some(
        (candidate) => candidate !== key,
      );
      if (hasOtherAdmission) {
        if (!await waitForAdmissionChange(dispatchOpts.abortSignal)) {
          releaseExactAdmission();
          return { status: 'cancelled' };
        }
        continue;
      }

      // Keep the exact transition admission installed while synchronously
      // acquiring dispatch custody. Other provider-input waiters therefore
      // remain closed, while a newer admission waits for this accepted
      // dispatch to settle. The finally block consumes this exact epoch on
      // success, cancellation after acquisition, and Provider failure.
      activeProviderInputDispatches += 1;
      try {
        return {
          status: 'dispatched',
          value: await dispatchOpts.dispatch(),
        };
      } finally {
        activeProviderInputDispatches -= 1;
        releaseExactAdmission();
        if (activeProviderInputDispatches === 0) {
          for (const notify of [...activeDispatchDrainWaiters]) {
            activeDispatchDrainWaiters.delete(notify);
            notify();
          }
        }
      }
    }
  };

  const drainPending = async (drainOpts?: DrainPendingOptions): Promise<DrainPendingResult> => {
    const result: DrainPendingResult = await runPendingMaterializationExclusive(async (): Promise<DrainPendingResult> => {
      if (readAdmission()) {
        return { materialized: 0, stoppedReason: 'action_required' };
      }
      if (hasLocalInputCustody()) {
        return { materialized: 0, stoppedReason: 'materialization_blocked' };
      }
      const callerShouldContinue = drainOpts?.shouldContinue;
      const result = await drainPendingMessages(withDefaultDrainOptions(
        opts.session,
        opts.pendingDrainMaxPopPerWake,
        opts.resolvePendingQueueDeliveryTiming?.() ?? opts.pendingQueueDeliveryTiming,
        opts.resolvePendingQueueDeliveryTiming,
        {
          ...drainOpts,
          shouldContinue: async () => !readAdmission() && (await (callerShouldContinue?.() ?? true)),
        },
      ));
      return readAdmission()
        ? { materialized: result.materialized, stoppedReason: 'action_required' }
        : result;
    });
    markPassDirty();
    return result;
  };

  return {
    async enforceProviderInputAdmission(disposition) {
      admissions.set(admissionKey(disposition), disposition);
      markPassDirty();
      notifyAdmissionChanged();
      await Promise.all([
        waitForActiveProviderInputDispatches(),
        waitForActivePendingMaterializationTurns(),
      ]);
      return { status: 'enforced', disposition };
    },
    async clearProviderInputAdmission(scope) {
      let disposition: ProviderInputActionRequiredDisposition;
      if (scope.epochId === undefined) {
        disposition = {
          kind: 'action_required',
          reason: 'group_unavailable',
          serviceId: scope.serviceId,
          groupId: scope.groupId,
        };
      } else {
        disposition = {
          kind: 'action_required',
          reason: 'generation_pending',
          serviceId: scope.serviceId,
          groupId: scope.groupId,
          epochId: scope.epochId,
        };
      }
      const key = admissionKey(disposition);
      const admission = admissions.get(key);
      if (!admission || (
        scope.epochId !== undefined
        && (
          admission.reason !== 'generation_pending'
          || admission.epochId !== scope.epochId
        )
      )) {
        return { status: 'not_matched' };
      }
      admissions.delete(key);
      markPassDirty();
      notifyAdmissionChanged();
      return { status: 'cleared' };
    },
    readProviderInputAdmission() {
      return readAdmission() ?? { kind: 'admitted' };
    },
    async waitUntilProviderInputAdmitted(waitOpts) {
      return await waitUntilAdmitted(waitOpts.abortSignal);
    },
    runProviderInputDispatch,
    runProviderInputDispatchFromAdmission,
    async waitForNextInput(waitOpts: WaitForNextProviderInputOptions): Promise<MessageBatch<Mode, Message> | null> {
      const previousTurn = waitForNextInputTurn;
      let releaseTurn: () => void = () => {};
      const currentTurn = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      waitForNextInputTurn = previousTurn.catch(() => undefined).then(() => currentTurn);

      try {
        const canStart = await waitForSerializedWaitTurn(previousTurn, waitOpts.abortSignal);
        if (!canStart || waitOpts.abortSignal.aborted) {
          return null;
        }
        return await waitForNextInput({
          ...opts,
          ...waitOpts,
          abortSignal: waitOpts.abortSignal,
          waitUntilAdmitted,
          waitForAdmissionChange,
          takeReservedBatch: () => {
            const batch = reservedBatch;
            reservedBatch = null;
            if (batch) markPassDirty();
            return batch;
          },
          reserveBatch: (batch) => {
            reservedBatch = batch;
            markPassDirty();
          },
          hasLocalInputCustody,
          isAdmitted: () => readAdmission() === null,
          readPassSequence: () => passSequence,
          runPendingMaterializationExclusive,
        });
      } finally {
        releaseTurn();
      }
    },
    drainPending,
    async pumpPendingWhileActive(pumpOpts) {
      await pumpPendingWhileActive({
        ...pumpOpts,
        waitForMetadataUpdate: opts.session.waitForMetadataUpdate,
        waitForAdmissionChange,
        drainPending,
      });
    },
  };
}

async function pumpPendingWhileActive(
  opts: ActiveTurnPendingPumpOptions & Readonly<{
    waitForMetadataUpdate: SessionProviderInputConsumerSession['waitForMetadataUpdate'];
    waitForAdmissionChange: (abortSignal: AbortSignal) => Promise<boolean>;
    drainPending: (drainOpts?: DrainPendingOptions) => Promise<DrainPendingResult>;
  }>,
): Promise<void> {
  while (!opts.abortSignal.aborted && await (opts.shouldContinue?.() ?? true)) {
    const wakeController = new AbortController();
    const onAbort = () => wakeController.abort(opts.abortSignal.reason);
    opts.abortSignal.addEventListener('abort', onAbort, { once: true });
    if (opts.abortSignal.aborted) wakeController.abort(opts.abortSignal.reason);

    const waitForWake = async (): Promise<boolean> => await Promise.race([
      opts.waitForMetadataUpdate(wakeController.signal).catch(() => false),
      opts.waitForAdmissionChange(wakeController.signal),
    ]);
    let passDirty = false;
    const armedWake = waitForWake().then((didWake) => {
      if (didWake) passDirty = true;
      return didWake;
    });

    try {
      const result = await opts.drainPending({
        ...opts,
        abortSignal: opts.abortSignal,
      });
      if (
        opts.abortSignal.aborted
        || !(await (opts.shouldContinue?.() ?? true))
        || result.stoppedReason === 'aborted'
        || result.stoppedReason === 'auth_failure'
      ) return;
      if (passDirty) continue;
      const didWake = await armedWake || (
        !opts.abortSignal.aborted
        && await waitForWake()
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
  opts: WaitForNextInputOptions<Mode, Message>,
): Promise<MessageBatch<Mode, Message> | null> {
  const metadataWaitRetryBackoffMs =
    opts.metadataWaitRetryBackoffMs ?? DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS;
  const refreshBeforeQueuedBatch = opts.refreshBeforeQueuedBatch !== false;
  let timedMaterializationRejoinConsumed = false;

  while (true) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.abortSignal.addEventListener('abort', onAbort, { once: true });
    if (opts.abortSignal.aborted) {
      controller.abort();
    }

    try {
      const passSequence = opts.readPassSequence();
      const armedWake = waitForWakeSignal({
        messageQueue: opts.messageQueue,
        waitForMetadataUpdate: opts.session.waitForMetadataUpdate,
        waitForAdmissionChange: opts.waitForAdmissionChange,
        controller,
        metadataWaitRetryBackoffMs,
      });

      if (opts.abortSignal.aborted) return null;
      if (!await opts.waitUntilAdmitted(opts.abortSignal)) return null;
      const reservedBatch = opts.takeReservedBatch();
      if (reservedBatch) {
        controller.abort('sessionProviderInputConsumer-reserved');
        return reservedBatch;
      }

      const existingBatch = await collectQueuedBatch(opts);
      if (existingBatch) {
        controller.abort('sessionProviderInputConsumer-existing');
        return await returnBatch(opts, existingBatch, refreshBeforeQueuedBatch);
      }

      const materializationRetryAfterMs = await materializePendingMessage(opts);

      const materializedBatch = await collectQueuedBatch(opts);
      if (materializedBatch) {
        controller.abort('sessionProviderInputConsumer-materialized');
        return await returnBatch(opts, materializedBatch, refreshBeforeQueuedBatch);
      }

      if (
        opts.messageQueue.size() > 0
        || opts.readPassSequence() !== passSequence
        || !opts.isAdmitted()
      ) {
        controller.abort('sessionProviderInputConsumer-dirty-pass');
        continue;
      }

      let winner: WakeWinner | Readonly<{ kind: 'retry' }>;
      if (materializationRetryAfterMs === null || timedMaterializationRejoinConsumed) {
        winner = await armedWake;
      } else {
        timedMaterializationRejoinConsumed = true;
        winner = await Promise.race([
          armedWake,
          waitForSessionMetadataRetryBackoff({
            abortSignal: controller.signal,
            backoffMs: materializationRetryAfterMs,
          }).then(() => ({ kind: 'retry' as const })),
        ]);
      }

      if (winner.kind === 'retry') {
        controller.abort('sessionProviderInputConsumer-materialization-retry');
        continue;
      }

      if (winner.kind === 'meta' && !winner.ok) {
        controller.abort('sessionProviderInputConsumer-meta-false');

        if (opts.abortSignal.aborted) {
          return null;
        }

        await callMetadataUpdate(opts.onMetadataUpdate, opts.abortSignal);
        continue;
      }

      controller.abort('sessionProviderInputConsumer');

      if (winner.kind === 'queue') {
        if (!winner.hasMessages) {
          return null;
        }
        const queuedBatch = await collectQueuedBatch(opts);
        if (queuedBatch) {
          return await returnBatch(
            opts,
            queuedBatch,
            refreshBeforeQueuedBatch || winner.refreshBeforeReturn === true,
          );
        }
        continue;
      }

      if (winner.kind === 'meta') {
        await callMetadataUpdate(opts.onMetadataUpdate, opts.abortSignal);
        const refreshedBatch = await collectQueuedBatch(opts);
        if (refreshedBatch) {
          return await returnBatch(opts, refreshedBatch, false);
        }
      }
    } finally {
      opts.abortSignal.removeEventListener('abort', onAbort);
    }
  }
}

async function returnBatch<Mode, Message>(
  opts: WaitForNextInputOptions<Mode, Message>,
  batch: MessageBatch<Mode, Message>,
  refreshBeforeReturn: boolean,
): Promise<MessageBatch<Mode, Message> | null> {
  if (!await opts.waitUntilAdmitted(opts.abortSignal)) {
    opts.reserveBatch(batch);
    return null;
  }
  if (refreshBeforeReturn) {
    await callMetadataUpdate(opts.onMetadataUpdate, opts.abortSignal);
  }
  if (opts.abortSignal.aborted) {
    opts.reserveBatch(batch);
    return null;
  }
  if (!await opts.waitUntilAdmitted(opts.abortSignal)) {
    opts.reserveBatch(batch);
    return null;
  }
  return batch;
}

async function collectQueuedBatch<Mode, Message>(
  opts: WaitForNextInputOptions<Mode, Message>,
): Promise<MessageBatch<Mode, Message> | null> {
  await opts.beforeCollectQueuedBatch?.();
  if (opts.messageQueue.size() <= 0) {
    return null;
  }
  return await opts.messageQueue.waitForMessagesAndGetAsString(opts.abortSignal);
}

async function materializePendingMessage<Mode, Message>(
  opts: WaitForNextInputOptions<Mode, Message>,
): Promise<number | null> {
  return await opts.runPendingMaterializationExclusive(async () => {
    if (opts.abortSignal.aborted || !opts.isAdmitted() || opts.hasLocalInputCustody()) return null;
    if (isSessionPendingDrainBlocked(opts.session)) return null;
    if ((await (opts.beforePendingMaterialize?.() ?? true)) !== true) return null;
    if (!opts.isAdmitted() || opts.hasLocalInputCustody()) return null;
    if ((await reconcilePendingProviderInputCustodyBeforeMaterialization(opts.session)) !== true) return null;
    if (opts.abortSignal.aborted || !opts.isAdmitted() || opts.hasLocalInputCustody()) return null;

    let result: MaterializeNextPendingResult;
    try {
      result = await materializeWithRuntimeActivityTail(opts.session, buildMaterializeOptions(
          opts.reconcileWhenEmpty ?? 'throttled',
          opts.resolvePendingQueueDeliveryTiming?.() ?? opts.pendingQueueDeliveryTiming,
        ), opts.abortSignal);
    } catch (error) {
      if (error instanceof PendingQueueMaterializationAuthError) throw error;
      if (readAuthenticationStatus(error) !== null) {
        throw new PendingQueueMaterializationAuthError();
      }
      logger.debug('[INPUT-CONSUMER] Pending materialization episode failed nonfatally', { error });
      return null;
    }
    if (result.type === 'auth_failure' || (result.type === 'deferred' && result.reason === 'supervisor_auth_failed')) {
      throw new PendingQueueMaterializationAuthError();
    }
    return result.type === 'retryable_transport' && result.retryAfterMs !== undefined
      ? result.retryAfterMs
      : null;
  });
}

function withDefaultDrainOptions(
  session: SessionProviderInputConsumerSession,
  defaultMaxPopPerWake: number | undefined,
  defaultPendingQueueDeliveryTiming: SessionPendingQueueDeliveryTiming | undefined,
  resolvePendingQueueDeliveryTiming: (() => SessionPendingQueueDeliveryTiming) | undefined,
  drainOpts: DrainPendingOptions | undefined,
): DrainPendingOptions & {
  session: SessionProviderInputConsumerSession;
  pendingQueueDeliveryTiming: SessionPendingQueueDeliveryTiming;
  resolvePendingQueueDeliveryTiming?: () => SessionPendingQueueDeliveryTiming;
} {
  return {
    ...(drainOpts ?? {}),
    session,
    maxPopPerWake: drainOpts?.maxPopPerWake ?? defaultMaxPopPerWake,
    pendingQueueDeliveryTiming: defaultPendingQueueDeliveryTiming ?? 'after_foreground_ready',
    ...(resolvePendingQueueDeliveryTiming ? { resolvePendingQueueDeliveryTiming } : {}),
  };
}

async function drainPendingMessages(
  opts: DrainPendingOptions & {
    session: SessionProviderInputConsumerSession;
    pendingQueueDeliveryTiming: SessionPendingQueueDeliveryTiming;
    resolvePendingQueueDeliveryTiming?: () => SessionPendingQueueDeliveryTiming;
  },
): Promise<DrainPendingResult> {
  try {
    if (opts.abortSignal?.aborted) {
      return { materialized: 0, stoppedReason: 'aborted' };
    }
    if (isSessionPendingDrainBlocked(opts.session)) {
      return { materialized: 0, stoppedReason: 'materialization_blocked' };
    }
    if ((await reconcilePendingProviderInputCustodyBeforeMaterialization(opts.session)) !== true) {
      return { materialized: 0, stoppedReason: 'materialization_blocked' };
    }
    if (opts.abortSignal?.aborted) {
      return { materialized: 0, stoppedReason: 'aborted' };
    }
    if (opts.shouldContinue && !(await opts.shouldContinue())) {
      return { materialized: 0, stoppedReason: 'drain_disallowed' };
    }
    if (isSessionPendingDrainBlocked(opts.session)) {
      return { materialized: 0, stoppedReason: 'materialization_blocked' };
    }

    if ((await (opts.session.shouldAttemptPendingMaterialization?.() ?? true)) !== true) {
      await opts.session.reconcilePendingQueueState?.({ force: true });
      if (opts.abortSignal?.aborted) {
        return { materialized: 0, stoppedReason: 'aborted' };
      }
      if (isSessionPendingDrainBlocked(opts.session)) {
        return { materialized: 0, stoppedReason: 'materialization_blocked' };
      }
      if ((await (opts.session.shouldAttemptPendingMaterialization?.() ?? true)) !== true) {
        return { materialized: 0, stoppedReason: 'materialization_blocked' };
      }
    }

    const result = await materializeNextPendingForDrain(
      opts.session,
      opts,
    );
    return result === 'materialized'
      ? { materialized: 1, stoppedReason: 'max_pop_per_wake' }
      : { materialized: 0, stoppedReason: result };
  } catch (error) {
    return { materialized: 0, stoppedReason: readDrainErrorStoppedReason(error, opts) };
  }
}

async function reconcilePendingProviderInputCustodyBeforeMaterialization(
  session: SessionProviderInputConsumerSession,
): Promise<boolean> {
  return await (session.reconcilePendingProviderInputCustodyBeforeMaterialization?.() ?? true);
}

function isSessionPendingDrainBlocked(session: SessionProviderInputConsumerSession): boolean {
  if (!session.getMetadataSnapshot) {
    return false;
  }
  const metadata = session.getMetadataSnapshot();
  return isSessionPendingQueueHoldBlockingPendingDrain(metadata);
}

async function materializeNextPendingForDrain(
  session: SessionProviderInputConsumerSession,
  opts: DrainPendingOptions & {
    pendingQueueDeliveryTiming: SessionPendingQueueDeliveryTiming;
    resolvePendingQueueDeliveryTiming?: () => SessionPendingQueueDeliveryTiming;
  },
): Promise<Exclude<DrainPendingResult['stoppedReason'], 'aborted' | 'drain_disallowed' | 'materialization_blocked' | 'max_pop_per_wake'> | 'materialized'> {
  try {
      const result = await materializeWithRuntimeActivityTail(
          session,
          buildMaterializeOptions(
            'force',
            opts.resolvePendingQueueDeliveryTiming?.() ?? opts.pendingQueueDeliveryTiming,
          ),
          opts.abortSignal ?? new AbortController().signal,
        );
      if (result.type === 'materialized') return 'materialized';
      if (result.type === 'auth_failure') {
        logTerminalAuthDrainStop(opts, null);
        return 'auth_failure';
      }
      if (result.type === 'deferred') {
        if (result.reason === 'supervisor_auth_failed') {
          logTerminalAuthDrainStop(opts, null);
          return 'auth_failure';
        }
        return 'deferred';
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
  waitForMetadataUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
  waitForAdmissionChange: (abortSignal: AbortSignal) => Promise<boolean>;
  controller: AbortController;
  metadataWaitRetryBackoffMs: number;
}): Promise<WakeWinner> {
  const queueWait = opts.messageQueue
    .waitForMessagesSignal(opts.controller.signal)
    .then((hasMessages) => ({ kind: 'queue' as const, hasMessages }));
  const admissionWait = opts.waitForAdmissionChange(opts.controller.signal)
    .then((changed) => ({ kind: 'admission' as const, changed }));
  while (true) {
    if (opts.controller.signal.aborted) {
      return { kind: 'meta', ok: false };
    }

    const metaWait = opts.waitForMetadataUpdate(opts.controller.signal).then(
      (ok) => ({ kind: 'meta' as const, ok }),
      () => ({ kind: 'meta' as const, ok: false }),
    );

    const winner = await Promise.race([queueWait, metaWait, admissionWait]);
    if (winner.kind !== 'meta' || winner.ok || opts.controller.signal.aborted) {
      return winner;
    }

    const queueOrBackoffWinner = await Promise.race([
      queueWait,
      admissionWait,
      waitForSessionMetadataRetryBackoff({
        abortSignal: opts.controller.signal,
        backoffMs: opts.metadataWaitRetryBackoffMs,
      }).then(() => null),
    ]);
    if (queueOrBackoffWinner) {
      return queueOrBackoffWinner.kind === 'queue'
        ? { ...queueOrBackoffWinner, refreshBeforeReturn: true }
        : queueOrBackoffWinner;
    }
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
