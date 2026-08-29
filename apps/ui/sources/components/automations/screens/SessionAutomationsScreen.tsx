import React from 'react';
import { Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { layout } from '@/components/ui/layout/layout';
import { getExistingSessionAutomationUnavailableReason } from '@/components/automations/shared/existingSessionAutomationAvailabilityUi';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import {
    useActiveServerAccountScope,
    useAutomations,
    useSession,
    useSettings,
} from '@/sync/domains/state/storage';
import { resolveExistingSessionAutomationAvailability } from '@/sync/domains/automations/existingSessionAutomationAvailability';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { sync } from '@/sync/sync';
import { filterAutomationDefinitionsLinkedToSession } from '@/sync/domains/automations/automationSessionLink';
import { AutomationListGroup } from '@/components/automations/list/AutomationListGroup';
import { useAutomationRunNowController } from '@/components/automations/list/useAutomationRunNowController';
import { AutomationsEmptyState } from '@/components/automations/shared/AutomationsEmptyState';
import { t } from '@/text';
import { navigateWithBlurOnWeb } from '@/utils/platform/deferOnWeb';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { isSessionRouteHydrationAvailable } from '@/sync/domains/session/sessionRouteHydrationState';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { VirtualizedList } from '@/components/ui/lists/virtualized';
import { buildAutomationListSegments } from '@/components/automations/list/automationListSegmentation';
import { useAutomationDefinitionPagination } from '@/components/automations/list/useAutomationDefinitionPagination';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    loading: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    resolvingLinks: {
        minHeight: 96,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

/**
 * One retained definition revision. The association answer is version-scoped:
 * a newer template version is a different question and must be asked again.
 */
function directDetailKey(
    accountScopeKey: string,
    automation: Readonly<{ id: string; templateVersion: number }>,
): string {
    return `${accountScopeKey}\u0000${automation.id}\u0000${automation.templateVersion}`;
}

export function SessionAutomationsScreen(props: {
    sessionId: string;
    hydrationOptions?: Readonly<{ serverId?: string; forceRefresh?: boolean }>;
}) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const activeAccountScope = useActiveServerAccountScope();
    const accountScopeKey = activeAccountScope
        ? serverAccountScopeKeySuffix(activeAccountScope)
        : 'unscoped';
    const routeIdentity = `${accountScopeKey}\u0000${props.sessionId}`;
    const automations = useAutomations();
    // The bounded list does not disclose private recipe targets. Resolve only
    // unloaded existing-Session candidates through the canonical direct
    // definition reader before associating them with this Session.
    const undisclosedExistingSessionDefinitions = React.useMemo(
        () => automations.filter((automation) => (
            automation.targetType === 'existingSession'
            && automation.detail.kind === 'unloaded'
            && automation.linkedExistingSessionId === null
        )),
        [automations],
    );
    const [completedDirectDetailKeys, setCompletedDirectDetailKeys] = React.useState<ReadonlySet<string>>(
        () => new Set<string>(),
    );
    // A read that FAILED is not a read that answered. Keeping the two in one
    // "already attempted" set is what let one rejection hide every remaining
    // association for the route lifetime; keeping them apart lets the failed
    // ones be re-admitted by an explicit retry without re-arming an automatic
    // loop for a target that is still failing.
    const [failedDirectDetailKeys, setFailedDirectDetailKeys] = React.useState<ReadonlySet<string>>(
        () => new Set<string>(),
    );
    const directDetailsToResolve = React.useMemo(
        () => undisclosedExistingSessionDefinitions.filter((automation) => {
            const key = directDetailKey(accountScopeKey, automation);
            return !completedDirectDetailKeys.has(key) && !failedDirectDetailKeys.has(key);
        }),
        [accountScopeKey, completedDirectDetailKeys, failedDirectDetailKeys, undisclosedExistingSessionDefinitions],
    );
    const hasUnresolvedDirectDetailFailure = React.useMemo(
        () => undisclosedExistingSessionDefinitions.some(
            (automation) => failedDirectDetailKeys.has(directDetailKey(accountScopeKey, automation)),
        ),
        [accountScopeKey, failedDirectDetailKeys, undisclosedExistingSessionDefinitions],
    );
    const routeHydrationState = useHydrateSessionForRoute(
        props.sessionId,
        'SessionAutomationsScreen.hydrateTargetSession',
        props.hydrationOptions,
    );
    const sessionHydrated = isSessionRouteHydrationAvailable(routeHydrationState);
    const session = useSession(props.sessionId);
    const settings = useSettings();
    const sessionDekBase64 = sync.getSessionEncryptionKeyBase64ForResume(props.sessionId);
    const [loadingState, setLoadingState] = React.useState(() => ({
        routeIdentity,
        value: true,
    }));
    const [refreshFailure, setRefreshFailure] = React.useState(() => ({
        routeIdentity,
        value: false,
    }));
    const currentRouteIdentityRef = React.useRef(routeIdentity);
    currentRouteIdentityRef.current = routeIdentity;
    const mountedRef = React.useRef(true);
    React.useEffect(() => () => {
        mountedRef.current = false;
    }, []);
    const isInvocationCurrent = React.useCallback(
        () => mountedRef.current && currentRouteIdentityRef.current === routeIdentity,
        [routeIdentity],
    );
    // A newly selected Account has not completed its authoritative read even
    // if the previous Account settled its own refresh. Treat that first render
    // as pending instead of briefly enabling cached mutations before the
    // refresh effect runs.
    const loading = loadingState.routeIdentity === routeIdentity
        ? loadingState.value
        : true;
    const refreshFailed = refreshFailure.routeIdentity === routeIdentity && refreshFailure.value;
    const runNow = useAutomationRunNowController();
    const pagination = useAutomationDefinitionPagination();

    const refresh = React.useCallback(async () => {
        const requestRouteIdentity = routeIdentity;
        try {
            setLoadingState({ routeIdentity: requestRouteIdentity, value: true });
            setRefreshFailure({ routeIdentity: requestRouteIdentity, value: false });
            await sync.refreshAutomations();
        } catch {
            if (mountedRef.current && currentRouteIdentityRef.current === requestRouteIdentity) {
                setRefreshFailure({ routeIdentity: requestRouteIdentity, value: true });
            }
        } finally {
            if (mountedRef.current && currentRouteIdentityRef.current === requestRouteIdentity) {
                setLoadingState({ routeIdentity: requestRouteIdentity, value: false });
            }
        }
    }, [routeIdentity]);

    // One recovery affordance for "this surface could not finish loading",
    // whichever half failed: the list refresh, the private association reads,
    // or both. Re-admitting the failed reads is what makes them eligible for
    // the resolution effect again.
    const retryFailedLoads = React.useCallback(() => {
        setFailedDirectDetailKeys(new Set<string>());
        void refresh();
    }, [refresh]);

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    React.useEffect(() => {
        if (loading || directDetailsToResolve.length === 0) return;
        let alive = true;
        void (async () => {
            const resolvedKeys: string[] = [];
            const failedKeys: string[] = [];
            // Accounts can contain thousands of listed definitions, so this
            // resolution runs through the shared request-concurrency owner and
            // stops issuing reads the moment the route retires instead of
            // fanning out one request each.
            // Each read owns its own outcome: a rejection that escaped the
            // task would also cancel its peers' queue.
            await runTasksWithLimit(
                directDetailsToResolve.map((automation) => async () => {
                    if (!alive) return;
                    try {
                        await sync.refreshAutomationDefinitionDetail(automation.id);
                        resolvedKeys.push(directDetailKey(accountScopeKey, automation));
                    } catch {
                        failedKeys.push(directDetailKey(accountScopeKey, automation));
                    }
                }),
                loadSyncTuning().automationDefinitionDetailHydrationConcurrencyLimit,
            );
            if (!alive) return;
            if (resolvedKeys.length > 0) {
                setCompletedDirectDetailKeys((previous) => {
                    const next = new Set(previous);
                    for (const key of resolvedKeys) next.add(key);
                    return next;
                });
            }
            if (failedKeys.length > 0) {
                setFailedDirectDetailKeys((previous) => {
                    const next = new Set(previous);
                    for (const key of failedKeys) next.add(key);
                    return next;
                });
            }
        })();
        return () => {
            alive = false;
        };
    }, [accountScopeKey, directDetailsToResolve, loading]);

    const linked = React.useMemo(() => {
        return filterAutomationDefinitionsLinkedToSession(automations, props.sessionId);
    }, [automations, props.sessionId]);
    const machineIdOverride = readMachineControlTargetForSession(props.sessionId)?.machineId ?? null;
    const availability = React.useMemo(() => resolveExistingSessionAutomationAvailability({
        sessionHydrated,
        session,
        machineIdOverride,
        sessionDekBase64,
        accountSettings: settings,
    }), [machineIdOverride, session, sessionDekBase64, sessionHydrated, settings]);
    const addAutomationUnavailableReason = React.useMemo(
        () => getExistingSessionAutomationUnavailableReason(availability),
        [availability],
    );
    const linkedSegments = React.useMemo(
        () => buildAutomationListSegments(linked),
        [linked],
    );
    const listFailureHeader = refreshFailed || hasUnresolvedDirectDetailFailure ? (
        <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
            <ItemGroup>
                <Item
                    testID="session-automations-stale-refresh-error"
                    title={t('automations.session.failedToLoad')}
                    icon={<Icon name="warning" size={20} color={theme.colors.state.warning.foreground} />}
                    mode="info"
                    showChevron={false}
                    accessibilityRole="alert"
                    accessibilityLiveRegion="assertive"
                    webRole="alert"
                />
                <Item
                    testID="session-automations-stale-refresh-retry"
                    title={t('common.retry')}
                    icon={<Icon name="arrow-clockwise" size={20} color={theme.colors.accent.blue} />}
                    onPress={retryFailedLoads}
                    showChevron={false}
                />
            </ItemGroup>
        </View>
    ) : null;
    const actionsFooter = (
        <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
            <ItemGroup title={t('common.actions')}>
                <Item
                    title={t('automations.session.addAutomation')}
                    subtitle={addAutomationUnavailableReason ?? undefined}
                    icon={<Icon name="plus" size={29} color={theme.colors.accent.blue} />}
                    onPress={() => navigateWithBlurOnWeb(() => router.push(`/session/${props.sessionId}/automations/new` as any))}
                    disabled={availability.kind !== 'ready'}
                />
            </ItemGroup>
        </View>
    );
    const paginationFooter = pagination.loadingMore ? (
        <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%', minHeight: 64, justifyContent: 'center' }}>
            <ActivitySpinner size="small" color={theme.colors.text.secondary} />
        </View>
    ) : pagination.hasMore ? (
        <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
            <ItemGroup>
                <Item
                    testID="session-automations-load-more"
                    title={t(pagination.loadMoreFailed ? 'common.retry' : 'common.more')}
                    icon={<Icon name={pagination.loadMoreFailed ? 'arrow-clockwise' : 'arrow-down'} size={20} color={theme.colors.accent.blue} />}
                    onPress={pagination.requestPage}
                    showChevron={false}
                    accessibilityRole="button"
                />
            </ItemGroup>
        </View>
    ) : null;
    if (loading && linked.length === 0) {
        return (
            <View style={styles.loading}>
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
            </View>
        );
    }

    if (refreshFailed && linked.length === 0) {
        return (
            <View style={styles.container}>
                <SurfaceStateCard
                    testID="session-automations-refresh-error"
                    kind="error"
                    title={t('common.error')}
                    reason={t('automations.session.failedToLoad')}
                    action={{
                        label: t('common.retry'),
                        onPress: retryFailedLoads,
                    }}
                    accessibilitySemantics="alert"
                />
            </View>
        );
    }

    if (linked.length > 0) {
        return (
            <View style={styles.container}>
                <VirtualizedList
                    testID="session-automations-list"
                    data={linkedSegments}
                    keyExtractor={(segment) => segment.key}
                    renderItem={({ item }) => (
                        <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                            <AutomationListGroup
                                {...(item.first ? { title: t('sessionInfo.automationsTitle') } : {})}
                                automations={item.automations}
                                mutationsEnabled={!loading && !refreshFailed}
                                runNow={runNow}
                                isInvocationCurrent={isInvocationCurrent}
                                virtualizedSegment={{ first: item.first, last: item.last }}
                            />
                        </View>
                    )}
                    style={{ flex: 1, ...(Platform.OS === 'web' ? { minHeight: 0 } : {}) }}
                    contentContainerStyle={{ paddingBottom: Platform.OS === 'ios' ? 34 : 16 }}
                    backendPreference="auto"
                    initialNumToRender={4}
                    ListHeaderComponent={listFailureHeader}
                    ListFooterComponent={<>{paginationFooter}{actionsFooter}</>}
                    onEndReached={pagination.hasMore && !pagination.loadingMore && !pagination.loadMoreFailed
                        ? pagination.requestPage
                        : undefined}
                    onEndReachedThreshold={0.35}
                />
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <ItemList style={{ paddingTop: 0 }}>
                <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                    {listFailureHeader}
                    {directDetailsToResolve.length > 0 ? (
                        <View style={styles.resolvingLinks}>
                            <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                        </View>
                    ) : (
                        <AutomationsEmptyState
                            title={t('automations.session.emptyTitle')}
                            body={t('automations.session.emptyBody')}
                        />
                    )}
                    {paginationFooter}
                    {actionsFooter}
                </View>
            </ItemList>
        </View>
    );
}
