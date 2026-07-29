import type { SessionNotification } from '@agentclientprotocol/sdk';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { TransportHandler } from '@/agent/transport';
import { logger } from '@/ui/logger';
import { buildTokenCountAgentMessageFromUsageObservation } from '@/usage/legacy/legacyUsageTransport';
import type { AcpReplayCapture } from '../history/acpReplayCapture';
import type {
  HandlerContext,
  SessionUpdate,
} from '../sessionUpdateHandlers';
import {
  handleAgentMessageChunk,
  handleAgentThoughtChunk,
  handleAvailableCommandsUpdate,
  handleCurrentModeUpdate,
  handleLegacyMessageChunk,
  handlePlanUpdate,
  handleThinkingUpdate,
  handleToolCall,
  handleToolCallUpdate,
  handleUserMessageChunk,
} from '../sessionUpdateHandlers';
import type {
  SessionConfigOption,
  SessionModeState,
  SessionModelState,
} from '../sessionSettings/sessionSettingsState';
import {
  normalizeSessionConfigOptions,
} from '../sessionSettings/sessionSettingsState';
import {
  buildAcpSessionUpdateUsageObservation,
  buildAcpUsageUpdateObservation,
} from '../usage/buildAcpUsageObservation';
import {
  buildStructuredAgentMessageChunkMirrorSet,
  shouldSkipLegacyMessageChunkMirror,
} from './legacyMessageChunkMirrorDedup';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export async function handleAcpSessionNotification(params: Readonly<{
  notification: SessionNotification;
  agentName: string;
  transport: TransportHandler;
  replayCapture: AcpReplayCapture | null;
  sessionUpdateShapeLogger?: Readonly<{ log?: (shape: string, payload: unknown) => void }> | null;
  waitingForResponse: boolean;
  onResponseTrafficObserved: () => void;
  onAssistantMessageObserved: () => void;
  prepareToolUpdate?: (
    update: SessionUpdate,
    context: Readonly<{ toolCallCountSincePrompt: number }>,
  ) => Promise<SessionUpdate>;
  createHandlerContext: () => HandlerContext;
  setToolCallCountSincePrompt: (count: number) => void;
  getToolCallCountSincePrompt?: () => number;
  emit: (message: AgentMessage) => void;
  sessionModeState: SessionModeState | null;
  setSessionModeState: (state: SessionModeState) => void;
  sessionModelState: SessionModelState | null;
  setSessionModelState: (state: SessionModelState) => void;
  sessionConfigOptionsState: ReadonlyArray<SessionConfigOption> | null;
  setSessionConfigOptionsState: (state: ReadonlyArray<SessionConfigOption>) => void;
}>): Promise<void> {
  const raw = asRecord(params.notification) ?? {};
  const updateCandidates: unknown[] = [];
  let sessionModeState = params.sessionModeState;
  let sessionModelState = params.sessionModelState;
  let sessionConfigOptionsState = params.sessionConfigOptionsState;

  const maxUpdatesPerNotification = (() => {
    const rawMax =
      process.env.HAPPIER_ACP_MAX_UPDATES_PER_NOTIFICATION ??
      process.env.HAPPY_ACP_MAX_UPDATES_PER_NOTIFICATION ??
      '';
    const parsed = Number.parseInt(String(rawMax).trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, 10_000);
    return 1000;
  })();

  const pushUpdateCandidate = (value: unknown): boolean => {
    if (updateCandidates.length >= maxUpdatesPerNotification) return false;
    updateCandidates.push(value);
    return true;
  };

  if (raw.update !== undefined) {
    const updateField = raw.update;
    if (Array.isArray(updateField)) {
      for (const item of updateField) {
        if (!pushUpdateCandidate(item)) {
          logger.warn(
            `[AcpBackend] Received ${updateField.length} updates in a single notification; truncating to ${maxUpdatesPerNotification}`,
          );
          break;
        }
      }
    } else {
      pushUpdateCandidate(updateField);
    }
  } else if (Array.isArray(raw.updates)) {
    for (const item of raw.updates) {
      if (!pushUpdateCandidate(item)) {
        logger.warn(
          `[AcpBackend] Received ${raw.updates.length} updates in a single notification; truncating to ${maxUpdatesPerNotification}`,
        );
        break;
      }
    }
  }

  if (updateCandidates.length === 0) {
    logger.debug('[AcpBackend] Received session update without update field:', params.notification);
    return;
  }

  if (params.waitingForResponse) {
    params.onResponseTrafficObserved();
  }

  const handleOneUpdate = (rawUpdate: SessionUpdate): void => {
    const rawSessionUpdateType = typeof rawUpdate.sessionUpdate === 'string'
      ? rawUpdate.sessionUpdate
      : undefined;
    const update = rawSessionUpdateType === 'tool_call' || rawSessionUpdateType === 'tool_call_update'
      ? params.transport.sanitizeToolUpdateContent?.(rawUpdate) ?? rawUpdate
      : rawUpdate;
    const sessionUpdateType = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : undefined;
    params.sessionUpdateShapeLogger?.log?.(
      `inbound:${params.agentName}:${sessionUpdateType ?? 'unknown'}`,
      update,
    );
    if (
      sessionUpdateType === 'agent_message_chunk'
      || (update.messageChunk && typeof update.messageChunk.textDelta === 'string' && update.messageChunk.textDelta.length > 0)
    ) {
      params.onAssistantMessageObserved();
    }

    if (params.replayCapture) {
      try {
        params.replayCapture.handleUpdate(update as SessionUpdate);
      } catch (error) {
        logger.debug('[AcpBackend] Replay capture failed (non-fatal)', { error });
      }

      const suppress =
        sessionUpdateType === 'user_message_chunk'
        || sessionUpdateType === 'agent_message_chunk'
        || sessionUpdateType === 'agent_thought_chunk'
        || sessionUpdateType === 'tool_call'
        || sessionUpdateType === 'tool_call_update'
        || sessionUpdateType === 'plan';
      if (suppress) {
        return;
      }
    }

    if (sessionUpdateType !== 'agent_message_chunk') {
      logger.debug(`[AcpBackend] Received session update: ${sessionUpdateType}`, JSON.stringify({
        sessionUpdate: sessionUpdateType,
        toolCallId: update.toolCallId,
        status: update.status,
        kind: update.kind,
        hasContent: !!update.content,
        hasLocations: !!update.locations,
      }, null, 2));
    }

    if (
      (sessionUpdateType === 'tool_call_update' || sessionUpdateType === 'tool_call') &&
      (update.status === 'completed' || update.status === 'failed' || update.status === 'cancelled')
    ) {
      params.transport.logTerminalToolUpdate?.(update, {
        sessionUpdateType,
      });
    }

    const ctx = params.createHandlerContext();

    if (sessionUpdateType === 'agent_message_chunk') {
      handleAgentMessageChunk(update, ctx);
      return;
    }

    if (sessionUpdateType === 'user_message_chunk') {
      handleUserMessageChunk(update, ctx);
      return;
    }

    if (sessionUpdateType === 'tool_call_update') {
      const result = handleToolCallUpdate(update, ctx);
      if (result.toolCallCountSincePrompt !== undefined) {
        params.setToolCallCountSincePrompt(result.toolCallCountSincePrompt);
      }
      return;
    }

    if (sessionUpdateType === 'agent_thought_chunk') {
      handleAgentThoughtChunk(update, ctx);
      return;
    }

    if (sessionUpdateType === 'tool_call') {
      const result = handleToolCall(update, ctx);
      if (result.toolCallCountSincePrompt !== undefined) {
        params.setToolCallCountSincePrompt(result.toolCallCountSincePrompt);
      }
      return;
    }

    if (sessionUpdateType === 'available_commands_update') {
      handleAvailableCommandsUpdate(update, ctx);
      return;
    }

    if (sessionUpdateType === 'current_mode_update') {
      const modeId = typeof update.currentModeId === 'string' ? update.currentModeId : null;
      if (modeId && sessionModeState) {
        sessionModeState = {
          ...sessionModeState,
          currentModeId: modeId,
        };
        params.setSessionModeState(sessionModeState);
      }
      handleCurrentModeUpdate(update, ctx);
      return;
    }

    if (sessionUpdateType === 'current_model_update') {
      const modelId =
        typeof (update as { currentModelId?: unknown }).currentModelId === 'string'
          ? (update as { currentModelId: string }).currentModelId
          : (typeof (update as { currentModel?: unknown }).currentModel === 'string'
            ? (update as { currentModel: string }).currentModel
            : null);
      if (modelId && sessionModelState) {
        sessionModelState = {
          ...sessionModelState,
          currentModelId: modelId,
        };
        params.setSessionModelState(sessionModelState);
      }
      params.emit({ type: 'event', name: 'current_model_update', payload: { currentModelId: modelId ?? '' } });
      return;
    }

    if (sessionUpdateType === 'config_option_update') {
      const configOptionsCandidate = (update as { configOptions?: unknown }).configOptions;
      const configOptionsRaw = Array.isArray(configOptionsCandidate) ? configOptionsCandidate : null;
      if (configOptionsRaw) {
        sessionConfigOptionsState = normalizeSessionConfigOptions(configOptionsRaw);
        params.setSessionConfigOptionsState(sessionConfigOptionsState);
      }
      params.emit({
        type: 'event',
        name: 'config_options_update',
        payload: { configOptions: sessionConfigOptionsState ?? [] },
      });
      return;
    }

    if (sessionUpdateType === 'plan') {
      handlePlanUpdate(update, ctx);
      return;
    }

    if (sessionUpdateType === 'usage_update') {
      const observation = buildAcpUsageUpdateObservation({
        provider: params.agentName,
        update,
      });
      const telemetry = observation ? buildTokenCountAgentMessageFromUsageObservation(observation) : null;
      if (telemetry) {
        params.emit(telemetry);
      }
      return;
    }

    const usageCandidate = (update as { usage?: unknown }).usage;
    const usageObservation = usageCandidate
      ? buildAcpSessionUpdateUsageObservation({
          provider: params.agentName,
          usage: usageCandidate,
        })
      : null;
    const usageTelemetry = usageObservation ? buildTokenCountAgentMessageFromUsageObservation(usageObservation) : null;
    if (usageTelemetry) {
      params.emit(usageTelemetry);
    }

    handleLegacyMessageChunk(update, ctx);
    handlePlanUpdate(update, ctx);
    handleThinkingUpdate(update, ctx);

    const updateTypeStr = sessionUpdateType as string;
    const handledTypes = [
      'agent_message_chunk',
      'user_message_chunk',
      'tool_call_update',
      'agent_thought_chunk',
      'tool_call',
      'available_commands_update',
      'current_mode_update',
      'current_model_update',
      'config_option_update',
      'plan',
      'usage_update',
    ];
    if (
      updateTypeStr
      && !handledTypes.includes(updateTypeStr)
      && !update.messageChunk
      && !update.plan
      && !update.thinking
      && !update.availableCommands
      && !update.currentModeId
      && !update.entries
    ) {
      logger.debug(
        `[AcpBackend] Unhandled session update type: ${updateTypeStr}`,
        JSON.stringify({
          keys: Object.keys(update as unknown as Record<string, unknown>).slice(0, 50),
        }, null, 2),
      );
    }
  };

  const normalizedUpdates: SessionUpdate[] = [];
  for (const candidate of updateCandidates) {
    const update = (asRecord(candidate) ?? {}) as SessionUpdate;
    if (Object.keys(update).length === 0) continue;
    normalizedUpdates.push(update);
  }

  const mirroredStructuredChunkTexts = buildStructuredAgentMessageChunkMirrorSet(normalizedUpdates);

  for (const update of normalizedUpdates) {
    if (shouldSkipLegacyMessageChunkMirror(update, mirroredStructuredChunkTexts)) {
      continue;
    }
    const sessionUpdateType = typeof update.sessionUpdate === 'string'
      ? update.sessionUpdate
      : undefined;
    const prepared = params.prepareToolUpdate
      && (sessionUpdateType === 'tool_call' || sessionUpdateType === 'tool_call_update')
      ? await params.prepareToolUpdate(update, {
          toolCallCountSincePrompt: (params.getToolCallCountSincePrompt?.() ?? 0) + 1,
        })
      : update;
    handleOneUpdate(prepared);
  }
}
