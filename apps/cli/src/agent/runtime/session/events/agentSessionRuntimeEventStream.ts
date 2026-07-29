import {
  AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1,
  AgentSessionRuntimeEventV1Schema,
} from '@happier-dev/protocol/runtime';

import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agent-runtime';
import type { Disposable, PluginDiagnosticData } from '@happier-dev/plugin-sdk';

export type AgentSessionRuntimeEventStreamFailure =
  | Readonly<{
      status: 'overflow';
      reason: 'count' | 'bytes';
      diagnostic: PluginDiagnosticData;
    }>
  | Readonly<{
      status: 'invalidEvent' | 'listenerFailed';
      diagnostic: PluginDiagnosticData;
    }>;

export type AgentSessionRuntimeEventPublishResult =
  | Readonly<{ status: 'accepted'; delivery: 'buffered' | 'delivered' }>
  | AgentSessionRuntimeEventStreamFailure
  | Readonly<{ status: 'disposed'; diagnostic: PluginDiagnosticData }>;

export type AgentSessionRuntimeEventStreamDisposeResult = Readonly<{
  status: 'disposed';
  undeliveredEvents: number;
  undeliveredJsonBytes: number;
  listenerDrainTimedOut: boolean;
}>;

export type AgentSessionRuntimeEventStreamDisposeOptions = Readonly<{
  timeoutMs?: number;
}>;

export type AgentSessionRuntimeEventListener = (
  event: AgentSessionRuntimeEvent,
) => void | Promise<void>;

export type AgentSessionRuntimeEventAdmissionOptions = Readonly<{
  useRecoveryReserve?: boolean;
}>;

export type AgentSessionRuntimeEventStream = Readonly<{
  publish(event: AgentSessionRuntimeEvent): Promise<AgentSessionRuntimeEventPublishResult>;
  admit(
    event: AgentSessionRuntimeEvent,
    options?: AgentSessionRuntimeEventAdmissionOptions,
  ): AgentSessionRuntimeEventPublishResult;
  watch(listener: AgentSessionRuntimeEventListener): Disposable;
  whenIdle(): Promise<void>;
  dispose(
    options?: AgentSessionRuntimeEventStreamDisposeOptions,
  ): Promise<AgentSessionRuntimeEventStreamDisposeResult>;
}>;

type PendingEvent = {
  readonly event: AgentSessionRuntimeEvent;
  readonly jsonBytes: number;
  readonly settle?: (result: AgentSessionRuntimeEventPublishResult) => void;
};

const BUFFER_LIMITS = AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.p0MeasuredCandidates;
const DEFAULT_LISTENER_DISPOSAL_TIMEOUT_MS = 5_000;

const DISPOSED_DIAGNOSTIC: PluginDiagnosticData = Object.freeze({
  code: 'agent_runtime_event_stream_disposed',
  severity: 'warning',
});

function overflowFailure(reason: 'count' | 'bytes'): AgentSessionRuntimeEventStreamFailure {
  return Object.freeze({
    status: 'overflow',
    reason,
    diagnostic: Object.freeze({
      code: 'agent_runtime_event_buffer_overflow',
      severity: 'error',
      details: Object.freeze({ reason }),
    }),
  });
}

function invalidEventFailure(): AgentSessionRuntimeEventStreamFailure {
  return Object.freeze({
    status: 'invalidEvent',
    diagnostic: Object.freeze({
      code: 'agent_runtime_event_invalid',
      severity: 'error',
    }),
  });
}

function listenerFailure(
  undeliveredEvents: number,
  undeliveredJsonBytes: number,
): AgentSessionRuntimeEventStreamFailure {
  return Object.freeze({
    status: 'listenerFailed',
    diagnostic: Object.freeze({
      code: 'agent_runtime_event_listener_failed',
      severity: 'error',
      details: Object.freeze({ undeliveredEvents, undeliveredJsonBytes }),
    }),
  });
}

export function measureAgentSessionRuntimeEventJsonBytes(
  event: AgentSessionRuntimeEvent,
): number {
  return new TextEncoder().encode(JSON.stringify(event)).byteLength;
}

export function createAgentSessionRuntimeEventStream(
  options: Readonly<{
    onFailure?: (
      failure: AgentSessionRuntimeEventStreamFailure,
    ) => void | Promise<void>;
    recoveryReserve?: Readonly<{ maxEvents: number; maxJsonBytes: number }>;
  }> = {},
): AgentSessionRuntimeEventStream {
  const pending: PendingEvent[] = [];
  let pendingJsonBytes = 0;
  let listener: AgentSessionRuntimeEventListener | undefined;
  let terminalFailure: AgentSessionRuntimeEventStreamFailure | undefined;
  let disposed = false;
  let drainPromise: Promise<void> | undefined;
  let disposePromise: Promise<AgentSessionRuntimeEventStreamDisposeResult> | undefined;
  let listenerInvocationActive = false;
  let lastAcceptedSequence: number | undefined;
  let acceptedSessionId: string | undefined;
  const recoveryReserveMaxEvents = Math.min(
    BUFFER_LIMITS.preWatchReplayBufferMaxEvents,
    Math.max(0, Math.trunc(options.recoveryReserve?.maxEvents ?? 0)),
  );
  const recoveryReserveMaxJsonBytes = Math.min(
    BUFFER_LIMITS.preWatchReplayBufferMaxJsonBytes,
    Math.max(0, Math.trunc(options.recoveryReserve?.maxJsonBytes ?? 0)),
  );

  const notifyFailure = (failure: AgentSessionRuntimeEventStreamFailure): void => {
    if (terminalFailure !== undefined) return;
    terminalFailure = failure;
    try {
      const observation = options.onFailure?.(failure);
      if (observation !== undefined) {
        void Promise.resolve(observation).catch(() => {
          // Failure observation must never replace or hide the owning stream failure.
        });
      }
    } catch {
      // Failure observation must never replace or hide the owning stream failure.
    }
  };

  const settleAndRemoveHead = (result: AgentSessionRuntimeEventPublishResult): void => {
    const entry = pending.shift();
    if (entry === undefined) return;
    pendingJsonBytes -= entry.jsonBytes;
    entry.settle?.(result);
  };

  const failPendingDeliveries = (result: AgentSessionRuntimeEventPublishResult): void => {
    while (pending.length > 0) settleAndRemoveHead(result);
  };

  const ensureDrain = (): void => {
    if (listener === undefined || drainPromise !== undefined || pending.length === 0) return;
    drainPromise = Promise.resolve().then(async () => {
      while (listener !== undefined && pending.length > 0 && !disposed) {
        const currentListener = listener;
        const current = pending[0]!;
        try {
          listenerInvocationActive = true;
          await currentListener(current.event);
          settleAndRemoveHead({ status: 'accepted', delivery: 'delivered' });
        } catch {
          const failure = listenerFailure(pending.length, pendingJsonBytes);
          notifyFailure(failure);
          failPendingDeliveries(failure);
          listener = undefined;
          break;
        } finally {
          listenerInvocationActive = false;
        }
      }
    }).finally(() => {
      drainPromise = undefined;
      if (listener !== undefined && pending.length > 0 && !disposed) ensureDrain();
    });
  };

  const enqueue = (
    event: AgentSessionRuntimeEvent,
    admissionOptions: AgentSessionRuntimeEventAdmissionOptions,
    waitForDelivery: boolean,
  ): AgentSessionRuntimeEventPublishResult | Promise<AgentSessionRuntimeEventPublishResult> => {
    if (disposed) return { status: 'disposed', diagnostic: DISPOSED_DIAGNOSTIC };
    const useRecoveryReserve = admissionOptions.useRecoveryReserve === true;
    if (
      terminalFailure !== undefined
      && !(useRecoveryReserve && terminalFailure.status === 'overflow')
    ) return terminalFailure;

    const parsed = AgentSessionRuntimeEventV1Schema.safeParse(event);
    if (!parsed.success) {
      const failure = invalidEventFailure();
      notifyFailure(failure);
      return failure;
    }
    const normalized: AgentSessionRuntimeEvent = parsed.data;
    if (acceptedSessionId !== undefined && normalized.sessionId !== acceptedSessionId) {
      const failure = invalidEventFailure();
      notifyFailure(failure);
      return failure;
    }
    if (lastAcceptedSequence !== undefined && normalized.sequence <= lastAcceptedSequence) {
      const failure = invalidEventFailure();
      notifyFailure(failure);
      return failure;
    }
    const jsonBytes = measureAgentSessionRuntimeEventJsonBytes(normalized);
    const nextCount = pending.length + 1;
    const nextJsonBytes = pendingJsonBytes + jsonBytes;
    const countLimit = BUFFER_LIMITS.preWatchReplayBufferMaxEvents
      - (useRecoveryReserve ? 0 : recoveryReserveMaxEvents);
    const jsonByteLimit = BUFFER_LIMITS.preWatchReplayBufferMaxJsonBytes
      - (useRecoveryReserve ? 0 : recoveryReserveMaxJsonBytes);
    if (nextCount > countLimit) {
      const failure = overflowFailure('count');
      notifyFailure(failure);
      return failure;
    }
    if (nextJsonBytes > jsonByteLimit) {
      const failure = overflowFailure('bytes');
      notifyFailure(failure);
      return failure;
    }

    acceptedSessionId = normalized.sessionId;
    if (listener === undefined || listenerInvocationActive || !waitForDelivery) {
      pending.push({ event: normalized, jsonBytes });
      pendingJsonBytes = nextJsonBytes;
      lastAcceptedSequence = normalized.sequence;
      ensureDrain();
      return { status: 'accepted', delivery: 'buffered' };
    }

    const delivered = new Promise<AgentSessionRuntimeEventPublishResult>((settle) => {
      pending.push({ event: normalized, jsonBytes, settle });
      pendingJsonBytes = nextJsonBytes;
      lastAcceptedSequence = normalized.sequence;
    });
    ensureDrain();
    return delivered;
  };

  const publish = (
    event: AgentSessionRuntimeEvent,
  ): Promise<AgentSessionRuntimeEventPublishResult> => Promise.resolve(enqueue(event, {}, true));

  const admit = (
    event: AgentSessionRuntimeEvent,
    admissionOptions: AgentSessionRuntimeEventAdmissionOptions = {},
  ): AgentSessionRuntimeEventPublishResult => enqueue(
    event,
    admissionOptions,
    false,
  ) as AgentSessionRuntimeEventPublishResult;

  const watch = (nextListener: AgentSessionRuntimeEventListener): Disposable => {
    if (disposed) throw new Error('Agent session runtime event stream is disposed');
    if (listener !== undefined) {
      throw new Error('Agent session runtime event stream already has an active watcher');
    }
    if (terminalFailure?.status === 'listenerFailed') {
      throw new Error('Agent session runtime event stream has terminally failed');
    }
    listener = nextListener;
    ensureDrain();

    return {
      dispose(): void {
        if (listener !== nextListener) return;
        listener = undefined;
      },
    };
  };

  const whenIdle = async (): Promise<void> => {
    while (drainPromise !== undefined) await drainPromise;
  };

  const dispose = (
    disposeOptions: AgentSessionRuntimeEventStreamDisposeOptions = {},
  ): Promise<AgentSessionRuntimeEventStreamDisposeResult> => {
    if (disposePromise !== undefined) return disposePromise;
    disposed = true;
    listener = undefined;
    disposePromise = (async () => {
      let listenerDrainTimedOut = false;
      if (drainPromise !== undefined) {
        const requestedTimeoutMs = disposeOptions.timeoutMs;
        const timeoutMs = requestedTimeoutMs !== undefined
          && Number.isFinite(requestedTimeoutMs)
          && requestedTimeoutMs > 0
          ? requestedTimeoutMs
          : DEFAULT_LISTENER_DISPOSAL_TIMEOUT_MS;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
          drainPromise.then(() => 'drained' as const),
          new Promise<'timeout'>((resolve) => {
            timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs);
          }),
        ]);
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        listenerDrainTimedOut = outcome === 'timeout';
      }
      const result = {
        status: 'disposed' as const,
        undeliveredEvents: pending.length,
        undeliveredJsonBytes: pendingJsonBytes,
        listenerDrainTimedOut,
      };
      failPendingDeliveries({ status: 'disposed', diagnostic: DISPOSED_DIAGNOSTIC });
      return result;
    })();
    return disposePromise;
  };

  return Object.freeze({ publish, admit, watch, whenIdle, dispose });
}
