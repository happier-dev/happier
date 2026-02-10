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

  const total = typeof extracted.tokens.total === 'number' ? extracted.tokens.total : 0;
  return {
    key,
    sessionId: params.sessionId,
    tokens: { total, ...extracted.tokens },
    // Token-only telemetry for ACP providers: cost is unknown here.
    cost: { total: 0 },
  };
}

