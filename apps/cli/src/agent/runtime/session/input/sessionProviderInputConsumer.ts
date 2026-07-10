import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { readAuthenticationStatus } from '@/api/client/httpStatusError';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import {
  isSessionContinuationRecoveryBlockingPendingDrain,
  isSessionPendingQueueHoldBlockingPendingDrain,
  type SessionPendingQueueDeliveryTiming,
} from '@happier-dev/protocol';
import {
  DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS,
  waitForSessionMetadataRetryBackoff,
} from '@/agent/runtime/session/metadataWaitRetryBackoff';

import type {
  DrainPendingOptions,
  DrainPendingResult,
  MessageBatch,
  PendingMaterializationReconcileWhenEmpty,
  SessionProviderInputConsumer,
  SessionProviderInputConsumerSession,
} from './_types';
import type { PendingMaterializationActiveTurnPolicy } from '@/api/session/pendingMaterializationActiveTurnPolicy';
import { PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE } from './pendingQueueDrainPolicy';

type WakeWinner =
  | { kind: 'queue'; hasMessages: boolean; refreshBeforeReturn?: boolean }
  | { kind: 'meta'; ok: boolean }
  | { kind: 'idle' };

const DEFAULT_PENDING_MATERIALIZATION_FAILURE_BLOCK_THRESHOLD = 3;

type PendingMaterializationFailureState = {
  consecutiveFailures: number;
};

export class PendingQueueMaterializationAuthError extends Error {
  constructor() {
    super('Pending queue materialization stopped after supervisor authentication failure');
    this.name = 'PendingQueueMaterializationAuthError';
  }
}

export class PendingQueueMaterializationFailureBudgetExceededError extends Error {
  readonly code = 'pending_queue_materialization_failure_budget_exhausted';
  readonly failureCount: number;
  readonly materializationError: unknown;

  constructor(failureCount: number, materializationError: unknown) {
    super(`Pending queue materialization failed ${failureCount} consecutive times`);
    this.name = 'PendingQueueMaterializationFailureBudgetExceededError';
    this.failureCount = failureCount;
    this.materializationError = materializationError;
  }
}

export type SessionProviderInputConsumerOptions<Mode, Message> = Readonly<{
  messageQueue: MessageQueue2<Mode, Message>;
  session: SessionProviderInputConsumerSession;
  beforeCollectQueuedBatch?: (() => void | Promise<void>) | null;
  beforePendingMaterialize?: (() => boolean | Promise<boolean>) | null;
  onMetadataUpdate?: (() => void | Promise<void>) | null;
  reconcileWhenEmpty?: PendingMaterializationReconcileWhenEmpty;
  activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
  resolveActiveTurnDeliveryPolicy?: () => PendingMaterializationActiveTurnPolicy | undefined;
  pendingQueueDeliveryTiming?: SessionPendingQueueDeliveryTiming;
  idleWakePollIntervalMs?: number;
  metadataWaitRetryBackoffMs?: number;
  refreshBeforeQueuedBatch?: boolean;
  pendingDrainMaxPopPerWake?: number;
}>;

type WaitForNextInputOptions<Mode, Message> = SessionProviderInputConsumerOptions<Mode, Message> & {
  abortSignal: AbortSignal;
  materializationFailureState: PendingMaterializationFailureState;
};

function buildMaterializeOptions(
  reconcileWhenEmpty: PendingMaterializationReconcileWhenEmpty,
  activeTurnDeliveryPolicy: PendingMaterializationActiveTurnPolicy | undefined,
  pendingQueueDeliveryTiming: SessionPendingQueueDeliveryTiming | undefined,
): {
  reconcileWhenEmpty: PendingMaterializationReconcileWhenEmpty;
  activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
  deliveryTiming?: 'after_runtime_idle';
} {
  return {
    reconcileWhenEmpty,
    ...(activeTurnDeliveryPolicy ? { activeTurnDeliveryPolicy } : {}),
    ...(pendingQueueDeliveryTiming === 'after_runtime_idle' ? { deliveryTiming: 'after_runtime_idle' } : {}),
  };
}

function readActiveTurnDeliveryPolicy(opts: {
  activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
  resolveActiveTurnDeliveryPolicy?: () => PendingMaterializationActiveTurnPolicy | undefined;
}): PendingMaterializationActiveTurnPolicy | undefined {
  return opts.resolveActiveTurnDeliveryPolicy?.() ?? opts.activeTurnDeliveryPolicy;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePendingDeliveryLocalIds(value: unknown): string[] {
  const rawValues = Array.isArray(value) ? value : [value];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const rawValue of rawValues) {
    if (typeof rawValue !== 'string') continue;
    const id = rawValue.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function readPendingDeliveryFailureLocalIds(error: unknown): string[] {
  if (!isRecord(error)) return [];
  const direct = normalizePendingDeliveryLocalIds(error.localIds);
  if (direct.length > 0) return direct;
  const localId = normalizePendingDeliveryLocalIds(error.localId);
  if (localId.length > 0) return localId;
  if (isRecord(error.data)) {
    const dataIds = normalizePendingDeliveryLocalIds(error.data.localIds);
    if (dataIds.length > 0) return dataIds;
    const dataLocalId = normalizePendingDeliveryLocalIds(error.data.localId);
    if (dataLocalId.length > 0) return dataLocalId;
  }
  if (isRecord(error.response) && isRecord(error.response.data)) {
    const responseIds = normalizePendingDeliveryLocalIds(error.response.data.localIds);
    if (responseIds.length > 0) return responseIds;
    return normalizePendingDeliveryLocalIds(error.response.data.localId);
  }
  return [];
}

async function blockFailedPendingDelivery(
  session: SessionProviderInputConsumerSession,
  error: unknown,
): Promise<boolean> {
  const localIds = readPendingDeliveryFailureLocalIds(error);
  if (localIds.length === 0 || !session.blockPendingMessageDelivery) return false;
  try {
    return await session.blockPendingMessageDelivery({
      localIds,
      reason: 'unknown',
    });
  } catch (blockError) {
    logger.debug('[INPUT-CONSUMER] Failed to block pending delivery after materialization failure', { error: blockError });
    return false;
  }
}

export function createSessionProviderInputConsumer<Mode, Message>(
  opts: SessionProviderInputConsumerOptions<Mode, Message>,
): SessionProviderInputConsumer<Mode, Message> {
  let waitForNextInputTurn: Promise<void> = Promise.resolve();
  const materializationFailureState: PendingMaterializationFailureState = { consecutiveFailures: 0 };

  return {
    async waitForNextInput(waitOpts: { abortSignal: AbortSignal }): Promise<MessageBatch<Mode, Message> | null> {
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
        return await waitForNextInput({ ...opts, abortSignal: waitOpts.abortSignal, materializationFailureState });
      } finally {
        releaseTurn();
      }
    },
    async drainPending(drainOpts?: DrainPendingOptions): Promise<DrainPendingResult> {
      return await drainPendingMessages(withDefaultDrainOptions(
        opts.session,
        opts.pendingDrainMaxPopPerWake,
        opts.activeTurnDeliveryPolicy,
        opts.resolveActiveTurnDeliveryPolicy,
        opts.pendingQueueDeliveryTiming,
        drainOpts,
      ));
    },
  };
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
  const idleWakePollIntervalMs = opts.idleWakePollIntervalMs ?? configuration.pendingQueueIdleWakePollIntervalMs;
  const metadataWaitRetryBackoffMs =
    opts.metadataWaitRetryBackoffMs ?? DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS;
  const refreshBeforeQueuedBatch = opts.refreshBeforeQueuedBatch !== false;

  while (true) {
    if (opts.abortSignal.aborted) {
      return null;
    }

    const existingBatch = await collectQueuedBatch(opts);
    if (existingBatch) {
      return await returnBatch(opts, existingBatch, refreshBeforeQueuedBatch);
    }

    await materializePendingMessage(opts);

    const materializedBatch = await collectQueuedBatch(opts);
    if (materializedBatch) {
      return await returnBatch(opts, materializedBatch, refreshBeforeQueuedBatch);
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.abortSignal.addEventListener('abort', onAbort, { once: true });
    if (opts.abortSignal.aborted) {
      controller.abort();
    }

    try {
      const winner = await waitForWakeSignal({
        messageQueue: opts.messageQueue,
        waitForMetadataUpdate: opts.session.waitForMetadataUpdate,
        controller,
        idleWakePollIntervalMs,
        metadataWaitRetryBackoffMs,
      });

      if (winner.kind === 'meta' && !winner.ok) {
        controller.abort('sessionProviderInputConsumer-meta-false');

        if (opts.abortSignal.aborted) {
          return null;
        }

        await callMetadataUpdate(opts.onMetadataUpdate);
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

      if (winner.kind === 'idle') {
        await callMetadataUpdate(opts.onMetadataUpdate);
        continue;
      }

      if (winner.kind === 'meta') {
        await callMetadataUpdate(opts.onMetadataUpdate);
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
  if (refreshBeforeReturn) {
    await callMetadataUpdate(opts.onMetadataUpdate);
  }
  if (opts.abortSignal.aborted) {
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
): Promise<void> {
  if (isSessionPendingDrainBlocked(opts.session)) {
    return;
  }

  const materializeSafely = opts.session.materializeNextPendingMessageSafely;
  if (materializeSafely) {
    if ((await (opts.beforePendingMaterialize?.() ?? true)) !== true) {
      return;
    }
    let result: Awaited<ReturnType<NonNullable<SessionProviderInputConsumerSession['materializeNextPendingMessageSafely']>>>;
    try {
      result = await materializeSafely(buildMaterializeOptions(
        opts.reconcileWhenEmpty ?? 'throttled',
        readActiveTurnDeliveryPolicy(opts),
        opts.pendingQueueDeliveryTiming,
      ));
    } catch (error) {
      if (error instanceof PendingQueueMaterializationAuthError) {
        throw error;
      }
      opts.materializationFailureState.consecutiveFailures += 1;
      const failureCount = opts.materializationFailureState.consecutiveFailures;
      const failureBlockThreshold = DEFAULT_PENDING_MATERIALIZATION_FAILURE_BLOCK_THRESHOLD;
      logger.debug('[INPUT-CONSUMER] Pending materialization failed without stopping the runner', {
        error,
        failureCount,
        failureBlockThreshold,
      });
      if (failureCount < failureBlockThreshold) {
        return;
      }
      if (await blockFailedPendingDelivery(opts.session, error)) {
        opts.materializationFailureState.consecutiveFailures = 0;
        return;
      }
      throw new PendingQueueMaterializationFailureBudgetExceededError(failureCount, error);
    }
    opts.materializationFailureState.consecutiveFailures = 0;
    if (result.type === 'deferred' && result.reason === 'supervisor_auth_failed') {
      throw new PendingQueueMaterializationAuthError();
    }
    if (!result || typeof result !== 'object' || !('type' in result)) {
      await opts.session.popPendingMessage();
    }
    return;
  }

  const attemptOpts = { activeTurnDeliveryPolicy: readActiveTurnDeliveryPolicy(opts) };
  if (!(await (opts.session.shouldAttemptPendingMaterialization?.(attemptOpts) ?? true))) {
    await opts.session.reconcilePendingQueueState?.({ force: true });
  }

  if (isSessionPendingDrainBlocked(opts.session)) {
    return;
  }

  if (!(await (opts.session.shouldAttemptPendingMaterialization?.(attemptOpts) ?? true))) {
    return;
  }

  if ((await (opts.beforePendingMaterialize?.() ?? true)) !== true) {
    return;
  }

  await opts.session.popPendingMessage();
}

export function createSessionProviderPendingDrainAdapter(
  session: SessionProviderInputConsumerSession,
  defaults?: Pick<
    DrainPendingOptions,
    | 'maxPopPerWake'
    | 'activeTurnDeliveryPolicy'
    | 'resolveActiveTurnDeliveryPolicy'
    | 'deliveryTiming'
  >,
): Pick<SessionProviderInputConsumer<never, never>, 'drainPending'> {
  return {
    async drainPending(drainOpts?: DrainPendingOptions): Promise<DrainPendingResult> {
      return await drainPendingMessages(withDefaultDrainOptions(
        session,
        defaults?.maxPopPerWake,
        defaults?.activeTurnDeliveryPolicy,
        defaults?.resolveActiveTurnDeliveryPolicy,
        defaults?.deliveryTiming === 'after_runtime_idle' ? 'after_runtime_idle' : undefined,
        drainOpts,
      ));
    },
  };
}

function withDefaultDrainOptions(
  session: SessionProviderInputConsumerSession,
  defaultMaxPopPerWake: number | undefined,
  defaultActiveTurnDeliveryPolicy: PendingMaterializationActiveTurnPolicy | undefined,
  defaultResolveActiveTurnDeliveryPolicy: (() => PendingMaterializationActiveTurnPolicy | undefined) | undefined,
  defaultPendingQueueDeliveryTiming: SessionPendingQueueDeliveryTiming | undefined,
  drainOpts: DrainPendingOptions | undefined,
): DrainPendingOptions & { session: SessionProviderInputConsumerSession } {
  const drainPolicyOverride = drainOpts?.activeTurnDeliveryPolicy !== undefined;
  return {
    ...(drainOpts ?? {}),
    session,
    maxPopPerWake: drainOpts?.maxPopPerWake ?? defaultMaxPopPerWake,
    activeTurnDeliveryPolicy: drainOpts?.activeTurnDeliveryPolicy ?? defaultActiveTurnDeliveryPolicy,
    resolveActiveTurnDeliveryPolicy: drainOpts?.resolveActiveTurnDeliveryPolicy
      ?? (drainPolicyOverride ? undefined : defaultResolveActiveTurnDeliveryPolicy),
    deliveryTiming: drainOpts?.deliveryTiming
      ?? (defaultPendingQueueDeliveryTiming === 'after_runtime_idle' ? 'after_runtime_idle' : undefined),
  };
}

async function drainPendingMessages(
  opts: DrainPendingOptions & { session: SessionProviderInputConsumerSession },
): Promise<DrainPendingResult> {
  const maxPopPerWake = Math.max(1, Math.trunc(opts.maxPopPerWake ?? PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE));
  let materialized = 0;

  for (let i = 0; i < maxPopPerWake; i += 1) {
    try {
      if (opts.abortSignal?.aborted) {
        return { materialized, stoppedReason: 'aborted' };
      }
      if (opts.shouldContinue && !(await opts.shouldContinue())) {
        return { materialized, stoppedReason: 'drain_disallowed' };
      }
      if (isSessionPendingDrainBlocked(opts.session)) {
        return { materialized, stoppedReason: 'materialization_blocked' };
      }

      const attemptOpts = { activeTurnDeliveryPolicy: readActiveTurnDeliveryPolicy(opts) };
      if ((await (opts.session.shouldAttemptPendingMaterialization?.(attemptOpts) ?? true)) !== true) {
        await opts.session.reconcilePendingQueueState?.({ force: true });
        if (opts.abortSignal?.aborted) {
          return { materialized, stoppedReason: 'aborted' };
        }
        if (isSessionPendingDrainBlocked(opts.session)) {
          return { materialized, stoppedReason: 'materialization_blocked' };
        }
        if ((await (opts.session.shouldAttemptPendingMaterialization?.(attemptOpts) ?? true)) !== true) {
          return { materialized, stoppedReason: 'materialization_blocked' };
        }
      }

      const result = await materializeNextPendingForDrain(opts.session, opts);
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

function isSessionPendingDrainBlocked(session: SessionProviderInputConsumerSession): boolean {
  if (!session.getMetadataSnapshot) {
    return false;
  }
  const metadata = session.getMetadataSnapshot();
  return isSessionContinuationRecoveryBlockingPendingDrain(metadata)
    || isSessionPendingQueueHoldBlockingPendingDrain(metadata);
}

async function materializeNextPendingForDrain(
  session: SessionProviderInputConsumerSession,
  opts: DrainPendingOptions,
): Promise<Exclude<DrainPendingResult['stoppedReason'], 'aborted' | 'drain_disallowed' | 'materialization_blocked' | 'max_pop_per_wake'> | 'materialized'> {
  const materializeSafely = session.materializeNextPendingMessageSafely;
  if (materializeSafely) {
    try {
      const result = await materializeSafely(buildMaterializeOptions('force', readActiveTurnDeliveryPolicy(opts), opts.deliveryTiming));
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
      return 'no_pending';
    } catch (error) {
      return readDrainErrorStoppedReason(error, opts);
    }
  }

  try {
    const didPop = await session.popPendingMessage();
    return didPop ? 'materialized' : 'no_pending';
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
  controller: AbortController;
  idleWakePollIntervalMs: number;
  metadataWaitRetryBackoffMs: number;
}): Promise<WakeWinner> {
  const queueWait = opts.messageQueue
    .waitForMessagesSignal(opts.controller.signal)
    .then((hasMessages) => ({ kind: 'queue' as const, hasMessages }));
  const idleWait = createIdleWakeWait(opts.idleWakePollIntervalMs, opts.controller.signal);

  try {
    while (true) {
      if (opts.controller.signal.aborted) {
        return { kind: 'meta', ok: false };
      }

      const metaWait = opts.waitForMetadataUpdate(opts.controller.signal).then(
        (ok) => ({ kind: 'meta' as const, ok }),
        () => ({ kind: 'meta' as const, ok: false }),
      );

      const winner = await Promise.race([queueWait, ...(idleWait ? [idleWait.promise] : []), metaWait]);
      if (winner.kind !== 'meta' || winner.ok || opts.controller.signal.aborted) {
        return winner;
      }

      const queueIdleOrBackoffWinner = await Promise.race([
        queueWait,
        ...(idleWait ? [idleWait.promise] : []),
        waitForSessionMetadataRetryBackoff({
          abortSignal: opts.controller.signal,
          backoffMs: opts.metadataWaitRetryBackoffMs,
        }).then(() => null),
      ]);
      if (queueIdleOrBackoffWinner) {
        return queueIdleOrBackoffWinner.kind === 'queue'
          ? { ...queueIdleOrBackoffWinner, refreshBeforeReturn: true }
          : queueIdleOrBackoffWinner;
      }
    }
  } finally {
    idleWait?.cancel();
  }
}

function createIdleWakeWait(
  idleWakePollIntervalMs: number,
  abortSignal: AbortSignal,
): { promise: Promise<WakeWinner>; cancel: () => void } | null {
  if (idleWakePollIntervalMs <= 0) {
    return null;
  }

  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveWait: ((winner: WakeWinner) => void) | null = null;

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    abortSignal.removeEventListener('abort', onAbort);
  };

  const finish = (winner: WakeWinner) => {
    if (done) return;
    done = true;
    cleanup();
    resolveWait?.(winner);
  };

  const onAbort = () => finish({ kind: 'meta', ok: false });

  const promise = new Promise<WakeWinner>((resolve) => {
    resolveWait = resolve;
    timer = setTimeout(() => finish({ kind: 'idle' }), idleWakePollIntervalMs);
    timer.unref?.();
    abortSignal.addEventListener('abort', onAbort, { once: true });
    if (abortSignal.aborted) {
      onAbort();
    }
  });

  return {
    promise,
    cancel: cleanup,
  };
}

async function callMetadataUpdate(onMetadataUpdate: (() => void | Promise<void>) | null | undefined): Promise<void> {
  try {
    await onMetadataUpdate?.();
  } catch {
    // Non-fatal: metadata reconciliation should not break the message loop.
  }
}
