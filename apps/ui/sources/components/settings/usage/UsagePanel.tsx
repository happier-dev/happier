import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { useAuth } from '@/auth/context/AuthContext';
import { HappyError } from '@/utils/errors/errors';
import { t } from '@/text';
import { getUsageForPeriod, type UsageResponse } from '@/sync/api/account/apiUsage';
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

type UsagePanelProps = {
    sessionId?: string;
    initialFilters?: UsageFilterState;
    onFiltersChange?: (filters: UsageFilterState) => void;
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
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
        backgroundColor: theme.colors.groupped.background,
    },
    loadingText: {
        marginTop: 12,
        fontSize: 14,
        color: theme.colors.textSecondary,
        fontWeight: '600',
    },
}));

export const UsagePanel: React.FC<UsagePanelProps> = ({ sessionId, initialFilters, onFiltersChange }) => {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const resolvedInitialFilters = React.useMemo(() => resolveInitialFilters(initialFilters), [initialFilters]);
    const [period, setPeriod] = React.useState<UsageFilterState['period']>(resolvedInitialFilters.period);
    const [metric, setMetric] = React.useState<UsageMetric>(resolvedInitialFilters.metric);
    const [costMode, setCostMode] = React.useState<UsageCostMode>(resolvedInitialFilters.costMode);
    const [focus, setFocus] = React.useState<UsageFocus | null>(resolvedInitialFilters.focus);
    const [usageData, setUsageData] = React.useState<UsageResponse | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
    const [reloadToken, setReloadToken] = React.useState(0);
    const hasPublishedFiltersRef = React.useRef(false);
    const lastAppliedInitialFiltersRef = React.useRef<UsageFilterState>(resolvedInitialFilters);
    const latestOnFiltersChangeRef = React.useRef(onFiltersChange);
    const {
        summaries: connectedServiceQuotaSummaries,
        isRefreshing: connectedServiceQuotaSummariesRefreshing,
        hasConnectedProfiles: hasConnectedServiceQuotaProfiles,
    } = useConnectedServiceQuotaSummaries();

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
        let cancelled = false;

        async function loadUsageData() {
            if (!auth.credentials) {
                if (!cancelled) {
                    setUsageData(null);
                    setErrorMessage(t('errors.unknownError'));
                    setLoading(false);
                }
                return;
            }

            setLoading(true);

            try {
                const response = await getUsageForPeriod(auth.credentials, period, sessionId, focus, costMode);
                if (cancelled) {
                    return;
                }

                const nextViewModel = buildUsageAnalyticsViewModel(response, {
                    period,
                    metric,
                    costMode,
                    focus,
                });

                setUsageData(response);
                setErrorMessage(null);
                if (focus && nextViewModel.filteredUsageCount === 0) {
                    setFocus(null);
                }
            } catch (error) {
                if (cancelled) {
                    return;
                }

                if (error instanceof HappyError) {
                    setErrorMessage(error.message);
                } else {
                    setErrorMessage(t('errors.unknownError'));
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        }

        void loadUsageData();

        return () => {
            cancelled = true;
        };
    }, [auth.credentials, period, sessionId, focus, costMode, reloadToken]);

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

    if (loading && usageData == null) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color={theme.colors.accent.blue} />
                <Text style={styles.loadingText}>{t('common.loading')}</Text>
            </View>
        );
    }

    return (
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
};
