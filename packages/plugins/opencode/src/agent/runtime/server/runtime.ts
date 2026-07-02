import type { PluginContextV1 } from '@happier-dev/plugin-sdk';
import type { RuntimeEventV1 } from '@happier-dev/protocol';

import { publishOpenCodeNativeTodosWorkState } from '../workState.js';
import type { OpenCodeRuntimeTurnOperations } from './operations.js';
import { publishOpenCodeTurnCancelled, publishOpenCodeRuntimeEvent } from './openCodeRuntimeEvents.js';
import type { OpenCodeServerClient } from './openCodeServerClient.js';
import { createOpenCodeServerClient } from './openCodeServerClient.js';
import { asRecord, normalizeString } from './openCodeParsing.js';
import {
  readOpenCodeBackgroundTaskWakeSource,
  openCodeToolPartLooksLikeBackgroundOutputContinuation,
} from './openCodeBackgroundTaskSignals.js';
import type { OpenCodeToolPart } from './providerActivity/createOpenCodeProviderActivityTracker.js';
import { createOpenCodeProviderActivityTracker } from './providerActivity/createOpenCodeProviderActivityTracker.js';
import { refreshOpenCodeProviderActivityFromHistory } from './providerActivity/history.js';
import { attachOpenCodeProviderEventSubscriptionIfNeeded } from './providerEvents.js';
import { normalizeOpenCodePromptConfigUpdate } from './promptConfig.js';
import { maybeFailOnOpenCodeRetryStatus } from './retryFailure.js';
import { publishOpenCodeProviderSessionId } from './sessionIdentity.js';
import {
  createOpenCodeServerRuntimeState,
  createOpenCodeTurnId,
  readEventSessionId,
  readOpenCodeToolCallKey,
  readOpenCodeToolPart,
  readProviderEvent,
  readStatusType,
  recordOpenCodeProviderAutonomousBackgroundWake,
} from './state.js';
import { completeOpenCodeTurnIfReady } from './turnCompletion.js';
import { beginOpenCodeProviderAutonomousBackgroundTurnIfNeeded } from './turnStart.js';

export function createOpenCodeServerRuntime(params: Readonly<{
  ctx: PluginContextV1;
  directory: string;
  happierSessionId: string;
  baseUrl: string;
  client?: OpenCodeServerClient;
  setThinking?: (thinking: boolean) => void;
}>): OpenCodeRuntimeTurnOperations {
  const client = params.client ?? createOpenCodeServerClient({
    fetch: params.ctx.fetch,
    baseUrl: params.baseUrl,
  });
  const state = createOpenCodeServerRuntimeState();
  const providerActivityTracker = createOpenCodeProviderActivityTracker();
  const messageHandlers = new Set<(message: RuntimeEventV1) => void>();
  const accumulatedBackgroundWakeTextByPartKey = new Map<string, string>();

  const publishMessage = (message: RuntimeEventV1): void => {
    for (const handler of messageHandlers) handler(message);
  };

  const publishRuntimeEvent = (event: RuntimeEventV1): void => {
    publishMessage(event);
  };

  const setThinking = (thinking: boolean): void => {
    params.setThinking?.(thinking);
  };

  const resetCurrentTurnObservations = (): void => {
    state.currentTurnObservedMessageIds.clear();
    state.currentTurnObservedToolCallKeys.clear();
  };

  const observeCurrentTurnMessageId = (messageId: string): void => {
    if (!state.turnInFlight || !messageId) return;
    state.currentTurnObservedMessageIds.add(messageId);
  };

  const observeCurrentTurnToolPart = (part: OpenCodeToolPart): void => {
    if (!state.turnInFlight) return;
    if (part.messageID) state.currentTurnObservedMessageIds.add(part.messageID);
    state.currentTurnObservedToolCallKeys.add(readOpenCodeToolCallKey(part));
  };

  const publishNativeTodosWorkState = async (): Promise<void> => {
    await publishOpenCodeNativeTodosWorkState({
      ctx: params.ctx,
      client,
      providerSessionId: state.providerSessionId,
    });
  };

  const refreshProviderActivityFromHistory = async (): Promise<void> => {
    await refreshOpenCodeProviderActivityFromHistory({
      client,
      state,
      tracker: providerActivityTracker,
    });
  };

  const completeTurnIfReady = async (status: unknown): Promise<void> => {
    await completeOpenCodeTurnIfReady({
      publishRuntimeEvent,
      state,
      providerActivityTracker,
      happierSessionId: params.happierSessionId,
      resetCurrentTurnObservations,
      setThinking,
      status,
    });
  };

  const handleProviderEvent = async (event: unknown): Promise<void> => {
    const { type, properties } = readProviderEvent(event);
    if (!type) return;
    const eventSessionId = readEventSessionId(properties);
    if (eventSessionId && state.providerSessionId && eventSessionId !== state.providerSessionId) return;

    if (type === 'todo.updated') {
      await publishNativeTodosWorkState().catch((error: unknown) => {
        params.ctx.logger.debug('[OpenCodeServer] failed to publish todo work-state update', { error });
      });
      return;
    }

    if (type === 'server.connected') {
      await refreshProviderActivityFromHistory();
      return;
    }

    if (type === 'session.status') {
      await handleStatus(asRecord(properties.status) ?? properties.status);
      return;
    }

    if (type === 'session.idle') {
      await handleStatus({ type: 'idle' });
      return;
    }

    if (type === 'message.part.updated' || type === 'message.part.created') {
      const rawPart = asRecord(properties.part);
      const rawPartText = normalizeString(rawPart?.text);
      observeCurrentTurnMessageId(normalizeString(rawPart?.messageID));
      const backgroundWakeSource = rawPartText
        ? readOpenCodeBackgroundTaskWakeSource(rawPartText)
        : null;
      if (backgroundWakeSource) {
        recordProviderAutonomousBackgroundWake({
          source: backgroundWakeSource,
          messageId: normalizeString(rawPart?.messageID),
        });
        return;
      }
      const part = readOpenCodeToolPart(rawPart);
      if (!part) return;
      const isBackgroundOutputContinuation =
        openCodeToolPartLooksLikeBackgroundOutputContinuation(part);
      if (
        !state.turnInFlight &&
        (state.pendingProviderAutonomousBackgroundWake ||
          isBackgroundOutputContinuation)
      ) {
        await beginProviderAutonomousBackgroundTurnIfNeeded({
          reason: isBackgroundOutputContinuation
            ? 'background-output-tool'
            : 'background-wake',
        });
      }
      providerActivityTracker.observeToolPart({
        part,
        source: 'live',
        partId: normalizeString(rawPart?.id) || null,
      });
      observeCurrentTurnToolPart(part);
      return;
    }

    if (type === 'message.updated') {
      observeCurrentTurnMessageId(normalizeString(asRecord(properties.info)?.id));
      return;
    }

    if (type === 'message.part.delta') {
      const messageId = normalizeString(properties.messageID);
      const partId = normalizeString(properties.partID);
      const delta = normalizeString(properties.delta);
      if (!state.providerSessionId || !messageId || !partId || !delta) return;
      observeCurrentTurnMessageId(messageId);
      const key = `${state.providerSessionId}:${messageId}:${partId}`;
      const accumulated = accumulatedBackgroundWakeTextByPartKey.get(key) ?? '';
      const nextAccumulated = delta.startsWith(accumulated) ? delta : accumulated + delta;
      accumulatedBackgroundWakeTextByPartKey.set(key, nextAccumulated);
      const backgroundWakeSource = readOpenCodeBackgroundTaskWakeSource(nextAccumulated);
      if (!backgroundWakeSource) return;
      recordProviderAutonomousBackgroundWake({
        source: backgroundWakeSource,
        messageId,
      });
      return;
    }
  };

  const recordProviderAutonomousBackgroundWake = (input: Readonly<{
    source: 'native-background-task' | 'oh-my-openagent-background-task';
    messageId?: string | null;
  }>): void => {
    recordOpenCodeProviderAutonomousBackgroundWake({
      state,
      source: input.source,
      messageId: input.messageId,
    });
  };

  const beginProviderAutonomousBackgroundTurnIfNeeded = async (input: Readonly<{
    reason: 'background-wake' | 'background-output-tool';
  }>): Promise<boolean> => beginOpenCodeProviderAutonomousBackgroundTurnIfNeeded({
    publishRuntimeEvent,
    state,
    happierSessionId: params.happierSessionId,
    setThinking,
    reason: input.reason,
  });

  const handleStatus = async (status: unknown): Promise<void> => {
    await maybeFailOnOpenCodeRetryStatus({
      ctx: params.ctx,
      publishRuntimeEvent,
      status,
      state,
      happierSessionId: params.happierSessionId,
    });
    const statusType = readStatusType(status);
    if (statusType === 'busy') {
      if (state.pendingProviderAutonomousBackgroundWake) {
        await beginProviderAutonomousBackgroundTurnIfNeeded({
          reason: 'background-wake',
        });
      }
      setThinking(true);
      return;
    }
    if (statusType === 'idle') {
      await refreshProviderActivityFromHistory().catch((error: unknown) => {
        params.ctx.logger.debug('[OpenCodeServer] history refresh failed before idle finality check', { error });
      });
      await completeTurnIfReady(status);
    }
  };

  return {
    beginTurnLifecycle() {
      state.activeTurnId = createOpenCodeTurnId();
      state.turnInFlight = true;
      resetCurrentTurnObservations();
      setThinking(true);
      void publishOpenCodeRuntimeEvent(publishRuntimeEvent, {
        kind: 'turn-start',
        sessionId: params.happierSessionId,
        turnId: state.activeTurnId,
        emittedAtMs: Date.now(),
      }).catch((error: unknown) => {
        params.ctx.logger.debug('[OpenCodeServer] failed to publish turn-start event', { error });
      });
    },
    async startOrLoadSession(opts = {}) {
      const resumeId = normalizeString(opts.resumeId);
      if (resumeId) {
        state.providerSessionId = resumeId;
      } else {
        const created = await client.sessionCreate({ directory: params.directory });
        state.providerSessionId = created.id;
      }
      await publishOpenCodeProviderSessionId({
        ctx: params.ctx,
        providerSessionId: state.providerSessionId,
        reason: 'opencode_session_started',
      });
      providerActivityTracker.resetForProviderSession(state.providerSessionId);
      state.pendingProviderAutonomousBackgroundWake = null;
      accumulatedBackgroundWakeTextByPartKey.clear();
      attachOpenCodeProviderEventSubscriptionIfNeeded({
        client,
        ctx: params.ctx,
        state,
        handleProviderEvent,
      });
      return state.providerSessionId;
    },
    async sendTurnPrompt(prompt) {
      if (!state.activeTurnId) this.beginTurnLifecycle();
      if (!state.providerSessionId) await this.startOrLoadSession();
      const providerSessionId = state.providerSessionId;
      const turnId = state.activeTurnId;
      if (!providerSessionId || !turnId) throw new Error('OpenCode session failed to initialize');

      await publishOpenCodeRuntimeEvent(publishRuntimeEvent, {
        kind: 'transcript-user-text',
        sessionId: params.happierSessionId,
        emittedAtMs: Date.now(),
        text: prompt,
        localId: `${turnId}:user`,
      });
      await client.sessionPromptAsync({
        sessionId: providerSessionId,
        messageId: `${turnId}:user`,
        text: prompt,
        ...(state.promptVariant ? { variant: state.promptVariant } : {}),
        ...(state.promptConfig ? { config: state.promptConfig } : {}),
      });
    },
    async steerInFlightTurn(message) {
      await this.sendTurnPrompt(message);
    },
    async waitForTurnCompletion() {
      if (!state.turnInFlight || !state.activeTurnId || !state.providerSessionId) return;
      let status: unknown;
      try {
        status = await client.sessionStatus({ sessionId: state.providerSessionId });
      } catch (error) {
        params.ctx.logger.debug('[OpenCodeServer] status poll failed during turn completion', { error });
        return;
      }
      await maybeFailOnOpenCodeRetryStatus({
        ctx: params.ctx,
        publishRuntimeEvent,
        status,
        state,
        happierSessionId: params.happierSessionId,
      });
      if (readStatusType(status) !== 'busy') {
        await refreshProviderActivityFromHistory().catch((error: unknown) => {
          params.ctx.logger.debug('[OpenCodeServer] history refresh failed before polling finality check', { error });
        });
      }
      await completeTurnIfReady(status);
    },
    subscribeRuntimeEvents(handler) {
      messageHandlers.add(handler);
      return () => {
        messageHandlers.delete(handler);
      };
    },
    async respondToPermission(requestId, approved) {
      await params.ctx.session.permissions.requestDecision({
        provider: 'opencode',
        requestId,
        approved,
      });
    },
    async cancelTurn() {
      if (state.providerSessionId) {
        await client.sessionAbort({ sessionId: state.providerSessionId }).catch((error: unknown) => {
          params.ctx.logger.debug('[OpenCodeServer] session abort failed during cancel', { error });
        });
      }
      if (state.activeTurnId) {
        await publishOpenCodeTurnCancelled({
          publishRuntimeEvent,
          sessionId: params.happierSessionId,
          turnId: state.activeTurnId,
          reason: 'cancelled',
          emittedAtMs: Date.now(),
        });
      }
      state.turnInFlight = false;
      resetCurrentTurnObservations();
      setThinking(false);
    },
    readSessionIdentity() {
      return { sessionId: state.providerSessionId };
    },
    async updateSessionRuntimeConfig(update) {
      const promptConfigUpdate = normalizeOpenCodePromptConfigUpdate(update);
      if (promptConfigUpdate.variant) {
        state.promptVariant = promptConfigUpdate.variant;
      }
      if (promptConfigUpdate.hasConfig) {
        state.promptConfig = promptConfigUpdate.config;
      }
      params.ctx.telemetry.emit({
        kind: 'opencode.runtime_config_update',
        update,
      });
    },
    handleProviderEvent,
    async resetOrDisposeRuntime() {
      state.disposed = true;
      state.subscriptionAbort?.abort('disposed');
      state.subscriptionAbort = null;
      state.providerSessionId = null;
      state.activeTurnId = null;
      state.turnInFlight = false;
      state.pendingProviderAutonomousBackgroundWake = null;
      accumulatedBackgroundWakeTextByPartKey.clear();
      resetCurrentTurnObservations();
      providerActivityTracker.resetForProviderSession(null);
      setThinking(false);
    },
  };
}
