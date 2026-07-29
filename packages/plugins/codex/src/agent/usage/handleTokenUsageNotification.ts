import { createHash } from 'node:crypto';

import {
  buildCodexAppServerTokenCountObservationInput,
  type CodexAppServerUsageObservationInput,
} from './tokenCountMessage.js';

export type CodexTokenUsageTranscriptMessage = Readonly<Record<string, unknown> & {
  type: 'token_count';
  id: string;
}>;

export type CodexTokenUsageRuntimeObservation = CodexAppServerUsageObservationInput & Readonly<{
  observationId: string;
  turnId: string;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function deriveUsageObservationId(params: Readonly<{
  sessionId: string;
  threadId: string;
  turnId: string;
  observation: CodexAppServerUsageObservationInput;
}>): string {
  const context = params.observation.context;
  const identity = JSON.stringify([
    params.sessionId.trim(),
    params.threadId,
    params.turnId,
    params.observation.source,
    params.observation.scope,
    params.observation.modelId ?? null,
    params.observation.tokens ?? null,
    params.observation.cost ?? null,
    context ? {
      v: context.v,
      modelId: context.modelId,
      usedTokens: context.usedTokens,
      windowTokens: context.windowTokens,
      totalProcessedTokens: context.totalProcessedTokens,
      baselineTokens: context.baselineTokens,
      isAutoCompactEnabled: context.isAutoCompactEnabled,
      categories: context.categories,
      source: context.source,
    } : null,
  ]);
  return `codex-usage:${createHash('sha256').update(identity, 'utf8').digest('hex')}`;
}

export function handleTokenUsageNotification(params: Readonly<{
  notificationParams: unknown;
  sessionId: string;
  modelId?: string | null;
  modelSource?: 'codex-native' | 'provider';
  now?: () => number;
  emit(
    message: CodexTokenUsageTranscriptMessage,
    observation: CodexTokenUsageRuntimeObservation | null,
  ): void;
}>): boolean {
  const notification = asRecord(params.notificationParams);
  if (!notification) return false;
  const threadId = readNonEmptyString(notification.threadId ?? notification.thread_id);
  const turnId = readNonEmptyString(notification.turnId ?? notification.turn_id);
  if (!threadId || !turnId) return false;

  const input = buildCodexAppServerTokenCountObservationInput({
    notificationParams: notification,
    modelId: params.modelId,
    modelSource: params.modelSource,
    observedAtMs: (params.now ?? Date.now)(),
  });
  if (!input) return false;

  const transcriptId = `codex:${threadId}:${turnId}`;
  params.emit({
    type: 'token_count',
    id: transcriptId,
    ...input.body,
  }, input.runtimeObservation ? {
    ...input.runtimeObservation,
    observationId: deriveUsageObservationId({
      sessionId: params.sessionId,
      threadId,
      turnId,
      observation: input.runtimeObservation,
    }),
    turnId,
  } : null);
  return true;
}
