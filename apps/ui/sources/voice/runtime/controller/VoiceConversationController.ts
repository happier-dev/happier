import type {
  VoiceConversationController,
  VoiceConversationControllerDeps,
  VoiceConversationControllerMachinePort,
  VoiceConversationControllerStartResult,
  VoiceConversationToolBarrier,
  VoicePlaybackInterruptionMode,
  VoicePlaybackInterruptionResolution,
  VoiceConnectionCloseReason,
  VoiceRealtimeConnection,
  VoiceRealtimeTransportEvent,
  VoiceRealtimeCanonicalEvent,
  VoiceRealtimePreparation,
} from '@happier-dev/bundled-voice-runtime-contract';
import type { VoiceRealtimeJsonValue } from '@happier-dev/protocol';
import {
  resolveVoiceTurnControlAction,
  type VoiceTurnControlAction,
} from '@/voice/runtime/protocol/VoiceTurnControlCapabilities';
import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';
import {
  normalizeVoiceRuntimeFailureCode,
  readSafeVoiceRuntimeFailureCode,
} from '@/voice/runtime/voiceRuntimeFailureCode';

export type {
  VoiceConversationController,
  VoiceConversationControllerDeps,
  VoiceConversationControllerMachinePort,
  VoiceConversationControllerStartResult,
  VoiceConversationToolBarrier,
} from '@happier-dev/bundled-voice-runtime-contract';

type Attempt = {
  id: number;
  controlSessionId: string;
  abortController: AbortController;
  connection: VoiceRealtimeConnection | null;
  closePromise: Promise<void> | null;
  terminalSettled: boolean;
  reconnecting: boolean;
  toolBarrier: VoiceConversationToolBarrier | null;
  activeToolResponseIds: Set<string>;
  toolTasks: Set<Promise<void>>;
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

  const cancelActiveToolResponses = (attempt: Attempt): void => {
    const barrier = attempt.toolBarrier;
    if (!barrier) return;
    for (const responseId of attempt.activeToolResponseIds) barrier.cancel(responseId);
    attempt.activeToolResponseIds.clear();
  };

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
      });
    }
    settleDisconnected(attempt, 'voice_provider_not_selected');
  };

  const reconnect = async (
    attempt: Attempt,
    reason: 'reconnect' | 'auth_refresh',
  ): Promise<void> => {
    if (!owns(attempt) || attempt.reconnecting || attempt.terminalSettled) return;
    attempt.reconnecting = true;
    deps.machine.reconnecting?.({
      controlSessionId: attempt.controlSessionId,
      attemptId: attempt.id,
      active: true,
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
        // Tool calls are scoped to the provider response on the detached
        // connection. Cancel provider delivery, but retain the attempt-scoped
        // barrier so a completed mutation can be resubmitted without rerunning.
        cancelActiveToolResponses(attempt);
        await previousConnection.close({ code: 'remote_close' }).catch(() => {});
        if (attempt.connection === previousConnection) attempt.connection = null;
        await endProviderSession(attempt, 'reconnect');
      }

      for (let reconnectAttempt = 1; reconnectAttempt <= maxReconnectAttempts; reconnectAttempt += 1) {
        await waitBeforeReconnect(reconnectAttempt, attempt.abortController.signal);
        if (!owns(attempt)) return;
        if (!deps.isSelectionCurrent()) {
          await settleSelectionInvalidated(attempt);
          return;
        }
        deps.machine.connecting({ controlSessionId: attempt.controlSessionId, attemptId: attempt.id });
        let preparation: VoiceRealtimePreparation;
        try {
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
        if (preparation.kind !== 'prepared') {
          if (preparation.kind === 'aborted') return;
          break;
        }

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
        });
      }
    }
  };

  const pumpControlEvents = async (
    attempt: Attempt,
    connection: VoiceRealtimeConnection = attempt.connection!,
    connectionId = attempt.connectionSequence,
  ): Promise<void> => {
    if (!connection) return;
    try {
      for await (const control of connection.controlEvents(attempt.abortController.signal)) {
        if (!owns(attempt) || attempt.connection !== connection || !deps.isSelectionCurrent()) return;
        const events = deps.adapter.decodeControl(control);
        for (const event of events) {
          if (!owns(attempt) || attempt.connection !== connection || !deps.isSelectionCurrent()) return;
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
        if (!owns(attempt) || !deps.isSelectionCurrent() || attempt.connection !== connection) return;
        await deps.onTransportEvent?.(event, attempt.abortController.signal);
        if (!owns(attempt) || !deps.isSelectionCurrent() || attempt.connection !== connection) return;
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
      closePromise: null,
      terminalSettled: false,
      reconnecting: false,
      toolBarrier: null,
      activeToolResponseIds: new Set(),
      toolTasks: new Set(),
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

  const requestReconnect = async (): Promise<boolean> => {
    const attempt = current;
    if (!attempt || !owns(attempt) || attempt.terminalSettled) return false;
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

  return Object.freeze({
    start,
    stop,
    fail,
    performTurnControl,
    sendClientControl,
    getActiveControlSessionId,
    getOwnedControlSessionId,
    requestReconnect,
    playbackCursorMs,
    beginOutputInterruptionCandidate,
    resolveOutputInterruptionCandidate,
  });
}
