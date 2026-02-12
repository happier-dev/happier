import { extractTokensFromAcpTokenCountMessage } from '@/api/session/acpTokenCountUsage';

function asFiniteNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeTokenCountCostForForwarding(raw: unknown): { total: number; [key: string]: number } | null {
  if (raw == null) return null;

  const direct = asFiniteNonNegativeNumber(raw);
  if (direct != null) {
    const out = Object.create(null) as Record<string, number>;
    out.total = direct;
    return out as { total: number; [key: string]: number };
  }

  const record = asRecord(raw);
  if (!record) return null;
  const out = Object.create(null) as Record<string, number>;

  let added = 0;
  for (const [key, value] of Object.entries(record)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (key.trim().length === 0 || key.length > 64) continue;
    const num = asFiniteNonNegativeNumber(value);
    if (num == null) continue;
    out[key] = num;
    added++;
    if (added >= 20) break;
  }

  if (added === 0) return null;

  if (out.total == null) {
    const total = Object.entries(out)
      .filter(([k]) => k !== 'total')
      .reduce((acc, [, v]) => acc + v, 0);
    out.total = total;
  }

  return out as { total: number; [key: string]: number };
}

function clampTokenCountTokensForForwarding(tokens: Record<string, number>): Record<string, number> {
  const MAX_KEYS = 32;
  const out = Object.create(null) as Record<string, number>;
  let count = 0;

  const priority: ReadonlyArray<string> = ['total', 'input', 'output', 'cache_creation', 'cache_read', 'thought'];
  for (const key of priority) {
    const value = tokens[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      out[key] = value;
      count++;
    }
  }

  const remaining = Object.keys(tokens)
    .filter((k) => !(k in out))
    .filter((k) => k.trim().length > 0 && k.length <= 64 && k !== '__proto__' && k !== 'constructor' && k !== 'prototype')
    .sort();

  for (const key of remaining) {
    if (count >= MAX_KEYS) break;
    const value = tokens[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    out[key] = value;
    count++;
  }

  if (out.total == null) {
    out.total =
      (out.input ?? 0) + (out.output ?? 0) + (out.cache_creation ?? 0) + (out.cache_read ?? 0) + (out.thought ?? 0);
  }

  return out;
}

export function buildTokenCountSessionMessageForForwarding(
  agentMessage: Record<string, unknown>,
): { type: 'token_count'; tokens: Record<string, number>; key?: string; model?: string; cost?: { total: number; [key: string]: number } } | null {
  const extracted = extractTokensFromAcpTokenCountMessage(agentMessage);
  if (!extracted) return null;

  const tokens = clampTokenCountTokensForForwarding(extracted.tokens);
  const key = extracted.key;
  const model = extracted.modelId;
  const cost = normalizeTokenCountCostForForwarding(agentMessage.cost);

  return {
    type: 'token_count',
    tokens,
    ...(key ? { key } : {}),
    ...(model ? { model } : {}),
    ...(cost ? { cost } : {}),
  };
}
