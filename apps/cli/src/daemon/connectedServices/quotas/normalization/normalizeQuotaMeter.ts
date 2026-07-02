import type { ProviderLimitCategory } from './classifyProviderLimitEvidence';

export type NormalizedQuotaMeter = Readonly<{
  meterId: string;
  label: string;
  limitCategory: ProviderLimitCategory;
  remainingPct: number | null;
  utilizationPct: number | null;
  resetAtMs: number | null;
  providerLimitId: string | null;
  reliable: boolean;
  applicable: boolean;
}>;

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeQuotaMeter(input: Readonly<{
  meterId: unknown;
  label: unknown;
  limitCategory?: ProviderLimitCategory;
  remainingPct?: unknown;
  utilizationPct?: unknown;
  used?: unknown;
  limit?: unknown;
  resetAtMs?: unknown;
  providerLimitId?: unknown;
  reliable?: boolean;
  applicable?: boolean;
}>): NormalizedQuotaMeter {
  const explicitRemainingPct = finiteNumber(input.remainingPct);
  const utilizationPct = finiteNumber(input.utilizationPct);
  const used = finiteNumber(input.used);
  const limit = finiteNumber(input.limit);
  const derivedRemainingPct =
    explicitRemainingPct !== null
      ? explicitRemainingPct
      : utilizationPct !== null
      ? 100 - utilizationPct
      : used !== null && limit !== null && limit > 0
      ? ((limit - used) / limit) * 100
      : null;
  const normalizedUtilizationPct =
    utilizationPct !== null
      ? clampPct(utilizationPct)
      : derivedRemainingPct !== null
      ? clampPct(100 - derivedRemainingPct)
      : null;

  return {
    meterId: normalizeString(input.meterId) ?? 'unknown',
    label: normalizeString(input.label) ?? normalizeString(input.meterId) ?? 'Unknown',
    limitCategory: input.limitCategory ?? 'usage_limit',
    remainingPct: derivedRemainingPct === null ? null : clampPct(derivedRemainingPct),
    utilizationPct: normalizedUtilizationPct,
    resetAtMs: finiteNumber(input.resetAtMs),
    providerLimitId: normalizeString(input.providerLimitId),
    reliable: input.reliable ?? derivedRemainingPct !== null,
    applicable: input.applicable ?? true,
  };
}
