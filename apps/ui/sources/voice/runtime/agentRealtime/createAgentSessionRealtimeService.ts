import type {
  AgentSessionRealtimeAvailability,
  AgentSessionRealtimeHandle,
  AgentSessionRealtimeLifecycleEvent,
  AgentSessionRealtimeStartInput,
  AgentSessionRealtimeStartResult,
  AgentSessionRealtimeStopResult,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  PluginVoiceAgentSessionRealtimeService,
} from '@happier-dev/plugin-sdk/voice/client';
import {
  AgentSessionRealtimeInspectResultV1Schema,
  AgentSessionRealtimeStartRequestV1Schema,
  AgentSessionRealtimeStartResultV1Schema,
  AgentSessionRealtimeStopResultV1Schema,
  AgentSessionRealtimeWatchResultV1Schema,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

import { normalizeVoiceRuntimeFailureCode } from '../voiceRuntimeFailureCode';

type SessionRpc = (input: Readonly<{
  sessionId: string;
  method: string;
  payload: unknown;
  signal: AbortSignal;
}>) => Promise<unknown>;

type StopAttemptOutcome =
  | Readonly<{
      kind: 'caller_aborted';
      result: Readonly<{ status: 'aborted' }>;
    }>
  | Readonly<{
      kind: 'ambiguous';
      result: AgentSessionRealtimeStopResult;
    }>
  | Readonly<{
      kind: 'authoritative';
      result: AgentSessionRealtimeStopResult;
    }>;

const OPERATION_ABORTED = Symbol('operation_aborted');

const HOST_DIAGNOSTIC_MESSAGES = Object.freeze({
  unavailable: 'Agent realtime is unavailable.',
  inspectFailed: 'Agent realtime inspection failed.',
  startFailed: 'Agent realtime start failed.',
  watchFailed: 'Agent realtime watch failed.',
  terminal: 'Agent realtime ended.',
  stopUnavailable: 'Agent realtime stop is unavailable.',
  stopFailed: 'Agent realtime stop failed.',
});

function diagnostic(input: Readonly<{
  code: unknown;
  fallbackCode: string;
  message: string;
  severity?: 'info' | 'warning' | 'error';
}>) {
  const normalizedCode = normalizeVoiceRuntimeFailureCode(input.code);
  return Object.freeze({
    code: normalizedCode === 'voice_connection_failed'
      && input.code !== normalizedCode
      ? input.fallbackCode
      : normalizedCode,
    severity: input.severity ?? 'error',
    message: input.message,
  });
}

function unavailableAvailability(
  code: unknown,
  fallbackCode: string,
  message: string,
  reason: Extract<
    AgentSessionRealtimeAvailability,
    Readonly<{ status: 'unavailable' }>
  >['reason'] = 'session_unavailable',
): AgentSessionRealtimeAvailability {
  return Object.freeze({
    status: 'unavailable' as const,
    reason,
    diagnostic: diagnostic({ code, fallbackCode, message }),
  });
}

/**
 * The RPC seam rejects with this exact message when a request is refused
 * because the attempt or its owning runtime generation has been retired —
 * never because the daemon failed. It is a retirement fact, not an error, so
 * consumers classify it as an aborted attempt rather than an operation failure.
 */
export const AGENT_REALTIME_REQUEST_ABORTED_REJECTION = 'agent_realtime_request_aborted';

function isRequestAbortedRejection(error: unknown): boolean {
  return error instanceof Error
    && error.message === AGENT_REALTIME_REQUEST_ABORTED_REJECTION;
}

function waitForOperationOrAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof OPERATION_ABORTED> {
  if (signal.aborted) return Promise.resolve(OPERATION_ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      resolve(OPERATION_ABORTED);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export function createAgentSessionRealtimeService(input: Readonly<{
  provider: Readonly<{ pluginId: string; localId: string }>;
  conversationSessionId: string;
  applicationAttemptId: string;
  signal: AbortSignal;
  sessionRpc: SessionRpc;
  onTerminal(event: AgentSessionRealtimeLifecycleEvent): void;
}>): PluginVoiceAgentSessionRealtimeService {
  const selection = Object.freeze({
    v: 1 as const,
    provider: input.provider,
  });
  let started = false;
  let terminal: AgentSessionRealtimeLifecycleEvent | null = null;
  let stopAttempt: Promise<StopAttemptOutcome> | null = null;
  let stopResult: AgentSessionRealtimeStopResult | null = null;
  let retainedCleanupResult: AgentSessionRealtimeStopResult | null = null;
  let ambiguousStopObserved = false;
  let disposePromise: Promise<void> | null = null;
  let abortCleanupScheduled = false;
  let lateStartCompensationPromise: Promise<void> | null = null;
  const cleanupSignal = new AbortController().signal;
  const watchers = new Set<Readonly<{
    listener(event: AgentSessionRealtimeLifecycleEvent): void;
  }>>();

  const notifyTerminal = (
    listener: (event: AgentSessionRealtimeLifecycleEvent) => void,
    event: AgentSessionRealtimeLifecycleEvent,
  ): void => {
    try {
      listener(event);
    } catch {
      // Terminal fanout and mandatory cleanup must survive consumer failures.
    }
  };

  const emitTerminal = (event: AgentSessionRealtimeLifecycleEvent): void => {
    if (terminal) return;
    terminal = event;
    const registrations = [...watchers];
    watchers.clear();
    notifyTerminal(input.onTerminal, event);
    for (const registration of registrations) {
      notifyTerminal(registration.listener, event);
    }
  };

  const rpc = async (
    method: string,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<unknown> => {
    if (signal.aborted) throw new Error(AGENT_REALTIME_REQUEST_ABORTED_REJECTION);
    return await input.sessionRpc({
      sessionId: input.conversationSessionId,
      method,
      payload,
      signal,
    });
  };

  const bindOperationSignal = (callerSignal?: AbortSignal) => (
    mergeAbortSignals([input.signal, callerSignal])
  );

  const requestStop = async (
    signal: AbortSignal,
  ): Promise<StopAttemptOutcome> => {
    if (signal.aborted) {
      return {
        kind: 'caller_aborted',
        result: { status: 'aborted' as const },
      };
    }
    try {
      const raw = await rpc(
        SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP,
        { ...selection, applicationAttemptId: input.applicationAttemptId },
        signal,
      );
      const parsed = AgentSessionRealtimeStopResultV1Schema.safeParse(raw);
      if (!parsed.success) {
        return {
          kind: 'ambiguous',
          result: {
            status: 'unavailable' as const,
            diagnostic: diagnostic({
              code: 'agent_realtime_invalid_stop_response',
              fallbackCode: 'agent_realtime_invalid_stop_response',
              message: HOST_DIAGNOSTIC_MESSAGES.stopFailed,
            }),
          },
        };
      }
      if (!parsed.data.ok) {
        return {
          kind: 'authoritative',
          result: {
            status: 'unavailable' as const,
            diagnostic: diagnostic({
              code: parsed.data.code,
              fallbackCode: 'agent_realtime_stop_failed',
              message: HOST_DIAGNOSTIC_MESSAGES.stopUnavailable,
            }),
          },
        };
      }
      if (parsed.data.status !== 'already_stopped') {
        emitTerminal({
          kind: 'terminal',
          reason: parsed.data.status === 'aborted' ? 'aborted' : 'stopped',
        });
      }
      return {
        kind: 'authoritative',
        result: { status: parsed.data.status },
      };
    } catch {
      if (signal.aborted) {
        return {
          kind: 'caller_aborted',
          result: { status: 'aborted' as const },
        };
      }
      return {
        kind: 'ambiguous',
        result: {
          status: 'unavailable' as const,
          diagnostic: diagnostic({
            code: 'agent_realtime_stop_failed',
            fallbackCode: 'agent_realtime_stop_failed',
            message: HOST_DIAGNOSTIC_MESSAGES.stopFailed,
          }),
        },
      };
    }
  };

  const ensureStopped = async (
    signal: AbortSignal,
    options: Readonly<{ retryAmbiguousOnce?: boolean }> = {},
  ): Promise<AgentSessionRealtimeStopResult> => {
    let canRetryAmbiguous =
      options.retryAmbiguousOnce === true
      && !ambiguousStopObserved;
    if (stopResult) return stopResult;
    if (retainedCleanupResult) return retainedCleanupResult;
    if (signal.aborted) return { status: 'aborted' };
    if (!started) {
      return { status: terminal ? 'already_stopped' : 'aborted' };
    }
    for (;;) {
      if (stopResult) return stopResult;
      if (retainedCleanupResult) return retainedCleanupResult;
      if (signal.aborted) return { status: 'aborted' };
      const currentAttempt = stopAttempt ?? requestStop(signal);
      stopAttempt = currentAttempt;
      const outcome = await waitForOperationOrAbort(currentAttempt, signal);
      if (outcome === OPERATION_ABORTED) return { status: 'aborted' };
      if (stopAttempt === currentAttempt) stopAttempt = null;
      if (outcome.kind === 'authoritative') {
        stopResult ??= outcome.result;
        return stopResult;
      }
      if (outcome.kind === 'ambiguous') {
        ambiguousStopObserved = true;
        if (canRetryAmbiguous) {
          canRetryAmbiguous = false;
          continue;
        }
        return outcome.result;
      }
      if (signal.aborted) return outcome.result;
    }
  };

  const stop = (
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<AgentSessionRealtimeStopResult> => {
    return ensureStopped(options.signal ?? cleanupSignal);
  };

  const scheduleAbortCleanup = (): void => {
    if (abortCleanupScheduled) return;
    abortCleanupScheduled = true;
    void ensureDisposalCleanup();
  };

  const ensureDisposalCleanup = (): Promise<void> => {
    disposePromise ??= ensureStopped(
      cleanupSignal,
      { retryAmbiguousOnce: true },
    ).then((result) => {
      if (result.status !== 'unavailable') return;
      if (!stopResult) retainedCleanupResult ??= result;
      emitTerminal({
        kind: 'terminal',
        reason: 'error',
        diagnostic: result.diagnostic,
      });
    });
    return disposePromise;
  };

  const ensureLateStartCompensation = (): Promise<void> => {
    if (lateStartCompensationPromise) return lateStartCompensationPromise;
    lateStartCompensationPromise = (async () => {
      if (retainedCleanupResult) {
        retainedCleanupResult = null;
        ambiguousStopObserved = false;
        await ensureStopped(cleanupSignal, { retryAmbiguousOnce: true });
        return;
      }
      const initialStopResult = stopResult ?? await ensureStopped(
        cleanupSignal,
        { retryAmbiguousOnce: true },
      );
      if (initialStopResult.status !== 'already_stopped') return;
      stopResult = null;
      ambiguousStopObserved = false;
      await ensureStopped(cleanupSignal, { retryAmbiguousOnce: true });
    })();
    return lateStartCompensationPromise;
  };

  const handle: AgentSessionRealtimeHandle = Object.freeze({
    stop,
    watch(listener: (event: AgentSessionRealtimeLifecycleEvent) => void) {
      const registration = Object.freeze({ listener });
      if (terminal) notifyTerminal(listener, terminal);
      else watchers.add(registration);
      return Object.freeze({
        dispose() {
          watchers.delete(registration);
        },
      });
    },
    dispose() {
      return ensureDisposalCleanup();
    },
  });

  const watchTerminal = (): void => {
    void rpc(
      SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH,
      { ...selection, applicationAttemptId: input.applicationAttemptId },
      input.signal,
    ).then((raw) => {
      const parsed = AgentSessionRealtimeWatchResultV1Schema.safeParse(raw);
      if (!parsed.success) {
        emitTerminal({
          kind: 'terminal',
          reason: 'error',
          diagnostic: diagnostic({
            code: 'agent_realtime_invalid_watch_response',
            fallbackCode: 'agent_realtime_invalid_watch_response',
            message: HOST_DIAGNOSTIC_MESSAGES.watchFailed,
          }),
        });
        return;
      }
      if (!parsed.data.ok) {
        emitTerminal({
          kind: 'terminal',
          reason: 'error',
          diagnostic: diagnostic({
            code: parsed.data.code,
            fallbackCode: 'agent_realtime_watch_failed',
            message: HOST_DIAGNOSTIC_MESSAGES.watchFailed,
          }),
        });
        return;
      }
      emitTerminal({
        kind: 'terminal',
        reason: parsed.data.event.reason,
        ...(parsed.data.event.diagnostic
          ? {
              diagnostic: diagnostic({
                code: parsed.data.event.diagnostic.code,
                fallbackCode: 'agent_realtime_terminal_error',
                message: HOST_DIAGNOSTIC_MESSAGES.terminal,
                severity: parsed.data.event.diagnostic.severity,
              }),
            }
          : {}),
      });
    }).catch(() => {
      emitTerminal({
        kind: 'terminal',
        reason: input.signal.aborted ? 'aborted' : 'error',
        ...(input.signal.aborted
          ? {}
          : {
              diagnostic: diagnostic({
                code: 'agent_realtime_watch_failed',
                fallbackCode: 'agent_realtime_watch_failed',
                message: HOST_DIAGNOSTIC_MESSAGES.watchFailed,
              }),
            }),
      });
    });
  };

  const onAbort = (): void => {
    emitTerminal({ kind: 'terminal', reason: 'aborted' });
    scheduleAbortCleanup();
  };
  if (input.signal.aborted) onAbort();
  else input.signal.addEventListener('abort', onAbort, { once: true });

  return Object.freeze({
    async inspect(options: Readonly<{ signal?: AbortSignal }> = {}) {
      if (input.signal.aborted || options.signal?.aborted) {
        return unavailableAvailability(
          'agent_realtime_attempt_aborted',
          'agent_realtime_attempt_aborted',
          HOST_DIAGNOSTIC_MESSAGES.unavailable,
        );
      }
      const operationSignal = bindOperationSignal(options.signal);
      const signal = operationSignal.signal;
      try {
        const raw = await waitForOperationOrAbort(rpc(
          SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT,
          selection,
          signal,
        ), signal);
        if (raw === OPERATION_ABORTED || signal.aborted) {
          return unavailableAvailability(
            'agent_realtime_attempt_aborted',
            'agent_realtime_attempt_aborted',
            HOST_DIAGNOSTIC_MESSAGES.unavailable,
          );
        }
        const parsed = AgentSessionRealtimeInspectResultV1Schema.safeParse(raw);
        if (!parsed.success) {
          return unavailableAvailability(
            'agent_realtime_invalid_inspect_response',
            'agent_realtime_invalid_inspect_response',
            HOST_DIAGNOSTIC_MESSAGES.inspectFailed,
          );
        }
        if (!parsed.data.ok) {
          return unavailableAvailability(
            parsed.data.code,
            'agent_realtime_inspect_failed',
            HOST_DIAGNOSTIC_MESSAGES.unavailable,
            parsed.data.reason ?? 'session_unavailable',
          );
        }
        return Object.freeze({
          status: 'available' as const,
          transport: 'webrtc' as const,
        });
      } catch (error) {
        const retired = signal.aborted || isRequestAbortedRejection(error);
        return unavailableAvailability(
          retired
            ? 'agent_realtime_attempt_aborted'
            : 'agent_realtime_inspect_failed',
          'agent_realtime_inspect_failed',
          retired
            ? HOST_DIAGNOSTIC_MESSAGES.unavailable
            : HOST_DIAGNOSTIC_MESSAGES.inspectFailed,
        );
      } finally {
        operationSignal.dispose();
      }
    },
    async start(
      request: AgentSessionRealtimeStartInput,
      options: Readonly<{ signal?: AbortSignal }> = {},
    ): Promise<AgentSessionRealtimeStartResult> {
      if (input.signal.aborted || options.signal?.aborted) return { status: 'aborted' };
      if (started) return { status: 'busy' };
      const parsedRequest = AgentSessionRealtimeStartRequestV1Schema.safeParse({
        ...selection,
        applicationAttemptId: input.applicationAttemptId,
        ...request,
      });
      if (!parsedRequest.success) {
        return {
          status: 'failed',
          diagnostic: diagnostic({
            code: 'agent_realtime_invalid_start_request',
            fallbackCode: 'agent_realtime_invalid_start_request',
            message: HOST_DIAGNOSTIC_MESSAGES.startFailed,
          }),
        };
      }
      started = true;
      const operationSignal = bindOperationSignal(options.signal);
      const signal = operationSignal.signal;
      try {
        const startRequest = rpc(
          SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START,
          parsedRequest.data,
          signal,
        ).then(async (raw) => {
          const parsed = AgentSessionRealtimeStartResultV1Schema.safeParse(raw);
          if (
            signal.aborted
            && parsed.success
            && parsed.data.ok
            && parsed.data.status === 'started'
          ) {
            await ensureLateStartCompensation();
          }
          return parsed;
        });
        const parsed = await waitForOperationOrAbort(startRequest, signal);
        if (parsed === OPERATION_ABORTED || signal.aborted) {
          emitTerminal({ kind: 'terminal', reason: 'aborted' });
          scheduleAbortCleanup();
          return { status: 'aborted' };
        }
        if (!parsed.success) {
          return {
            status: 'failed',
            diagnostic: diagnostic({
              code: 'agent_realtime_invalid_start_response',
              fallbackCode: 'agent_realtime_invalid_start_response',
              message: HOST_DIAGNOSTIC_MESSAGES.startFailed,
            }),
          };
        }
        if (!parsed.data.ok) {
          return {
            status: parsed.data.status,
            diagnostic: diagnostic({
              code: parsed.data.code,
              fallbackCode: 'agent_realtime_start_failed',
              message: HOST_DIAGNOSTIC_MESSAGES.startFailed,
            }),
          };
        }
        if (parsed.data.status !== 'started') return { status: parsed.data.status };
        watchTerminal();
        return Object.freeze({
          status: 'started' as const,
          transport: parsed.data.transport,
          handle,
        });
      } catch {
        if (signal.aborted) {
          emitTerminal({ kind: 'terminal', reason: 'aborted' });
          scheduleAbortCleanup();
          return { status: 'aborted' };
        }
        return {
          status: 'failed',
          diagnostic: diagnostic({
            code: 'agent_realtime_start_failed',
            fallbackCode: 'agent_realtime_start_failed',
            message: HOST_DIAGNOSTIC_MESSAGES.startFailed,
          }),
        };
      } finally {
        operationSignal.dispose();
      }
    },
  });
}
