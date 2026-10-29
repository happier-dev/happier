import { AsyncLocalStorage } from 'node:async_hooks';

import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { readAuthenticationStatus } from '@/api/client/httpStatusError';
import { logger } from '@/ui/logger';
import { isSessionPendingQueueHoldBlockingPendingDrain } from '@happier-dev/protocol/sessions/metadata/sessionPendingQueueHoldV1';
import { readSessionExplicitStopV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import type { SessionPendingQueueDeliveryTiming } from '@happier-dev/protocol';
import { SessionAgentActivityHeadlineV1Schema, SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityHeadlineV1';
import { isInProgressAgentActivityStatus } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityStatusV1';
import { SessionActionConfirmationsV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionActionConfirmationsV1';
import { derivePendingRequestFlagsFromAgentState } from '@happier-dev/session-core/pending';
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
  SessionInputLiveWork,
  WaitForNextProviderInputOptions,
} from './_types';
import type {
  MaterializeNextPendingOptions,
  MaterializeNextPendingResult,
  PendingMaterializationDiagnosticPhase,
  RuntimeActivitySnapshotTail,
} from '@/api/session/sessionClientPort';

const PENDING_INPUT_SLOW_PHASE_DIAGNOSTIC_MS = 30_000;

type WakeWinner =
  | { kind: 'queue'; hasMessages: boolean; refreshBeforeReturn?: boolean }
  | { kind: 'meta'; ok: boolean }
  | { kind: 'admission'; changed: boolean }
  | { kind: 'context_only'; changed: boolean };

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
  /** Host-private, non-queued input source used by centralized runtime owners. */
  takeContextOnlyInput?: ((abortSignal: AbortSignal) => Promise<MessageBatch<Mode, Message> | null>) | null;
  /** Remains ready for an unobserved source change until the corresponding take observes it. */
  waitForContextOnlyInputChange?: ((abortSignal: AbortSignal) => Promise<boolean>) | null;
}>;

export function createSessionProviderPendingDrainAdapter(
  session: SessionProviderInputConsumerSession,
  defaults?: Readonly<{
    maxPopPerWake?: number;
    pendingQueueDeliveryTiming?: SessionPendingQueueDeliveryTiming;
    afterDrain?: () => Promise<void>;
    waitForInputChange?: (abortSignal: AbortSignal) => Promise<boolean>;
  }>,
): Pick<SessionProviderInputConsumer<never, never>, 'drainPending' | 'pumpPendingWhileActive'> {
  const drainPending = async (options?: DrainPendingOptions): Promise<DrainPendingResult> => {
    const result = await drainPendingMessages(
      withDefaultDrainOptions(
        session,
        defaults?.maxPopPerWake,
        defaults?.pendingQueueDeliveryTiming,
        undefined,
        options,
      ),
    );
    await defaults?.afterDrain?.();
    return result;
  };
  return {
    drainPending,
    pumpPendingWhileActive: async (options) => await pumpPendingWhileActive({
      ...options,
      waitForMetadataUpdate: session.waitForMetadataUpdate,
      waitForAdmissionChange: defaults?.waitForInputChange,
      drainPending,
    }),
  };
}

type WaitForNextInputOptions<Mode, Message> = SessionProviderInputConsumerOptions<Mode, Message> & {
  abortSignal: AbortSignal;
  waitUntilAdmitted: (abortSignal: AbortSignal) => Promise<boolean>;
  waitForAdmissionChange: (abortSignal: AbortSignal) => Promise<boolean>;
  takeReservedBatch: () => MessageBatch<Mode, Message> | null;
  takeDeferredContextOnlyBatch: () => MessageBatch<Mode, Message> | null;
  hasDeferredContextOnlyBatch: () => boolean;
  resumeDeferredContextOnlyBatch: () => void;
  prepareContextOnlyInput: ((abortSignal: AbortSignal) => Promise<PromiseSettledResult<MessageBatch<Mode, Message> | null>>) | null;
  retainPreparedContextOnlyInput: (result: PromiseSettledResult<MessageBatch<Mode, Message> | null>) => boolean;
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
): MaterializeNextPendingOptions {
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
    async (onDiagnosticPhase) => await session.materializeNextPendingMessageSafely?.({
      ...options,
      onDiagnosticPhase,
    })
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
        async (onDiagnosticPhase) => await session.materializeNextPendingMessageSafely?.({
          ...options,
          expectedRuntimeActivityRevision: committedRevision,
          onDiagnosticPhase,
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
  let deferredContextOnlyBatch: MessageBatch<Mode, Message> | null = null;
  let deferredContextOnlyWaitingForChange = false;
  let contextOnlyPreparation: Promise<PromiseSettledResult<MessageBatch<Mode, Message> | null>> | null = null;
  let releasedInputBatch: MessageBatch<Mode, Message> | null = null;
  const liveWorkListeners = new Set<() => void>();
  let liveWorkObservation: AbortController | null = null;
  let unsubscribeQueueLiveWork: (() => void) | null = null;
  let unsubscribeSubagentLiveWork: (() => void) | null = null;
  let settledAt: number | undefined;
  let observedUnsettled = false;
  let priorLiveWorkNotification: string | null = null;
  const notifyLiveWorkChanged = (): void => {
    if (liveWorkListeners.size === 0) {
      // Retire an unobserved custody edge without querying Activity on the input path.
      settledAt = undefined;
      observedUnsettled = true;
      return;
    }
    const signature = readLiveWorkNotificationSignature();
    if (signature === priorLiveWorkNotification) return;
    priorLiveWorkNotification = signature;
    for (const listener of liveWorkListeners) listener();
  };
  const admissionKey = (scope: ProviderInputActionRequiredDisposition) =>
    `${scope.reason}\u0000${scope.serviceId}\u0000${scope.groupId}`;
  const admissions = new Map<string, ProviderInputActionRequiredDisposition>();
  const readAdmission = (): ProviderInputActionRequiredDisposition | null =>
    admissions.values().next().value ?? null;
  const admissionWaiters = new Set<() => void>();
  const providerInputDispatchCustody = new AsyncLocalStorage<{ active: boolean }>();
  let activeProviderInputDispatches = 0;
  const activeDispatchDrainWaiters = new Set<() => void>();
  let activePendingMaterializationTurns = 0;
  let activePendingMaterializationCustodies = 0;
  const activePendingMaterializationDrainWaiters = new Set<() => void>();
  let passSequence = 0;
  const markPassDirty = (): void => {
    passSequence += 1;
    notifyLiveWorkChanged();
  };

  const hasLocalInputCustody = (): boolean =>
    reservedBatch !== null
    || opts.messageQueue.size() > 0;
  const hasAcceptedInputCustody = (): boolean => hasLocalInputCustody()
    || releasedInputBatch !== null || deferredContextOnlyBatch !== null
    || contextOnlyPreparation !== null
    || activeProviderInputDispatches > 0 || activePendingMaterializationCustodies > 0;
  const readSessionLiveState = (): SessionInputLiveWork['session'] => {
    const tail = opts.session.readRuntimeActivitySnapshotTail?.();
    return tail && readExactIdleRuntimeActivityRevision(tail) !== undefined
      ? 'settled' : tail?.custody?.value.state === 'active'
        || tail?.settlement?.committedProjection.state === 'active' ? 'active' : 'unknown';
  };
  const readLiveWorkFacts = (input: SessionInputLiveWork['input']): SessionInputLiveWork => {
    const session = readSessionLiveState();
    const nativeState = opts.session.readNativeRuntimeActivitySnapshot?.().state;
    const nativeRuntimeActivity = nativeState === 'idle' ? 'settled' : nativeState ?? 'unknown';
    const metadata = opts.session.getMetadataSnapshot?.();
    const record = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata as Record<string, unknown> : null;
    const subagents = opts.session.readSubagentLiveWork?.();
    const rawHeadline = record?.[SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY];
    const headline = rawHeadline === undefined ? null : SessionAgentActivityHeadlineV1Schema.safeParse(rawHeadline);
    const entries = headline?.success ? headline.data.activeEntries : [];
    const activeEntries = entries.filter(entry => isInProgressAgentActivityStatus(entry.status));
    const headlineCount = activeEntries.filter(entry => entry.kind === 'workflow_agent').length;
    const agentsActiveCount = (subagents?.activeCount ?? 0) + headlineCount;
    const agents = agentsActiveCount > 0 || activeEntries.length > 0 ? 'active' : !record || !subagents || subagents.state === 'unknown'
      || headline?.success === false || entries.some(entry => entry.status === 'unknown') ? 'unknown' : 'settled';
    const agentState = opts.session.getAgentStateSnapshot?.();
    // Request attention does not consume capability values, whose nullable host
    // semantics differ from the client state projection.
    const ownedFlags = derivePendingRequestFlagsFromAgentState(agentState == null ? agentState : {
      requests: agentState.requests, completedRequests: agentState.completedRequests,
    });
    const rawConfirmations = record?.actionConfirmationsV1;
    const confirmations = rawConfirmations === undefined ? null : SessionActionConfirmationsV1Schema.safeParse(rawConfirmations);
    const sharedFlags = derivePendingRequestFlagsFromAgentState(confirmations?.success ? confirmations.data : null);
    const attention = ownedFlags.hasPendingPermissionRequests || ownedFlags.hasPendingUserActionRequests
      || sharedFlags.hasPendingPermissionRequests || sharedFlags.hasPendingUserActionRequests ? 'active'
      : !record || agentState == null || confirmations?.success === false ? 'unknown' : 'settled';
    if (session === 'settled' && input === 'settled' && agents === 'settled' && attention === 'settled') {
      const observedAt = opts.session.readRuntimeActivitySnapshotTail?.().settlement?.committedProjection.observedAt;
      if (typeof observedAt === 'number' && Number.isSafeInteger(observedAt) && observedAt >= 0) {
        settledAt = Math.max(settledAt ?? observedAt, observedAt, observedUnsettled ? Date.now() : 0);
        observedUnsettled = false;
      } else {
        settledAt = undefined;
        observedUnsettled = true;
      }
    } else {
      settledAt = undefined;
      observedUnsettled = true;
    }
    return { session, input, nativeRuntimeActivity, agents, attention, agentsActiveCount, ...(settledAt !== undefined ? { settledAt } : {}) };
  };
  const readLiveWorkNotificationSignature = (): string => {
    const pending = opts.session.getPendingQueueState?.();
    // `settledAt` is re-stamped with the clock by any read that could not prove a settled fact
    // (an observer's own re-read), so it is not a change. The host's committed settlement time is.
    const { settledAt: _restamped, ...facts } = readLiveWorkFacts(hasAcceptedInputCustody() || (pending?.known && pending.pendingCount > 0)
      ? 'active' : pending?.known ? 'settled' : 'unknown');
    return JSON.stringify({ ...facts,
      settlementObservedAt: opts.session.readRuntimeActivitySnapshotTail?.().settlement?.committedProjection.observedAt });
  };

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
    const pending = opts.session.getPendingQueueState?.();
    const holdsInputCustody = pending?.known !== true || pending.pendingCount > 0;
    if (holdsInputCustody) {
      activePendingMaterializationCustodies += 1;
      notifyLiveWorkChanged();
    }
    try {
      await observePendingInputPhase('pending_materialization_turn', async () => await previousTurn.catch(() => undefined));
      return await operation();
    } finally {
      activePendingMaterializationTurns -= 1;
      if (holdsInputCustody) {
        activePendingMaterializationCustodies -= 1;
        notifyLiveWorkChanged();
      }
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
      if (!await observePendingInputPhase('input_admission', async () => await waitForAdmissionChange(abortSignal))) return false;
    }
    return true;
  };

  const waitForActiveProviderInputDispatches = async (): Promise<void> => {
    // A replacement reached from provider preparation already holds dispatch
    // custody. Drain every other dispatch, without waiting for this call's own
    // finally. External callers and continuations of retired dispatches drain all.
    const custody = providerInputDispatchCustody.getStore();
    while (activeProviderInputDispatches > (custody?.active ? 1 : 0)) {
      await new Promise<void>((resolve) => {
        activeDispatchDrainWaiters.add(resolve);
      });
    }
  };

  const dispatchWithCustody = async <Value>(dispatch: () => Promise<Value>): Promise<Value> => {
    const custody = { active: true };
    activeProviderInputDispatches += 1;
    notifyLiveWorkChanged();
    try {
      return await providerInputDispatchCustody.run(custody, dispatch);
    } finally {
      custody.active = false;
      activeProviderInputDispatches -= 1;
      notifyLiveWorkChanged();
      // A caller holding its own custody can finish draining at one remaining
      // dispatch; external callers recheck until all dispatches have settled.
      for (const notify of [...activeDispatchDrainWaiters]) {
        activeDispatchDrainWaiters.delete(notify);
        notify();
      }
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
      return { status: 'dispatched', value: await dispatchWithCustody(dispatchOpts.dispatch) };
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
      try {
        return {
          status: 'dispatched',
          value: await dispatchWithCustody(dispatchOpts.dispatch),
        };
      } finally {
        releaseExactAdmission();
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
    async readLiveWork(): Promise<SessionInputLiveWork> {
      let pendingKnown = false;
      let pendingActive = false;
      try {
        if (opts.session.readPendingQueueStateForLiveWork) {
          const pending = await opts.session.readPendingQueueStateForLiveWork();
          pendingKnown = pending.known;
          pendingActive = pending.known && pending.pendingCount > 0;
        }
      } catch {
        // An old empty observation cannot prove current Pending settlement.
      }
      const input = hasAcceptedInputCustody() || pendingActive
        ? 'active' : pendingKnown ? 'settled' : 'unknown';
      return readLiveWorkFacts(input);
    },
    subscribeLiveWork(listener) {
      liveWorkListeners.add(listener);
      if (liveWorkObservation === null) {
        const controller = new AbortController();
        liveWorkObservation = controller;
        priorLiveWorkNotification = readLiveWorkNotificationSignature();
        unsubscribeQueueLiveWork = opts.messageQueue.subscribeChanges(batch => {
          // Transfer custody synchronously with queue removal, before any asynchronous fresh read.
          if (batch) releasedInputBatch = batch;
          notifyLiveWorkChanged();
        });
        unsubscribeSubagentLiveWork = opts.session.subscribeSubagentLiveWork?.(notifyLiveWorkChanged) ?? null;
        const observe = async (wait: () => Promise<boolean>): Promise<void> => {
          while (!controller.signal.aborted) {
            if (!await wait()) break;
            if (!controller.signal.aborted) notifyLiveWorkChanged();
          }
        };
        void observe(() => opts.session.waitForMetadataUpdate(controller.signal)).catch(notifyLiveWorkChanged);
        if (opts.session.readRuntimeActivitySnapshotTail && opts.session.waitForRuntimeActivitySnapshotTailChange) {
          void observe(() => opts.session.waitForRuntimeActivitySnapshotTailChange!(
            opts.session.readRuntimeActivitySnapshotTail!().sequence, controller.signal,
          )).catch(notifyLiveWorkChanged);
        }
      }
      return () => {
        liveWorkListeners.delete(listener);
        if (liveWorkListeners.size === 0) {
          liveWorkObservation?.abort();
          liveWorkObservation = null;
          unsubscribeQueueLiveWork?.();
          unsubscribeQueueLiveWork = null;
          unsubscribeSubagentLiveWork?.();
          unsubscribeSubagentLiveWork = null;
          priorLiveWorkNotification = null;
        }
      };
    },
    releaseInputBatch() {
      if (releasedInputBatch === null) return;
      releasedInputBatch = null;
      markPassDirty();
    },
    deferContextOnlyInput(batch) {
      deferredContextOnlyBatch = batch;
      deferredContextOnlyWaitingForChange = true;
      markPassDirty();
    },
    async finalizeContextOnlyInput(finalizeOpts) {
      if (finalizeOpts.abortSignal.aborted || !await finalizeOpts.recheck()) return 'withdrawn';
      if (finalizeOpts.abortSignal.aborted) return 'withdrawn';
      // No await between this queue check and commit invocation: queue arrivals and
      // workflow withdrawal share the same event-loop ordering point.
      if (readAdmission() || hasLocalInputCustody() || opts.session.hasPendingProviderInput?.()) {
        deferredContextOnlyBatch = finalizeOpts.batch;
        deferredContextOnlyWaitingForChange = false;
        markPassDirty();
        return 'deferred';
      }
      return await finalizeOpts.commit() ? 'committed' : 'withdrawn';
    },
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
        const batch = await waitForNextInput({
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
          takeDeferredContextOnlyBatch: () => {
            if (deferredContextOnlyWaitingForChange) return null;
            const batch = deferredContextOnlyBatch;
            deferredContextOnlyBatch = null;
            return batch;
          },
          hasDeferredContextOnlyBatch: () => deferredContextOnlyBatch !== null,
          resumeDeferredContextOnlyBatch: () => { deferredContextOnlyWaitingForChange = false; },
          prepareContextOnlyInput: opts.takeContextOnlyInput ? (signal) => {
            // A take can acquire context custody before its asynchronous preparation
            // finishes. Keep that one operation across user-input wakes and waits.
            if (contextOnlyPreparation === null) {
              contextOnlyPreparation = observePendingInputPhase('context_only',
                async () => await opts.takeContextOnlyInput?.(signal) ?? null).then(
                value => ({ status: 'fulfilled' as const, value }),
                reason => ({ status: 'rejected' as const, reason }),
              );
              // No notification here: a context invalidation can yield an empty take,
              // which is not work. Readers still see the in-flight
              // preparation as busy; the retained result below is the edge observers are told about.
            }
            return contextOnlyPreparation;
          } : null,
          retainPreparedContextOnlyInput: (result) => {
            contextOnlyPreparation = null;
            if (result.status === 'rejected') {
              notifyLiveWorkChanged();
              throw result.reason;
            }
            deferredContextOnlyBatch = result.value;
            deferredContextOnlyWaitingForChange = false;
            if (result.value) markPassDirty();
            else notifyLiveWorkChanged();
            return result.value !== null;
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
        if (batch) {
          releasedInputBatch = batch;
          markPassDirty();
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
    waitForAdmissionChange?: (abortSignal: AbortSignal) => Promise<boolean>;
    drainPending: (drainOpts?: DrainPendingOptions) => Promise<DrainPendingResult>;
  }>,
): Promise<void> {
  while (!opts.abortSignal.aborted && await (opts.shouldContinue?.() ?? true)) {
    const wakeController = new AbortController();
    const onAbort = () => wakeController.abort(opts.abortSignal.reason);
    opts.abortSignal.addEventListener('abort', onAbort, { once: true });
    if (opts.abortSignal.aborted) wakeController.abort(opts.abortSignal.reason);

    let passDirty = false;
    const armedWake = waitForWakeSignal({
      waitForMetadataUpdate: opts.waitForMetadataUpdate,
      waitForAdmissionChange: opts.waitForAdmissionChange,
      controller: wakeController,
      metadataWaitRetryBackoffMs: DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS,
    }).then((winner) => {
      const didWake = winner.kind === 'meta' ? winner.ok
        : winner.kind === 'queue' ? winner.hasMessages : winner.changed;
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
      const didWake = result.retryAfterMs === undefined
        ? await armedWake
        : await Promise.race([
          armedWake,
          // Rejoin the retained claim under its owner's delay, just as the idle
          // consumer does; a missing metadata event cannot strand active input.
          waitForSessionMetadataRetryBackoff({
            abortSignal: wakeController.signal,
            backoffMs: result.retryAfterMs,
          }).then(() => true),
        ]);
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
  let contextOnlyNeedsRead = true;

  while (true) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.abortSignal.addEventListener('abort', onAbort, { once: true });
    if (opts.abortSignal.aborted) {
      controller.abort();
    }

    try {
      const passSequence = opts.readPassSequence();
      const armedInputWake = waitForWakeSignal({
        messageQueue: opts.messageQueue,
        waitForMetadataUpdate: opts.session.waitForMetadataUpdate,
        waitForAdmissionChange: opts.waitForAdmissionChange,
        controller,
        metadataWaitRetryBackoffMs,
      });
      const pendingInput = opts.session.hasPendingProviderInput?.();
      // Context changes retained behind Pending custody must be read once it drains.
      if (pendingInput) contextOnlyNeedsRead = true;
      const contextOnlyWake =
        // Context sources can remain ready until taken. Pending custody prevents
        // taking them below, so arm only queue/metadata/admission wakes until
        // Pending changes; otherwise the same retained wake spins this runner.
        pendingInput ? undefined
          : opts.waitForContextOnlyInputChange?.(controller.signal)
            .then(changed => {
              if (changed) contextOnlyNeedsRead = true;
              return { kind: 'context_only' as const, changed };
            });
      const armedWake = Promise.race([
        armedInputWake,
        ...(contextOnlyWake ? [contextOnlyWake] : []),
      ]).then((winner) => {
        if ((winner.kind === 'meta' && winner.ok)
          || (winner.kind === 'queue' && winner.hasMessages)
          || ((winner.kind === 'context_only' || winner.kind === 'admission') && winner.changed)) {
          opts.resumeDeferredContextOnlyBatch();
        }
        return winner;
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
        opts.resumeDeferredContextOnlyBatch();
        controller.abort('sessionProviderInputConsumer-existing');
        return await returnBatch(opts, existingBatch, refreshBeforeQueuedBatch);
      }

      const materializationRetryAfterMs = await materializePendingMessage(opts);

      const materializedBatch = await collectQueuedBatch(opts);
      if (materializedBatch) {
        opts.resumeDeferredContextOnlyBatch();
        controller.abort('sessionProviderInputConsumer-materialized');
        return await returnBatch(opts, materializedBatch, refreshBeforeQueuedBatch);
      }

      // A taken context-only item is retained outside the user queue, after both
      // direct and Pending input have had the opportunity to run.
      let contextOnlyBatch = opts.session.hasPendingProviderInput?.()
        ? null
        : opts.takeDeferredContextOnlyBatch();
      if (!contextOnlyBatch
        && !opts.session.hasPendingProviderInput?.()
        && !opts.hasDeferredContextOnlyBatch()
        && (contextOnlyNeedsRead || !opts.waitForContextOnlyInputChange)
        && opts.prepareContextOnlyInput) {
        // An empty take stays settled until its source changes. Metadata updates
        // (including Guard's own notice) are not new context work.
        contextOnlyNeedsRead = false;
        // A context-ready signal may stay ready until its take settles. Only
        // user-input wakes interrupt preparation; they never cancel its custody.
        const preparation = await Promise.race([
          opts.prepareContextOnlyInput(opts.abortSignal).then(result => ({ kind: 'prepared' as const, result })),
          armedInputWake.then(() => ({ kind: 'wake' as const })),
        ]);
        if (preparation.kind === 'prepared') {
          // Recheck input priority after the asynchronous take, without repeating
          // the full preparation/materialization pass when nothing arrived.
          if (opts.abortSignal.aborted || opts.hasLocalInputCustody()
            || opts.session.hasPendingProviderInput?.() || !opts.isAdmitted()) {
            contextOnlyNeedsRead = true;
            continue;
          }
          if (opts.retainPreparedContextOnlyInput(preparation.result)) {
            contextOnlyBatch = opts.takeDeferredContextOnlyBatch();
          }
        } else contextOnlyNeedsRead = true;
      }
      if (contextOnlyBatch) {
        controller.abort('sessionProviderInputConsumer-context-only');
        return contextOnlyBatch;
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
      if (materializationRetryAfterMs === null) {
        winner = await armedWake;
      } else {
        // The Pending owner retains this claim until settlement. Its retry hint
        // remains live after repeated uncertainty, even without another wake.
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
      controller.abort('sessionProviderInputConsumer-pass-complete');
    }
  }
}

async function returnBatch<Mode, Message>(
  opts: WaitForNextInputOptions<Mode, Message>,
  batch: MessageBatch<Mode, Message>,
  refreshBeforeReturn: boolean,
): Promise<MessageBatch<Mode, Message> | null> {
  // Keep dequeued input in local custody across metadata and admission waits,
  // so concurrent Pending drains cannot overtake an interrupted batch.
  opts.reserveBatch(batch);
  if (!await opts.waitUntilAdmitted(opts.abortSignal)) {
    return null;
  }
  if (refreshBeforeReturn) {
    await callMetadataUpdate(opts.onMetadataUpdate, opts.abortSignal);
  }
  if (opts.abortSignal.aborted) {
    return null;
  }
  if (!await opts.waitUntilAdmitted(opts.abortSignal)) {
    return null;
  }
  return opts.takeReservedBatch();
}

async function collectQueuedBatch<Mode, Message>(
  opts: WaitForNextInputOptions<Mode, Message>,
): Promise<MessageBatch<Mode, Message> | null> {
  await observePendingInputPhase('queued_input_preparation', async () => await opts.beforeCollectQueuedBatch?.());
  if (opts.messageQueue.size() <= 0) {
    return null;
  }
  return await opts.messageQueue.waitForMessagesAndGetAsString(opts.abortSignal);
}

function logInputConsumerMaterializationDecision(opts: Readonly<{
  source: 'waitForNextInput' | 'drainPending';
  reconcileWhenEmpty: PendingMaterializationReconcileWhenEmpty;
  deliveryTiming: SessionPendingQueueDeliveryTiming | undefined;
  result: MaterializeNextPendingResult;
}>): void {
  logger.infoFile('[pendingQueue] input consumer materialization decision', {
    source: opts.source,
    reconcileWhenEmpty: opts.reconcileWhenEmpty,
    deliveryTiming: opts.deliveryTiming ?? 'after_foreground_ready',
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

async function materializePendingMessage<Mode, Message>(
  opts: WaitForNextInputOptions<Mode, Message>,
): Promise<number | null> {
  return await opts.runPendingMaterializationExclusive(async () => {
    if (opts.abortSignal.aborted || !opts.isAdmitted() || opts.hasLocalInputCustody()) return null;
    if (isSessionPendingDrainBlocked(opts.session)) return null;
    if ((await observePendingInputPhase('pending_handoff', async () => await (opts.beforePendingMaterialize?.() ?? true))) !== true) return null;
    if (!opts.isAdmitted() || opts.hasLocalInputCustody()) return null;
    if ((await reconcilePendingProviderInputCustodyBeforeMaterialization(opts.session)) !== true) return null;
    if (opts.abortSignal.aborted || !opts.isAdmitted() || opts.hasLocalInputCustody()) return null;

    let result: MaterializeNextPendingResult;
    const reconcileWhenEmpty = opts.reconcileWhenEmpty ?? 'throttled';
    const deliveryTiming = opts.resolvePendingQueueDeliveryTiming?.() ?? opts.pendingQueueDeliveryTiming;
    try {
      result = await materializeWithRuntimeActivityTail(opts.session, buildMaterializeOptions(
          reconcileWhenEmpty,
          deliveryTiming,
        ), opts.abortSignal);
    } catch (error) {
      if (error instanceof PendingQueueMaterializationAuthError) throw error;
      if (readAuthenticationStatus(error) !== null) {
        throw new PendingQueueMaterializationAuthError();
      }
      logger.debug('[INPUT-CONSUMER] Pending materialization episode failed nonfatally', { error });
      return null;
    }
    logInputConsumerMaterializationDecision({
      source: 'waitForNextInput',
      reconcileWhenEmpty,
      deliveryTiming,
      result,
    });
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

    return await materializeNextPendingForDrain(
      opts.session,
      opts,
    );
  } catch (error) {
    return { materialized: 0, stoppedReason: readDrainErrorStoppedReason(error, opts) };
  }
}

async function reconcilePendingProviderInputCustodyBeforeMaterialization(
  session: SessionProviderInputConsumerSession,
): Promise<boolean> {
  return await observePendingInputPhase('pending_provider_custody',
    async () => await (session.reconcilePendingProviderInputCustodyBeforeMaterialization?.() ?? true));
}

function isSessionPendingDrainBlocked(session: SessionProviderInputConsumerSession): boolean {
  if (!session.getMetadataSnapshot) {
    return false;
  }
  const metadata = session.getMetadataSnapshot();
  return isSessionPendingQueueHoldBlockingPendingDrain(metadata)
    || readSessionExplicitStopV1FromMetadata(metadata) !== null;
}

async function materializeNextPendingForDrain(
  session: SessionProviderInputConsumerSession,
  opts: DrainPendingOptions & {
    pendingQueueDeliveryTiming: SessionPendingQueueDeliveryTiming;
    resolvePendingQueueDeliveryTiming?: () => SessionPendingQueueDeliveryTiming;
  },
): Promise<DrainPendingResult> {
    try {
      const reconcileWhenEmpty = 'force';
      const deliveryTiming = opts.resolvePendingQueueDeliveryTiming?.() ?? opts.pendingQueueDeliveryTiming;
      const result = await materializeWithRuntimeActivityTail(
          session,
          buildMaterializeOptions(
            reconcileWhenEmpty,
            deliveryTiming,
          ),
          opts.abortSignal ?? new AbortController().signal,
        );
      logInputConsumerMaterializationDecision({
        source: 'drainPending',
        reconcileWhenEmpty,
        deliveryTiming,
        result,
      });
      if (result.type === 'materialized') return { materialized: 1, stoppedReason: 'max_pop_per_wake' };
      if (result.type === 'auth_failure') {
        logTerminalAuthDrainStop(opts, null);
        return { materialized: 0, stoppedReason: 'auth_failure' };
      }
      if (result.type === 'deferred') {
        if (result.reason === 'supervisor_auth_failed') {
          logTerminalAuthDrainStop(opts, null);
          return { materialized: 0, stoppedReason: 'auth_failure' };
        }
        return { materialized: 0, stoppedReason: 'deferred' };
      }
      if (result.type === 'retryable_transport') return { materialized: 0, stoppedReason: 'error',
        ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }) };
      return { materialized: 0, stoppedReason: 'no_pending' };
    } catch (error) {
      return { materialized: 0, stoppedReason: readDrainErrorStoppedReason(error, opts) };
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
  messageQueue?: MessageQueue2<Mode, Message>;
  waitForMetadataUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
  waitForAdmissionChange?: (abortSignal: AbortSignal) => Promise<boolean>;
  controller: AbortController;
  metadataWaitRetryBackoffMs: number;
}): Promise<WakeWinner> {
  const queueWait = opts.messageQueue
    ?.waitForMessagesSignal(opts.controller.signal)
    .then((hasMessages) => ({ kind: 'queue' as const, hasMessages }));
  const admissionWait = opts.waitForAdmissionChange?.(opts.controller.signal)
    .then((changed) => ({ kind: 'admission' as const, changed }));
  while (true) {
    if (opts.controller.signal.aborted) {
      return { kind: 'meta', ok: false };
    }

    const metaWait = opts.waitForMetadataUpdate(opts.controller.signal).then(
      (ok) => ({ kind: 'meta' as const, ok }),
      () => ({ kind: 'meta' as const, ok: false }),
    );
    const winner = await Promise.race([
      ...(queueWait ? [queueWait] : []),
      metaWait,
      ...(admissionWait ? [admissionWait] : []),
    ]);
    if (winner.kind !== 'meta' || winner.ok || opts.controller.signal.aborted) {
      return winner;
    }

    // Keep the adapter-unavailable retry bounded without polling the queue. Real client
    // waits retain their subscription through transient disconnects.
    const queueOrBackoffWinner = await Promise.race([
      ...(queueWait ? [queueWait] : []),
      ...(admissionWait ? [admissionWait] : []),
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

type PendingInputConsumerDiagnosticPhase =
  | 'materialize'
  | 'materialize_runtime_tail_retry'
  | 'metadata_reconcile'
  | 'pending_materialization_turn'
  | 'input_admission'
  | 'queued_input_preparation'
  | 'pending_handoff'
  | 'pending_provider_custody'
  | 'context_only'
  | PendingMaterializationDiagnosticPhase;

async function observePendingInputPhase<T>(
  initialPhase: PendingInputConsumerDiagnosticPhase,
  operation: (onPhase: (phase: PendingMaterializationDiagnosticPhase) => void) => Promise<T>,
): Promise<T> {
  let phase = initialPhase;
  let startedAt = Date.now();
  let slowDiagnosticEmitted = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const finishPhase = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (slowDiagnosticEmitted) {
      logger.infoFile('[pendingQueue] input consumer slow phase settled', {
        elapsedMs: Date.now() - startedAt,
        phase,
      });
    }
  };
  const startPhase = () => {
    startedAt = Date.now();
    slowDiagnosticEmitted = false;
    timer = setTimeout(() => {
      slowDiagnosticEmitted = true;
      logger.infoFile('[pendingQueue] input consumer phase remains unsettled', {
        elapsedMs: Date.now() - startedAt,
        phase,
      });
    }, PENDING_INPUT_SLOW_PHASE_DIAGNOSTIC_MS);
    timer.unref?.();
  };
  const onPhase = (nextPhase: PendingMaterializationDiagnosticPhase) => {
    if (nextPhase === phase) return;
    finishPhase();
    phase = nextPhase;
    startPhase();
  };

  startPhase();
  try {
    return await operation(onPhase);
  } finally {
    finishPhase();
  }
}
