import type {
  UsageRecapComposeResult,
  UsageRecapField,
} from '@happier-dev/protocol';
import { t } from '@/text';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import { formatUsageCalendarPeriod } from '@/sync/domains/usage/usageCalendarPresentation';

export type UsageRecapComposed = Extract<
  UsageRecapComposeResult,
  { kind: 'composed' }
>;
export type UsageRecapStyle = UsageRecapComposed['style'];
export type UsageRecapFormat = UsageRecapComposed['format'];

type MoneyKind = NonNullable<
  UsageRecapComposed['facts']['dollars']
>['facts'][number]['kind'];
export type UsageStatCardStat = Readonly<{
  id:
    | 'activeDays'
    | 'streak'
    | 'agentHours'
    | 'maximumConcurrency'
    | 'linkedOutcomes'
    | 'cacheShare'
    | 'nightActivity'
    | 'coachFindings'
    | 'dollars';
  value: string;
  label: string;
}>;
export type UsageStatCardMixRow = Readonly<{
  id: string;
  share: number;
  label: string | null;
}>;

/**
 * What a private stat card shows, derived only from the composed selected-field result. Every style
 * and format draws this one model; a fact that was not selected (or not witnessed) is simply absent.
 */
export type UsageStatCardModel = Readonly<{
  style: UsageRecapStyle;
  format: UsageRecapFormat;
  /** The exact selected-field manifest the result was composed with. */
  manifest: readonly UsageRecapField[];
  unavailable: readonly UsageRecapField[];
  headline: Readonly<{ value: string; unit: string }> | null;
  /** Agent mix when selected, else model mix; names only when Names was selected. */
  mix: readonly UsageStatCardMixRow[];
  stats: readonly UsageStatCardStat[];
  /** Day activity for art that draws the rhythm (Skyline, Terminal); counts only. */
  days: readonly number[];
  period: UsageRecapComposed['period'];
  periodLabel: string;
  asOfMs: number | null;
}>;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MONEY_ORDER: readonly MoneyKind[] = [
  'invoice',
  'reported',
  'estimated',
  'api_equivalent',
  'unpriced',
];

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(Math.round(value));
}

/** "Jul 1 – Sep 30, 2026" in the composed calendar (its fixed offset), never the viewer's clock. */
export function formatUsageRecapPeriod(
  period: UsageRecapComposed['period'],
): string {
  return formatUsageCalendarPeriod(period);
}

function mixRows(
  rows: NonNullable<UsageRecapComposed['facts']['agentMix']>,
  named: boolean,
): UsageStatCardMixRow[] {
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  if (total <= 0) return [];
  return rows
    .filter((row) => row.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map((row, index) => ({
      id: `mix-${index}`,
      share: row.tokens / total,
      label: named ? (row.name ?? null) : null,
    }));
}

export function buildUsageStatCardModel(
  result: UsageRecapComposed,
): UsageStatCardModel {
  const { facts } = result;
  const selected = new Set(result.selectedFields);
  const stats: UsageStatCardStat[] = [];
  if (facts.activeDays !== undefined)
    stats.push({
      id: 'activeDays',
      value: formatCount(facts.activeDays),
      label: t('usage.board.recap.statActiveDays'),
    });
  if (facts.streak)
    stats.push({
      id: 'streak',
      value: t('usage.board.recap.daysValue', {
        count: facts.streak.longestDays,
      }),
      label: t('usage.board.recap.statStreak'),
    });
  if (facts.parallel) {
    stats.push({
      id: 'agentHours',
      value: `${formatCount(facts.parallel.sumAgentMs / HOUR_MS)} h`,
      label: t('usage.board.recap.statAgentHours'),
    });
    stats.push({
      id: 'maximumConcurrency',
      value: formatCount(facts.parallel.maximumConcurrency),
      label: t('usage.board.recap.statAtOnce'),
    });
  }
  if (facts.work)
    stats.push({
      id: 'linkedOutcomes',
      value: formatCount(facts.work.linkedOutcomes),
      label: t('usage.board.recap.statLinkedOutcomes'),
    });
  if (facts.cache && facts.tokens && facts.tokens.total > 0) {
    stats.push({
      id: 'cacheShare',
      value: `${Math.round((facts.cache.readTokens / facts.tokens.total) * 100)}%`,
      label: t('usage.board.recap.statCacheRead'),
    });
  }
  if (facts.night?.recordedActivityCount != null) {
    stats.push({
      id: 'nightActivity',
      value: formatCount(facts.night.recordedActivityCount),
      label: t('usage.board.recap.statNight'),
    });
  }
  if (facts.coach)
    stats.push({
      id: 'coachFindings',
      value: formatCount(facts.coach.findings.length),
      label: t('usage.board.recap.statCoach'),
    });
  if (facts.dollars) {
    // Each money truth stays its own kind; nothing is summed or repriced here.
    for (const kind of MONEY_ORDER) {
      for (const fact of facts.dollars.facts.filter(
        (row) => row.kind === kind,
      )) {
        stats.push({
          id: 'dollars',
          label: t(`usage.board.recap.money_${kind}`),
          value:
            fact.amountUsd === null
              ? t('usage.board.recap.tokensValue', {
                  value: formatTokenCount(fact.tokens.total),
                })
              : formatUsageCost(fact.amountUsd, fact.currency),
        });
      }
    }
  }
  const mixSource = facts.agentMix ?? facts.modelMix;
  const days = facts.rhythm?.calendarDays.map((day) => day.eventCount) ?? [];
  return {
    style: result.style,
    format: result.format,
    manifest: result.selectedFields,
    unavailable: result.unavailableFields,
    headline: facts.tokens
      ? {
          value: formatTokenCount(facts.tokens.total),
          unit: t('usage.board.recap.tokensUnit'),
        }
      : null,
    mix: mixSource ? mixRows(mixSource, selected.has('names')) : [],
    stats,
    days,
    period: result.period,
    periodLabel: formatUsageRecapPeriod(result.period),
    asOfMs: result.asOfMs,
  };
}

/** Whole days the composed period covers (used by art that lays out a calendar). */
export function usageRecapPeriodDays(
  period: UsageRecapComposed['period'],
): number {
  return Math.max(1, Math.round((period.endMs - period.startMs) / DAY_MS));
}
