import type {
  VoiceRealtimeCanonicalEvent,
  VoiceRealtimeConnection,
  VoiceOutputFocusApplication,
  VoiceOutputFocusState,
  VoiceRealtimePreparation,
} from '@happier-dev/plugin-sdk/voice/client';
import type {
  VoiceRealtimeJsonValue,
  VoiceRealtimeToolCallV1,
  VoiceTranscriptCanonicalEventV1,
} from '@happier-dev/protocol';
import type {
  VoiceConnectionCloseReason,
  VoiceRealtimeTransportEvent,
} from '@/voice/runtime/connection/VoiceRealtimeConnection';
import type {
  VoicePlaybackInterruptionMode,
  VoicePlaybackInterruptionResolution,
} from '@/voice/runtime/playback/VoicePlaybackController';
import type {
  VoiceRealtimePreparedSession,
  VoiceRealtimeProtocolAdapter,
} from '@/voice/runtime/protocol/VoiceRealtimeProtocolAdapter';
import {
  resolveVoiceTurnControlAction,
  type VoiceTurnControlAction,
} from '@/voice/runtime/protocol/VoiceTurnControlCapabilities';
import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';
import {
  normalizeVoiceRuntimeFailureCode,
  readSafeVoiceRuntimeFailureCode,
  readSafeVoiceRuntimeFailureDiagnosticReason,
  type VoiceRuntimeFailureDiagnosticReason,
} from '@/voice/runtime/voiceRuntimeFailureCode';

const RECOVERABLE_WEBRTC_TRANSPORT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'voice_webrtc_ice_closed',
  'voice_webrtc_ice_failed',
  'voice_webrtc_closed',
  'voice_webrtc_failed',
  'voice_webrtc_data_channel_closed',
  'voice_webrtc_data_channel_error',
]);

function isRecoverableWebRtcTransportFailure(
  connection: VoiceRealtimeConnection,
  code: string,
): boolean {
  return connection.kind === 'webrtc' && RECOVERABLE_WEBRTC_TRANSPORT_FAILURE_CODES.has(code);
}

export type VoiceConversationToolBarrier = Readonly<{
  run(input: Readonly<{
    responseId: string;
    calls: readonly VoiceRealtimeToolCallV1[];
    signal?: AbortSignal | null;
  }>): Promise<Readonly<{ status: 'submitted' | 'cancelled' | 'detached' | 'failed' }>>;
  /** Cancel only the detached provider-delivery leg; preserve attempt execution custody. */
  detach(responseId: string): void;
  /** Terminal response/attempt cancellation. */
  cancel(responseId: string): void;
  dispose(): void;
}>;

export type VoiceConversationControllerStartResult =
  | Readonly<{ status: 'connected' }>
  | Readonly<{ status: 'declined'; code: string }>
  | Readonly<{ status: 'aborted' }>
  | Readonly<{ status: 'failed'; code: string }>;

export type VoiceConversationControllerMachinePort = Readonly<{
  connecting(input: Readonly<{ controlSessionId: string; attemptId: number }>): void;
  reconnecting?(input: Readonly<{
    controlSessionId: string;
    attemptId: number;
    active: boolean;
    /** True only while the next retained reconnect slot is waiting. */
    retryAvailable?: boolean;
  }>): void;
  connected(input: Readonly<{ controlSessionId: string; attemptId: number }>): void;
  ending(input: Readonly<{ controlSessionId: string; attemptId: number }>): void;
  disconnected(input: Readonly<{ controlSessionId: string; attemptId: number; code?: string }>): void;
  failed(input: Readonly<{
    controlSessionId: string;
    attemptId: number;
    code: string;
    diagnosticReason?: VoiceRuntimeFailureDiagnosticReason;
  }>): void;
}>;

export type VoiceConversationControllerDeps = Readonly<{
  adapter: VoiceRealtimeProtocolAdapter;
  machine: VoiceConversationControllerMachinePort;
  createConnection(
    session: VoiceRealtimePreparedSession,
    attemptId: number,
    signal: AbortSignal,
  ): Promise<VoiceRealtimeConnection>;
  isSelectionCurrent(): boolean;
  onCanonicalEvent(event: VoiceRealtimeCanonicalEvent, signal: AbortSignal): Promise<void>;
  projectTranscript?(input: Readonly<{
    controlSessionId: string;
    attemptId: number;
    connectionId: number;
    event: VoiceTranscriptCanonicalEventV1;
  }>): void;
  onTransportEvent?(event: VoiceRealtimeTransportEvent, signal: AbortSignal): Promise<void>;
  onConnectionReady?(input: Readonly<{
    controlSessionId: string;
    attemptId: number;
    reason: 'initial' | 'reconnect' | 'auth_refresh';
    request: VoiceRealtimeJsonValue;
    connection: VoiceRealtimeConnection;
    signal: AbortSignal;
  }>): Promise<void>;
  createToolBarrier?(input: Readonly<{
    controlSessionId: string;
    attemptId: number;
  }>): VoiceConversationToolBarrier;
  resources?: Readonly<{
    preflight?(input: Readonly<{
      controlSessionId: string;
      attemptId: number;
      request: VoiceRealtimeJsonValue;
      signal: AbortSignal;
    }>): Promise<void>;
    prepare(input: Readonly<{
      controlSessionId: string;
      attemptId: number;
      request: VoiceRealtimeJsonValue;
      signal: AbortSignal;
    }>): Promise<void | Readonly<{ kind: 'declined'; code: string }>>;
    release(input: Readonly<{
      controlSessionId: string;
      attemptId: number;
      reason: VoiceConnectionCloseReason;
    }>): Promise<void>;
  }>;
  sessionLifecycle?: Readonly<{
    connected(input: Readonly<{
      controlSessionId: string;
      attemptId: number;
      providerSessionId: string;
    }>): Promise<void>;
    ended(input: Readonly<{
      controlSessionId: string;
      attemptId: number;
      providerSessionId: string;
      reason: VoiceConnectionCloseReason['code'] | 'reconnect';
    }>): Promise<void>;
  }>;
  waitBeforeReconnect?(attempt: number, signal: AbortSignal): Promise<void>;
  maxReconnectAttempts?: number;
  connectionReadyTimeoutMs?: number;
}>;

export type VoiceConversationController = Readonly<{
  start(input: Readonly<{
    controlSessionId: string;
    request?: VoiceRealtimeJsonValue;
  }>): Promise<VoiceConversationControllerStartResult>;
  stop(): Promise<void>;
  fail(code: string): Promise<void>;
  performTurnControl(
    action: VoiceTurnControlAction,
    payload?: VoiceRealtimeJsonValue,
  ): Promise<
    | Readonly<{ status: 'sent' }>
    | Readonly<{
        status: 'unavailable';
        code: 'voice_turn_action_unsupported' | 'voice_connection_not_open';
      }>
  >;
  sendClientControl(event: VoiceRealtimeJsonValue): Promise<
    | Readonly<{ status: 'sent' }>
    | Readonly<{ status: 'unavailable'; code: 'voice_connection_not_open' }>
  >;
  getActiveControlSessionId(): string | null;
  getOwnedControlSessionId(): string | null;
  /** Existing attempt identity for a current owner-scoped side effect. */
  getOwnedAttemptId(): number | null;
  requestReconnect(): Promise<boolean>;
  playbackCursorMs(): number | null;
  beginOutputInterruptionCandidate(): VoicePlaybackInterruptionMode;
  resolveOutputInterruptionCandidate(resolution: VoicePlaybackInterruptionResolution): void;
  /**
   * Retains the native audio-session output policy across connection creation
   * and reconnects for this exact attempt owner.
   */
  setOutputFocusState?(state: VoiceOutputFocusState): VoiceOutputFocusApplication;
}>;

export type CreateVoiceConversationController = (
  input: VoiceConversationControllerDeps,
) => VoiceConversationController;

type Attempt = {
  id: number;
  controlSessionId: string;
  abortController: AbortController;
  connection: VoiceRealtimeConnection | null;
  /**
   * The native audio-session owner projects this exact attempt's desired output
   * state. Retaining it covers a late connection or reconnect without letting
   * a completed attempt govern its successor.
   */
  outputFocusState: VoiceOutputFocusState;
  closePromise: Promise<void> | null;
  terminalSettled: boolean;
  reconnecting: boolean;
  reconnectPromise: Promise<void> | null;
  pendingReconnectBackoffAbortController: AbortController | null;
  toolBarrier: VoiceConversationToolBarrier | null;
  activeToolResponseIds: Set<string>;
  toolTasks: Set<Promise<void>>;
  /** Current prepared carrier's proof that exact tool identities survived. */
  toolResultReplay: 'none' | 'stable_ids';
  request: VoiceRealtimeJsonValue;
  resourcesPrepared: boolean;
  resourceReleasePromise: Promise<void> | null;
  providerSessionId: string | null;
  providerSessionEndPromise: Promise<void> | null;
  providerPreparationReleasePromise: Promise<void> | null;
  authRefreshCount: number;
  connectionSequence: number;
};

class VoiceConnectionReadyTimeoutError extends Error {
  readonly code = 'voice_connection_timeout' as const;

  constructor() {
    super('voice_connection_timeout');
    this.name = 'VoiceConnectionReadyTimeoutError';
  }
}

export function createVoiceConversationController(
  deps: VoiceConversationControllerDeps,
): VoiceConversationController {
  let sequence = 0;
  let current: Attempt | null = null;
  const reconnectDefaults = VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.reconnect;
  const maxReconnectAttempts = Math.max(0, Math.floor(
    deps.maxReconnectAttempts ?? reconnectDefaults.maxRetries,
  ));
  const connectionReadyTimeoutMs = Math.max(1, Math.floor(
    deps.connectionReadyTimeoutMs ?? VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.connectionReadyTimeoutMs,
  ));

  const waitBeforeReconnect = deps.waitBeforeReconnect ?? (async (attempt: number, signal: AbortSignal) => {
    const delayMs = Math.min(
      reconnectDefaults.maxBackoffMs,
      reconnectDefaults.baseBackoffMs
        * reconnectDefaults.backoffFactor ** Math.max(0, attempt - 1),
    );
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, delayMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  });

  const owns = (attempt: Attempt): boolean => current === attempt && !attempt.abortController.signal.aborted;

  const applyOutputFocusState = (
    attempt: Attempt,
    connection: VoiceRealtimeConnection,
  ): VoiceOutputFocusApplication => (
    connection.setOutputFocusState?.(attempt.outputFocusState)
      ?? (attempt.outputFocusState === 'active' ? 'applied' : 'unsupported')
  );

  const awaitConnectionReady = async (operation: Promise<void>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new VoiceConnectionReadyTimeoutError());
      }, connectionReadyTimeoutMs);
    });
    try {
      await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const disposeToolBarrier = (attempt: Attempt): void => {
    const barrier = attempt.toolBarrier;
    if (!barrier) return;
    for (const responseId of attempt.activeToolResponseIds) barrier.cancel(responseId);
    barrier.dispose();
    attempt.toolBarrier = null;
    attempt.activeToolResponseIds.clear();
  };

  const detachActiveToolResponses = (attempt: Attempt): void => {
    const barrier = attempt.toolBarrier;
    if (!barrier) return;
    for (const responseId of attempt.activeToolResponseIds) barrier.detach(responseId);
    attempt.activeToolResponseIds.clear();
  };

  const recordPreparedToolResultReplay = (
    attempt: Attempt,
    preparation: Extract<VoiceRealtimePreparation, Readonly<{ kind: 'prepared' }>>,
  ): void => {
    // A provider declaration says what its implementation can support in
    // principle. Only this concrete prepared carrier can establish that the
    // original response/call identities survived this reconnect.
    attempt.toolResultReplay = (
      deps.adapter.turnControls.resumption === 'resume'
      && deps.adapter.turnControls.replay === 'stable_ids'
      && preparation.session.toolResultReplay === 'stable_ids'
    ) ? 'stable_ids' : 'none';
  };

  const canRedeliverRetainedToolResult = (attempt: Attempt): boolean => (
    deps.adapter.turnControls.resumption === 'resume'
    && deps.adapter.turnControls.replay === 'stable_ids'
    && attempt.toolResultReplay === 'stable_ids'
  );

  const createToolBarrier = (attempt: Attempt): void => {
    attempt.toolBarrier = deps.createToolBarrier?.({
      controlSessionId: attempt.controlSessionId,
      attemptId: attempt.id,
    }) ?? null;
  };

  const releaseTerminalOwnership = (attempt: Attempt): void => {
    attempt.abortController.abort();
    if (current === attempt) current = null;
  };

  const endProviderSession = async (
    attempt: Attempt,
    reason: VoiceConnectionCloseReason['code'] | 'reconnect',
  ): Promise<void> => {
    const providerSessionId = attempt.providerSessionId;
    if (!providerSessionId) return;
    attempt.providerSessionEndPromise ??= deps.sessionLifecycle?.ended({
      controlSessionId: attempt.controlSessionId,
      attemptId: attempt.id,
      providerSessionId,
      reason,
    }) ?? Promise.resolve();
    await attempt.providerSessionEndPromise.catch(() => {});
    if (attempt.providerSessionId === providerSessionId) attempt.providerSessionId = null;
  };

  const bindProviderSessionIdentity = async (
    attempt: Attempt,
    connection: VoiceRealtimeConnection,
    providerSessionId: string,
  ): Promise<void> => {
    if (!owns(attempt) || attempt.connection !== connection) return;
    if (attempt.providerSessionId === providerSessionId) return;
    if (attempt.providerSessionId) await endProviderSession(attempt, 'reconnect');
    if (!owns(attempt) || attempt.connection !== connection) return;
    attempt.providerSessionId = providerSessionId;
    attempt.providerSessionEndPromise = null;
    await deps.sessionLifecycle?.connected({
      controlSessionId: attempt.controlSessionId,
      attemptId: attempt.id,
      providerSessionId,
    });
  };

  const closeAttempt = async (
    attempt: Attempt,
    reason: VoiceConnectionCloseReason,
  ): Promise<void> => {
    disposeToolBarrier(attempt);
    if (attempt.connection) {
      attempt.closePromise ??= attempt.connection.close(reason);
      await attempt.closePromise.catch(() => {});
    }
    await endProviderSession(attempt, reason.code);
    attempt.providerPreparationReleasePromise ??= (async () => {
      await deps.adapter.releasePrepared?.({
        controlSessionId: attempt.controlSessionId,
        attemptId: attempt.id,
        reason,
      });
    })();
    await attempt.providerPreparationReleasePromise.catch(() => {});
    if (attempt.resourcesPrepared) {
      attempt.resourceReleasePromise ??= deps.resources?.release({
        controlSessionId: attempt.controlSessionId,
        attemptId: attempt.id,
        reason,
      }) ?? Promise.resolve();
      await attempt.resourceReleasePromise.catch(() => {});
    }
  };

  const settleDisconnected = (attempt: Attempt, code?: string): void => {
    if (attempt.terminalSettled || current !== attempt) return;
    attempt.terminalSettled = true;
    releaseTerminalOwnership(attempt);
    deps.machine.disconnected({
      controlSessionId: attempt.controlSessionId,
      attemptId: attempt.id,
      ...(code ? { code } : {}),
    });
  };

  const claimAttemptOwnership = (attempt: Attempt): Promise<void> => {
    const previous = current;
    current = attempt;
    if (!previous) return Promise.resolve();
    previous.abortController.abort();
    return closeAttempt(previous, { code: 'replaced' });
  };

  const settleReconnectFailure = async (attempt: Attempt, code: string): Promise<void> => {
    if (!owns(attempt) || attempt.terminalSettled) return;
    await closeAttempt(attempt, { code: 'error', detail: code });
    if (!owns(attempt) || attempt.terminalSettled) return;
    attempt.terminalSettled = true;
    releaseTerminalOwnership(attempt);
    deps.machine.failed({
      controlSessionId: attempt.controlSessionId,
      attemptId: attempt.id,
      code,
    });
  };

  const settleSelectionInvalidated = async (attempt: Attempt): Promise<void> => {
    if (!owns(attempt) || deps.isSelectionCurrent()) return;
    attempt.abortController.abort();
    await closeAttempt(attempt, { code: 'replaced', detail: 'voice_provider_not_selected' });
    if (current !== attempt || attempt.terminalSettled) return;
    if (attempt.reconnecting) {
      attempt.reconnecting = false;
      deps.machine.reconnecting?.({
        controlSessionId: attempt.controlSessionId,
        attemptId: attempt.id,
        active: false,
        retryAvailable: false,
      });
    }
    settleDisconnected(attempt, 'voice_provider_not_selected');
  };

  const reconnect = (
    attempt: Attempt,
    reason: 'reconnect' | 'auth_refresh',
  ): Promise<void> => {
    if (!owns(attempt) || attempt.terminalSettled) return Promise.resolve();
    if (attempt.reconnectPromise) return attempt.reconnectPromise;

    const reconnectPromise = (async () => {
    attempt.reconnecting = true;
    deps.machine.reconnecting?.({
      controlSessionId: attempt.controlSessionId,
      attemptId: attempt.id,
      active: true,
      retryAvailable: false,
    });
    const previousConnection = attempt.connection;
    try {
      if (reason === 'auth_refresh') {
        if (attempt.authRefreshCount >= 1) {
          await settleReconnectFailure(attempt, 'voice_auth_refresh_exhausted');
          return;
        }
        attempt.authRefreshCount += 1;
        let refreshed = false;
        try {
          refreshed = await deps.adapter.refreshAuth?.(attempt.abortController.signal) ?? false;
        } catch {
          refreshed = false;
        }
        if (!owns(attempt)) return;
        if (!refreshed) {
          await settleReconnectFailure(attempt, 'voice_auth_refresh_failed');
          return;
        }
      }

      if (previousConnection) {
        // A lost carrier interrupts only provider delivery. The barrier keeps
        // execution and its redacted settlement attempt-owned so a resumed
        // provider response can receive it without replaying the tool.
        detachActiveToolResponses(attempt);
        if (attempt.connection === previousConnection) attempt.connection = null;
        await previousConnection.close({ code: 'remote_close' }).catch(() => {});
        await endProviderSession(attempt, 'reconnect');
      }

      for (let reconnectAttempt = 1; reconnectAttempt <= maxReconnectAttempts; reconnectAttempt += 1) {
        const backoffAbortController = new AbortController();
        const abortBackoff = () => backoffAbortController.abort();
        if (attempt.abortController.signal.aborted) {
          abortBackoff();
        } else {
          attempt.abortController.signal.addEventListener('abort', abortBackoff, { once: true });
        }
        attempt.pendingReconnectBackoffAbortController = backoffAbortController;
        deps.machine.reconnecting?.({
          controlSessionId: attempt.controlSessionId,
          attemptId: attempt.id,
          active: true,
          retryAvailable: true,
        });
        try {
          await waitBeforeReconnect(reconnectAttempt, backoffAbortController.signal);
        } finally {
          attempt.abortController.signal.removeEventListener('abort', abortBackoff);
          if (attempt.pendingReconnectBackoffAbortController === backoffAbortController) {
            attempt.pendingReconnectBackoffAbortController = null;
          }
          if (owns(attempt) && attempt.reconnecting) {
            deps.machine.reconnecting?.({
              controlSessionId: attempt.controlSessionId,
              attemptId: attempt.id,
              active: true,
              retryAvailable: false,
            });
          }
        }
        if (!owns(attempt)) return;
        if (!deps.isSelectionCurrent()) {
          await settleSelectionInvalidated(attempt);
          return;
        }
        deps.machine.connecting({ controlSessionId: attempt.controlSessionId, attemptId: attempt.id });
        let preparation: VoiceRealtimePreparation;
        try {
          // Never carry a previous provider carrier's proof into a new
          // preparation. Omission remains an explicit fail-closed result.
          attempt.toolResultReplay = 'none';
          preparation = await deps.adapter.prepare({
            controlSessionId: attempt.controlSessionId,
            attemptId: attempt.id,
            reason,
            request: attempt.request,
            signal: attempt.abortController.signal,
          });
        } catch {
          if (!owns(attempt)) return;
          continue;
        }
        if (!owns(attempt)) return;
        if (!deps.isSelectionCurrent()) {
          await settleSelectionInvalidated(attempt);
          return;
        }
        if (preparation.kind === 'declined') {
          await settleReconnectFailure(
            attempt,
            normalizeVoiceRuntimeFailureCode(preparation.code),
          );
          return;
        }
        if (preparation.kind === 'aborted') {
          return;
        }
        recordPreparedToolResultReplay(attempt, preparation);

        let nextConnection: VoiceRealtimeConnection;
        try {
          nextConnection = await deps.createConnection(
            preparation.session,
            attempt.id,
            attempt.abortController.signal,
          );
        } catch {
          if (!owns(attempt)) return;
          continue;
        }
        if (!owns(attempt)) {
          await nextConnection.close({ code: 'aborted' }).catch(() => {});
          return;
        }
        if (!deps.isSelectionCurrent()) {
          await nextConnection.close({ code: 'aborted' }).catch(() => {});
          await settleSelectionInvalidated(attempt);
          return;
        }
        attempt.connection = nextConnection;
        attempt.closePromise = null;
        if (
          attempt.outputFocusState !== 'active'
          && applyOutputFocusState(attempt, nextConnection) === 'unsupported'
        ) {
          await settleReconnectFailure(attempt, 'voice_output_focus_unsupported');
          return;
        }
        try {
          await awaitConnectionReady(nextConnection.connect(attempt.abortController.signal));
          if (!owns(attempt) || attempt.connection !== nextConnection) {
            await nextConnection.close({ code: 'aborted' }).catch(() => {});
            return;
          }
          await awaitConnectionReady(Promise.resolve(deps.onConnectionReady?.({
            controlSessionId: attempt.controlSessionId,
            attemptId: attempt.id,
            reason,
            request: attempt.request,
            connection: nextConnection,
            signal: attempt.abortController.signal,
          })));
        } catch {
          await nextConnection.close({ code: 'error' }).catch(() => {});
          if (!owns(attempt)) return;
          continue;
        }
        if (!owns(attempt)) {
          await nextConnection.close({ code: 'aborted' }).catch(() => {});
          return;
        }
        if (!deps.isSelectionCurrent()) {
          await settleSelectionInvalidated(attempt);
          return;
        }
        const providerSessionId = nextConnection.currentProviderSessionId();
        if (providerSessionId) {
          await bindProviderSessionIdentity(attempt, nextConnection, providerSessionId);
          if (!owns(attempt) || attempt.connection !== nextConnection) return;
          if (!deps.isSelectionCurrent()) {
            await settleSelectionInvalidated(attempt);
            return;
          }
        }
        deps.machine.connected({ controlSessionId: attempt.controlSessionId, attemptId: attempt.id });
        if (!owns(attempt) || attempt.connection !== nextConnection) return;
        if (!deps.isSelectionCurrent()) {
          await settleSelectionInvalidated(attempt);
          return;
        }
        if (!attempt.toolBarrier) createToolBarrier(attempt);
        attempt.reconnecting = false;
        const connectionId = ++attempt.connectionSequence;
        void pumpControlEvents(attempt, nextConnection, connectionId);
        void pumpTransportEvents(attempt, nextConnection);
        return;
      }
      await settleReconnectFailure(attempt, 'reconnect_exhausted');
    } finally {
      if (current === attempt) {
        attempt.reconnecting = false;
        deps.machine.reconnecting?.({
          controlSessionId: attempt.controlSessionId,
          attemptId: attempt.id,
          active: false,
          retryAvailable: false,
        });
      }
    }
    })();
    attempt.reconnectPromise = reconnectPromise;
    const clearReconnectPromise = (): void => {
      if (attempt.reconnectPromise === reconnectPromise) {
        attempt.reconnectPromise = null;
      }
    };
    void reconnectPromise.then(clearReconnectPromise, clearReconnectPromise);
    return reconnectPromise;
  };

  const pumpControlEvents = async (
    attempt: Attempt,
    connection: VoiceRealtimeConnection = attempt.connection!,
    connectionId = attempt.connectionSequence,
  ): Promise<void> => {
    if (!connection) return;
    try {
      for await (const control of connection.controlEvents(attempt.abortController.signal)) {
        if (!owns(attempt) || attempt.connection !== connection) return;
        // A still-owned attempt whose selection went stale must end, not be
        // abandoned. Returning here used to leave a WebRTC conversation alive on
        // its media tracks — still heard, still hearing — while transcripts,
        // tool calls, and turn edges stopped forever with nothing recorded.
        if (!deps.isSelectionCurrent()) {
          await settleSelectionInvalidated(attempt);
          return;
        }
        const events = deps.adapter.decodeControl(control);
        for (const event of events) {
          if (!owns(attempt) || attempt.connection !== connection) return;
          if (!deps.isSelectionCurrent()) {
            await settleSelectionInvalidated(attempt);
            return;
          }
          if (event.type === 'auth_expired') {
            await reconnect(attempt, 'auth_refresh');
            return;
          }
          if (event.type === 'transcript') {
            if (deps.projectTranscript) {
              deps.projectTranscript({
                controlSessionId: attempt.controlSessionId,
                attemptId: attempt.id,
                connectionId,
                event: event.event,
              });
            }
            continue;
          }
          if (event.type === 'tool_calls') {
            const barrier = attempt.toolBarrier;
            if (!barrier) throw new Error('voice_tool_barrier_unavailable');
            attempt.activeToolResponseIds.add(event.responseId);
            const runBarrier = async () => await barrier.run({
              responseId: event.responseId,
              calls: event.calls,
              signal: attempt.abortController.signal,
            });
            const task = runBarrier().then(async (result) => {
              if (!owns(attempt) || result.status === 'cancelled' || result.status === 'submitted') return;

              // Same-call transport custody retains the completed redacted
              // result after delivery failure. Reconnect, then redeliver that
              // exact call/result identity; no semantic effect is re-executed.
              await reconnect(attempt, 'reconnect');
              if (
                !owns(attempt)
                || attempt.toolBarrier !== barrier
                || attempt.connection?.state() !== 'open'
              ) return;

              // A fresh provider response cannot safely receive a retained
              // result. The reconnect preparation, not the static declaration,
              // must prove that this concrete carrier retained response/call
              // identity. Never discard the settlement or rerun its effect/read.
              if (!canRedeliverRetainedToolResult(attempt)) {
                await settleReconnectFailure(attempt, 'voice_tool_result_delivery_unrecoverable');
                return;
              }

              attempt.activeToolResponseIds.add(event.responseId);
              const redelivered = await runBarrier();
              if (!owns(attempt) || redelivered.status === 'cancelled' || redelivered.status === 'submitted') return;
              await settleReconnectFailure(attempt, 'voice_tool_submission_failed');
            }).catch(async () => {
              if (owns(attempt)) await settleReconnectFailure(attempt, 'voice_tool_barrier_failed');
            }).finally(() => {
              attempt.activeToolResponseIds.delete(event.responseId);
              attempt.toolTasks.delete(task);
            });
            attempt.toolTasks.add(task);
            continue;
          }
          await deps.onCanonicalEvent(event, attempt.abortController.signal);
        }
      }
      if (owns(attempt) && attempt.connection === connection && connection.state() === 'closed') {
        await reconnect(attempt, 'reconnect');
      }
    } catch (error) {
      if (!owns(attempt) || attempt.connection !== connection) return;
      const failureCode = readSafeVoiceRuntimeFailureCode(error)
        ?? 'voice_control_event_failure';
      if (isRecoverableWebRtcTransportFailure(connection, failureCode)) {
        await reconnect(attempt, 'reconnect');
        return;
      }
      await closeAttempt(attempt, { code: 'error', detail: failureCode });
      if (!owns(attempt)) return;
      attempt.terminalSettled = true;
      releaseTerminalOwnership(attempt);
      deps.machine.failed({
        controlSessionId: attempt.controlSessionId,
        attemptId: attempt.id,
        code: failureCode,
      });
    }
  };

  const pumpTransportEvents = async (
    attempt: Attempt,
    connection: VoiceRealtimeConnection = attempt.connection!,
  ): Promise<void> => {
    if (!connection) return;
    try {
      for await (const event of connection.transportEvents(attempt.abortController.signal)) {
        if (!owns(attempt) || attempt.connection !== connection) return;
        if (!deps.isSelectionCurrent()) {
          await settleSelectionInvalidated(attempt);
          return;
        }
        await deps.onTransportEvent?.(event, attempt.abortController.signal);
        if (!owns(attempt) || attempt.connection !== connection) return;
        if (!deps.isSelectionCurrent()) {
          await settleSelectionInvalidated(attempt);
          return;
        }
        if (event.type === 'session_identity') {
          await bindProviderSessionIdentity(attempt, connection, event.sessionId);
          if (!owns(attempt) || attempt.connection !== connection) return;
          if (!deps.isSelectionCurrent()) {
            await settleSelectionInvalidated(attempt);
            return;
          }
        }
        if (event.type === 'webrtc_ice_state' && event.state === 'failed') {
          if (connection.state() === 'closed') continue;
          await reconnect(attempt, 'reconnect');
          return;
        }
      }
    } catch (error) {
      if (!owns(attempt) || attempt.connection !== connection) return;
      const failureCode = readSafeVoiceRuntimeFailureCode(error)
        ?? 'voice_transport_event_failure';
      if (isRecoverableWebRtcTransportFailure(connection, failureCode)) {
        await reconnect(attempt, 'reconnect');
        return;
      }
      await closeAttempt(attempt, { code: 'error', detail: failureCode });
      if (!owns(attempt)) return;
      attempt.terminalSettled = true;
      releaseTerminalOwnership(attempt);
      deps.machine.failed({
        controlSessionId: attempt.controlSessionId,
        attemptId: attempt.id,
        code: failureCode,
      });
    }
  };

  const start = async (input: Readonly<{
    controlSessionId: string;
    request?: VoiceRealtimeJsonValue;
  }>): Promise<VoiceConversationControllerStartResult> => {
    // A stale registry selection must not acquire microphone/audio resources or
    // supersede the currently owned conversation. Selection is checked again
    // after every asynchronous boundary below because it can change in flight.
    if (!deps.isSelectionCurrent()) {
      return { status: 'declined', code: 'voice_provider_not_selected' };
    }
    const attempt: Attempt = {
      id: ++sequence,
      controlSessionId: input.controlSessionId,
      abortController: new AbortController(),
      connection: null,
      outputFocusState: 'active',
      closePromise: null,
      terminalSettled: false,
      reconnecting: false,
      reconnectPromise: null,
      pendingReconnectBackoffAbortController: null,
      toolBarrier: null,
      activeToolResponseIds: new Set(),
      toolTasks: new Set(),
      toolResultReplay: 'none',
      request: input.request ?? null,
      resourcesPrepared: false,
      resourceReleasePromise: null,
      providerSessionId: null,
      providerSessionEndPromise: null,
      providerPreparationReleasePromise: null,
      authRefreshCount: 0,
      connectionSequence: 0,
    };
    const previousAttemptCleanup = claimAttemptOwnership(attempt);

    try {
      await previousAttemptCleanup;
      if (!owns(attempt)) {
        await closeAttempt(attempt, { code: 'aborted' });
        settleDisconnected(attempt);
        return { status: 'aborted' };
      }
      deps.machine.connecting({ controlSessionId: attempt.controlSessionId, attemptId: attempt.id });
      const providerPreflight = await deps.adapter.preflight?.({
        controlSessionId: attempt.controlSessionId,
        attemptId: attempt.id,
        request: attempt.request,
        signal: attempt.abortController.signal,
      });
      if (!owns(attempt) || !deps.isSelectionCurrent()) {
        await closeAttempt(attempt, { code: 'aborted' });
        settleDisconnected(attempt);
        return { status: 'aborted' };
      }
      if (providerPreflight?.kind === 'aborted') {
        await closeAttempt(attempt, { code: 'aborted' });
        settleDisconnected(attempt);
        return { status: 'aborted' };
      }
      if (providerPreflight?.kind === 'declined') {
        const failureCode = normalizeVoiceRuntimeFailureCode(providerPreflight.code);
        await closeAttempt(attempt, { code: 'error', detail: failureCode });
        settleDisconnected(attempt, failureCode);
        return { status: 'declined', code: failureCode };
      }
      await deps.resources?.preflight?.({
        controlSessionId: attempt.controlSessionId,
        attemptId: attempt.id,
        request: attempt.request,
        signal: attempt.abortController.signal,
      });
      if (!owns(attempt) || !deps.isSelectionCurrent()) {
        await closeAttempt(attempt, { code: 'aborted' });
        settleDisconnected(attempt);
        return { status: 'aborted' };
      }

      // Provider preparation is deliberately pre-media. A selected-source
      // switch, deletion, or revocation before short-lived auth issuance fails
      // here without acquiring the microphone. Successful issuance admits that
      // exact attempt; later source changes apply to the next attempt. Public
      // provider preparation has no media capability; the host supplies
      // microphone/media only to createConnection.
      const preparation = await deps.adapter.prepare({
        controlSessionId: attempt.controlSessionId,
        attemptId: attempt.id,
        reason: 'initial',
        request: attempt.request,
        signal: attempt.abortController.signal,
      });
      if (!owns(attempt) || !deps.isSelectionCurrent()) {
        await closeAttempt(attempt, { code: 'aborted' });
        settleDisconnected(attempt);
        return { status: 'aborted' };
      }
      if (preparation.kind === 'aborted') {
        await closeAttempt(attempt, { code: 'aborted' });
        settleDisconnected(attempt);
        return { status: 'aborted' };
      }
      if (preparation.kind === 'declined') {
        const failureCode = normalizeVoiceRuntimeFailureCode(preparation.code);
        await closeAttempt(attempt, { code: 'error', detail: failureCode });
        settleDisconnected(attempt, failureCode);
        return { status: 'declined', code: failureCode };
      }
      recordPreparedToolResultReplay(attempt, preparation);

      if (deps.resources) {
        attempt.resourcesPrepared = true;
        const resourcePreparation = await deps.resources.prepare({
          controlSessionId: attempt.controlSessionId,
          attemptId: attempt.id,
          request: attempt.request,
          signal: attempt.abortController.signal,
        });
        if (!owns(attempt) || !deps.isSelectionCurrent()) {
          await closeAttempt(attempt, { code: 'aborted' });
          settleDisconnected(attempt);
          return { status: 'aborted' };
        }
        if (resourcePreparation?.kind === 'declined') {
          const failureCode = normalizeVoiceRuntimeFailureCode(resourcePreparation.code);
          await closeAttempt(attempt, { code: 'error', detail: failureCode });
          settleDisconnected(attempt, failureCode);
          return { status: 'declined', code: failureCode };
        }
        // Resource owners may project an acquiring-mic state while preparing;
        // restore connecting before opening the provider transport.
        deps.machine.connecting({ controlSessionId: attempt.controlSessionId, attemptId: attempt.id });
      }

      const connection = await deps.createConnection(
        preparation.session,
        attempt.id,
        attempt.abortController.signal,
      );
      attempt.connection = connection;
      if (!owns(attempt) || !deps.isSelectionCurrent()) {
        await closeAttempt(attempt, { code: 'aborted' });
        settleDisconnected(attempt);
        return { status: 'aborted' };
      }

      if (
        attempt.outputFocusState !== 'active'
        && applyOutputFocusState(attempt, connection) === 'unsupported'
      ) {
        throw Object.assign(new Error('voice_output_focus_unsupported'), {
          code: 'voice_output_focus_unsupported',
        });
      }

      await awaitConnectionReady(connection.connect(attempt.abortController.signal));
      if (!owns(attempt) || !deps.isSelectionCurrent()) {
        await closeAttempt(attempt, { code: 'aborted' });
        settleDisconnected(attempt);
        return { status: 'aborted' };
      }
      await awaitConnectionReady(Promise.resolve(deps.onConnectionReady?.({
        controlSessionId: attempt.controlSessionId,
        attemptId: attempt.id,
        reason: 'initial',
        request: attempt.request,
        connection,
        signal: attempt.abortController.signal,
      })));
      if (!owns(attempt) || !deps.isSelectionCurrent()) {
        await closeAttempt(attempt, { code: 'aborted' });
        settleDisconnected(attempt);
        return { status: 'aborted' };
      }
      const providerSessionId = connection.currentProviderSessionId();
      if (providerSessionId) {
        await bindProviderSessionIdentity(attempt, connection, providerSessionId);
        if (!owns(attempt) || attempt.connection !== connection) {
          return { status: 'aborted' };
        }
        if (!deps.isSelectionCurrent()) {
          await settleSelectionInvalidated(attempt);
          return { status: 'aborted' };
        }
      }
      deps.machine.connected({ controlSessionId: attempt.controlSessionId, attemptId: attempt.id });
      if (!owns(attempt) || attempt.connection !== connection) {
        return { status: 'aborted' };
      }
      if (!deps.isSelectionCurrent()) {
        await settleSelectionInvalidated(attempt);
        return { status: 'aborted' };
      }
      createToolBarrier(attempt);
      const connectionId = ++attempt.connectionSequence;
      void pumpControlEvents(attempt, connection, connectionId);
      void pumpTransportEvents(attempt, connection);
      return { status: 'connected' };
    } catch (error) {
      const aborted = attempt.abortController.signal.aborted || current !== attempt;
      const timedOut = !aborted && error instanceof VoiceConnectionReadyTimeoutError;
      const failureCode = timedOut
        ? error.code
        : readSafeVoiceRuntimeFailureCode(error) ?? 'voice_connection_failed';
      await closeAttempt(attempt, {
        code: aborted ? 'aborted' : 'error',
        ...(!aborted && failureCode !== 'voice_connection_failed' ? { detail: failureCode } : {}),
      });
      if (aborted) {
        settleDisconnected(attempt);
        return { status: 'aborted' };
      }
      if (current === attempt && !attempt.terminalSettled) {
        attempt.terminalSettled = true;
        releaseTerminalOwnership(attempt);
        deps.machine.failed({
          controlSessionId: attempt.controlSessionId,
          attemptId: attempt.id,
          code: failureCode,
          diagnosticReason: readSafeVoiceRuntimeFailureDiagnosticReason(error),
        });
      }
      return { status: 'failed', code: failureCode };
    }
  };

  const stop = async (): Promise<void> => {
    const attempt = current;
    if (!attempt) return;
    current = null;
    attempt.abortController.abort();
    if (!attempt.terminalSettled) {
      deps.machine.ending({ controlSessionId: attempt.controlSessionId, attemptId: attempt.id });
    }
    await closeAttempt(attempt, { code: 'user_stop' });
    if (!attempt.terminalSettled && sequence === attempt.id) {
      attempt.terminalSettled = true;
      deps.machine.disconnected({ controlSessionId: attempt.controlSessionId, attemptId: attempt.id });
    }
  };

  const fail = async (code: string): Promise<void> => {
    const attempt = current;
    if (!attempt) return;
    current = null;
    attempt.abortController.abort();
    await closeAttempt(attempt, { code: 'error', detail: code });
    if (attempt.terminalSettled || sequence !== attempt.id) return;
    attempt.terminalSettled = true;
    deps.machine.failed({
      controlSessionId: attempt.controlSessionId,
      attemptId: attempt.id,
      code,
    });
  };

  const performTurnControl = async (
    action: VoiceTurnControlAction,
    payload?: VoiceRealtimeJsonValue,
  ): Promise<Readonly<{ status: 'sent' }> | Readonly<{
    status: 'unavailable';
    code: 'voice_turn_action_unsupported' | 'voice_connection_not_open';
  }>> => {
    const availability = resolveVoiceTurnControlAction(deps.adapter.turnControls, action);
    if (availability.status === 'unavailable') return availability;
    const attempt = current;
    if (!attempt?.connection || !owns(attempt) || attempt.connection.state() !== 'open') {
      return { status: 'unavailable', code: 'voice_connection_not_open' };
    }
    const encoded = deps.adapter.encodeTurnControl(action, payload);
    if (encoded === null) return { status: 'unavailable', code: 'voice_turn_action_unsupported' };
    await attempt.connection.sendControl(encoded);
    return { status: 'sent' };
  };

  const sendClientControl = async (
    event: VoiceRealtimeJsonValue,
  ): Promise<Readonly<{ status: 'sent' }> | Readonly<{
    status: 'unavailable';
    code: 'voice_connection_not_open';
  }>> => {
    const attempt = current;
    if (!attempt?.connection || !owns(attempt) || attempt.connection.state() !== 'open') {
      return { status: 'unavailable', code: 'voice_connection_not_open' };
    }
    await attempt.connection.sendControl(event);
    return { status: 'sent' };
  };

  const getActiveControlSessionId = (): string | null => {
    const attempt = current;
    return attempt && owns(attempt) && attempt.connection?.state() === 'open'
      ? attempt.controlSessionId
      : null;
  };

  const getOwnedControlSessionId = (): string | null => {
    const attempt = current;
    return attempt && owns(attempt) ? attempt.controlSessionId : null;
  };

  const getOwnedAttemptId = (): number | null => {
    const attempt = current;
    return attempt && owns(attempt) ? attempt.id : null;
  };

  const requestReconnect = async (): Promise<boolean> => {
    const attempt = current;
    if (!attempt || !owns(attempt) || attempt.terminalSettled) return false;
    if (attempt.reconnecting) {
      attempt.pendingReconnectBackoffAbortController?.abort();
      await attempt.reconnectPromise;
      return owns(attempt) && attempt.connection?.state() === 'open';
    }
    await reconnect(attempt, 'reconnect');
    return owns(attempt) && attempt.connection?.state() === 'open';
  };

  const beginOutputInterruptionCandidate = (): VoicePlaybackInterruptionMode => {
    const attempt = current;
    if (!attempt?.connection || !owns(attempt) || attempt.connection.state() !== 'open') {
      return 'unsupported';
    }
    return attempt.connection.beginOutputInterruptionCandidate();
  };

  const playbackCursorMs = (): number | null => {
    const attempt = current;
    if (!attempt?.connection || !owns(attempt) || attempt.connection.state() !== 'open') return null;
    return attempt.connection.playbackCursorMs();
  };

  const resolveOutputInterruptionCandidate = (
    resolution: VoicePlaybackInterruptionResolution,
  ): void => {
    const attempt = current;
    if (!attempt?.connection || !owns(attempt) || attempt.connection.state() !== 'open') return;
    attempt.connection.resolveOutputInterruptionCandidate(resolution);
  };

  const setOutputFocusState = (
    state: VoiceOutputFocusState,
  ): VoiceOutputFocusApplication => {
    const attempt = current;
    if (!attempt || !owns(attempt)) return 'unsupported';
    attempt.outputFocusState = state;
    if (!attempt.connection) return 'applied';
    return attempt.connection.setOutputFocusState?.(state)
      ?? (state === 'active' ? 'applied' : 'unsupported');
  };

  return Object.freeze({
    start,
    stop,
    fail,
    performTurnControl,
    sendClientControl,
    getActiveControlSessionId,
    getOwnedControlSessionId,
    getOwnedAttemptId,
    requestReconnect,
    playbackCursorMs,
    beginOutputInterruptionCandidate,
    resolveOutputInterruptionCandidate,
    setOutputFocusState,
  });
}
