import * as React from 'react';
import { View } from 'react-native';
import { HappierDataMetric, UsageSourceCoverageBody } from '@happier-dev/plugin-ui/presentation';
import type { UsageAnalyticsCoverage } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { addUsageMeasurements } from '@happier-dev/protocol/usage/usageAggregation';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { t } from '@/text';
import { formatTokenCount } from '@/utils/format/usageNumbers';
import { UsageModelPricesLine } from './UsageModelPrices';
import { useUsageRetryCommand } from './usageMountedControls';
import { UsageBodyInsufficient, UsageBodyNoUsage, UsageCoverageLine, UsageShowAllRows, leadingUsageRows, readUsageCoverageGaps,
  usageCoverageDescription, usageCoverageSummary, usagePeriodPhrase, usageSourceTitle, useUsagePluginTheme, type UsageBodyProps } from './usageBodyKit';

const statusKeys = {
  available: 'usage.board.sources.coverageAvailable', partial: 'usage.board.page.factIncomplete',
  unknown: 'usage.board.sources.coverageUnknown', unsupported: 'usage.board.sources.unsupported',
  pending: 'usage.board.page.loading', error: 'usage.board.sources.failed',
} as const;
const captureKeys = {
  measured: 'usage.board.page.sourceKindMeasured', from_logs: 'usage.board.page.sourceKindFromLogs',
  not_added: 'usage.board.page.sourceKindNotAdded',
} as const;

/** Witnessed accounting coverage, never a guessed Agent support table or a second discovery read. */
export function UsageSourceCoverageWidget(props: UsageBodyProps) {
  const theme = useUsagePluginTheme();
  useWidgetFrameBodyCaption(usagePeriodPhrase(props.query));
  const [expanded, setExpanded] = React.useState(false);
  const rows = React.useMemo(() => groupCoverageRows(props.slice.accounting?.coverage?.sources ?? []), [props.slice.accounting]);
  const led = leadingUsageRows(rows, expanded);
  const failed = !!props.slice.accounting && readUsageCoverageGaps(props.slice, ['accounting']).some(gap => gap.status === 'error');
  const description = props.slice.accounting ? usageCoverageDescription(props.slice, ['accounting']) : null;
  const summary = props.slice.accounting ? usageCoverageSummary(props.slice, ['accounting']) : null;
  // The caveat is one compact line; its sources and reasons are one press away (detail on demand), never a paragraph.
  const [detailOpen, setDetailOpen] = React.useState(false);
  const hasMore = !!description && description !== summary;
  const retry = useUsageRetryCommand(props.model.refresh, failed && !!description);
  if (!props.slice.accounting) return <UsageBodyNoUsage slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />;
  return <UsageSourceCoverageBody theme={theme} testID={props.testID} label={t('usage.widgets.usage_source_coverage')}
    columns={[t('usage.widgets.usage_sources'), t('usage.widgets.usage_source_coverage')]} rows={led.rows}
    showAll={<UsageShowAllRows label={t('usage.widgets.usage_source_coverage')} testID={`${props.testID}.showAll`} total={rows.length}
      hidden={led.hidden} expanded={expanded} onToggle={() => setExpanded(value => !value)} />}
    empty={<UsageBodyInsufficient testID={`${props.testID}.unknown`} replacesContent={false} title={t('usage.board.sources.coverageUnknown')} />}
    detail={description ? <View>
      <SurfaceFreshnessLine testID={`${props.testID}.detail`} reason={(detailOpen ? description : summary) || description}
        tone={failed ? 'warning' : 'neutral'}
        {...(failed ? { action: { label: t('common.retry'), onPress: retry } }
          : hasMore ? { action: { label: detailOpen ? t('usage.showLess') : t('common.details'), testID: `${props.testID}.detail.action`,
            onPress: () => setDetailOpen(open => !open) } } : {})} />
    </View> : null} />;
}

/**
 * One capture is read per machine, so a fleet repeats the same source: one row per source with its count, and when its
 * captures differ in status, each status said once with its own count ("Measured · coverage unknown ×35; Measured ·
 * partial history ×43"), never the same source title on several rows (sweep 1110 N8).
 */
function groupCoverageRows(sources: readonly UsageAnalyticsCoverage['sources'][number][]) {
  const groups = new Map<string, { title: string; kinds: Set<string | null>; status: CoverageStatus; count: number }>();
  for (const source of sources) {
    // A source's own title can be a mid-sentence fragment ("usage"); a row opens with a capital.
    const named = usageSourceTitle(source.source);
    const title = `${named.charAt(0).toLocaleUpperCase()}${named.slice(1)}`;
    const status = sourceCoverageStatus(source);
    const group = groups.get(title) ?? { title, kinds: new Set<string | null>(), status, count: 0 };
    group.count += 1;
    group.kinds.add(source.captureKind ?? null);
    if (COVERAGE_STATUS_RANK.indexOf(status) < COVERAGE_STATUS_RANK.indexOf(group.status)) group.status = status;
    groups.set(title, group);
  }
  // One status per row, the most limiting one; how it is captured only when every machine captures it the same way.
  return [...groups.values()].map(({ title, kinds, status, count }) => {
    const kind = kinds.size === 1 ? [...kinds][0] : null;
    return { title, label: [count > 1 ? t('usage.board.page.machinesCount', { count }) : null,
      kind ? t(captureKeys[kind as keyof typeof captureKeys]) : null, t(statusKeys[status])].filter(Boolean).join(' · ') };
  });
}

type CoverageStatus = 'error' | 'unsupported' | 'partial' | 'unknown' | 'pending' | 'available';
const COVERAGE_STATUS_RANK: readonly CoverageStatus[] = ['error', 'unsupported', 'partial', 'unknown', 'pending', 'available'];

/** A capture's one coverage fact: an available source whose history is incomplete or unknown says that instead. */
function sourceCoverageStatus(source: UsageAnalyticsCoverage['sources'][number]): CoverageStatus {
  if (source.status === 'available' && source.historyComplete !== true) return source.historyComplete === false ? 'partial' : 'unknown';
  return source.status;
}

/** The same unpriced population as Cost facts; unknown dollars never become a zero-dollar metric. */
export function UsageUnpricedWidget(props: UsageBodyProps) {
  const theme = useUsagePluginTheme();
  useWidgetFrameBodyCaption(usagePeriodPhrase(props.query));
  if (!props.slice.accounting) return <UsageBodyNoUsage slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />;
  const facts = props.slice.costFactTotals?.filter(fact => fact.kind === 'unpriced');
  const total = facts?.reduce<number | null>((sum, fact) => addUsageMeasurements(sum, fact.tokens.total), facts.length === 0 ? 0 : null);
  return <View testID={`${props.testID}.facts`}>
    <HappierDataMetric theme={theme} testID={`${props.testID}.tokens`} size="stat" showLabel
      label={t('usage.board.sources.unpricedPurpose')} value={total ?? '—'} unit={t('usage.board.page.tokensUnit')}
      valueFormatter={formatTokenCount} caption={total === undefined ? t('usage.board.page.notMeasuredYet')
        : [t('usage.board.page.unpricedCaption'), facts?.some(fact => !fact.complete) ? t('usage.board.page.factIncomplete') : null].filter(Boolean).join(' · ')} />
    <UsageModelPricesLine slice={props.slice} serverId={props.serverId} testID={`${props.testID}.prices`} />
    <UsageCoverageLine slice={props.slice} sources={['accounting']} onRetry={props.model.refresh} testID={`${props.testID}.coverage`} />
  </View>;
}
