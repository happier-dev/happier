export type QuotaUtilizationMeterLike = Readonly<{
  used: number | null;
  limit: number | null;
  utilizationPct: number | null;
  usedPct?: number | null;
  remainingPct?: number | null;
}>;

export function clampQuotaPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function deriveQuotaUtilizationPct(meter: QuotaUtilizationMeterLike): number | null {
  if (typeof meter.utilizationPct === 'number' && Number.isFinite(meter.utilizationPct)) {
    return clampQuotaPct(meter.utilizationPct);
  }

  if (typeof meter.usedPct === 'number' && Number.isFinite(meter.usedPct)) {
    return clampQuotaPct(meter.usedPct);
  }

  if (typeof meter.remainingPct === 'number' && Number.isFinite(meter.remainingPct)) {
    return clampQuotaPct(100 - meter.remainingPct);
  }

  if (
    typeof meter.used === 'number' &&
    typeof meter.limit === 'number' &&
    Number.isFinite(meter.used) &&
    Number.isFinite(meter.limit) &&
    meter.limit > 0
  ) {
    return clampQuotaPct((meter.used / meter.limit) * 100);
  }

  return null;
}
