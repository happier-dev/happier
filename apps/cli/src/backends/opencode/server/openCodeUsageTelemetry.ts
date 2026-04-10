import { extractUsageObservationFromTokenCountMessage, type UsageObservation } from '@/usage/usageObservation';

import { asRecord, normalizeString } from './openCodeParsing';

type OpenCodeUsageTelemetry = Readonly<{
  observation: UsageObservation;
  dedupeKey: string | null;
}>;

function asFiniteNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function buildCanonicalTokens(raw: unknown): Record<string, number> | null {
  const record = asRecord(raw);
  if (!record) return null;
  const cache = asRecord(record.cache);

  const total = asFiniteNonNegativeNumber(record.total);
  const input = asFiniteNonNegativeNumber(record.input);
  const output = asFiniteNonNegativeNumber(record.output);
  const thought = asFiniteNonNegativeNumber(record.reasoning);
  const cacheRead = asFiniteNonNegativeNumber(cache?.read);
  const cacheCreation = asFiniteNonNegativeNumber(cache?.write);
  const hasAny =
    total != null ||
    input != null ||
    output != null ||
    thought != null ||
    cacheRead != null ||
    cacheCreation != null;
  if (!hasAny) return null;

  const tokens: Record<string, number> = {};
  if (total != null) tokens.total = total;
  if (input != null) tokens.input = input;
  if (output != null) tokens.output = output;
  if (thought != null) tokens.thought = thought;
  if (cacheRead != null) tokens.cache_read = cacheRead;
  if (cacheCreation != null) tokens.cache_creation = cacheCreation;
  return tokens;
}

function resolveContextUsedTokens(tokens: Record<string, number> | null): number | null {
  if (!tokens) return null;
  const total = asFiniteNonNegativeNumber(tokens.total);
  if (total != null) return total;
  const parts = [
    asFiniteNonNegativeNumber(tokens.input),
    asFiniteNonNegativeNumber(tokens.output),
    asFiniteNonNegativeNumber(tokens.thought),
    asFiniteNonNegativeNumber(tokens.cache_read),
    asFiniteNonNegativeNumber(tokens.cache_creation),
  ].filter((value): value is number => value != null);
  if (parts.length === 0) return null;
  return parts.reduce((sum, value) => sum + value, 0);
}

function normalizeModelId(params: Readonly<{
  providerId?: string | null;
  modelId?: string | null;
  fallbackModelId?: string | null;
}>): string | null {
  const providerId = normalizeString(params.providerId).trim();
  const modelId = normalizeString(params.modelId).trim();
  if (providerId && modelId) {
    return `${providerId}/${modelId}`;
  }
  const fallbackModelId = normalizeString(params.fallbackModelId).trim();
  return fallbackModelId || null;
}

function resolveProviderReportedUsd(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return asFiniteNonNegativeNumber(raw);
  }
  const record = asRecord(raw);
  if (!record) return null;
  return (
    asFiniteNonNegativeNumber(record.reportedUsd) ??
    asFiniteNonNegativeNumber(record.reported_usd) ??
    asFiniteNonNegativeNumber(record.reported) ??
    asFiniteNonNegativeNumber(record.total)
  );
}

function buildTelemetry(params: Readonly<{
  key: string | null;
  dedupeKey: string | null;
  source: string;
  tokensRaw: unknown;
  costRaw?: unknown;
  providerId?: string | null;
  modelId?: string | null;
  fallbackModelId?: string | null;
  contextWindowTokens?: number | null;
}>): OpenCodeUsageTelemetry | null {
  const tokens = buildCanonicalTokens(params.tokensRaw);
  const contextUsedTokens = resolveContextUsedTokens(tokens);
  const modelId = normalizeModelId({
    providerId: params.providerId,
    modelId: params.modelId,
    fallbackModelId: params.fallbackModelId,
  });

  const observation = extractUsageObservationFromTokenCountMessage({
    provider: 'opencode',
    defaultSource: params.source,
    defaultScope: 'turn_delta',
    body: {
      ...(params.key ? { key: params.key } : {}),
      ...(modelId ? { modelId } : {}),
      ...(tokens ? { tokens } : {}),
      ...(params.costRaw != null ? { cost: params.costRaw } : {}),
      ...(contextUsedTokens != null ? { context_used_tokens: contextUsedTokens } : {}),
      ...(params.contextWindowTokens != null ? { context_window_tokens: params.contextWindowTokens } : {}),
      source: params.source,
      scope: 'turn_delta',
    },
  });
  if (!observation) return null;

  const reportedUsd = resolveProviderReportedUsd(params.costRaw);
  if (reportedUsd != null) {
    observation.cost = {
      ...(observation.cost ?? {}),
      reportedUsd,
      total: observation.cost?.total ?? reportedUsd,
    };
  }

  return {
    observation,
    dedupeKey: params.dedupeKey,
  };
}

export function extractOpenCodeModelContextWindowTokens(raw: unknown): number | null {
  const record = asRecord(raw);
  if (!record) return null;
  const limit = asRecord(record.limit);
  const context = asFiniteNonNegativeNumber(limit?.context);
  return context != null ? Math.floor(context) : null;
}

export function buildOpenCodeMessageUpdatedUsageTelemetry(params: Readonly<{
  info: unknown;
  fallbackModelId?: string | null;
  contextWindowTokens?: number | null;
}>): OpenCodeUsageTelemetry | null {
  const info = asRecord(params.info);
  if (!info) return null;
  const messageId = normalizeString(info.id).trim() || null;
  return buildTelemetry({
    key: messageId ? `opencode-message:${messageId}` : null,
    dedupeKey: messageId,
    source: 'opencode-message-updated',
    tokensRaw: info.tokens,
    costRaw: info.cost,
    providerId: normalizeString(info.providerID).trim() || null,
    modelId: normalizeString(info.modelID).trim() || null,
    fallbackModelId: params.fallbackModelId,
    contextWindowTokens: params.contextWindowTokens ?? null,
  });
}

export function buildOpenCodeStepFinishUsageTelemetry(params: Readonly<{
  part: unknown;
  fallbackModelId?: string | null;
  contextWindowTokens?: number | null;
}>): OpenCodeUsageTelemetry | null {
  const part = asRecord(params.part);
  if (!part || normalizeString(part.type) !== 'step-finish') return null;
  const messageId = normalizeString(part.messageID).trim() || null;
  const partId = normalizeString(part.id).trim() || null;
  return buildTelemetry({
    key: messageId && partId ? `opencode-step-finish:${messageId}:${partId}` : null,
    dedupeKey: messageId,
    source: 'opencode-step-finish',
    tokensRaw: part.tokens,
    costRaw: part.cost,
    fallbackModelId: params.fallbackModelId,
    contextWindowTokens: params.contextWindowTokens ?? null,
  });
}

export function buildOpenCodeUsageDedupeFingerprint(observation: UsageObservation): string {
  return JSON.stringify({
    modelId: observation.modelId,
    tokens: observation.tokens,
    cost: observation.cost,
    contextUsedTokens: observation.contextUsedTokens,
    contextWindowTokens: observation.contextWindowTokens,
  });
}
