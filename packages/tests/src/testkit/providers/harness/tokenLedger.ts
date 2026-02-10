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
