import type { ACPProvider } from './sessionMessageTypes';

import { extractTokensFromAcpTokenCountMessage } from './acpTokenCountUsage';

export type UsageReportV1 = {
  key: string;
  sessionId: string;
  tokens: {
    total: number;
    [key: string]: number;
  };
  cost: {
    total: number;
    [key: string]: number;
  };
};

function asFiniteNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function createSafeNumberMap(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

function normalizeCostMap(raw: unknown): { total: number; [key: string]: number } {
  if (raw == null) {
    const out = createSafeNumberMap();
    out.total = 0;
    return out as { total: number; [key: string]: number };
  }
  const direct = asFiniteNonNegativeNumber(raw);
  if (direct != null) {
    const out = createSafeNumberMap();
    out.total = direct;
    return out as { total: number; [key: string]: number };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const out = createSafeNumberMap();
    out.total = 0;
    return out as { total: number; [key: string]: number };
  }
  const out = createSafeNumberMap();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const num = asFiniteNonNegativeNumber(value);
    if (num == null) continue;
    out[key] = num;
  }

  if (out.total == null) {
    const total = Object.entries(out)
      .filter(([k]) => k !== 'total')
      .reduce((acc, [, v]) => acc + v, 0);
    out.total = total;
  }

  return out as { total: number; [key: string]: number };
}

/** Project token measurements to scalar replacement reports; partial context updates remain telemetry. */
export function buildUsageReportFromAcpTokenCount(params: {
  provider: ACPProvider;
  sessionId: string;
  body: unknown;
}): UsageReportV1 | null {
  const extracted = extractTokensFromAcpTokenCountMessage(params.body);
  if (!extracted) return null;

  // Key must be stable enough for upsert semantics but still allow multiple usage updates per session.
  // If the provider supplies a key, use it; otherwise fall back to a per-provider session key.
  const key = extracted.key ?? `${params.provider}-session`;

  const { used, size, ...tokens } = extracted.tokens;
  // ACP used/size describe the current context, not tokens consumed by an inference.
  const contextOnly = (used != null || size != null)
    && (tokens.total == null || tokens.total === (used ?? 0))
    && Object.keys(tokens).every(key => key === 'total');
  // Scalar servers replace tokens and cost together, so a partial context cost cannot safely update the row.
  if (contextOnly) return null;
  const cost = normalizeCostMap((params.body as Record<string, unknown>).cost);
  const total = typeof tokens.total === 'number' ? tokens.total : 0;
  return {
    key,
    sessionId: params.sessionId,
    tokens: { ...tokens, total },
    cost,
  };
}
