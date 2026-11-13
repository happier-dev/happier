import type { ProviderAccountUsageDaySummaryV1 } from '@happier-dev/protocol/connect/providerAccountUsageDaySummary';
import { getProviderAccountUsageQuotaPageFactsV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { deriveQuotaMeterValues } from '@/sync/domains/connectedServices/deriveQuotaUtilizationPct';
import type { UsagePlanAccount } from './usagePlansModel';

type WindowFact = ProviderAccountUsageDaySummaryV1['windows'][number];

export type UsageDailyQuotaHistorySeries = Readonly<{
  key: string;
  account: UsagePlanAccount;
  meterId: string;
  label: string;
  unit: WindowFact['lastSnapshot']['meters'][number]['unit'];
  measure: 'amount' | 'percent';
  days: readonly Readonly<{
    dayStartAtMs: number;
    last: number | null;
    peak: number | null;
    windows: readonly WindowFact[];
  }>[];
}>;

/** Present canonical day facts. Counters from separate allowance windows are never added. */
export function projectUsageDailyQuotaHistory(accounts: readonly UsagePlanAccount[]): UsageDailyQuotaHistorySeries[] {
  const groups = new Map<string, {
    account: UsagePlanAccount; meterId: string; label: string; unit: UsageDailyQuotaHistorySeries['unit'];
    hasAmounts: boolean; days: Map<number, WindowFact[]>;
  }>();
  for (const account of accounts) {
    const facts = account.read && getProviderAccountUsageQuotaPageFactsV1(account.read)?.dayQuotaHistory;
    for (const day of facts ?? []) for (const window of day.windows) {
      const meter = window.lastSnapshot.meters[0]!;
      const key = JSON.stringify([account.key, window.meterId, meter.unit]);
      let group = groups.get(key);
      if (!group) {
        group = { account, meterId: window.meterId, label: meter.label, unit: meter.unit, hasAmounts: false, days: new Map() };
        groups.set(key, group);
      }
      group.hasAmounts ||= meter.used !== null || window.peakUsed !== null;
      const windows = group.days.get(day.dayStartAtMs);
      if (windows) windows.push(window);
      else group.days.set(day.dayStartAtMs, [window]);
    }
  }
  return [...groups].map(([key, group]): UsageDailyQuotaHistorySeries => ({
    key, account: group.account, meterId: group.meterId, label: group.label, unit: group.unit,
    measure: group.hasAmounts ? 'amount' : 'percent',
    days: [...group.days].sort(([left], [right]) => left - right).map(([dayStartAtMs, windows]) => {
      const latest = windows.reduce((last, window) => window.lastObservedAtMs > last.lastObservedAtMs
        || window.lastObservedAtMs === last.lastObservedAtMs && window.lastSnapshot.fetchedAtMs > last.lastSnapshot.fetchedAtMs
        ? window : last);
      const values = deriveQuotaMeterValues(latest.lastSnapshot.meters[0]!);
      return { dayStartAtMs, windows, last: group.hasAmounts ? values.used : values.usedPct,
        // A raw peak cannot become a percentage against the last reading's possibly changed limit.
        // Percentage-only meters retain the last reported share and an explicitly unknown peak.
        peak: group.hasAmounts ? windows.reduce<number | null>((peak, window) => window.peakUsed === null ? peak
          : peak === null ? window.peakUsed : Math.max(peak, window.peakUsed), null) : null };
    }),
  }));
}
