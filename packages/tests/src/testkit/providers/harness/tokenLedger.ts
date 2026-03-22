import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { fetchAllMessages } from '../../sessions';
import { decryptLegacyBase64 } from '../../messageCrypto';
import type { CapturedEvent } from '../../socketClient';

export type ProviderTokenLedgerEntryV1 = {
  v: 1;
  providerId: string;
  scenarioId: string;
  phase: 'single' | 'phase1' | 'phase2';
  sessionId: string;
  key: string;
  timestamp: number;
  tokens: Record<string, number>;
  modelId: string | null;
  source:
    | 'socket-ephemeral-usage'
    | 'socket-update-token-count'
    | 'session-message-token-count'
    | 'missing-usage';
};

export type ProviderTokenLedgerV1 = {
  v: 1;
  runId: string;
  generatedAt: number;
  entries: ProviderTokenLedgerEntryV1[];
};

export type ProviderTokenTelemetryEntryV1 = ProviderTokenLedgerEntryV1;
type ProviderTokenTelemetryReportV1 = ProviderTokenLedgerV1;

export type ProviderTokenSummary = {
  providerId: string;
  modelId: string | null;
  entries: number;
  tokens: Record<string, number>;
};

function normalizeTokenMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    out[key] = value;
  }
  return out;
}

function addTokenMaps(base: Record<string, number>, delta: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...base };
  for (const [key, value] of Object.entries(delta)) {
    out[key] = (out[key] ?? 0) + value;
  }
  return out;
}

export function resolveProviderTokenLedgerPath(defaultRunDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.HAPPIER_E2E_PROVIDER_TOKEN_LEDGER_PATH ?? env.HAPPY_E2E_PROVIDER_TOKEN_LEDGER_PATH ?? '').trim();
  if (raw.length > 0) return resolve(raw);
  return resolve(join(defaultRunDir, 'provider-token-ledger.v1.json'));
}

export async function extractProviderTokenTelemetryEntries(params: {
  providerId: string;
  scenarioId: string;
  phase: 'single' | 'phase1' | 'phase2';
  sessionId: string;
  modelId: string | null;
  events: CapturedEvent[];
  secret?: Uint8Array;
  baseUrl?: string;
  token?: string;
  allowSessionMessageTokenCountFallback?: boolean;
}): Promise<ProviderTokenTelemetryEntryV1[]> {
  const out: ProviderTokenTelemetryEntryV1[] = [];
  for (const event of params.events) {
    if (event.kind !== 'ephemeral') continue;
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload || payload.type !== 'usage') continue;

    const keyRaw = typeof payload.key === 'string' ? payload.key.trim() : '';
    const key = keyRaw.length > 0 ? keyRaw : 'unknown';
    const timestamp = typeof payload.timestamp === 'number' && Number.isFinite(payload.timestamp) ? payload.timestamp : event.at;
    const tokens = normalizeTokenMap(payload.tokens);
    if (Object.keys(tokens).length === 0) continue;

    out.push({
      v: 1,
      providerId: params.providerId,
      scenarioId: params.scenarioId,
      phase: params.phase,
      sessionId: params.sessionId,
      key,
      timestamp,
      tokens,
      modelId: params.modelId,
      source: 'socket-ephemeral-usage',
    });
  }
  if (out.length > 0 || !params.secret) return out;

  const tokenCountEntries: ProviderTokenTelemetryEntryV1[] = [];
  for (const event of params.events) {
    if (event.kind !== 'update') continue;
    const body = event.payload?.body;
    if (!body || typeof body !== 'object') continue;
    const typedBody = body as { t?: unknown; message?: unknown };
    if (typedBody.t !== 'new-message') continue;
    const message = typedBody.message;
    if (!message || typeof message !== 'object') continue;
    const content = (message as { content?: unknown }).content;
    if (!content || typeof content !== 'object') continue;
    const encrypted = (content as { c?: unknown }).c;
    if (typeof encrypted !== 'string' || encrypted.trim().length === 0) continue;

    const decrypted = decryptLegacyBase64(encrypted, params.secret);
    if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) continue;
    const record = findTokenCountRecord(decrypted);
    if (!record) continue;

    const keyRaw = typeof record.key === 'string' ? record.key.trim() : '';
    const key = keyRaw.length > 0 ? keyRaw : 'unknown';

    const modelRaw = typeof record.model === 'string'
      ? record.model.trim()
      : typeof record.modelId === 'string'
        ? record.modelId.trim()
        : '';
    const modelId = modelRaw.length > 0 ? modelRaw : params.modelId;

    const tokens = extractNormalizedTokenCounts(record);
    if (!tokens) continue;

    tokenCountEntries.push({
      v: 1,
      providerId: params.providerId,
      scenarioId: params.scenarioId,
      phase: params.phase,
      sessionId: params.sessionId,
      key,
      timestamp: event.at,
      tokens,
      modelId,
      source: 'socket-update-token-count',
    });
  }

  if (tokenCountEntries.length > 0) return tokenCountEntries;

  const baseUrl = typeof params.baseUrl === 'string' ? params.baseUrl.trim() : '';
  const token = typeof params.token === 'string' ? params.token.trim() : '';
  const allowFallback = params.allowSessionMessageTokenCountFallback === true;
  if (!allowFallback || !baseUrl || !token) return tokenCountEntries;

  try {
    const rows = (await fetchAllMessages(baseUrl, token, params.sessionId)) as Array<{
      id: string;
      createdAt: number;
      content: { t: 'encrypted'; c: string };
    }>;

    const fromMessages: ProviderTokenTelemetryEntryV1[] = [];
    for (const row of rows) {
      const encrypted = row?.content?.c;
      if (typeof encrypted !== 'string' || encrypted.trim().length === 0) continue;
      const decrypted = decryptLegacyBase64(encrypted, params.secret);
      if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) continue;

      const record = findTokenCountRecord(decrypted);
      if (!record) continue;

      const tokens = extractNormalizedTokenCounts(record);
      if (!tokens) continue;

      const keyRaw = typeof record.key === 'string' ? record.key.trim() : '';
      const key = keyRaw.length > 0 ? keyRaw : typeof row.id === 'string' ? row.id : 'unknown';

      const modelRaw = typeof record.model === 'string'
        ? record.model.trim()
        : typeof record.modelId === 'string'
          ? record.modelId.trim()
          : '';
      const modelId = modelRaw.length > 0 ? modelRaw : params.modelId;

      const createdAt = typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) ? row.createdAt : Date.now();
      fromMessages.push({
        v: 1,
        providerId: params.providerId,
        scenarioId: params.scenarioId,
        phase: params.phase,
        sessionId: params.sessionId,
        key,
        timestamp: createdAt,
        tokens,
        modelId,
        source: 'session-message-token-count',
      });
    }

    return fromMessages;
  } catch {
    return tokenCountEntries;
  }
}

export function ensureProviderTokenTelemetryEntries(params: {
  providerId: string;
  scenarioId: string;
  phase: 'single' | 'phase1' | 'phase2';
  sessionId: string;
  modelId: string | null;
  extracted: ProviderTokenTelemetryEntryV1[];
}): ProviderTokenTelemetryEntryV1[] {
  if (Array.isArray(params.extracted) && params.extracted.length > 0) return params.extracted;
  return [
    {
      v: 1,
      providerId: params.providerId,
      scenarioId: params.scenarioId,
      phase: params.phase,
      sessionId: params.sessionId,
      key: 'missing-usage',
      timestamp: Date.now(),
      tokens: {},
      modelId: params.modelId,
      source: 'missing-usage',
    },
  ];
}

export async function appendProviderTokenTelemetryEntries(params: {
  entries: ProviderTokenTelemetryEntryV1[];
  reportPath: string;
  runId: string;
}): Promise<void> {
  if (!Array.isArray(params.entries) || params.entries.length === 0) return;

  let existingEntries: ProviderTokenTelemetryEntryV1[] = [];
  try {
    const raw = await readFile(params.reportPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ProviderTokenTelemetryReportV1>;
    if (parsed && parsed.v === 1 && Array.isArray(parsed.entries)) {
      existingEntries = parsed.entries as ProviderTokenTelemetryEntryV1[];
    }
  } catch {
    // Best-effort merge.
  }

  const next: ProviderTokenTelemetryReportV1 = {
    v: 1,
    runId: params.runId,
    generatedAt: Date.now(),
    entries: [...existingEntries, ...params.entries],
  };
  await writeFile(params.reportPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

export function summarizeProviderTokenLedgerByProviderAndModel(entries: ProviderTokenLedgerEntryV1[]): ProviderTokenSummary[] {
  const acc = new Map<string, ProviderTokenSummary>();
  for (const entry of entries) {
    const providerId = typeof entry.providerId === 'string' ? entry.providerId.trim() : '';
    if (!providerId) continue;
    const modelId = typeof entry.modelId === 'string' && entry.modelId.trim().length > 0 ? entry.modelId.trim() : null;
    const key = `${providerId}::${modelId ?? 'null'}`;
    const normalizedTokens = normalizeTokenMap(entry.tokens);
    const current = acc.get(key) ?? {
      providerId,
      modelId,
      entries: 0,
      tokens: {},
    };
    current.entries += 1;
    current.tokens = addTokenMaps(current.tokens, normalizedTokens);
    acc.set(key, current);
  }

  return [...acc.values()].sort((a, b) => {
    if (a.providerId !== b.providerId) return a.providerId.localeCompare(b.providerId);
    return (a.modelId ?? '').localeCompare(b.modelId ?? '');
  });
}

export function summarizeProviderTokenLedgerTotals(entries: ProviderTokenLedgerEntryV1[]): {
  entries: number;
  tokens: Record<string, number>;
} {
  let count = 0;
  let totals: Record<string, number> = {};
  for (const entry of entries) {
    totals = addTokenMaps(totals, normalizeTokenMap(entry.tokens));
    count += 1;
  }
  return { entries: count, tokens: totals };
}

function findTokenCountRecord(decrypted: unknown): Record<string, unknown> | null {
  if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) return null;
  const envelope = decrypted as Record<string, unknown>;
  if (envelope.type === 'token_count') return envelope;

  const content = envelope.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const contentRecord = content as Record<string, unknown>;
  if (contentRecord.type !== 'acp') return null;

  const data = contentRecord.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const dataRecord = data as Record<string, unknown>;
  return dataRecord.type === 'token_count' ? dataRecord : null;
}

function extractNormalizedTokenCounts(record: Record<string, unknown>): Record<string, number> | null {
  const nestedTokens = normalizeTokenMap(record.tokens);
  const topLevelTokens = normalizeTokenMap({
    input: record.input_tokens ?? record.input ?? record.prompt_tokens,
    output: record.output_tokens ?? record.output ?? record.completion_tokens,
    cache_creation: record.cache_creation_input_tokens ?? record.cache_creation,
    cache_read: record.cache_read_input_tokens ?? record.cache_read,
    thought: record.thought_tokens ?? record.thought,
    total: record.total_tokens ?? record.total,
  });

  const tokens = Object.keys(nestedTokens).length > 0 ? nestedTokens : topLevelTokens;
  if (Object.keys(tokens).length === 0) return null;

  if (tokens.total == null) {
    tokens.total =
      (tokens.input ?? 0) +
      (tokens.output ?? 0) +
      (tokens.cache_creation ?? 0) +
      (tokens.cache_read ?? 0) +
      (tokens.thought ?? 0);
  }

  return tokens;
}
