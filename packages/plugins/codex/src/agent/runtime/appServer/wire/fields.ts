import { isCodexAppServerFastServiceTier } from '../serviceTier.js';

type CodexAppServerThreadResponse = Readonly<{
  threadId?: unknown;
  thread_id?: unknown;
  id?: unknown;
  thread?: Readonly<{ id?: unknown; threadId?: unknown; thread_id?: unknown }> | null;
}>;

type CodexAppServerTurnResponse = Readonly<{
  turnId?: unknown;
  id?: unknown;
  turn?: Readonly<{ id?: unknown; turnId?: unknown }> | null;
}>;

export function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function trimSessionId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function trimStringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readThreadId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const response = value as CodexAppServerThreadResponse;
  const candidates = [
    response.threadId,
    response.thread_id,
    response.id,
    response.thread?.threadId,
    response.thread?.thread_id,
    response.thread?.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

export function readTurnId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const response = value as CodexAppServerTurnResponse;
  const candidates = [response.turnId, response.id, response.turn?.turnId, response.turn?.id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

export function readProviderEventTurnId(
  value: unknown,
  options?: Readonly<{ allowTopLevelId?: boolean }>,
): string | null {
  const record = readRecord(value);
  if (!record) return null;
  const turn = readRecord(record.turn);
  const item = readRecord(record.item);
  const recordMetadataPassthrough = readRecord(record.internal_chat_message_metadata_passthrough);
  const itemMetadataPassthrough = readRecord(item?.internal_chat_message_metadata_passthrough);
  const candidates = [
    record.turnId,
    record.turn_id,
    turn?.turnId,
    turn?.turn_id,
    turn?.id,
    recordMetadataPassthrough?.turnId,
    recordMetadataPassthrough?.turn_id,
    itemMetadataPassthrough?.turnId,
    itemMetadataPassthrough?.turn_id,
    options?.allowTopLevelId === true ? readTopLevelProviderTurnId(record) : null,
  ];
  for (const candidate of candidates) {
    const turnId = trimStringValue(candidate);
    if (turnId) return turnId;
  }
  return null;
}

function readTopLevelProviderTurnId(record: Record<string, unknown>): string | null {
  const hasTopLevelItemIdentity = Boolean(
    readRecord(record.item)
      || trimStringValue(record.itemId)
      || trimStringValue(record.item_id)
      || trimStringValue(record.callId)
      || trimStringValue(record.call_id)
      || trimStringValue(record.type),
  );
  return hasTopLevelItemIdentity ? null : trimStringValue(record.id);
}

export function readProviderEventItemRecord(value: unknown): Record<string, unknown> | null {
  const record = readRecord(value);
  if (!record) return null;
  return readRecord(record.item) ?? record;
}

export function readProviderEventItemId(value: unknown): string | null {
  const item = readProviderEventItemRecord(value);
  if (!item) return null;
  const candidates = [
    item.itemId,
    item.item_id,
    item.id,
    item.callId,
    item.call_id,
  ];
  for (const candidate of candidates) {
    const itemId = trimStringValue(candidate);
    if (itemId) return itemId;
  }
  return null;
}

export function readNormalizedProviderEventItemType(value: unknown): string | null {
  const item = readProviderEventItemRecord(value);
  const rawType = item
    ? trimStringValue(item.type) ?? trimStringValue(item.itemType) ?? trimStringValue(item.item_type)
    : null;
  if (!rawType) return null;
  const normalized = rawType.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function readRollbackUnsupportedErrorMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const message = error.message.trim();
  if (message.length === 0) return null;
  const normalized = message.toLowerCase();
  if (normalized.includes('method not found') || normalized.includes('invalid params')) {
    return message;
  }
  return null;
}

export function readModelId(value: unknown): string | null {
  const record = readRecord(value);
  return record ? trimStringValue(record.model) : null;
}

export function readServiceTier(value: unknown): string | null {
  const record = readRecord(value);
  if (!record) return null;
  const serviceTier = trimStringValue(record.serviceTier) ?? trimStringValue(record.service_tier);
  return isCodexAppServerFastServiceTier(serviceTier) ? 'fast' : serviceTier;
}

export function readCodexTurnStatus(value: unknown): string | null {
  const record = readRecord(value);
  const turn = readRecord(record?.turn);
  return trimStringValue(turn?.status) ?? trimStringValue(record?.status);
}

export function isCodexTurnInterruptedStatus(status: string | null): boolean {
  return status === 'interrupted'
    || status === 'cancelled'
    || status === 'canceled'
    || status === 'aborted';
}

export function buildThreadServiceTierParams(
  currentServiceTier: string | null,
  hasServiceTierOverride: boolean,
): { serviceTier?: 'fast' | null } {
  if (!hasServiceTierOverride) {
    return {};
  }
  return currentServiceTier === 'fast' ? { serviceTier: 'fast' } : { serviceTier: null };
}

export function buildThreadConfigOverrideParams(
  currentReasoningEffort: string | null,
): { config?: Record<string, string> } {
  if (!currentReasoningEffort) {
    return {};
  }
  return {
    config: {
      model_reasoning_effort: currentReasoningEffort,
    },
  };
}
