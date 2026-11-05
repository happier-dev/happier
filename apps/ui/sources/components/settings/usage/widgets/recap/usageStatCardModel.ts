import type {
  UsageRecapComposeResult,
  UsageRecapField,
} from '@happier-dev/protocol/usage/usageRecap';
import { t } from '@/text';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import { formatUsageCalendarPeriod } from '@/sync/domains/usage/usageCalendarPresentation';
import { usageAgentTitle } from '@/sync/domains/usage/usageLabels';

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
    | 'mergedPrs'
    | 'cacheShare'
    | 'cacheReadTokens'
    | 'cacheWriteTokens'
    | 'observedPeak'
    | 'highlightOutcomes'
    | 'nightActivity'
    | 'coachFindings'
    | 'dollars';
  value: string;
  label: string;
  /**
   * Money only. `lead` is the selected total; `comparison` is a separate population (not an extra
   * charge) drawn quieter beneath it. Every other fact has no tier.
   */
  tier?: 'lead' | 'comparison';
}>;
export type UsageStatCardMixRow = Readonly<{
  id: string;
  /** Public Agent catalog identity, independent of the private Names selection. */
  agentId?: string;
  share: number;
  label: string | null;
}>;
/** One selected population: public shares can remain useful with its token total hidden. */
export type UsageStatCardMixGroup = Readonly<{
  kind: 'agentMix' | 'modelMix';
  rows: readonly UsageStatCardMixRow[];
  totalTokens: number | null;
}>;

/**
 * What a stat card shows, derived only from the composed selected-field result. Every style
 * and format draws this one model; a fact that was not selected (or not witnessed) is simply absent.
 */
export type UsageStatCardModel = Readonly<{
  style: UsageRecapStyle;
  format: UsageRecapFormat;
  /** The exact selected-field manifest the result was composed with. */
  manifest: readonly UsageRecapField[];
  unavailable: readonly UsageRecapField[];
  headline: Readonly<{ value: string; unit: string }> | null;
  /** Distinct selected populations; render each group, never blend their shares. */
  mixGroups: readonly UsageStatCardMixGroup[];
  stats: readonly UsageStatCardStat[];
  /** Day activity for art that draws the rhythm (Skyline, Terminal); counts only. */
  days: readonly number[];
  period: UsageRecapComposed['period'];
  periodLabel: string;
  asOfMs: number | null;
  sourceSelection?: UsageRecapComposed['sourceSelection'];
  executionCoverage?: UsageRecapComposed['coverage']['execution'];
}>;

const HOUR_MS = 3_600_000;
const MONEY_ORDER: readonly MoneyKind[] = [
  'invoice',
  'estimated',
  'api_equivalent',
  'unpriced',
];

function moneyLabel(kind: MoneyKind | 'mixed'): string {
  if (kind === 'mixed') return t('usage.board.page.costBasisAuto');
  if (kind === 'invoice') return t('usage.board.page.factInvoice');
  return t(`usage.board.recap.money_${kind}`);
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(Math.round(value));
}

/** "Jul 1 – Sep 30, 2026" in the composed calendar (its fixed offset), never the viewer's clock. */
export function formatUsageRecapPeriod(
  period: UsageRecapComposed['period'],
): string {
  return formatUsageCalendarPeriod(period);
}

function mixGroup(
  kind: UsageStatCardMixGroup['kind'],
  rows: NonNullable<UsageRecapComposed['facts']['agentMix']>,
  named: boolean,
): UsageStatCardMixGroup {
  const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
  return {
    kind,
    totalTokens,
    rows: totalTokens <= 0
      ? []
      : rows
          .filter((row) => row.tokens > 0)
          .sort((a, b) => b.tokens - a.tokens)
          .map((row, index) => ({
            id: `${kind}-${index}`,
            share: row.tokens / totalTokens,
            ...(kind === 'agentMix' && row.agentId ? { agentId: row.agentId } : {}),
            label: kind === 'agentMix' && row.agentId ? usageAgentTitle(row.agentId)
              : named ? (row.name ?? null) : null,
          })),
  };
}

export function buildUsageStatCardModel(
  result: UsageRecapComposed,
): UsageStatCardModel {
  if (result.source === 'public_profile' && result.publicSnapshot) {
    const facts = result.publicSnapshot.facts;
    const stats: UsageStatCardStat[] = [];
    if (facts.activeDays !== undefined) stats.push({ id: 'activeDays', value: formatCount(facts.activeDays), label: t('usage.board.recap.statActiveDays') });
    if (facts.bestStreakDays !== undefined) stats.push({ id: 'streak',
      value: t('usage.board.recap.daysValue', { count: facts.bestStreakDays }), label: t('usage.board.recap.statStreak') });
    if (facts.agentTimeMs !== undefined) stats.push({ id: 'agentHours', value: `${formatCount(facts.agentTimeMs / HOUR_MS)} h`, label: t('usage.board.recap.statAgentHours') });
    if (facts.peakParallel !== undefined) stats.push({ id: 'maximumConcurrency', value: formatCount(facts.peakParallel), label: t('usage.board.recap.statAtOnce') });
    if (facts.mergedPrs !== undefined) stats.push({ id: 'mergedPrs', value: formatCount(facts.mergedPrs), label: t('usage.board.recap.statMergedPrs') });
    for (const highlight of facts.highlights ?? []) {
      const id = highlight.kind === 'active_days' ? 'activeDays' : highlight.kind === 'peak_parallel' ? 'maximumConcurrency' : 'mergedPrs';
      if (stats.some(stat => stat.id === id)) continue;
      const label = highlight.kind === 'active_days' ? t('usage.board.recap.statActiveDays')
        : highlight.kind === 'peak_parallel' ? t('usage.board.recap.statAtOnce') : t('usage.board.recap.statMergedPrs');
      stats.push({ id, value: formatCount(highlight.count), label });
    }
    return { style: result.style, format: result.format, manifest: result.selectedFields, unavailable: result.unavailableFields,
      headline: facts.tokens === undefined ? null : { value: formatTokenCount(facts.tokens), unit: t('usage.board.recap.tokensUnit') },
      mixGroups: facts.agentMix ? [{ kind: 'agentMix', totalTokens: facts.tokens ?? null,
        rows: facts.agentMix.map((row, index) => ({ id: `agentMix-${index}`, agentId: row.agentId, share: row.share, label: usageAgentTitle(row.agentId) })) }] : [],
      stats, days: facts.calendar?.map(day => day.level ?? 0) ?? [],
      period: result.period, periodLabel: formatUsageRecapPeriod(result.period), asOfMs: result.asOfMs };
  }
  const { facts } = result;
  const selected = new Set(result.selectedFields);
  const stats: UsageStatCardStat[] = [];
  const moneyStats: UsageStatCardStat[] = [];
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
  if (facts.cache) {
    stats.push({ id: 'cacheReadTokens', value: formatTokenCount(facts.cache.readTokens), label: t('usage.tokenMix.cacheRead') });
    stats.push({ id: 'cacheWriteTokens', value: formatTokenCount(facts.cache.writeTokens), label: t('usage.tokenMix.cacheWrite') });
  }
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
  for (const highlight of facts.highlights ?? []) {
    if (highlight.kind === 'observed_peak') stats.push({ id: 'observedPeak', value: formatTokenCount(highlight.tokens),
      label: t('usage.banner.peakTokens') });
    else if (!facts.work) stats.push({ id: 'highlightOutcomes', value: formatCount(highlight.count), label: t('usage.board.recap.statLinkedOutcomes') });
  }
  if (facts.dollars) {
    const money = facts.dollars.selected;
    // An unknown selected total is absent, never a bare dash: the comparisons below then lead on their own.
    if (money) moneyStats.push({ id: 'dollars', tier: 'lead', value: formatUsageCost(money.amountUsd, money.currency),
      label: `${moneyLabel(money.kind)} · ${money.currency}` });
    // Raw whole reports cannot establish scoped spend. Only the selected owner
    // supplies reported money; other kinds are separate comparison populations.
    for (const kind of MONEY_ORDER) {
      for (const fact of facts.dollars.facts.filter(
        (row) => row.kind === kind && !(money?.kind === kind && money.currency === row.currency),
      )) {
        moneyStats.push({
          id: 'dollars',
          tier: 'comparison',
          label: `${moneyLabel(kind)} · ${fact.currency}`,
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
  const mixGroups = (['agentMix', 'modelMix'] as const).flatMap((kind) => {
    const rows = facts[kind];
    return rows ? [mixGroup(kind, rows, selected.has('names'))] : [];
  });
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
    mixGroups,
    // The selected money and its comparisons come first: the card reads total, then what else was counted.
    stats: [...moneyStats, ...stats],
    days,
    period: result.period,
    periodLabel: formatUsageRecapPeriod(result.period),
    asOfMs: result.asOfMs,
    sourceSelection: result.sourceSelection,
    executionCoverage: result.coverage.execution,
  };
}
