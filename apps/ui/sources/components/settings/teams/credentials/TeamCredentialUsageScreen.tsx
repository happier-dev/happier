import * as React from 'react';
import type {
    TeamCredentialUsageBreakdownDimensionV1,
    TeamCredentialUsageLimitV1,
    TeamCredentialUsageQueryInputV1,
} from '@happier-dev/protocol/teams';

import { StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { usageSeriesFrame, usageSeriesTooltip, usageSeriesValueFormatter, useUsageSeriesMotion, usageVolumeLens } from '@/components/settings/usage/usageSeriesPresentation';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useTeamCredentialUsage, useTeamCredentialUsageWriteRefresh } from '@/hooks/teams/useTeamCredentialResources';
import { useTeamGroups } from '@/hooks/teams/useTeamGroups';
import { useTeamMembersRoster } from '@/hooks/teams/useTeamMembersRoster';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import {
    resolveAvailableCostModes,
    resolveDisplayCost,
    type UsageCostMode,
} from '@/sync/api/account/usageAnalytics';
import {
    getUsagePeriodDefinition,
    resolveUsagePeriodStartTimeSeconds,
    USAGE_PERIODS,
    type UsagePeriod,
} from '@/sync/api/account/usagePeriods';
import { t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { formatTokenCountLong, formatUsageCost } from '@/utils/format/usageNumbers';

import { TeamSection } from '../TeamSection';
import type { TeamSectionContext } from '../teamSectionContext';
import {
    credentialFailureMessage,
    formatLimitResetUtc,
    limitMetricLabel,
    limitPeriodLabel,
    limitReached,
    limitSubjectLine,
    offeredTeamCredentialUsageBreakdowns,
    orderTeamCredentialLimitsByRemaining,
    usageBreakdownLabel,
    usageRequestMetricLabel,
} from './teamCredentialPresentation';
import { exportTeamCredentialUsageCsv } from './teamCredentialUsageExport';
import { useTeamCredentialResourceView } from './useTeamCredentialResourceView';

/**
 * Labels for the metrics the shared usage chart can draw. Request points are
 * offered only when the Home's coverage projection says the count is usable.
 */
type UsageVolumeMetric = 'tokens' | 'cost' | 'requests';
function metricLabel(metric: UsageVolumeMetric): string {
    if (metric === 'requests') return t('teams.credentials.limits.metric.requests');
    return metric === 'tokens' ? t('usage.tokens') : t('usage.cost');
}

const COST_MODE_LABEL_KEYS = {
    auto: 'usage.auto',
    reported: 'usage.reported',
    estimated: 'usage.estimated',
} as const satisfies Record<UsageCostMode, string>;

/**
 * Which kind of cost a total is. An estimate and a Provider-reported amount can
 * be the same number, so the amount alone does not say which one a reader is
 * looking at; the automatic mode sums each event's own best fact and may mix
 * both.
 */
function costProvenanceLabel(
    cost: Readonly<{ reportedUsd: number; estimatedUsd: number }>,
    mode: UsageCostMode,
): string | undefined {
    if (mode !== 'auto') return t(COST_MODE_LABEL_KEYS[mode]);
    if (cost.reportedUsd > 0 && cost.estimatedUsd > 0) {
        return `${t('usage.reported')} + ${t('usage.estimated')}`;
    }
    if (cost.reportedUsd > 0) return t('usage.reported');
    if (cost.estimatedUsd > 0) return t('usage.estimated');
    return undefined;
}

function seriesBucketLabel(timestampSeconds: number, period: UsagePeriod): string {
    const date = new Date(timestampSeconds * 1000);
    const granularity = getUsagePeriodDefinition(period).granularity;
    return formatWithCachedDateTimeFormatter(
        date,
        undefined,
        granularity === 'hour'
            ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
            : granularity === 'month'
                ? { month: 'short', year: 'numeric' }
                : { month: 'short', day: 'numeric' },
    );
}

/**
 * Recorded usage for one shared credential.
 *
 * Period, granularity, metric, cost resolution, the volume chart and the export
 * file all come from the account usage owners rather than from a second copy
 * here: the same events must not read differently on two screens. What this
 * composition adds is the resource scope — who may see which dimension, and how
 * honestly a request count can be named for this resource's delivery routes.
 *
 * The Home owns every number, including how complete it is. Nothing on this
 * screen adds, estimates or zero-fills: an absent cost is reported as absent
 * rather than as nothing spent, and direct delivery — which happens outside
 * Happier entirely — is named as missing from the totals instead of being
 * quietly folded into them.
 */
const CredentialUsage = React.memo(function CredentialUsage(props: Readonly<{
    context: TeamSectionContext;
    resourceId: string;
}>) {
    const { context, resourceId } = props;
    const view = useTeamCredentialResourceView({ context, resourceId });
    const resource = view.resource;
    const catalogResource = view.catalogResource;

    const { theme } = useUnistyles();
    const [period, setPeriod] = React.useState<UsagePeriod>('30days');
    const [metric, setMetric] = React.useState<UsageVolumeMetric>('tokens');
    const [breakdown, setBreakdown] = React.useState<TeamCredentialUsageBreakdownDimensionV1 | null>(null);
    // The same cost modes the personal usage dashboard offers. The Home resolves
    // the effective cost under the chosen mode, so the request, its cursor and
    // any export all carry it.
    const [costMode, setCostMode] = React.useState<UsageCostMode>('auto');
    const [showSeriesList, setShowSeriesList] = React.useState(false);
    const [exportBusy, setExportBusy] = React.useState(false);
    const [exportNotice, setExportNotice] = React.useState<string | null>(null);
    // The end stays stable between refreshes, but a refresh — explicit, or woken
    // by the Home recording usage for this resource — always moves it to the
    // current instant instead of pinning the route's mount time.
    const [nowMs, setNowMs] = React.useState(() => Date.now());

    const range = React.useMemo(() => Object.freeze({
        startMs: resolveUsagePeriodStartTimeSeconds(period, nowMs) * 1000,
        endMs: nowMs,
        granularity: getUsagePeriodDefinition(period).granularity,
    }), [nowMs, period]);

    const input = React.useMemo<TeamCredentialUsageQueryInputV1>(() => ({
        resourceId,
        startMs: range.startMs,
        endMs: range.endMs,
        granularity: range.granularity,
        costMode,
        ...(breakdown === null ? {} : { breakdown }),
    }), [breakdown, costMode, range, resourceId]);

    // A Group or member allowance names who it governs. Both rosters belong to
    // the same authority that may read these rules at all, and neither is read
    // for a recipient, who sees only their own remaining amount.
    const administersLimits = resource?.capabilities.manageLimits === true;
    const groupsRoster = useTeamGroups({
        scope: context.scope,
        address: context.address,
        archived: 'active',
        enabled: administersLimits,
    });
    const membersRoster = useTeamMembersRoster({
        scope: context.scope,
        address: context.address,
        filter: 'all',
        enabled: administersLimits,
    });
    const resolveLimitSubjectName = React.useCallback((limit: TeamCredentialUsageLimitV1): string | null => {
        if (limit.subjectKind === 'team_group') {
            return groupsRoster.rows.find((row) => row.id === limit.subjectId)?.name ?? null;
        }
        if (limit.subjectKind === 'team_member') {
            const membership = membersRoster.rows.find((row) => row.accountId === limit.subjectId);
            return membership ? formatAccountDisplayName(membership.account) ?? null : null;
        }
        return null;
    }, [groupsRoster.rows, membersRoster.rows]);

    // Usage is read only once this route is open and the resource exists;
    // the list projection never opens it per row.
    const usageEnabled = view.featureEnabled && (resource !== null || catalogResource !== null);
    const usage = useTeamCredentialUsage({
        scope: context.scope,
        input,
        resourceRevision: resource?.revision ?? catalogResource?.resourceRevision ?? null,
        enabled: usageEnabled,
    });
    const seriesMotion = useUsageSeriesMotion(usage.result?.series.length ?? 0);
    // Refresh moves the end to the current instant; a reread on the same
    // instant would otherwise leave the query identity unchanged.
    const refreshToNow = React.useCallback(() => {
        const current = Date.now();
        if (current === nowMs) {
            void usage.reload();
        } else {
            setNowMs(current);
        }
    }, [nowMs, usage.reload]);
    useTeamCredentialUsageWriteRefresh({
        scope: context.scope,
        resourceId,
        enabled: usageEnabled,
        reading: usage.status === 'loading',
        refresh: refreshToNow,
    });

    if (!view.featureEnabled || (view.resolved && resource === null && catalogResource === null)) {
        return (
            <ItemGroup description={view.featureEnabled
                ? t('teams.credentials.detail.notFound')
                : t('teams.credentials.unavailable')}>
                <Item
                    testID="team-credential-usage-unavailable"
                    title={t('teams.errors.notFound')}
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    if (resource === null && catalogResource === null) {
        if (view.error) {
            return (
                <ItemGroup description={credentialFailureMessage(view.error)}>
                    <Item
                        testID="team-credential-usage-resource-retry"
                        title={t('teams.unavailable.retry')}
                        onPress={() => void view.reload()}
                        showChevron={false}
                    />
                </ItemGroup>
            );
        }
        return (
            <ItemGroup>
                <Item
                    testID="team-credential-usage-loading"
                    title={t('teams.credentials.usage.title')}
                    loading
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    const result = usage.result;
    /**
     * Whether this viewer reads the administration projection. It mirrors the
     * usage owner's own rule so the screen offers exactly the dimensions the
     * Home will answer, rather than a control that silently returns nothing.
     */
    const administers = resource !== null
        && (view.viewer?.manageCredentials === true
            || resource.custodianAccountId === context.scope.accountId);
    const dimensions = offeredTeamCredentialUsageBreakdowns(administers);
    // Independent completeness facts, stated separately because they have
    // different causes: material used outside Happier is never recorded, a
    // resource with no brokered grant has no admission to count at all, and a
    // model without a canonical price contributes tokens but no cost.
    const coverage = result?.coverage ?? null;
    const showRequests = coverage !== null
        && (coverage.requestCountCoverage === 'complete' || coverage.requestAdmissionCount > 0);
    const tokenChartAvailable = coverage !== null
        && coverage.tokenCoverage !== 'unavailable'
        && !(coverage.tokenCoverage === 'partial' && result?.totals.tokens.total === 0);
    const resolvedCost = result === null ? 0 : resolveDisplayCost(result.totals.cost);
    const costChartAvailable = coverage !== null
        && coverage.costCoverage !== 'unavailable'
        && !(coverage.costCoverage === 'partial' && resolvedCost === 0);
    const chartMetrics: readonly UsageVolumeMetric[] = coverage === null
        ? ['tokens', 'cost']
        : [
            ...(showRequests ? ['requests' as const] : []),
            ...(tokenChartAvailable ? ['tokens' as const] : []),
            ...(costChartAvailable ? ['cost' as const] : []),
        ];
    const selectedMetric = chartMetrics.includes(metric) ? metric : chartMetrics[0] ?? 'tokens';
    const completeness = [
        coverage?.directRecordedUseOnly === true ? t('teams.credentials.usage.directIncomplete') : null,
        coverage?.requestCountCoverage === 'brokered_only' ? t('teams.credentials.usage.requestIncomplete') : null,
        (coverage?.unobservedExternalRequestCount ?? 0) > 0
            ? t('teams.credentials.usage.externalObservationsIncomplete', {
                count: coverage?.unobservedExternalRequestCount ?? 0,
            })
            : null,
        coverage?.tokenCoverage === 'partial' ? t('teams.credentials.usage.tokenIncomplete') : null,
        coverage?.tokenCoverage === 'unavailable' ? t('teams.credentials.usage.tokenUnavailable') : null,
        coverage?.costCoverage === 'partial' ? t('teams.credentials.usage.costIncomplete') : null,
        coverage?.costCoverage === 'unavailable' ? t('teams.credentials.usage.costUnavailable') : null,
        coverage !== null
            && coverage.directRecordedUseOnly === false
            && coverage.requestCountCoverage === 'complete'
            && coverage.tokenCoverage === 'complete'
            && coverage.costCoverage === 'complete'
            ? t('teams.credentials.usage.recordedByHappier')
            : null,
    ].filter((part): part is string => part !== null).join('\n');

    /**
     * `null` means the Home could not price this period, which is a different
     * fact from nothing having been spent. Only a zero total that the Home
     * itself marked incomplete is unknown; a real zero stays a real zero.
     */
    const costUsd = result === null
        ? null
        : (() => {
            return result.coverage.costCoverage !== 'complete' && resolvedCost === 0 ? null : resolvedCost;
        })();

    // Offered from the totals themselves, exactly as the personal dashboard
    // does; a chosen mode stays offered so it can be switched back.
    const costModes: readonly UsageCostMode[] = result === null || coverage?.costCoverage === 'unavailable'
        ? []
        : [...new Set([...resolveAvailableCostModes(result.totals.cost), costMode])];
    const limits = result ? orderTeamCredentialLimitsByRemaining(result.limits) : [];
    const recipientLimit = catalogResource?.usageLimit ?? null;
    // A retained result belongs to the previous query range while refresh is
    // pending. Keep it visible, but do not export it under the new range —
    // including when that refresh FAILED, which leaves the old numbers on
    // screen under the new labels with `status === 'error'`.
    const exportUnavailable = exportBusy || !usage.resultIsCurrentQuery;
    const series = result?.series.map((bucket) => ({
        timestamp: Math.floor(bucket.bucketStartMs / 1000),
        tokens: bucket.totals.tokens.total,
        cost: resolveDisplayCost(bucket.totals.cost),
        requests: bucket.totals.requestCount,
        reportCount: bucket.totals.eventCount,
    })) ?? [];
    const resourceName = resource?.displayName ?? catalogResource?.displayName ?? '';

    return (
        <>
            <ItemGroup
                title={t('teams.credentials.usage.rangeLabel')}
                accessibilityRole="radiogroup"
                accessibilityLabel={t('teams.credentials.usage.rangeLabel')}
            >
                {USAGE_PERIODS.map((candidate) => (
                    <Item
                        key={candidate}
                        testID={`team-credential-usage-period:${candidate}`}
                        title={t(getUsagePeriodDefinition(candidate).translationKey)}
                        selected={period === candidate}
                        onPress={() => setPeriod(candidate)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            <ItemGroup
                title={t('usage.summary.export.metric')}
                accessibilityRole="radiogroup"
                accessibilityLabel={t('usage.summary.export.metric')}
            >
                {chartMetrics.map((candidate) => (
                    <Item
                        key={candidate}
                        testID={`team-credential-usage-metric:${candidate}`}
                        title={metricLabel(candidate)}
                        selected={selectedMetric === candidate}
                        onPress={() => setMetric(candidate)}
                        showChevron={false}
                    />
                ))}
                {chartMetrics.length === 0 ? (
                    <Item
                        testID="team-credential-usage-metrics-unavailable"
                        title={t('common.unavailable')}
                        showChevron={false}
                    />
                ) : null}
            </ItemGroup>

            <ItemGroup>
                <Item
                    testID="team-credential-usage-refresh"
                    title={t('common.refresh')}
                    loading={usage.status === 'loading' && result !== null}
                    accessibilityLiveRegion={usage.status === 'loading' ? 'polite' : undefined}
                    onPress={refreshToNow}
                    showChevron={false}
                />
            </ItemGroup>

            {/* Totals already read stay on screen while the next range loads. */}
            {result === null && usage.status === 'loading' ? (
                <ItemGroup>
                    <Item
                        testID="team-credential-usage-totals-loading"
                        title={t('teams.credentials.usage.title')}
                        loading
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {result !== null ? (
                <ItemGroup title={t('teams.credentials.usage.title')} description={completeness || undefined}>
                    {!showRequests || coverage === null ? null : (
                        <Item
                            testID="team-credential-usage-requests"
                            // The Home names completeness. The UI never derives
                            // it from the resource's current delivery settings.
                            title={usageRequestMetricLabel(coverage.requestCountCoverage)}
                            detail={formatTokenCountLong(coverage.requestAdmissionCount)}
                            showChevron={false}
                        />
                    )}
                    <Item
                        testID="team-credential-usage-tokens"
                        title={limitMetricLabel('total_tokens')}
                        detail={coverage?.tokenCoverage === 'unavailable'
                            || (coverage?.tokenCoverage === 'partial' && result.totals.tokens.total === 0)
                            ? t('common.unavailable')
                            : formatTokenCountLong(result.totals.tokens.total)}
                        showChevron={false}
                    />
                    <Item
                        testID="team-credential-usage-cost"
                        title={limitMetricLabel('cost_usd')}
                        // An unavailable cost is never rendered as zero: a
                        // missing price is not a free request. The amount itself
                        // comes from the shared usage owner so the same events
                        // cannot read differently here and on the dashboard.
                        detail={costUsd === null
                            ? t('teams.credentials.usage.costUnknown')
                            : formatUsageCost(costUsd, result.totals.cost.currency)}
                        subtitle={costUsd === null ? undefined : costProvenanceLabel(result.totals.cost, costMode)}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {costModes.length > 1 ? (
                <ItemGroup
                    title={t('usage.costMode')}
                    accessibilityRole="radiogroup"
                    accessibilityLabel={t('usage.costMode')}
                >
                    {costModes.map((candidate) => (
                        <Item
                            key={candidate}
                            testID={`team-credential-usage-cost-mode:${candidate}`}
                            title={t(COST_MODE_LABEL_KEYS[candidate])}
                            selected={costMode === candidate}
                            onPress={() => setCostMode(candidate)}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            ) : null}

            {result !== null && series.length > 0 && chartMetrics.length > 0 ? (
                <ItemGroup title={t('usage.usageOverTime')}>
                    <StackedSeriesChart
                        testID="team-credential-usage-series"
                        theme={projectPluginUiTheme(theme)} label={metricLabel(selectedMetric)} variant="bar" size="full" minimumMaximum={1}
                        {...seriesMotion} showReadout={false}
                        unknownLabel={t('common.unavailable')}
                        barWidth={26} barSlotWidth={42} barGap={10} barLeadingInset={4} barMinHeight={10} barTrackColor={theme.colors.surface.inset}
                        barEmphasis="maximum" showPeakValue showPointLabels showScaleValues
                        series={[{ id: selectedMetric, label: selectedMetric === 'requests' ? usageRequestMetricLabel(result.coverage.requestCountCoverage) : metricLabel(selectedMetric), color: theme.colors.text.link,
                            points: series.map((point) => ({ id: String(point.timestamp), x: point.timestamp, label: seriesBucketLabel(point.timestamp, period),
                                y: selectedMetric === 'tokens' ? point.tokens : selectedMetric === 'cost' ? point.cost : point.requests ?? null })) }]}
                        valueFormatter={usageSeriesValueFormatter(selectedMetric, result.totals.cost.currency)}
                        renderBucket={usageSeriesTooltip(theme.colors.text.link, 'usage-volume-point-trigger', usageSeriesValueFormatter(selectedMetric, result.totals.cost.currency))}
                        renderFrame={usageSeriesFrame(series.length, { accentColor: theme.colors.text.link,
                            resolveContent: usageVolumeLens(series, result.totals.cost.currency, (timestamp) => seriesBucketLabel(timestamp, period), usageRequestMetricLabel(result.coverage.requestCountCoverage)) })}
                    />
                    <Item
                        testID="team-credential-usage-series-list-toggle"
                        title={showSeriesList ? t('usage.showLess') : t('usage.showAll')}
                        onPress={() => setShowSeriesList((current) => !current)}
                        showChevron={false}
                    />
                    {showSeriesList ? series.map((point) => (
                        <Item
                            key={point.timestamp}
                            testID="team-credential-usage-series-list-row"
                            title={seriesBucketLabel(point.timestamp, period)}
                            // The table alternative reads the same metric the
                            // chart draws; a chart-only fact is not accessible.
                            detail={selectedMetric === 'cost'
                                ? formatUsageCost(point.cost, result.totals.cost.currency)
                                : selectedMetric === 'requests'
                                    ? `${formatTokenCountLong(point.requests)} ${usageRequestMetricLabel(result.coverage.requestCountCoverage)}`
                                    : `${formatTokenCountLong(point.tokens)} ${t('usage.tokens')}`}
                            showChevron={false}
                        />
                    )) : null}
                </ItemGroup>
            ) : null}

            <ItemGroup
                title={t('teams.credentials.usage.breakdownLabel')}
                description={administers ? undefined : t('teams.credentials.usage.breakdownRestricted')}
                accessibilityRole="radiogroup"
                accessibilityLabel={t('teams.credentials.usage.breakdownLabel')}
            >
                <Item
                    testID="team-credential-usage-breakdown:none"
                    title={t('teams.credentials.usage.breakdownNone')}
                    selected={breakdown === null}
                    onPress={() => setBreakdown(null)}
                    showChevron={false}
                />
                {dimensions.map((dimension) => (
                    <Item
                        key={dimension}
                        testID={`team-credential-usage-breakdown:${dimension}`}
                        title={usageBreakdownLabel(dimension)}
                        selected={breakdown === dimension}
                        onPress={() => setBreakdown(dimension)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            {breakdown !== null && result !== null ? (
                (result.breakdown ?? []).length === 0 ? (
                    <ItemGroup description={t('teams.credentials.usage.empty')}>
                        <Item
                            testID="team-credential-usage-breakdown-empty"
                            title={usageBreakdownLabel(breakdown)}
                            showChevron={false}
                        />
                    </ItemGroup>
                ) : (
                    <ItemGroup title={usageBreakdownLabel(breakdown)}>
                        {(result.breakdown ?? []).map((entry) => (
                            <Item
                                key={entry.key}
                                testID={`team-credential-usage-slice:${entry.key}`}
                                // The Home names its own slices. A key without a
                                // label is shown as the Home sent it rather than
                                // being decorated with a guess about what it is.
                                title={entry.label ?? entry.key}
                                subtitle={t('teams.credentials.usage.sliceSummary', {
                                    requests: result.coverage.requestCountCoverage === 'brokered_only'
                                        && entry.totals.requestCount === 0
                                        ? t('common.unavailable')
                                        : formatTokenCountLong(entry.totals.requestCount),
                                    tokens: result.coverage.tokenCoverage === 'unavailable'
                                        || (result.coverage.tokenCoverage === 'partial' && entry.totals.tokens.total === 0)
                                        ? t('common.unavailable')
                                        : formatTokenCountLong(entry.totals.tokens.total),
                                })}
                                showChevron={false}
                            />
                        ))}
                    </ItemGroup>
                )
            ) : null}

            {usage.hasMore && !usage.partial ? (
                <ItemGroup>
                    <Item
                        testID="team-credential-usage-load-more"
                        title={t('homeGovernance.loadMore')}
                        loading={usage.loadingMore}
                        disabled={usage.loadingMore}
                        accessibilityLiveRegion={usage.loadingMore ? 'polite' : undefined}
                        onPress={() => void usage.loadMore()}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {usage.partial && usage.error ? (
                <ItemGroup description={credentialFailureMessage(usage.error)}>
                    <Item
                        testID="team-credential-usage-load-more-retry"
                        title={t('teams.unavailable.retry')}
                        loading={usage.loadingMore}
                        disabled={usage.loadingMore}
                        accessibilityLiveRegion="polite"
                        onPress={() => void usage.loadMore()}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {result !== null ? (
                <ItemGroup description={exportNotice ?? undefined}>
                    <Item
                        testID="team-credential-usage-export"
                        title={t('teams.credentials.usage.export')}
                        loading={exportBusy}
                        disabled={exportUnavailable}
                        showChevron={false}
                        onPress={async () => {
                            if (exportUnavailable) return;
                            setExportBusy(true);
                            setExportNotice(null);
                            try {
                                const exported = await exportTeamCredentialUsageCsv({
                                    resourceName,
                                    result,
                                    startMs: range.startMs,
                                    endMs: range.endMs,
                                    breakdown,
                                    // 52 ranked slices must not leave as 50
                                    // rows under a whole-query total with
                                    // nothing in the file saying so.
                                    breakdownComplete: !usage.hasMore && !usage.partial,
                                    costMode,
                                });
                                if (!exported) setExportNotice(t('teams.credentials.usage.exportFailed'));
                            } catch {
                                setExportNotice(t('teams.credentials.usage.exportFailed'));
                            } finally {
                                setExportBusy(false);
                            }
                        }}
                    />
                </ItemGroup>
            ) : null}

            {limits.length > 0 ? (
                <ItemGroup
                    title={t('teams.credentials.usage.limitsTitle')}
                    description={t('teams.credentials.limits.overshoot')}
                >
                    {limits.map((limit) => {
                        const reset = formatLimitResetUtc(limit.currentWindow.resetsAtUtc);
                        const reached = limitReached(limit);
                        const recorded = t('teams.credentials.limits.recorded', {
                            recorded: limit.currentWindow.recorded,
                            maximum: limit.maximum,
                        });
                        return (
                            <Item
                                key={limit.id}
                                testID={`team-credential-usage-limit:${limit.id}`}
                                title={`${limitSubjectLine(limit, resolveLimitSubjectName)} · ${limitMetricLabel(limit.metric)}`}
                                subtitle={[
                                    limitPeriodLabel(limit.period),
                                    recorded,
                                    reset,
                                    // A Group allowance is one shared pool, not a
                                    // private per-member one; saying so is the
                                    // difference between reading it right and wrong.
                                    limit.subjectKind === 'team_group' ? t('teams.credentials.limits.groupShared') : null,
                                ]
                                    .filter((part): part is string => part !== null)
                                    .join('\n')}
                                detail={reached ? t('teams.credentials.limits.reached') : undefined}
                                showChevron={false}
                            />
                        );
                    })}
                </ItemGroup>
            ) : null}

            {recipientLimit !== null ? (
                <ItemGroup
                    title={t('teams.credentials.usage.limitsTitle')}
                    description={formatLimitResetUtc(recipientLimit.resetsAtUtc) ?? undefined}
                >
                    <Item
                        testID="team-credential-usage-recipient-limit"
                        title={limitMetricLabel(recipientLimit.metric)}
                        detail={recipientLimit.remaining}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {usage.error && !usage.partial ? (
                <ItemGroup description={credentialFailureMessage(usage.error)}>
                    <Item
                        testID="team-credential-usage-retry"
                        title={t('teams.unavailable.retry')}
                        onPress={() => void usage.reload()}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {view.error ? (
                <ItemGroup description={credentialFailureMessage(view.error)}>
                    <Item
                        testID="team-credential-usage-resource-retry"
                        title={t('teams.unavailable.retry')}
                        onPress={() => void view.reload()}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
        </>
    );
});

export const TeamCredentialUsageScreen = React.memo(function TeamCredentialUsageScreen(props: Readonly<{
    serverId: string;
    teamId: string;
    resourceId: string;
}>) {
    return (
        <TeamSection
            serverId={props.serverId}
            teamId={props.teamId}
            title={t('teams.credentials.usage.title')}
            description={t('teams.pages.credentialUsage')}
        >
            {(context) => <CredentialUsage context={context} resourceId={props.resourceId} />}
        </TeamSection>
    );
});
