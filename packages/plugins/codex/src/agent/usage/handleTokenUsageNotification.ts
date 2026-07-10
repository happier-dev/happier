import { buildCodexAppServerTokenCountObservationInput } from './tokenCountMessage.js';

export type CodexTokenUsageTranscriptMessage = Readonly<Record<string, unknown> & {
  type: 'token_count';
  id: string;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function handleTokenUsageNotification(params: Readonly<{
  notificationParams: unknown;
  modelId?: string | null;
  now?: () => number;
  emit(message: CodexTokenUsageTranscriptMessage): void;
}>): boolean {
  const notification = asRecord(params.notificationParams);
  if (!notification) return false;
  const threadId = readNonEmptyString(notification.threadId ?? notification.thread_id);
  const turnId = readNonEmptyString(notification.turnId ?? notification.turn_id);
  if (!threadId || !turnId) return false;

  const input = buildCodexAppServerTokenCountObservationInput({
    notificationParams: notification,
    modelId: params.modelId,
    observedAtMs: (params.now ?? Date.now)(),
  });
  if (!input) return false;

  params.emit({
    type: 'token_count',
    id: `codex:${threadId}:${turnId}`,
    ...input.body,
  });
  return true;
}
