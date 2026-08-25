import type { PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import {
  AgentSessionRealtimeStartRequestV1Schema,
  AgentSessionRealtimeStartResultV1Schema,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  AgentSessionRealtimeAvailability,
  AgentSessionRealtimeConversation,
  AgentSessionRealtimeHandle,
  AgentSessionRealtimeLifecycleEvent,
  AgentSessionRealtimeStartInput,
  AgentSessionRealtimeStartResult,
  AgentSessionRealtimeStopResult,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { classifyCodexConnectedServiceAuthFailure } from '../../auth/services/runtime/auth/failure.js';
import {
  isCodexRealtimeEnabledAppServerLaunchUnavailableError,
  type DisposableCodexAppServerClient,
} from './client.js';
import { readCodexAppServerRealtimeStartTimeoutMs } from './client/timeout.js';
import { isCodexAppServerApplicationRejectionForMethod } from './compatibility.js';
import {
  CODEX_OPERATION_ABORTED,
  inspectCodexRealtimeFeature,
  waitForCodexOperationOrAbort,
  type CodexRealtimeFeatureInspection,
} from './realtimeFeatureInspection.js';

type CodexAppServerRealtimeConversation = AgentSessionRealtimeConversation & Readonly<{
  isActive(): boolean;
  hasRetainedAttemptAuthority(): boolean;
  dispose(): Promise<void>;
}>;

type AttemptPhase =
  | 'negotiating'
  | 'started'
  | 'active'
  | 'terminal';

type LifecycleSubscription = Readonly<{
  listener(event: AgentSessionRealtimeLifecycleEvent): void;
}>;

type Attempt = {
  client: DisposableCodexAppServerClient;
  threadId: string;
  phase: AttemptPhase;
  requestAccepted: boolean;
  answerSdp: string | null;
  stopRequested: boolean;
  stopIssued: boolean;
  requestedCloseObserved: boolean;
  stopPromise: Promise<PluginDiagnosticData | null> | null;
  terminal: AgentSessionRealtimeLifecycleEvent | null;
  listeners: Set<LifecycleSubscription>;
  unregisters: Array<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  settleStart(result: AgentSessionRealtimeStartResult): void;
  startSettled: boolean;
  handle: AgentSessionRealtimeHandle;
};

function diagnostic(code: string, message: string): PluginDiagnosticData {
  return { code, severity: 'error', message };
}

function unavailable(
  reason: Extract<AgentSessionRealtimeAvailability, { status: 'unavailable' }>['reason'],
  code: string,
  message: string,
): AgentSessionRealtimeAvailability {
  return {
    status: 'unavailable',
    reason,
    diagnostic: diagnostic(code, message),
  };
}

function authenticationRequiredDiagnostic(
  error: unknown,
): PluginDiagnosticData | null {
  const classification = classifyCodexConnectedServiceAuthFailure({
    providerErrorPath: true,
    error,
    serviceId: 'openai-codex',
    profileId: null,
    groupId: null,
  });
  if (
    classification?.kind !== 'auth_expired'
    && classification?.kind !== 'account_changed'
    && classification?.kind !== 'refresh_failed'
  ) {
    return null;
  }
  return diagnostic(
    'codex_realtime_authentication_required',
    'The selected Codex session must be connected again.',
  );
}

function authenticationRequiredAvailability(
  error: unknown,
): AgentSessionRealtimeAvailability | null {
  const authDiagnostic = authenticationRequiredDiagnostic(error);
  return authDiagnostic
    ? {
      status: 'unavailable',
      reason: 'authentication_required',
      diagnostic: authDiagnostic,
    }
    : null;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function isExactEmptyResponse(value: unknown): boolean {
  const record = readRecord(value);
  return record !== null && Object.keys(record).length === 0;
}

function isGeneratedRealtimeStartedNotification(
  record: Readonly<Record<string, unknown>>,
): boolean {
  return (
    (record.realtimeSessionId === null
      || typeof record.realtimeSessionId === 'string')
    && (
      record.version === 'v1'
      || record.version === 'v2'
      || record.version === 'v3'
    )
  );
}

function isGeneratedRealtimeSdpNotification(
  record: Readonly<Record<string, unknown>>,
): boolean {
  return typeof record.sdp === 'string';
}

function isGeneratedRealtimeErrorNotification(
  record: Readonly<Record<string, unknown>>,
): boolean {
  return typeof record.message === 'string';
}

function isGeneratedRealtimeClosedNotification(
  record: Readonly<Record<string, unknown>>,
): boolean {
  return record.reason === null || typeof record.reason === 'string';
}

function mapFeatureInspectionToAvailability(
  inspection: CodexRealtimeFeatureInspection,
): AgentSessionRealtimeAvailability {
  if (inspection.status === 'enabled') return { status: 'available', transport: 'webrtc' };
  switch (inspection.code) {
    case 'feature_not_advertised':
      return unavailable('update_required', 'codex_realtime_feature_not_advertised', 'The selected Codex runtime does not advertise Codex Realtime Voice.');
    case 'inspection_aborted':
      return unavailable('feature_unavailable', 'codex_realtime_inspect_aborted', 'Codex Realtime Voice readiness inspection was aborted.');
    case 'currentness_lost':
      return unavailable('session_unavailable', 'codex_realtime_thread_changed', 'The selected Codex session changed during readiness inspection.');
    case 'authentication_required':
      return unavailable('authentication_required', 'codex_realtime_authentication_required', 'The selected Codex session must be connected again.');
    case 'feature_list_unavailable':
      return unavailable('feature_unavailable', 'codex_realtime_feature_list_unavailable', 'The selected Codex runtime could not verify Codex Realtime Voice.');
    case 'feature_list_invalid':
      return unavailable('feature_unavailable', 'codex_realtime_feature_list_invalid', 'The selected Codex runtime returned an invalid feature list.');
    case 'feature_state_invalid':
      return unavailable('feature_unavailable', 'codex_realtime_feature_state_invalid', 'The selected Codex runtime returned an invalid Realtime Voice feature state.');
    case 'feature_state_ambiguous':
      return unavailable('feature_unavailable', 'codex_realtime_feature_state_ambiguous', 'The selected Codex runtime returned conflicting Realtime Voice feature state.');
    case 'feature_pagination_invalid':
      return unavailable('feature_unavailable', 'codex_realtime_feature_pagination_invalid', 'The selected Codex runtime returned an invalid feature-list cursor.');
    case 'feature_pagination_incomplete':
      return unavailable('feature_unavailable', 'codex_realtime_feature_pagination_incomplete', 'The selected Codex runtime feature list could not be exhausted safely.');
    case 'feature_missing':
      return unavailable('update_required', 'codex_realtime_feature_missing', 'The selected Codex runtime does not include Codex Realtime Voice.');
    case 'feature_disabled':
      return unavailable('feature_unavailable', 'codex_realtime_feature_disabled', 'Codex Realtime Voice is not enabled in the selected Codex session.');
  }
}

export function createCodexAppServerRealtimeConversation(params: Readonly<{
  getClient(): Promise<DisposableCodexAppServerClient>;
  getThreadId(): string | null;
  isDisposed(): boolean;
  isRuntimeExited?(): boolean;
  settlementTimeoutMs?: number;
}>): CodexAppServerRealtimeConversation {
  let attempt: Attempt | null = null;
  let preparing = false;

  const cleanupAttempt = (target: Attempt): void => {
    if (target.timer) {
      clearTimeout(target.timer);
      target.timer = null;
    }
    while (target.unregisters.length > 0) target.unregisters.pop()?.();
    if (attempt === target) attempt = null;
  };

  const settleStart = (
    target: Attempt,
    result: AgentSessionRealtimeStartResult,
  ): void => {
    if (target.startSettled) return;
    target.startSettled = true;
    target.settleStart(result);
  };

  const publishTerminal = (
    target: Attempt,
    event: AgentSessionRealtimeLifecycleEvent,
  ): void => {
    if (target.terminal) return;
    target.terminal = event;
    for (const subscription of [...target.listeners]) {
      try {
        subscription.listener(event);
      } catch {
        // One lifecycle consumer cannot block retained terminal fanout.
      }
    }
    target.listeners.clear();
  };

  const maybeReleaseOwnedStop = (target: Attempt): void => {
    if (
      !target.requestedCloseObserved
      || params.getThreadId() !== target.threadId
      || target.terminal?.kind !== 'terminal'
      || target.terminal.reason !== 'stopped'
    ) {
      return;
    }
    cleanupAttempt(target);
  };

  const requestStop = async (
    target: Attempt,
  ): Promise<PluginDiagnosticData | null> => {
    if (target.stopPromise) return await target.stopPromise;
    target.stopRequested = true;
    target.stopPromise = (async () => {
      try {
        target.stopIssued = true;
        const response = await target.client.request('thread/realtime/stop', {
          threadId: target.threadId,
        });
        if (!isExactEmptyResponse(response)) {
          return diagnostic(
            'codex_realtime_stop_response_invalid',
            'Codex Realtime Voice returned an invalid stop response.',
          );
        }
        return null;
      } catch {
        return diagnostic(
          'codex_realtime_stop_failed',
          'Codex Realtime Voice could not confirm upstream stop.',
        );
      }
    })();
    return await target.stopPromise;
  };

  const failNegotiation = (
    target: Attempt,
    failureDiagnostic: PluginDiagnosticData,
    options?: Readonly<{ requestUpstreamStop?: boolean }>,
  ): void => {
    if (target.phase === 'terminal') return;
    target.phase = 'terminal';
    if (target.timer) {
      clearTimeout(target.timer);
      target.timer = null;
    }
    const cleanup = options?.requestUpstreamStop === false
      ? null
      : requestStop(target);
    settleStart(target, { status: 'failed', diagnostic: failureDiagnostic });
    publishTerminal(target, {
      kind: 'terminal',
      reason: 'error',
      diagnostic: failureDiagnostic,
    });
    if (cleanup) void cleanup;
  };

  const maybeSettleStarted = (target: Attempt): void => {
    if (
      target.phase !== 'started'
      || !target.requestAccepted
      || target.answerSdp === null
    ) {
      return;
    }
    target.phase = 'active';
    if (target.timer) {
      clearTimeout(target.timer);
      target.timer = null;
    }
    settleStart(target, {
      status: 'started',
      transport: {
        kind: 'webrtc',
        answerSdp: target.answerSdp,
      },
      handle: target.handle,
    });
  };

  const failInvalidNotification = (target: Attempt): void => {
    const eventDiagnostic = diagnostic(
      'codex_realtime_notification_invalid',
      'The selected Codex runtime returned an invalid realtime lifecycle notification.',
    );
    if (target.phase === 'active') {
      target.phase = 'terminal';
      const cleanup = requestStop(target);
      publishTerminal(target, {
        kind: 'terminal',
        reason: 'error',
        diagnostic: eventDiagnostic,
      });
      void cleanup;
      return;
    }
    failNegotiation(target, eventDiagnostic);
  };

  const stopAttempt = async (
    target: Attempt,
    terminalReason: Extract<
      AgentSessionRealtimeLifecycleEvent['reason'],
      'stopped' | 'agent_session_disposed' | 'aborted'
    >,
  ): Promise<PluginDiagnosticData | null> => {
    if (target.phase !== 'terminal') {
      target.phase = 'terminal';
      if (target.timer) {
        clearTimeout(target.timer);
        target.timer = null;
      }
      const cleanup = requestStop(target);
      const terminalDiagnostic = terminalReason === 'agent_session_disposed'
        ? diagnostic(
          'codex_realtime_agent_session_disposed',
          'The Codex Agent session was disposed during Realtime Voice.',
        )
        : undefined;
      settleStart(
        target,
        terminalReason === 'aborted'
          ? { status: 'aborted' }
          : {
            status: 'failed',
            diagnostic: terminalDiagnostic ?? diagnostic(
              'codex_realtime_stopped_during_start',
              'Codex Realtime Voice stopped before negotiation completed.',
            ),
          },
      );
      const stopDiagnostic = await cleanup;
      publishTerminal(
        target,
        stopDiagnostic && terminalReason === 'stopped'
          ? {
            kind: 'terminal',
            reason: 'error',
            diagnostic: stopDiagnostic,
          }
          : {
            kind: 'terminal',
            reason: terminalReason,
            ...(terminalDiagnostic ? { diagnostic: terminalDiagnostic } : {}),
          },
      );
      maybeReleaseOwnedStop(target);
      return stopDiagnostic;
    }
    return target.stopPromise ? await target.stopPromise : null;
  };

  const resolveAvailability = async (
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Readonly<{
    availability: AgentSessionRealtimeAvailability;
    client?: DisposableCodexAppServerClient;
    threadId?: string;
  }>> => {
    if (params.isDisposed()) {
      return {
        availability: unavailable(
          'session_unavailable',
          'codex_realtime_session_disposed',
          'The selected Codex Agent session is unavailable.',
        ),
      };
    }
    if (params.isRuntimeExited?.() === true) {
      return {
        availability: unavailable(
          'session_unavailable',
          'codex_realtime_runtime_restart_required',
          'The Codex app-server runtime exited and must be recovered by the Agent session owner.',
        ),
      };
    }
    const threadId = params.getThreadId();
    if (!threadId) {
      return {
        availability: unavailable(
          'session_unavailable',
          'codex_realtime_thread_unavailable',
          'The selected Codex Agent session has no active app-server thread.',
        ),
      };
    }
    let client: DisposableCodexAppServerClient;
    try {
      const clientOutcome = await waitForCodexOperationOrAbort(
        params.getClient(),
        options?.signal,
      );
      if (clientOutcome === CODEX_OPERATION_ABORTED) {
        return {
          availability: unavailable(
            'feature_unavailable',
            'codex_realtime_inspect_aborted',
            'Codex Realtime Voice readiness inspection was aborted.',
          ),
        };
      }
      client = clientOutcome;
    } catch (error) {
      const authAvailability = authenticationRequiredAvailability(error);
      if (authAvailability) {
        return { availability: authAvailability };
      }
      if (isCodexRealtimeEnabledAppServerLaunchUnavailableError(error)) {
        return {
          availability: unavailable(
            'feature_unavailable',
            'codex_realtime_launch_enablement_unavailable',
            'The selected Codex runtime could not launch with Codex Realtime Voice enabled.',
          ),
        };
      }
      return {
        availability: unavailable(
          'unsupported_runtime',
          'codex_realtime_runtime_unavailable',
          'The selected Codex app-server runtime is unavailable.',
        ),
      };
    }
    const availability = mapFeatureInspectionToAvailability(await inspectCodexRealtimeFeature({
      client,
      threadId,
      isCurrent: () => params.getThreadId() === threadId,
      isAuthenticationError: (error) => authenticationRequiredDiagnostic(error) !== null,
      ...(options?.signal ? { signal: options.signal } : {}),
    }));
    if (params.isDisposed()) {
      return {
        availability: unavailable(
          'session_unavailable',
          'codex_realtime_session_disposed',
          'The selected Codex Agent session became unavailable during readiness inspection.',
        ),
      };
    }
    if (params.getThreadId() !== threadId) {
      return {
        availability: unavailable(
          'session_unavailable',
          'codex_realtime_thread_changed',
          'The selected Codex Agent session changed during readiness inspection.',
        ),
      };
    }
    if (params.isRuntimeExited?.() === true) {
      return {
        availability: unavailable(
          'session_unavailable',
          'codex_realtime_runtime_restart_required',
          'The Codex app-server runtime exited and must be recovered by the Agent session owner.',
        ),
      };
    }
    return {
      availability,
      ...(availability.status === 'available' ? { client, threadId } : {}),
    };
  };

  const inspect = async (
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentSessionRealtimeAvailability> => {
    return (await resolveAvailability(options)).availability;
  };

  const start = async (
    input: AgentSessionRealtimeStartInput,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AgentSessionRealtimeStartResult> => {
    if (options?.signal?.aborted) return { status: 'aborted' };
    if (
      typeof input.transport.offerSdp !== 'string'
      || input.transport.offerSdp.trim().length === 0
      || !AgentSessionRealtimeStartRequestV1Schema.safeParse({
        v: 1,
        provider: {
          pluginId: 'happier.agent.codex',
          localId: 'realtime-codex',
        },
        applicationAttemptId: 'codex-app-server-validation',
        transport: input.transport,
      }).success
    ) {
      return {
        status: 'failed',
        diagnostic: diagnostic(
          'codex_realtime_offer_invalid',
          'Codex Realtime Voice requires a valid WebRTC offer.',
        ),
      };
    }
    if (preparing) return { status: 'busy' };
    if (attempt) {
      return attempt.phase === 'terminal'
        ? {
          status: 'unavailable',
          diagnostic: diagnostic(
            'codex_realtime_retry_unavailable',
            'Codex Realtime Voice cannot retry on this thread until upstream closure.',
          ),
        }
        : { status: 'busy' };
    }

    preparing = true;
    try {
      const resolved = await resolveAvailability(options);
      if (options?.signal?.aborted) return { status: 'aborted' };
      if (resolved.availability.status === 'unavailable') {
        return {
          status: 'unavailable',
          diagnostic: resolved.availability.diagnostic,
        };
      }
      const threadId = resolved.threadId;
      const client = resolved.client;
      if (!threadId || !client || params.getThreadId() !== threadId) {
        return {
          status: 'unavailable',
          diagnostic: diagnostic(
            'codex_realtime_thread_changed',
            'The selected Codex Agent session changed before Realtime Voice startup.',
          ),
        };
      }
      if (attempt) return { status: 'busy' };

      let settleResult!: (result: AgentSessionRealtimeStartResult) => void;
      const resultPromise = new Promise<AgentSessionRealtimeStartResult>((resolve) => {
        settleResult = resolve;
      });
      const target: Attempt = {
        client,
        threadId,
        phase: 'negotiating' as AttemptPhase,
        requestAccepted: false,
        answerSdp: null,
        stopRequested: false,
        stopIssued: false,
        requestedCloseObserved: false,
        stopPromise: null,
        terminal: null,
        listeners: new Set<LifecycleSubscription>(),
        unregisters: [] as Array<() => void>,
        timer: null,
        settleStart: settleResult,
        startSettled: false,
        handle: null as unknown as AgentSessionRealtimeHandle,
      };

      const handle: AgentSessionRealtimeHandle = {
        async stop(stopOptions): Promise<AgentSessionRealtimeStopResult> {
          if (stopOptions?.signal?.aborted) return { status: 'aborted' };
          if (target.terminal) {
            if (target.stopPromise) {
              const joined = await waitForCodexOperationOrAbort(
                target.stopPromise,
                stopOptions?.signal,
              );
              if (joined === CODEX_OPERATION_ABORTED) return { status: 'aborted' };
              if (joined) return { status: 'unavailable', diagnostic: joined };
            }
            return { status: 'already_stopped' };
          }
          const stopDiagnostic = await waitForCodexOperationOrAbort(
            stopAttempt(target, 'stopped'),
            stopOptions?.signal,
          );
          if (stopDiagnostic === CODEX_OPERATION_ABORTED) return { status: 'aborted' };
          return stopDiagnostic
            ? { status: 'unavailable', diagnostic: stopDiagnostic }
            : { status: 'stopped' };
        },
        watch(listener) {
          if (target.terminal) {
            try {
              listener(target.terminal);
            } catch {
              // Retained replay is isolated just like initial terminal fanout.
            }
            return { dispose() {} };
          }
          const subscription: LifecycleSubscription = { listener };
          target.listeners.add(subscription);
          return {
            dispose() {
              target.listeners.delete(subscription);
            },
          };
        },
        async dispose() {
          if (target.terminal) {
            if (target.stopPromise) await target.stopPromise;
            return;
          }
          await stopAttempt(target, 'aborted');
        },
      };
      target.handle = handle;
      attempt = target;

      const register = (
        method: string,
        listener: (record: Readonly<Record<string, unknown>>) => void,
      ): void => {
        target.unregisters.push(client.registerNotificationHandler(method, (value) => {
          const record = readRecord(value);
          if (!record || record.threadId !== target.threadId) return;
          listener(record);
        }));
      };

      register('thread/realtime/started', (record) => {
        if (target.phase === 'terminal' || target.phase === 'active') return;
        if (!isGeneratedRealtimeStartedNotification(record)) {
          failInvalidNotification(target);
          return;
        }
        if (target.phase !== 'negotiating') {
          failNegotiation(
            target,
            diagnostic(
              'codex_realtime_notification_order',
              'Codex Realtime Voice received an invalid startup sequence.',
            ),
          );
          return;
        }
        if (record.version !== 'v3') {
          failNegotiation(
            target,
            diagnostic(
              'codex_realtime_version_unsupported',
              'The selected Codex runtime started an unsupported realtime protocol.',
            ),
          );
          return;
        }
        target.phase = 'started';
        maybeSettleStarted(target);
      });
      register('thread/realtime/sdp', (record) => {
        if (target.phase === 'terminal' || target.phase === 'active') return;
        if (!isGeneratedRealtimeSdpNotification(record)) {
          failInvalidNotification(target);
          return;
        }
        if (target.phase !== 'started') {
          failNegotiation(
            target,
            diagnostic(
              'codex_realtime_notification_order',
              'Codex Realtime Voice received SDP before its V3 started notification.',
            ),
          );
          return;
        }
        const parsedAnswer = AgentSessionRealtimeStartResultV1Schema.safeParse({
          ok: true,
          status: 'started',
          transport: {
            kind: 'webrtc',
            answerSdp: record.sdp,
          },
        });
        if (
          !parsedAnswer.success
          || parsedAnswer.data.status !== 'started'
          || parsedAnswer.data.transport.answerSdp.trim().length === 0
        ) {
          failNegotiation(
            target,
            diagnostic(
              'codex_realtime_answer_invalid',
              'The selected Codex runtime returned an invalid WebRTC answer.',
            ),
          );
          return;
        }
        target.answerSdp = parsedAnswer.data.transport.answerSdp;
        maybeSettleStarted(target);
      });
      register('thread/realtime/error', (record) => {
        if (target.phase === 'terminal') return;
        if (!isGeneratedRealtimeErrorNotification(record)) {
          failInvalidNotification(target);
          return;
        }
        const eventDiagnostic = authenticationRequiredDiagnostic(record)
          ?? diagnostic(
            'codex_realtime_upstream_error',
            target.phase === 'active'
              ? 'Codex Realtime Voice reported an upstream error.'
              : 'Codex Realtime Voice reported an upstream error during startup.',
        );
        if (target.phase === 'active') {
          target.phase = 'terminal';
          const cleanup = requestStop(target);
          publishTerminal(target, {
            kind: 'terminal',
            reason: 'error',
            diagnostic: eventDiagnostic,
          });
          void cleanup;
          return;
        }
        failNegotiation(target, eventDiagnostic);
      });
      register('thread/realtime/closed', (record) => {
        // Closed notifications have no attempt identity. A locally owned Stop
        // can release this thread fence only while the facade remains bound to
        // that thread, after both its exact response terminalizes this handle
        // and the ordered same-thread requested close arrives. The JSON-RPC
        // callback queue may deliver either fact first. Every other close
        // remains fenced until process exit.
        if (target.stopRequested) {
          if (
            target.stopIssued
            && params.getThreadId() === target.threadId
            && isGeneratedRealtimeClosedNotification(record)
            && record.reason === 'requested'
          ) {
            target.requestedCloseObserved = true;
            maybeReleaseOwnedStop(target);
          }
          return;
        }
        if (target.phase === 'terminal') return;
        if (!isGeneratedRealtimeClosedNotification(record)) {
          failInvalidNotification(target);
          return;
        }
        if (!target.terminal) {
          if (target.phase === 'active') {
            target.phase = 'terminal';
            publishTerminal(target, {
              kind: 'terminal',
              reason: 'upstream_closed',
            });
          } else {
            failNegotiation(
              target,
              diagnostic(
                'codex_realtime_upstream_closed',
                'Codex Realtime Voice closed before startup completed.',
              ),
              { requestUpstreamStop: false },
            );
          }
        }
      });
      target.unregisters.push(client.onExit(() => {
        const exitDiagnostic = diagnostic(
          'codex_realtime_runtime_exited',
          'The Codex app-server exited during Realtime Voice.',
        );
        if (!target.terminal) {
          if (target.phase === 'active') {
            target.phase = 'terminal';
            publishTerminal(target, {
              kind: 'terminal',
              reason: 'error',
              diagnostic: exitDiagnostic,
            });
          } else {
            failNegotiation(target, exitDiagnostic, { requestUpstreamStop: false });
          }
        }
        cleanupAttempt(target);
      }));

      const settlementTimeoutMs = Math.max(
        250,
        Math.trunc(
          params.settlementTimeoutMs ?? readCodexAppServerRealtimeStartTimeoutMs(),
        ),
      );
      target.timer = setTimeout(() => {
        failNegotiation(
          target,
          diagnostic(
            'codex_realtime_start_timeout',
            'Codex Realtime Voice timed out while waiting for V3 negotiation.',
          ),
        );
      }, settlementTimeoutMs);
      const abortListener = () => {
        void stopAttempt(target, 'aborted');
      };
      options?.signal?.addEventListener('abort', abortListener, { once: true });
      target.unregisters.push(() => options?.signal?.removeEventListener('abort', abortListener));

      let startRequest: Promise<unknown>;
      try {
        startRequest = client.request('thread/realtime/start', {
          threadId,
          version: 'v3',
          outputModality: 'audio',
          transport: {
            type: 'webrtc',
            sdp: input.transport.offerSdp,
          },
          includeStartupContext: true,
          clientManagedHandoffs: false,
          flushTranscriptTailOnSessionEnd: false,
          codexResponseHandoffMode: 'thinking',
          codexResponsesAsItems: false,
        }, {
          timeoutMs: null,
          ...(options?.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        startRequest = Promise.reject(error);
      }
      void startRequest.then(
        (response) => {
          if (!isExactEmptyResponse(response)) {
            failNegotiation(
              target,
              diagnostic(
                'codex_realtime_start_response_invalid',
                'Codex Realtime Voice returned an invalid start response after admission became ambiguous.',
              ),
            );
            return;
          }
          target.requestAccepted = true;
          maybeSettleStarted(target);
        },
        (error: unknown) => {
          const authDiagnostic = authenticationRequiredDiagnostic(error);
          if (
            target.phase === 'negotiating'
            && isCodexAppServerApplicationRejectionForMethod(
              error,
              'thread/realtime/start',
            )
          ) {
            const rejectionDiagnostic = authDiagnostic ?? diagnostic(
              'codex_realtime_start_rejected',
              'The selected Codex runtime rejected Realtime Voice before admission.',
            );
            settleStart(target, {
              status: authDiagnostic ? 'unavailable' : 'failed',
              diagnostic: rejectionDiagnostic,
            });
            cleanupAttempt(target);
          } else {
            failNegotiation(
              target,
              authDiagnostic ?? diagnostic(
                'codex_realtime_start_failed',
                'Codex Realtime Voice failed after upstream admission became ambiguous.',
              ),
            );
          }
        },
      );
      return await resultPromise;
    } finally {
      preparing = false;
    }
  };

  return {
    inspect,
    start,
    isActive() {
      return attempt !== null && attempt.phase !== 'terminal';
    },
    hasRetainedAttemptAuthority() {
      return attempt !== null;
    },
    async dispose() {
      const current = attempt;
      if (!current) return;
      if (current.terminal) {
        if (current.stopPromise) await current.stopPromise;
        return;
      }
      await stopAttempt(current, 'agent_session_disposed');
    },
  };
}
