import type { PluginContextV1 } from '@happier-dev/plugin-sdk';
import {
  SESSION_PROVIDER_HOOK_EVENT_ID_V1,
  SESSION_PROVIDER_TRANSCRIPT_EVENT_ID_V1,
  type TypedEventV1,
} from '@happier-dev/protocol';

import type { ClaudeTerminalLifecycleObservation } from '../lifecycle.js';
import {
  mapClaudeHookEventToTerminalLifecycleObservation,
  mapClaudeTranscriptEventToTerminalLifecycleObservation,
} from '../lifecycle.js';
import { CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID } from './constants.js';

export const CLAUDE_UNIFIED_PROVIDER_HOOK_EVENT_ID = SESSION_PROVIDER_HOOK_EVENT_ID_V1;
export const CLAUDE_UNIFIED_PROVIDER_TRANSCRIPT_EVENT_ID = SESSION_PROVIDER_TRANSCRIPT_EVENT_ID_V1;

export type ClaudeUnifiedTerminalLifecycleObserver = Readonly<{
  observeTerminalLifecycle(observation: ClaudeTerminalLifecycleObservation): Promise<void> | void;
}>;

export type ClaudeUnifiedTerminalLifecycleEventSubscriptionParams = Readonly<{
  ctx: Pick<PluginContextV1, 'events' | 'logger'>;
  happierSessionId: string;
  observer: ClaudeUnifiedTerminalLifecycleObserver;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readNestedPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(payload.providerPayload)) return payload.providerPayload;
  if (isRecord(payload.payload)) return payload.payload;
  if (isRecord(payload.data)) return payload.data;
  if (isRecord(payload.raw)) return payload.raw;
  return payload;
}

function isClaudeSessionEvent(
  payload: Record<string, unknown>,
  happierSessionId: string,
): boolean {
  const providerId = readString(payload.providerId)
    ?? readString(payload.backendId)
    ?? readString(payload.agentId);
  if (providerId !== CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID) return false;

  const sessionId = readString(payload.sessionId)
    ?? readString(payload.happySessionId)
    ?? readString(payload.happierSessionId);
  return sessionId === happierSessionId;
}

function readHookObservation(
  payload: Record<string, unknown>,
  happierSessionId: string,
): ClaudeTerminalLifecycleObservation | null {
  if (!isClaudeSessionEvent(payload, happierSessionId)) return null;
  const nested = readNestedPayload(payload);
  const eventName = readString(payload.eventName)
    ?? readString(payload.hookEventName)
    ?? readString(nested.hook_event_name)
    ?? readString(nested.hookEventName);
  if (!eventName) return null;

  const detail = readString(payload.detail)
    ?? readString(nested.detail)
    ?? readString(nested.last_assistant_message)
    ?? readString(nested.lastAssistantMessage)
    ?? readString(nested.error)
    ?? readString(nested.message);
  const promptText = readString(payload.promptText)
    ?? readString(payload.prompt_text)
    ?? readString(payload.prompt)
    ?? readString(nested.promptText)
    ?? readString(nested.prompt_text)
    ?? readString(nested.prompt);
  const observedAtMs = readTimestampMs(payload.observedAtMs)
    ?? readTimestampMs(payload.observed_at_ms)
    ?? readTimestampMs(payload.timestamp)
    ?? readTimestampMs(nested.observedAtMs)
    ?? readTimestampMs(nested.observed_at_ms)
    ?? readTimestampMs(nested.timestamp);

  return mapClaudeHookEventToTerminalLifecycleObservation({
    agentId: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
    eventName,
    turnId: readString(payload.turnId) ?? readString(nested.turnId),
    ...(detail ? { detail } : {}),
    evidence: nested,
    ...(promptText ? { promptText } : {}),
    ...(typeof observedAtMs === 'number' ? { observedAtMs } : {}),
  });
}

function readTranscriptObservation(
  payload: Record<string, unknown>,
  happierSessionId: string,
): ClaudeTerminalLifecycleObservation | null {
  if (!isClaudeSessionEvent(payload, happierSessionId)) return null;
  const nested = readNestedPayload(payload);
  const kind = readString(payload.kind) ?? readString(nested.kind);
  if (!kind) return null;

  if (kind === 'user_prompt' || kind === 'user') {
    const text = readString(payload.text)
      ?? readString(payload.promptText)
      ?? readString(payload.prompt_text)
      ?? readString(payload.prompt)
      ?? readString(nested.text)
      ?? readString(nested.promptText)
      ?? readString(nested.prompt_text)
      ?? readString(nested.prompt);
    if (!text) return null;
    const observedAtMs = readTimestampMs(payload.observedAtMs)
      ?? readTimestampMs(payload.observed_at_ms)
      ?? readTimestampMs(payload.timestamp)
      ?? readTimestampMs(nested.observedAtMs)
      ?? readTimestampMs(nested.observed_at_ms)
      ?? readTimestampMs(nested.timestamp);
    return mapClaudeTranscriptEventToTerminalLifecycleObservation({
      agentId: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
      kind: 'user_prompt',
      text,
      turnId: readString(payload.turnId) ?? readString(nested.turnId),
      ...(typeof observedAtMs === 'number' ? { observedAtMs } : {}),
    });
  }

  if (kind === 'assistant_stop') {
    return mapClaudeTranscriptEventToTerminalLifecycleObservation({
      agentId: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
      kind,
      stopReason: readString(payload.stopReason)
        ?? readString(payload.stop_reason)
        ?? readString(nested.stopReason)
        ?? readString(nested.stop_reason),
      turnId: readString(payload.turnId) ?? readString(nested.turnId),
    });
  }

  if (kind === 'stop_hook_feedback') {
    return mapClaudeTranscriptEventToTerminalLifecycleObservation({
      agentId: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
      kind,
      turnId: readString(payload.turnId) ?? readString(nested.turnId),
    });
  }

  if (kind === 'compact_boundary') {
    return mapClaudeTranscriptEventToTerminalLifecycleObservation({
      agentId: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
      kind,
      turnId: readString(payload.turnId) ?? readString(nested.turnId),
    });
  }

  if (kind === 'text') {
    const text = readString(payload.text) ?? readString(nested.text);
    if (!text) return null;
    const observedAtMs = readTimestampMs(payload.observedAtMs)
      ?? readTimestampMs(payload.observed_at_ms)
      ?? readTimestampMs(payload.timestamp)
      ?? readTimestampMs(nested.observedAtMs)
      ?? readTimestampMs(nested.observed_at_ms)
      ?? readTimestampMs(nested.timestamp);
    return mapClaudeTranscriptEventToTerminalLifecycleObservation({
      agentId: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
      kind,
      text,
      turnId: readString(payload.turnId) ?? readString(nested.turnId),
      ...(typeof observedAtMs === 'number' ? { observedAtMs } : {}),
    });
  }

  return null;
}

async function observeMappedLifecycleEvent(params: Readonly<{
  ctx: Pick<PluginContextV1, 'logger'>;
  observer: ClaudeUnifiedTerminalLifecycleObserver;
  event: TypedEventV1;
  happierSessionId: string;
}>): Promise<void> {
  if (!isRecord(params.event.payload)) return;
  const observation = params.event.id === CLAUDE_UNIFIED_PROVIDER_HOOK_EVENT_ID
    ? readHookObservation(params.event.payload, params.happierSessionId)
    : readTranscriptObservation(params.event.payload, params.happierSessionId);
  if (!observation) return;

  try {
    await params.observer.observeTerminalLifecycle(observation);
  } catch (error) {
    params.ctx.logger.warn('[ClaudeUnifiedTerminal] failed to apply lifecycle event', {
      eventId: params.event.id,
      error,
    });
  }
}

export function subscribeClaudeUnifiedTerminalLifecycleEvents(
  params: ClaudeUnifiedTerminalLifecycleEventSubscriptionParams,
): () => void {
  const hookSubscription = params.ctx.events.subscribe(
    CLAUDE_UNIFIED_PROVIDER_HOOK_EVENT_ID,
    async (event) => observeMappedLifecycleEvent({
      ctx: params.ctx,
      observer: params.observer,
      event,
      happierSessionId: params.happierSessionId,
    }),
  );
  const transcriptSubscription = params.ctx.events.subscribe(
    CLAUDE_UNIFIED_PROVIDER_TRANSCRIPT_EVENT_ID,
    async (event) => observeMappedLifecycleEvent({
      ctx: params.ctx,
      observer: params.observer,
      event,
      happierSessionId: params.happierSessionId,
    }),
  );

  return () => {
    hookSubscription.unsubscribe();
    transcriptSubscription.unsubscribe();
  };
}
