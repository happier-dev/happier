import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useAuth } from '@/auth/context/AuthContext';
import { usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import type { CurrentUiContextMountedEnrichment } from '@/components/appShell/currentUiContext/currentUiContextModel';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { HappyError } from '@/utils/errors/errors';
import { t } from '@/text';
import { useConnectedServiceQuotaSummaries } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';
import { buildConnectedServiceQuotaSummaryCards } from '@/components/settings/connectedServices/buildConnectedServiceQuotaSummaryCards';
import {
    buildUsageAnalyticsViewModel,
    type UsageCostMode,
    type UsageFilterState,
    type UsageFocus,
    type UsageMetric,
} from '@/sync/api/account/usageAnalytics';
import { UsageAnalyticsDashboard } from './UsageAnalyticsDashboard';
import { SessionUsageDrilldownFrame } from './SessionUsageDrilldownFrame';
import { UsageLoadingSkeleton } from './sections';
import { useUsageAnalyticsQuery } from '@/sync/api/account/useUsageAnalyticsQuery';
import { getUsagePeriodDefinition } from '@/sync/api/account/usagePeriods';

type UsagePanelProps = {
    sessionId?: string;
    initialFilters?: UsageFilterState;
    onFiltersChange?: (filters: UsageFilterState) => void;
    /** Extra bottom padding for the full-page route (floating-nav clearance, D-R2-10). */
    contentBottomInset?: number;
};

type ConnectedServiceQuotaCards = ReturnType<typeof buildConnectedServiceQuotaSummaryCards>;

function resolveInitialFilters(initialFilters?: UsageFilterState): UsageFilterState {
    return initialFilters ?? {
        period: '7days',
        metric: 'tokens',
        costMode: 'auto',
        focus: null,
    };
}

function areUsageFocusEqual(left: UsageFocus | null, right: UsageFocus | null): boolean {
    if (left == null || right == null) {
        return left === right;
    }

    return left.dimension === right.dimension
        && left.key === right.key
        && left.label === right.label;
}

function areUsageFiltersEqual(left: UsageFilterState, right: UsageFilterState): boolean {
    return left.period === right.period
        && left.metric === right.metric
        && left.costMode === right.costMode
        && areUsageFocusEqual(left.focus, right.focus);
}

const styles = StyleSheet.create((theme) => ({
    loadingContainer: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
}));

function UsagePanelCurrentUiContext(props: Readonly<{
    enrichment: CurrentUiContextMountedEnrichment | null;
}>): null {
    usePublishCurrentUiContext(props.enrichment);
    return null;
}

export const UsagePanel: React.FC<UsagePanelProps> = ({ sessionId, initialFilters, onFiltersChange, contentBottomInset }) => {
    const auth = useAuth();
    const resolvedInitialFilters = React.useMemo(() => resolveInitialFilters(initialFilters), [initialFilters]);
    const [period, setPeriod] = React.useState<UsageFilterState['period']>(resolvedInitialFilters.period);
    const [metric, setMetric] = React.useState<UsageMetric>(resolvedInitialFilters.metric);
    const [costMode, setCostMode] = React.useState<UsageCostMode>(resolvedInitialFilters.costMode);
    const [focus, setFocus] = React.useState<UsageFocus | null>(resolvedInitialFilters.focus);
    const [reloadToken, setReloadToken] = React.useState(0);
    const hasPublishedFiltersRef = React.useRef(false);
    const lastAppliedInitialFiltersRef = React.useRef<UsageFilterState>(resolvedInitialFilters);
    const latestOnFiltersChangeRef = React.useRef(onFiltersChange);
    const {
        summaries: connectedServiceQuotaSummaries,
        isRefreshing: connectedServiceQuotaSummariesRefreshing,
        hasConnectedProfiles: hasConnectedServiceQuotaProfiles,
    } = useConnectedServiceQuotaSummaries();
    const usageQuery = useUsageAnalyticsQuery({
        credentials: auth.credentials,
        enabled: auth.credentials != null,
        period,
        sessionId,
        focus,
        costMode,
        reloadToken,
    });
    const usageData = usageQuery.data;
    const loading = usageQuery.isLoading;
    const errorMessage = usageQuery.error instanceof HappyError
        ? usageQuery.error.message
        : usageQuery.error != null || !auth.credentials
            ? t('errors.unknownError')
            : null;

    React.useEffect(() => {
        latestOnFiltersChangeRef.current = onFiltersChange;
    }, [onFiltersChange]);

    React.useEffect(() => {
        if (areUsageFiltersEqual(lastAppliedInitialFiltersRef.current, resolvedInitialFilters)) {
            return;
        }

        lastAppliedInitialFiltersRef.current = resolvedInitialFilters;
        setPeriod((current) => current === resolvedInitialFilters.period ? current : resolvedInitialFilters.period);
        setMetric((current) => current === resolvedInitialFilters.metric ? current : resolvedInitialFilters.metric);
        setCostMode((current) => current === resolvedInitialFilters.costMode ? current : resolvedInitialFilters.costMode);
        setFocus((current) => areUsageFocusEqual(current, resolvedInitialFilters.focus) ? current : resolvedInitialFilters.focus);
    }, [resolvedInitialFilters]);

    React.useEffect(() => {
        const nextFilters = {
            period,
            metric,
            costMode,
            focus,
        } satisfies UsageFilterState;

        if (!hasPublishedFiltersRef.current) {
            hasPublishedFiltersRef.current = true;
            return;
        }

        latestOnFiltersChangeRef.current?.(nextFilters);
    }, [period, metric, costMode, focus]);

    React.useEffect(() => {
        if (!focus || !usageData) return;
        const nextViewModel = buildUsageAnalyticsViewModel(usageData, {
            period,
            metric,
            costMode,
            focus,
        });
        if (nextViewModel.filteredUsageCount === 0) setFocus(null);
    }, [costMode, focus, metric, period, usageData]);

    const viewModel = React.useMemo(() => {
        return buildUsageAnalyticsViewModel(usageData ?? [], {
            period,
            metric,
            costMode,
            focus,
        });
    }, [usageData, period, metric, costMode, focus]);
    const connectedServiceQuotaCards = React.useMemo<ConnectedServiceQuotaCards>(
        () => buildConnectedServiceQuotaSummaryCards(connectedServiceQuotaSummaries),
        [connectedServiceQuotaSummaries],
    );
    const isAccountUsageScreen = sessionId === undefined;
    const currentUiContextEnrichment = React.useMemo<CurrentUiContextMountedEnrichment | null>(() => {
        if (!isAccountUsageScreen) return null;
        const periodLabel = t(getUsagePeriodDefinition(period).translationKey);
        const metricLabel = metric === 'cost' ? t('usage.cost') : t('usage.tokens');
        return {
            entity: {
                kind: 'usage_summary',
                label: t('usage.summary.title'),
                summary: `${periodLabel} · ${metricLabel}`,
            },
        };
    }, [isAccountUsageScreen, metric, period]);

    const content = loading && usageData == null
        ? (
            // Skeletons that echo sections 1–3 while the first response is in
            // flight — never a spinner (L6 loading contract).
            <View style={styles.loadingContainer}>
                <UsageLoadingSkeleton />
            </View>
        )
        : (
            <>
                {sessionId ? (
                    <SessionUsageDrilldownFrame sessionId={sessionId} />
                ) : null}
                <UsageAnalyticsDashboard
                    viewModel={viewModel}
                    connectedServiceQuotaCards={connectedServiceQuotaCards}
                    connectedServiceQuotasRefreshing={connectedServiceQuotaSummariesRefreshing}
                    showConnectedServiceQuotaSectionWhenEmpty={hasConnectedServiceQuotaProfiles}
                    filters={{ period, metric, costMode, focus }}
                    sessionId={sessionId}
                    contentBottomInset={contentBottomInset}
                    isRefreshing={loading && usageData != null}
                    errorMessage={errorMessage}
                    onPeriodChange={(nextPeriod) => {
                        setPeriod(nextPeriod);
                    }}
                    onMetricChange={(nextMetric) => {
                        setMetric(nextMetric);
                    }}
                    onCostModeChange={(nextCostMode) => {
                        setCostMode(nextCostMode);
                    }}
                    onFocusChange={(nextFocus) => {
                        setFocus(nextFocus);
                    }}
                    onRetry={() => {
                        setReloadToken((value) => value + 1);
                    }}
                />
            </>
        );

    return (
        <PluginSurfaceFocusEligibilityProvider
            active={isAccountUsageScreen}
            currentUiContextActive={isAccountUsageScreen}
        >
            <UsagePanelCurrentUiContext enrichment={currentUiContextEnrichment} />
            {content}
        </PluginSurfaceFocusEligibilityProvider>
    );
};
