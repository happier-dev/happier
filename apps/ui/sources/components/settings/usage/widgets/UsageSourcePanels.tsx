import * as React from 'react';
import { View } from 'react-native';
import { HappierDataMetric, UsageSourceCoverageBody } from '@happier-dev/plugin-ui/presentation';
import type { UsageAnalyticsCoverage } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { t } from '@/text';
import { formatTokenCount } from '@/utils/format/usageNumbers';
import { UsageModelPricesLine } from './UsageModelPrices';
import { useUsageRetryCommand } from './usageMountedControls';
import { UsageBodyInsufficient, UsageBodyNoUsage, UsageCoverageLine, UsageShowAllRows, leadingUsageRows, readUsageCoverageGaps,
  usageCoverageDescription, usagePeriodPhrase, usageSourceTitle, useUsagePluginTheme, type UsageBodyProps } from './usageBodyKit';

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
  const retry = useUsageRetryCommand(props.model.refresh, failed && !!description);
  if (!props.slice.accounting) return <UsageBodyNoUsage slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />;
  return <UsageSourceCoverageBody theme={theme} testID={props.testID} label={t('usage.widgets.usage_source_coverage')}
    columns={[t('usage.widgets.usage_sources'), t('usage.widgets.usage_source_coverage')]} rows={led.rows}
    showAll={<UsageShowAllRows label={t('usage.widgets.usage_source_coverage')} testID={`${props.testID}.showAll`} total={rows.length}
      hidden={led.hidden} expanded={expanded} onToggle={() => setExpanded(value => !value)} />}
    empty={<UsageBodyInsufficient testID={`${props.testID}.unknown`} replacesContent={false} title={t('usage.board.sources.coverageUnknown')} />}
    detail={description ? <SurfaceFreshnessLine testID={`${props.testID}.detail`} reason={description} tone={failed ? 'warning' : 'neutral'}
      {...(failed ? { action: { label: t('common.retry'), onPress: retry } } : {})} /> : null} />;
}

/** One capture is read per machine, so a fleet repeats the same source and status: said once with its count. */
function groupCoverageRows(sources: readonly UsageAnalyticsCoverage['sources'][number][]) {
  const groups = new Map<string, { title: string; label: string; count: number }>();
  for (const source of sources) {
    // A source's own title can be a mid-sentence fragment ("usage"); a row opens with a capital.
    const named = usageSourceTitle(source.source);
    const title = `${named.charAt(0).toLocaleUpperCase()}${named.slice(1)}`;
    const label = sourceCoverageLabel(source);
    const key = `${title}\u0000${label}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { title, label, count: 1 });
  }
  return [...groups.values()];
}

function sourceCoverageLabel(source: UsageAnalyticsCoverage['sources'][number]): string {
  return [source.captureKind ? t(captureKeys[source.captureKind]) : null, t(statusKeys[source.status]),
    source.status === 'available' && source.historyComplete !== true
      ? t(source.historyComplete === false ? 'usage.board.page.factIncomplete' : 'usage.board.sources.coverageUnknown') : null].filter(Boolean).join(' · ');
}

/** The same unpriced population as Cost facts; unknown dollars never become a zero-dollar metric. */
export function UsageUnpricedWidget(props: UsageBodyProps) {
  const theme = useUsagePluginTheme();
  useWidgetFrameBodyCaption(usagePeriodPhrase(props.query));
  if (!props.slice.accounting) return <UsageBodyNoUsage slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />;
  const facts = props.slice.costFactTotals?.filter(fact => fact.kind === 'unpriced');
  const total = facts?.reduce((sum, fact) => sum + fact.tokens.total, 0);
  return <View testID={`${props.testID}.facts`}>
    <HappierDataMetric theme={theme} testID={`${props.testID}.tokens`} size="stat" showLabel
      label={t('usage.board.sources.unpricedPurpose')} value={total ?? '—'} unit={t('usage.board.page.tokensUnit')}
      valueFormatter={formatTokenCount} caption={total === undefined ? t('usage.board.page.notMeasuredYet')
        : [t('usage.board.page.unpricedCaption'), facts?.some(fact => !fact.complete) ? t('usage.board.page.factIncomplete') : null].filter(Boolean).join(' · ')} />
    <UsageModelPricesLine slice={props.slice} serverId={props.serverId} testID={`${props.testID}.prices`} />
    <UsageCoverageLine slice={props.slice} sources={['accounting']} onRetry={props.model.refresh} testID={`${props.testID}.coverage`} />
  </View>;
}
