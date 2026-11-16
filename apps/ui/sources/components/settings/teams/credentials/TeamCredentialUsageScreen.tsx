import * as React from 'react';
import type {
    TeamCredentialUsageBreakdownDimensionV1,
    TeamCredentialUsageLimitV1,
    TeamCredentialUsageQueryInputV1,
    TeamCredentialUsageQueryResultV1,
} from '@happier-dev/protocol/teams';

import { UsageDailyChart, UsagePeriodSummaryBody, type UsageSummaryMetric } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { UsageFilterBar } from '@/components/settings/usage/UsageFilterBar';
import { usageSignatureAccent } from '@/components/settings/usage/usageAccent';
import {
    usageAxisTicks,
    usageDailyBarGeometry,
    usageSeriesValueFormatter,
    usageVolumeSeries,
    useUsageSeriesLens,
    useUsageSeriesMotion,
} from '@/components/settings/usage/usageSeriesPresentation';
import { useUsageDailyChartShape } from '@/components/settings/usage/widgets/UsageDailyWidget';
import { useUsageChartDetails } from '@/components/settings/usage/widgets/usageMountedControls';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useTeamCredentialUsage, useTeamCredentialUsageWriteRefresh } from '@/hooks/teams/useTeamCredentialResources';
import { useTeamGroups } from '@/hooks/teams/useTeamGroups';
import { useTeamGroupDisplayNames } from '@/hooks/teams/useTeamGroupDisplayNames';
import { useTeamMembersRoster } from '@/hooks/teams/useTeamMembersRoster';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { useOpenedPrivateLabels } from '@/sync/ops/privateLabels/useOpenedPrivateLabels';
import { teamCredentialExternalApiKeyLabelBinding } from '@/sync/ops/teams/teamCredentialLabels';
import { HomeAdministrationSection } from '@/components/settings/home/governance/HomeAdministrationSection';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import {
    resolveAvailableCostModes,
    resolveAnalyticsCost,
    type UsageCostMode,
    type UsageTrendPoint,
} from '@/sync/api/account/usageAnalytics';
import {
    getUsagePeriodDefinition,
    USAGE_PERIODS,
    type UsagePeriod,
} from '@/sync/api/account/usagePeriods';
import { t } from '@/text';
import { resolveUsageMeasuredTokens } from '@/sync/api/account/usageMeasuredTokens';
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
    usageBreakdownPresentation,
    usageRequestMetricLabel,
    resolveTeamCredentialUsageStartTimeSeconds,
} from './teamCredentialPresentation';
import { exportTeamCredentialUsageCsv } from './teamCredentialUsageExport';
import {
    contiguousTeamCredentialUsageBuckets,
    teamCredentialUsageCaveat,
    teamCredentialUsageCost,
    teamCredentialUsageTokens,
} from './teamCredentialUsagePresentation';
import { useTeamCredentialResourceView, type TeamCredentialResourceView } from './useTeamCredentialResourceView';

type UsageSubject = NonNullable<TeamCredentialUsageQueryInputV1['subject']>;

/**
 * Labels for the metrics the shared usage chart can draw. Request points are
 * offered only when the Home's coverage projection says the count is usable.
 */
type UsageVolumeMetric = 'tokens' | 'cost' | 'requests';
function metricLabel(metric: UsageVolumeMetric): string {
    if (metric === 'requests') return t('teams.credentials.limits.metric.requests');
    return metric === 'tokens' ? t('usage.tokens') : t('usage.cost');
}

const EMPTY_SCOPE_FILTERS: readonly never[] = [];

const COST_MODE_LABEL_KEYS = {
    auto: 'usage.auto',
    reported: 'usage.reported',
    estimated: 'usage.estimated',
    api_equivalent: 'usage.board.page.factApiEquivalent',
} as const satisfies Record<UsageCostMode, string>;

/**
 * Which kind of cost a total is. An estimate and a Provider-reported amount can
 * be the same number, so the amount alone does not say which one a reader is
 * looking at; the automatic mode sums each event's own best fact and may mix
 * both.
 */
function costProvenanceLabel(
    cost: Readonly<{ reportedUsd: number | null; estimatedUsd: number | null }>,
    mode: UsageCostMode,
): string | undefined {
    if (mode !== 'auto') return t(COST_MODE_LABEL_KEYS[mode]);
    if (cost.reportedUsd !== null && cost.reportedUsd > 0 && cost.estimatedUsd !== null && cost.estimatedUsd > 0) {
        return `${t('usage.reported')} + ${t('usage.estimated')}`;
    }
    if (cost.reportedUsd !== null && cost.reportedUsd > 0) return t('usage.reported');
    if (cost.estimatedUsd !== null && cost.estimatedUsd > 0) return t('usage.estimated');
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
    scope: ServerAccountScope;
    address: TeamAddress | null;
    target: Pick<TeamCredentialUsageQueryInputV1, 'resourceId' | 'subject'>;
    view?: TeamCredentialResourceView;
    featureEnabled: boolean;
    displayName: string;
}>) {
    const { scope, address, target, view, featureEnabled } = props;
    const resource = view?.resource ?? null;
    const catalogResource = view?.catalogResource ?? null;
    const aggregate = target.subject !== undefined;

    const [period, setPeriod] = React.useState<UsagePeriod>('30days');
    const [metric, setMetric] = React.useState<UsageVolumeMetric>('tokens');
    const [breakdown, setBreakdown] = React.useState<TeamCredentialUsageBreakdownDimensionV1 | null>(null);
    const [breakdownOpen, setBreakdownOpen] = React.useState(false);
    // The same cost modes the personal usage dashboard offers. The Home resolves
    // the effective cost under the chosen mode, so the request, its cursor and
    // any export all carry it.
    const [costMode, setCostMode] = React.useState<UsageCostMode>('auto');
    const [exportBusy, setExportBusy] = React.useState(false);
    const [exportNotice, setExportNotice] = React.useState<string | null>(null);
    // The end stays stable between refreshes, but a refresh — explicit, or woken
    // by the Home recording usage for this resource — always moves it to the
    // current instant instead of pinning the route's mount time.
    const [nowMs, setNowMs] = React.useState(() => Date.now());
    // The filter strip's writers: this screen's own read, applied at once.
    const changePeriod = React.useCallback(async (next: UsagePeriod) => { setPeriod(next); return true; }, []);
    const changeCostMode = React.useCallback(async (next: UsageCostMode) => { setCostMode(next); return true; }, []);

    const range = React.useMemo(() => Object.freeze({
        startMs: resolveTeamCredentialUsageStartTimeSeconds(period, nowMs) * 1000,
        endMs: nowMs,
        granularity: getUsagePeriodDefinition(period).granularity,
    }), [nowMs, period]);

    const input = React.useMemo<TeamCredentialUsageQueryInputV1>(() => ({
        ...target,
        startMs: range.startMs,
        endMs: range.endMs,
        granularity: range.granularity,
        costMode,
        ...(breakdown === null ? {} : { breakdown }),
    }), [breakdown, costMode, range, target]);

    // A Group or member allowance names who it governs. Both rosters belong to
    // the same authority that may read these rules at all, and neither is read
    // for a recipient, who sees only their own remaining amount.
    const administersLimits = resource?.capabilities.manageLimits === true;
    const groupsRoster = useTeamGroups({
        scope,
        address,
        archived: 'active',
        enabled: administersLimits,
    });
    const membersRoster = useTeamMembersRoster({
        scope,
        address,
        filter: 'all',
        enabled: administersLimits,
    });
    const groupDisplayNames = useTeamGroupDisplayNames({ scope, groups: groupsRoster.rows });
    const resolveLimitSubjectName = React.useCallback((limit: TeamCredentialUsageLimitV1): string | null => {
        if (limit.subjectKind === 'team_group') {
            return groupDisplayNames.get(limit.subjectId) ?? null;
        }
        if (limit.subjectKind === 'team_member') {
            const membership = membersRoster.rows.find((row) => row.accountId === limit.subjectId);
            return membership ? formatAccountDisplayName(membership.account) ?? null : null;
        }
        return null;
    }, [groupDisplayNames, membersRoster.rows]);

    // Usage is read only once this route is open and the resource exists;
    // the list projection never opens it per row.
    const usageEnabled = featureEnabled && (aggregate || resource !== null || catalogResource !== null);
    const usage = useTeamCredentialUsage({
        scope,
        input,
        resourceRevision: resource?.revision ?? catalogResource?.resourceRevision ?? null,
        enabled: usageEnabled,
    });
    const externalApiKeyLabelRequests = React.useMemo(() => (
        breakdown === 'external_api_key'
            ? (usage.result?.breakdown ?? []).flatMap((entry) => entry.privateLabel ? [{
                key: entry.key,
                binding: teamCredentialExternalApiKeyLabelBinding(entry.key),
                label: entry.privateLabel,
                readPolicy: { kind: 'team-resource' as const },
            }] : [])
            : []
    ), [breakdown, usage.result?.breakdown]);
    const openedExternalApiKeyLabels = useOpenedPrivateLabels({
        scope,
        requests: externalApiKeyLabelRequests,
        enabled: usageEnabled && breakdown === 'external_api_key',
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
        scope,
        ...target,
        enabled: usageEnabled,
        reading: usage.status === 'loading',
        refresh: refreshToNow,
    });

    if (!featureEnabled || (!aggregate && view?.resolved && resource === null && catalogResource === null)) {
        return (
            <SurfaceStateCard
                testID="team-credential-usage-unavailable"
                kind={featureEnabled ? 'empty' : 'unavailable'}
                size="pane"
                iconName="key"
                title={featureEnabled ? t('teams.errors.notFound') : t('teams.credentials.unavailable')}
                reason={featureEnabled ? t('teams.credentials.detail.notFound') : undefined}
            />
        );
    }

    if (!aggregate && resource === null && catalogResource === null) {
        if (view?.error) {
            return (
                <ItemGroup>
                    <SurfaceStateCard
                        testID="team-credential-usage-resource-error"
                        kind="error"
                        size="line"
                        title={credentialFailureMessage(view.error)}
                        action={{ label: t('common.retry'), onPress: () => void view.reload(), testID: 'team-credential-usage-resource-retry' }}
                        accessibilitySemantics="alert"
                    />
                </ItemGroup>
            );
        }
        return (
            <ItemGroup>
                <ItemLoadStateRows
                    testID="team-credential-usage-loading"
                    state={{ kind: 'loading' }}
                    rows={3}
                    accessibilityLabel={t('common.loading')}
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
    const administers = aggregate || (resource !== null
        && (view?.viewer?.manageCredentials === true
            || resource.custodianAccountId === scope.accountId));
    const dimensions = offeredTeamCredentialUsageBreakdowns(administers);
    // Independent completeness facts, stated separately because they have
    // different causes: material used outside Happier is never recorded, a
    // resource with no brokered grant has no admission to count at all, and a
    // model without a canonical price contributes tokens but no cost.
    const coverage = result?.coverage ?? null;
    const showRequests = coverage !== null
        && (coverage.requestCountCoverage === 'complete' || coverage.requestAdmissionCount > 0);
    const tokenChartAvailable = result !== null
        && resolveUsageMeasuredTokens(result.totals.tokens).total !== null;
    const resolvedCost = result === null ? null : resolveAnalyticsCost(result.totals.cost, costMode);
    const costChartAvailable = resolvedCost !== null;
    const chartMetrics: readonly UsageVolumeMetric[] = coverage === null
        ? ['tokens', 'cost']
        : [
            ...(showRequests ? ['requests' as const] : []),
            ...(tokenChartAvailable ? ['tokens' as const] : []),
            ...(costChartAvailable ? ['cost' as const] : []),
        ];
    const selectedMetric = chartMetrics.includes(metric) ? metric : chartMetrics[0] ?? 'tokens';
    // One line under the totals; token and cost gaps are said by their own figures.
    const completeness = teamCredentialUsageCaveat(coverage) ?? '';

    const costUsd = resolvedCost;

    // Offered from the totals themselves, exactly as the personal dashboard
    // does; a chosen mode stays offered so it can be switched back.
    const costModes: readonly UsageCostMode[] = result === null
        ? []
        : [...new Set([...resolveAvailableCostModes(result.totals.cost), costMode])];
    const limits = result ? orderTeamCredentialLimitsByRemaining(result.limits) : [];
    const recipientLimit = catalogResource?.usageLimit ?? null;
    // A retained result belongs to the previous query range while refresh is
    // pending. Keep it visible, but do not export it under the new range —
    // including when that refresh FAILED, which leaves the old numbers on
    // screen under the new labels with `status === 'error'`.
    const exportUnavailable = exportBusy || !usage.resultIsCurrentQuery;
    // One slot per bucket of the range: a period the Home recorded nothing for is an empty slot, not a skipped one.
    const recordedBuckets = new Map((result?.series ?? []).map((bucket) => [bucket.bucketStartMs, bucket] as const));
    const series = contiguousTeamCredentialUsageBuckets([...recordedBuckets.keys()], range).map(({ bucketStartMs }) => {
        const bucket = recordedBuckets.get(bucketStartMs);
        return {
            timestamp: Math.floor(bucketStartMs / 1000),
            tokens: bucket ? resolveUsageMeasuredTokens(bucket.totals.tokens).total : 0,
            cost: bucket ? resolveAnalyticsCost(bucket.totals.cost, costMode) : 0,
            requests: bucket?.totals.requestCount ?? 0,
            reportCount: bucket?.totals.eventCount ?? 0,
            recorded: bucket !== undefined,
        };
    });
    const resourceName = view?.displayName ?? props.displayName;
    const metricOptions = chartMetrics.map((candidate) => ({ id: candidate, label: metricLabel(candidate) }));

    return (
        <>
            {/* What the page shows, as on the account Usage page: the period, then the metric and the cost basis,
                one inline strip of one-press filters above the figures, never configuration rows. */}
            <ItemGroup surface="none">
                <UsageFilterBar<UsageVolumeMetric>
                    testID="team-credential-usage-filters"
                    period={period}
                    costBasis={costMode}
                    coverageIncomplete={false}
                    scopeFilters={EMPTY_SCOPE_FILTERS}
                    costBasisOptions={costModes}
                    costBasisPending={false}
                    onPeriodChange={changePeriod}
                    onCostBasisChange={changeCostMode}
                    metricOptions={metricOptions}
                    metric={selectedMetric}
                    onMetricChange={chartMetrics.length > 1 ? setMetric : null}
                />
            </ItemGroup>

            {/* Totals already read stay on screen while the next range loads. */}
            {result === null && usage.status === 'loading' ? (
                <ItemGroup title={t('teams.credentials.usage.title')}>
                    <ItemLoadStateRows
                        testID="team-credential-usage-totals-loading"
                        state={{ kind: 'loading' }}
                        rows={3}
                        accessibilityLabel={t('common.loading')}
                    />
                </ItemGroup>
            ) : null}

            <TeamCredentialUsageSummary result={result} period={period} costMode={costMode}
                showRequests={showRequests} completeness={completeness} costUsd={costUsd} series={series}
                chartMetrics={chartMetrics} selectedMetric={selectedMetric}
                seriesMotion={seriesMotion}
                refreshing={usage.status === 'loading'} onRefresh={refreshToNow} />

            <ItemGroup><DropdownMenu open={breakdownOpen} onOpenChange={setBreakdownOpen} selectedId={breakdown ?? 'none'} items={[{ id: 'none', testID: 'team-credential-usage-breakdown:none', title: t('teams.credentials.usage.breakdownNone') }, ...dimensions.map((id) => ({ id, testID: `team-credential-usage-breakdown:${id}`, title: usageBreakdownLabel(id) }))]} onSelect={(id) => setBreakdown(id === 'none' ? null : dimensions.find((dimension) => dimension === id) ?? breakdown)} itemTrigger={{ title: t('teams.credentials.usage.breakdownLabel'), subtitle: administers ? undefined : t('teams.credentials.usage.breakdownRestricted'), itemProps: { testID: 'team-credential-usage-breakdown-trigger' } }} /></ItemGroup>

            {breakdown !== null && result !== null ? (
                (result.breakdown ?? []).length === 0 ? (
                    <ItemGroup title={usageBreakdownLabel(breakdown)}>
                        <SurfaceStateCard
                            testID="team-credential-usage-breakdown-empty"
                            kind="empty"
                            size="line"
                            title={t('teams.credentials.usage.empty')}
                        />
                    </ItemGroup>
                ) : (
                    <ItemGroup title={usageBreakdownLabel(breakdown)}>
                        {(result.breakdown ?? []).map((entry) => {
                            const tokenCount = resolveUsageMeasuredTokens(entry.totals.tokens).total;
                            const presentation = usageBreakdownPresentation(breakdown, entry, scope.accountId);
                            const title = breakdown === 'external_api_key'
                                ? openedExternalApiKeyLabels[entry.key] ?? t('common.unavailable')
                                : presentation.name;
                            return (
                                <Item
                                    key={entry.key}
                                    testID={`team-credential-usage-slice:${entry.key}`}
                                    title={title}
                                    subtitle={[presentation.hint, t('teams.credentials.usage.sliceSummary', {
                                        requestCount: entry.totals.requestCount,
                                        tokenCount,
                                        requests: result.coverage.requestCountCoverage === 'brokered_only'
                                            && entry.totals.requestCount === 0
                                            ? t('common.unavailable')
                                            : formatTokenCountLong(entry.totals.requestCount),
                                        tokens: formatTokenCountLong(tokenCount),
                                    })].filter(Boolean).join(' · ')}
                                    showChevron={false}
                                />
                            );
                        })}
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
                <ItemGroup>
                    <SurfaceStateCard
                        testID="team-credential-usage-load-more-error"
                        kind="error"
                        size="line"
                        title={credentialFailureMessage(usage.error)}
                        action={{ label: t('common.retry'), disabled: usage.loadingMore, onPress: () => void usage.loadMore(), testID: 'team-credential-usage-load-more-retry' }}
                        accessibilitySemantics="alert"
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

            {result !== null ? (
                // Saving the period as a file closes the page: one quiet button, its failure beneath it.
                <ItemGroup surface="none">
                    <SectionButtonRow footnote={exportNotice ?? undefined}>
                        <RoundButton
                            testID="team-credential-usage-export"
                            size="small"
                            display="secondary"
                            title={t('teams.credentials.usage.export')}
                            loading={exportBusy}
                            disabled={exportUnavailable}
                            onPress={async () => {
                                if (exportUnavailable) return;
                                setExportBusy(true);
                                setExportNotice(null);
                                try {
                                    const exported = await exportTeamCredentialUsageCsv({
                                        scope,
                                        query: input,
                                        // Retain the displayed ranked-row scope; the export
                                        // never silently opens every remaining page.
                                        ...(breakdown === null ? {} : { breakdownRowCount: result.breakdown?.length ?? 0 }),
                                    });
                                    if (!exported) setExportNotice(t('teams.credentials.usage.exportFailed'));
                                } catch {
                                    setExportNotice(t('teams.credentials.usage.exportFailed'));
                                } finally {
                                    setExportBusy(false);
                                }
                            }}
                        />
                    </SectionButtonRow>
                </ItemGroup>
            ) : null}

            {usage.error && !usage.partial ? (
                <ItemGroup>
                    <SurfaceStateCard
                        testID="team-credential-usage-error"
                        kind={usage.error.kind === 'forbidden' || usage.error.kind === 'unauthorized' ? 'denied' : 'error'}
                        size="line"
                        title={credentialFailureMessage(usage.error)}
                        reason={(usage.error.code === 'not_found_or_not_visible' || usage.error.code === 'forbidden') && target.subject
                            ? target.subject.kind === 'home'
                                ? t('teams.credentials.usage.homeAdminRequired')
                                : t('teams.credentials.usage.teamCredentialManagerRequired')
                            : undefined}
                        action={{ label: t('common.retry'), onPress: () => void usage.reload(), testID: 'team-credential-usage-retry' }}
                        accessibilitySemantics="alert"
                    />
                </ItemGroup>
            ) : null}

            {view?.error ? (
                <ItemGroup>
                    <SurfaceStateCard
                        testID="team-credential-usage-resource-error"
                        kind="error"
                        size="line"
                        title={credentialFailureMessage(view.error)}
                        action={{ label: t('common.retry'), onPress: () => void view.reload(), testID: 'team-credential-usage-resource-retry' }}
                        accessibilitySemantics="alert"
                    />
                </ItemGroup>
            ) : null}
        </>
    );
});


const UNKNOWN_VALUE = '—';

/** The period's headline figures: requests when the Home can count them, tokens, and cost. */
function teamCredentialUsageStats(input: Readonly<{
    result: NonNullable<ReturnType<typeof useTeamCredentialUsage>['result']>;
    coverage: TeamCredentialUsageQueryResultV1['coverage'] | null;
    showRequests: boolean;
    costUsd: number | null;
    costMode: UsageCostMode;
}>): UsageSummaryMetric[] {
    const { result, coverage } = input;
    // Nothing recorded at all is a known zero, not an unpriced or unobserved period.
    const nothingRecorded = result.totals.eventCount === 0 && (coverage?.requestAdmissionCount ?? 0) === 0;
    const tokens = teamCredentialUsageTokens(resolveUsageMeasuredTokens(result.totals.tokens).total, coverage, nothingRecorded);
    const cost = teamCredentialUsageCost(input.costUsd, coverage, nothingRecorded);
    const currency = result.totals.cost.currency;
    return [
        ...(input.showRequests && coverage !== null ? [{
            id: 'requests',
            // The Home names completeness; the UI never derives it from the resource's delivery settings.
            label: usageRequestMetricLabel(coverage.requestCountCoverage),
            value: coverage.requestAdmissionCount,
            valueFormatter: formatTokenCountLong,
        }] : []),
        {
            id: 'tokens',
            label: limitMetricLabel('total_tokens'),
            value: tokens.tokens ?? UNKNOWN_VALUE,
            valueFormatter: formatTokenCountLong,
            ...(tokens.caption ? { caption: tokens.caption } : {}),
        },
        {
            id: 'cost',
            label: limitMetricLabel('cost_usd'),
            // An unknown or partly priced cost is never a zero: a missing price is not a free request.
            value: cost.amountUsd ?? UNKNOWN_VALUE,
            valueFormatter: (value: number) => formatUsageCost(value, currency),
            caption: cost.amountUsd === null ? cost.caption : costProvenanceLabel(result.totals.cost, input.costMode),
        },
    ];
}

/** The real usage totals and chart, without the Account-bound resource reader. */
export function TeamCredentialUsageSummary(props: Readonly<{
    result: ReturnType<typeof useTeamCredentialUsage>['result'];
    period: UsagePeriod;
    costMode: UsageCostMode;
    showRequests: boolean;
    completeness: string;
    costUsd: number | null;
    /** One point per bucket of the range; a bucket the Home recorded nothing for is a zero at the baseline. */
    series: readonly (UsageTrendPoint & { requests: number; recorded?: boolean })[];
    chartMetrics: readonly UsageVolumeMetric[];
    selectedMetric: UsageVolumeMetric;
    seriesMotion: ReturnType<typeof useUsageSeriesMotion>;
    refreshing: boolean;
    onRefresh: () => void;
}>): React.ReactElement {
    const { result, period, costMode, showRequests, completeness, costUsd, series,
        chartMetrics, selectedMetric, seriesMotion, refreshing, onRefresh } = props;
    const coverage = result?.coverage ?? null;
    const { theme } = useUnistyles();
    const currency = result?.totals.cost.currency ?? 'USD';
    const format = usageSeriesValueFormatter(selectedMetric, currency);
    const metricName = selectedMetric === 'requests' && coverage !== null
        ? usageRequestMetricLabel(coverage.requestCountCoverage)
        : metricLabel(selectedMetric);
    // The account Daily chart's own series, shape, lens and exact-values disclosure: the period fills the
    // chart's width, one bar per bucket, and the same events read the same on both pages.
    const chartSeries = React.useMemo(() => usageVolumeSeries(series, selectedMetric, metricName, usageSignatureAccent(theme))
        .map((entry) => ({ ...entry, points: entry.points.map((point) => {
            const label = seriesBucketLabel(Number(point.x), period);
            return { ...point, x: label, label };
        }) })), [series, selectedMetric, metricName, theme, period]);
    const axisTicks = React.useMemo(() => usageAxisTicks(chartSeries[0]?.points.map((point) => point.label ?? '') ?? []), [chartSeries]);
    const shape = useUsageDailyChartShape();
    const charted = result !== null && series.length > 0 && chartMetrics.length > 0;
    const details = useUsageChartDetails(t('usage.usageOverTime'), charted);
    const lens = useUsageSeriesLens({ series: chartSeries, format, accentColor: theme.colors.text.primary,
        testID: 'team-credential-usage-series.lens' });
    return <>
            {result !== null ? (
                <ItemGroup
                    // The page is "Usage"; this section is the period's figures, named as on the account page.
                    title={t('usage.widgets.usage_period_summary')}
                    description={completeness || undefined}
                    // Usage follows new writes by itself; this brings the period's end up to now.
                    action={(
                        <SectionActionButton
                            testID="team-credential-usage-refresh"
                            icon="arrow-clockwise"
                            title={t('common.refresh')}
                            loading={refreshing}
                            onPress={onRefresh}
                        />
                    )}
                >
                    {/* The headline figures, as on the account Usage page: one stat each, unknown as a dash with why. */}
                    <SectionContentRow>
                        <UsagePeriodSummaryBody
                            testID="team-credential-usage"
                            theme={projectPluginUiTheme(theme)}
                            spacing={{ body: theme.space.s20, statColumns: theme.space.s24, statRows: theme.space.s16 }}
                            stats={teamCredentialUsageStats({ result, coverage, showRequests, costUsd, costMode })}
                        />
                    </SectionContentRow>
                </ItemGroup>
            ) : null}

            {charted ? (
                <ItemGroup title={t('usage.usageOverTime')}>
                    <SectionContentRow>
                        <UsageDailyChart theme={projectPluginUiTheme(theme)} gap={theme.space.s10} testID="team-credential-usage-series" chart={{
                            ...details,
                            ...seriesMotion,
                            ...lens,
                            label: metricName,
                            series: chartSeries,
                            size: 'full',
                            viewportHeight: shape.plotPx,
                            ...usageDailyBarGeometry(series.length),
                            axisTicks,
                            // Money scales to the data; a count never draws a fractional axis.
                            ...(selectedMetric === 'cost' ? {} : { minimumMaximum: 1 }),
                            showScaleValues: true,
                            showPeakValue: shape.peak,
                            unknownLabel: t('common.unavailable'),
                            showReadout: false,
                            valuesLabel: t('usage.showAll'),
                            valuesCollapseLabel: t('usage.showLess'),
                            valueFormatter: format,
                        }} />
                    </SectionContentRow>
                </ItemGroup>
            ) : null}

    </>;
}

const ResourceUsage = React.memo(function ResourceUsage(props: Readonly<{
    context: TeamSectionContext; resourceId: string;
}>) {
    const view = useTeamCredentialResourceView(props);
    return <CredentialUsage scope={props.context.scope} address={props.context.address}
        target={{ resourceId: props.resourceId }} view={view} featureEnabled={view.featureEnabled}
        displayName={view.displayName ?? t('teams.credentials.title')} />;
});

export const TeamCredentialUsageScreen = React.memo(function TeamCredentialUsageScreen(props: Readonly<{
    serverId: string;
} & ({ teamId: string; resourceId: string; subject?: never }
    | { subject: UsageSubject; teamId?: never; resourceId?: never })>) {
    const featureEnabled = useFeatureEnabled('teams.credentialResources', { scopeKind: 'spawn', serverId: props.serverId });
    if (props.subject?.kind === 'home') {
        return <HomeAdministrationSection serverId={props.serverId} title={t('teams.credentials.usage.title')}
            description={t('homeGovernance.pages.usage')}
            forbiddenBody={t('teams.credentials.usage.homeAdminRequired')}>
            {(context) => <CredentialUsage scope={context.scope} address={null} target={{ subject: props.subject }}
                featureEnabled={featureEnabled} displayName={context.homeName} />}
        </HomeAdministrationSection>;
    }
    return (
        <TeamSection
            serverId={props.serverId}
            teamId={props.subject ? props.subject.teamId : props.teamId}
            title={t('teams.credentials.usage.title')}
            description={props.subject ? t('teams.pages.credentialUsageTeam') : t('teams.pages.credentialUsage')}
        >
            {(context) => props.subject
                ? <CredentialUsage scope={context.scope} address={context.address} target={{ subject: props.subject }}
                    featureEnabled={featureEnabled} displayName={context.team.name} />
                : <ResourceUsage context={context} resourceId={props.resourceId} />}
        </TeamSection>
    );
});
