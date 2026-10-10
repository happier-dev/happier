import * as React from 'react';
import type { PluginUiThemeV1 } from '@happier-dev/plugin-sdk/ui';
import { useUnistyles } from 'react-native-unistyles';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageBuiltinWidgetIdV1 } from '@happier-dev/protocol/widgets';
import type {
  UsageQueryResultSlice,
  UsageQuerySourceState,
} from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import {
  buildUsageAnalyticsViewModel,
  type UsageAnalyticsViewModel,
} from '@/sync/api/account/usageAnalytics';
import { getPreferredLanguage, t, type TranslationKeyNoParams } from '@/text';
import type { UsageAnalyticsCoverage } from '@happier-dev/protocol';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { formatUsageCalendarPeriod } from '@/sync/domains/usage/usageCalendarPresentation';

/** What every Usage body receives from the one dispatcher: admitted facts, never a fetch handle. */
export type UsageBodyProps = Readonly<{
  id: UsageBuiltinWidgetIdV1;
  model: UsageWidgetBodyModel;
  slice: UsageQueryResultSlice;
  /** The query these facts answer (the shown one while a period change settles). */
  query: UsageQuery;
  serverId: string;
  testID: string;
}>;

export function useUsagePluginTheme(): PluginUiThemeV1 {
  const { theme } = useUnistyles();
  return React.useMemo(() => projectPluginUiTheme(theme), [theme]);
}

/** Exact shown dates; a date range does not establish a rolling preset identity. */
export function usagePeriodPhrase(query: Pick<UsageQuery, 'period' | 'timeZoneOffsetMinutes'>): string {
  return formatUsageCalendarPeriod({ ...query.period, timeZoneOffsetMinutes: query.timeZoneOffsetMinutes });
}

// One projection per admitted accounting response and presentation; bodies share it, never rebuild it.
const viewModels = new WeakMap<object, Map<string, UsageAnalyticsViewModel>>();

/** The incumbent UI projection of A facts for this slice (A owns the numbers, this only shapes them). */
export function useUsageAnalyticsView(
  slice: UsageQueryResultSlice,
  query: UsageQuery,
): UsageAnalyticsViewModel | null {
  const accounting = slice.accounting;
  const language = getPreferredLanguage();
  return React.useMemo(() => {
    if (!accounting) return null;
    const key = `${query.metric}\u0000${query.costBasis}\u0000${query.timeZoneOffsetMinutes ?? 0}\u0000${language}`;
    let byKey = viewModels.get(accounting);
    if (!byKey) {
      byKey = new Map();
      viewModels.set(accounting, byKey);
    }
    const cached = byKey.get(key);
    if (cached) return cached;
    const built = buildUsageAnalyticsViewModel(
      accounting,
      // The response already carries the admitted range; the legacy array filter is unused here.
      { period: 'all', metric: query.metric, costMode: query.costBasis, focus: null },
      query.timeZoneOffsetMinutes ?? 0,
    );
    byKey.set(key, built);
    return built;
  }, [
    accounting,
    query.metric,
    query.costBasis,
    query.timeZoneOffsetMinutes,
    language,
  ]);
}

/**
 * A supported, visible result for a fact this query cannot answer yet. It says what is missing and
 * why; it never draws zero.
 */
export function UsageBodyInsufficient(
  props: Readonly<{
    title: string;
    reason?: string;
    testID: string;
    action?: Readonly<{ label: string; onPress: () => void }>;
  }>,
) {
  return (
    <SurfaceStateCard
      testID={props.testID}
      kind="empty"
      layout="inline"
      size="line"
      title={props.title}
      {...(props.reason ? { reason: props.reason } : {})}
      {...(props.action
        ? {
            action: {
              label: props.action.label,
              onPress: props.action.onPress,
            },
          }
        : {})}
    />
  );
}

const SOURCE_LABEL_KEYS: Readonly<
  Record<
    string,
    | 'usage.board.page.sourceAccounting'
    | 'usage.board.page.sourceQuota'
    | 'usage.board.page.sourceWork'
    | 'usage.board.page.sourceHowYouWork'
    | 'usage.board.page.sourceComparison'
  >
> = {
  accounting: 'usage.board.page.sourceAccounting',
  quota: 'usage.board.page.sourceQuota',
  work: 'usage.board.page.sourceWork',
  how_you_work: 'usage.board.page.sourceHowYouWork',
  comparison: 'usage.board.page.sourceComparison',
};
function sourceLabel(source: string): string {
  const key = SOURCE_LABEL_KEYS[source];
  return key ? t(key) : source;
}

const COVERAGE_REASON_KEYS = {
  missing_baseline: 'usage.board.page.coverageReason_missing_baseline',
  counter_discontinuity: 'usage.board.page.coverageReason_counter_discontinuity',
  ambiguous_overlap: 'usage.board.page.coverageReason_ambiguous_overlap',
  unattributed_model: 'usage.board.page.coverageReason_unattributed_model',
  unpriced_tokens: 'usage.board.page.coverageReason_unpriced_tokens',
  unknown_source: 'usage.board.page.coverageReason_unknown_source',
  incomplete_history: 'usage.board.page.coverageReason_incomplete_history',
  ranked_truncation: 'usage.board.page.coverageReason_ranked_truncation',
  unknown_token_categories: 'usage.board.page.coverageReason_unknown_token_categories',
} satisfies Record<UsageAnalyticsCoverage['reasons'][number], TranslationKeyNoParams>;

/** Sources this body depends on that are not complete, worded once under the content. */
export function readUsageCoverageGaps(
  slice: UsageQueryResultSlice,
  sources: readonly string[],
): readonly UsageQuerySourceState[] {
  const accounting = sources.includes('accounting') ? slice.accounting?.coverage : undefined;
  const dependent = new Set([...sources, ...(accounting?.sources.map(source => source.source) ?? [])]);
  const gaps = slice.sources.filter(source => dependent.has(source.source) && source.status !== 'available');
  if (sources.includes('accounting') && slice.accounting && !accounting
    && !gaps.some(source => source.source === 'accounting')) {
    gaps.unshift({ source: 'accounting', status: 'unknown' });
  }
  if (accounting && (accounting.status !== 'complete' || accounting.range.complete !== true || accounting.reasons.length > 0)
    && !gaps.some(source => source.source === 'accounting')) {
    gaps.unshift({ source: 'accounting', status: accounting.status === 'complete' ? 'partial' : accounting.status });
  }
  return gaps;
}

export function UsageCoverageLine(
  props: Readonly<{
    slice: UsageQueryResultSlice;
    sources: readonly string[];
    onRetry?: () => void | Promise<unknown>;
    testID: string;
  }>,
) {
  const gaps = readUsageCoverageGaps(props.slice, props.sources);
  if (gaps.length === 0) return null;
  const failed = gaps.some((gap) => gap.status === 'error');
  const pending = gaps.every(
    (gap) => gap.status === 'pending' || gap.status === 'not_loaded',
  );
  const names = gaps.map((gap) => gap.status === 'unsupported'
    ? `${sourceLabel(gap.source)} (${t('usage.board.sources.unsupported')})` : sourceLabel(gap.source)).join(', ');
  const accountingReasons = props.sources.includes('accounting')
    ? [...new Set(props.slice.accounting?.coverage?.reasons ?? [])].map(reason => t(COVERAGE_REASON_KEYS[reason])) : [];
  const statusReason = failed
    ? t('usage.board.page.coverageFailed', { sources: names })
    : pending ? t('usage.board.page.coveragePending', { sources: names })
      : t('usage.board.page.coveragePartial', { sources: names });
  const asOf = gaps.reduce<number | null>(
    (oldest, gap) =>
      gap.asOfMs === undefined
        ? oldest
        : oldest === null
          ? gap.asOfMs
          : Math.min(oldest, gap.asOfMs),
    null,
  );
  return (
    <SurfaceFreshnessLine
      testID={props.testID}
      asOf={asOf}
      busy={pending}
      tone={failed ? 'warning' : 'neutral'}
      reason={[statusReason, ...accountingReasons].join(' · ')}
      {...(failed && props.onRetry
        ? { action: { label: t('common.retry'), onPress: props.onRetry } }
        : {})}
    />
  );
}

const agentEntries = new Map<string, ReturnType<typeof resolveAgentCatalogProjection>>();
function readAgentEntry(agentId: string) {
    let entry = agentEntries.get(agentId);
    if (!entry) { entry = resolveAgentCatalogProjection(agentId, { enabledAgentIds: [] }); agentEntries.set(agentId, entry); }
    return entry;
}

/** An Agent's catalog title ("Claude Code"); unknown or unattributed ids keep their own words. */
export function usageAgentTitle(agentId: string, fallback?: string): string {
    if (!agentId || agentId === 'unknown') return fallback || t('usage.board.page.unattributed');
    try { return readAgentEntry(agentId).title || fallback || agentId; } catch { return fallback || agentId; }
}

/** The Agent's catalog mark, standing on its own (no tile), in ink. */
export function UsageAgentMark(props: Readonly<{ agentId: string; serverId: string | null; size?: number; color?: string }>) {
    const entry = React.useMemo(() => { try { return readAgentEntry(props.agentId); } catch { return null; } }, [props.agentId]);
    if (!entry) return null;
    return <AgentCatalogIdentityIcon entry={entry} machineId={null} serverId={props.serverId} current={false}
        size={props.size ?? ICON_SIZE.sm} {...(props.color ? { color: props.color } : {})} />;
}
