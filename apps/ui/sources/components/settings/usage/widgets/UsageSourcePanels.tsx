import * as React from 'react';
import { View } from 'react-native';
import { areSameAgentRoutingIdentity } from '@happier-dev/agents';
import { HappierDataMetric, UsageSourceCoverageBody } from '@happier-dev/plugin-ui/presentation';
import type { UsageAnalyticsCoverage } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { addUsageMeasurements } from '@happier-dev/protocol/usage/usageAggregation';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { usageSourceAgentId } from '@/sync/domains/usage/usageLabels';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { t } from '@/text';
import { formatTokenCount } from '@/utils/format/usageNumbers';
import { resolveUsageMeasuredTokens } from '@/sync/api/account/usageMeasuredTokens';
import { UsageModelPricesLine } from './UsageModelPrices';
import { useUsageRetryCommand } from './usageMountedControls';
import { UsagePlanDisclosure, usePlanText } from './plans/UsagePlanParts';
import { Text } from '@/components/ui/text/Text';
import { StyleSheet } from 'react-native-unistyles';
import { UsageBodyInsufficient, UsageBodyNoUsage, UsageCoverageLine, UsageShowAllRows, leadingUsageRows, readUsageCoverageGaps, usagePartialHistoryLabel,
  usageCoverageDescription, usageCoverageSummary, usagePeriodPhrase, usageSourceTitle, useUsagePluginTheme, type UsageBodyProps } from './usageBodyKit';

const statusKeys = {
  available: 'usage.board.sources.coverageAvailable', partial: 'usage.board.page.factIncomplete',
  unknown: 'usage.board.sources.coverageUnknown', unsupported: 'usage.board.sources.unsupported',
  pending: 'usage.board.page.loading', error: 'usage.board.sources.failed',
} as const;
/** Witnessed accounting coverage, never a guessed Agent support table or a second discovery read. */
export function UsageSourceCoverageWidget(props: UsageBodyProps) {
  const theme = useUsagePluginTheme();
  const text = usePlanText();
  useWidgetFrameBodyCaption(usagePeriodPhrase(props.query));
  const [expanded, setExpanded] = React.useState(false);
  const failed = !!props.slice.accounting && readUsageCoverageGaps(props.slice, ['accounting']).some(gap => gap.status === 'error');
  const description = props.slice.accounting ? usageCoverageDescription(props.slice, ['accounting']) : null;
  const summary = props.slice.accounting ? usageCoverageSummary(props.slice, ['accounting']) : null;
  const { rows, shared } = React.useMemo(() => groupCoverageRows(props.slice.accounting?.coverage?.sources ?? []),
    [props.slice.accounting]);
  const led = leadingUsageRows(rows, expanded);
  // Which captures each Agent's usage comes from is secondary detail: one disclosure under the rows, reachable by
  // pointer, touch and keyboard and spoken, never a second line on each row (review J-B15).
  const captured = rows.filter(row => row.captures);
  // The caveat is one compact line; its sources and reasons are one press away (detail on demand), never a paragraph.
  const [detailOpen, setDetailOpen] = React.useState(false);
  const hasMore = !!description && description !== summary;
  const retry = useUsageRetryCommand(props.model.refresh, failed && !!description);
  // A status every row shares is said once, on the line right under the rows (so a single row still shows it there),
  // never again on each row; the range caveat already says "Partial history" when that is the shared status.
  const sharedSaid = shared === null || (shared === 'partial' && summary === usagePartialHistoryLabel()) ? null : coverageStatusLabel(shared);
  const caveat = description ? (detailOpen ? description : summary) || description : '';
  const line = [sharedSaid, caveat].filter(Boolean).join(' · ');
  if (!props.slice.accounting) return <UsageBodyNoUsage slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />;
  return <UsageSourceCoverageBody theme={theme} testID={props.testID} label={t('usage.widgets.usage_source_coverage')}
    columns={[t('usage.widgets.usage_sources'), t('usage.widgets.usage_source_coverage')]} rows={led.rows.map(({ title, label }) => ({ title, label }))}
    showAll={<UsageShowAllRows label={t('usage.widgets.usage_source_coverage')} testID={`${props.testID}.showAll`} total={rows.length}
      hidden={led.hidden} expanded={expanded} onToggle={() => setExpanded(value => !value)} />}
    empty={<UsageBodyInsufficient testID={`${props.testID}.unknown`} replacesContent={false} title={t('usage.board.sources.coverageUnknown')} />}
    detail={line || captured.length ? <View style={styles.detail}>
      {line ? <SurfaceFreshnessLine testID={`${props.testID}.detail`} reason={line}
        tone={failed ? 'warning' : 'neutral'}
        {...(failed && description ? { action: { label: t('common.retry'), onPress: retry } }
          : hasMore ? { action: { label: detailOpen ? t('usage.showLess') : t('common.details'), testID: `${props.testID}.detail.action`,
            onPress: () => setDetailOpen(open => !open) } } : {})} /> : null}
      {captured.length ? <UsagePlanDisclosure title={t('usage.board.sources.capturesTitle')} testID={`${props.testID}.captures`}>
        {captured.map(row => <Text key={row.title} style={[styles.capture, text.detail]} testID={`${props.testID}.captures.row`}>
          {`${row.title}: ${row.captures}`}</Text>)}
      </UsagePlanDisclosure> : null}
    </View> : null} />;
}

type CoverageGroup = { agentId: string | null; title: string; captures: Set<string>;
  status: CoverageStatus; machines: Set<string>; unbound: boolean };

/**
 * Coverage shows one row per Agent (its routing identity, through the source's declaration; the title is display
 * only). Captures that name no Agent are one row, last, "Agent not reported", their names behind the same disclosure
 * as every other row's. Several capture paths can share an Agent and a Machine.
 */
function groupCoverageRows(sources: readonly UsageAnalyticsCoverage['sources'][number][]) {
  const groups: CoverageGroup[] = [];
  let unattributed: CoverageGroup | null = null;
  for (const source of sources) {
    const agentId = usageSourceAgentId(source.source);
    const status = sourceCoverageStatus(source);
    let group = agentId === null ? unattributed
      : groups.find(row => row.agentId !== null && areSameAgentRoutingIdentity(row.agentId, agentId));
    if (!group) {
      group = { agentId, title: agentId === null ? t('usage.board.page.agentNotReported') : sentence(usageSourceTitle(source.source, undefined, 'coverage')),
        captures: new Set(), status, machines: new Set(), unbound: false };
      if (agentId === null) unattributed = group;
      else groups.push(group);
    }
    group.captures.add(agentId === null ? sentence(usageSourceTitle(source.source, undefined, 'coverage')) : usageSourceTitle(source.source));
    if (source.machineId) group.machines.add(source.machineId);
    else group.unbound = true;
    if (COVERAGE_STATUS_RANK.indexOf(status) < COVERAGE_STATUS_RANK.indexOf(group.status)) group.status = status;
  }
  if (unattributed) groups.push(unattributed);
  // One status per row, the most limiting one. When every row has the same one it is said once, under the rows.
  const shared = groups.length && groups.every(group => group.status === groups[0]!.status) ? groups[0]!.status : null;
  return {
    shared,
    rows: groups.map(({ title, captures, status, machines, unbound }) => ({
      title,
      label: [shared ? null : coverageStatusLabel(status),
        !unbound && machines.size > 1 ? t('usage.board.page.machinesCount', { count: machines.size }) : null].filter(Boolean).join(' · '),
      ...(captures.size > 0 ? { captures: [...captures].join(', ') } : {}),
    })),
  };
}

/** A source's own title can be a mid-sentence fragment ("usage"); a row or a list line opens with a capital. */
function sentence(text: string): string {
  return `${text.charAt(0).toLocaleUpperCase()}${text.slice(1)}`;
}

/** Every status in one casing; it leads the row's line, so it opens with a capital like the range caveat. */
function coverageStatusLabel(status: CoverageStatus): string {
  return status === 'partial' ? usagePartialHistoryLabel() : sentence(t(statusKeys[status]));
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
  const measured = facts?.map(fact => resolveUsageMeasuredTokens(fact.tokens));
  const total = measured?.reduce<number | null>((sum, tokens) => addUsageMeasurements(sum, tokens.total), measured.length === 0 ? 0 : null);
  return <View testID={`${props.testID}.facts`}>
    <HappierDataMetric theme={theme} testID={`${props.testID}.tokens`} size="stat" showLabel
      label={t('usage.board.sources.unpricedPurpose')} value={total ?? '—'} unit={t('usage.board.page.tokensUnit')}
      valueFormatter={formatTokenCount} caption={total === undefined ? t('usage.board.page.notMeasuredYet')
        : [t('usage.board.page.unpricedCaption'), measured?.some(tokens => tokens.fromParts) ? t('usage.board.page.tokensFromParts') : null,
          facts?.some(fact => !fact.complete) ? t('usage.board.page.factIncomplete') : null].filter(Boolean).join(' · ')} />
    <UsageModelPricesLine slice={props.slice} serverId={props.serverId} testID={`${props.testID}.prices`} />
    <UsageCoverageLine slice={props.slice} sources={['accounting']} onRetry={props.model.refresh} testID={`${props.testID}.coverage`} />
  </View>;
}

const styles = StyleSheet.create((theme) => ({
  capture: { color: theme.colors.text.secondary },
  detail: { gap: theme.space.s8 },
}));
