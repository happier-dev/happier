import React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { layout } from '@/components/ui/layout/layout';
import { getExistingSessionAutomationUnavailableReason } from '@/components/automations/shared/existingSessionAutomationAvailabilityUi';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { useAutomations, useSession, useSettings } from '@/sync/domains/state/storage';
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
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import { storeTempData } from '@/utils/sessions/tempDataStore';

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
function directDetailKey(automation: Readonly<{ id: string; templateVersion: number }>): string {
    return `${automation.id}\u0000${automation.templateVersion}`;
}

export function SessionAutomationsScreen(props: {
    sessionId: string;
    hydrationOptions?: Readonly<{ serverId?: string; forceRefresh?: boolean }>;
}) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const automations = useAutomations();
    // The definition owner publishes the existing-Session association on the
    // bounded list, so only a retained predecessor template — whose
    // association is readable solely by a client that can open it — still
    // needs a direct private read. Answering the association question by
    // fanning private detail reads across the whole Account is neither
    // necessary nor privacy-preserving.
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
            const key = directDetailKey(automation);
            return !completedDirectDetailKeys.has(key) && !failedDirectDetailKeys.has(key);
        }),
        [completedDirectDetailKeys, failedDirectDetailKeys, undisclosedExistingSessionDefinitions],
    );
    const hasUnresolvedDirectDetailFailure = React.useMemo(
        () => undisclosedExistingSessionDefinitions.some(
            (automation) => failedDirectDetailKeys.has(directDetailKey(automation)),
        ),
        [failedDirectDetailKeys, undisclosedExistingSessionDefinitions],
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
    const [loading, setLoading] = React.useState(true);
    const [refreshFailure, setRefreshFailure] = React.useState(() => ({
        sessionId: props.sessionId,
        value: false,
    }));
    const currentSessionIdRef = React.useRef(props.sessionId);
    currentSessionIdRef.current = props.sessionId;
    const refreshFailed = refreshFailure.sessionId === props.sessionId && refreshFailure.value;
    const runNow = useAutomationRunNowController();

    const refresh = React.useCallback(async () => {
        const requestSessionId = props.sessionId;
        try {
            setLoading(true);
            setRefreshFailure({ sessionId: requestSessionId, value: false });
            await sync.refreshAutomations();
        } catch {
            if (currentSessionIdRef.current === requestSessionId) {
                setRefreshFailure({ sessionId: requestSessionId, value: true });
            }
        } finally {
            if (currentSessionIdRef.current === requestSessionId) {
                setLoading(false);
            }
        }
    }, [props.sessionId]);

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
                        resolvedKeys.push(directDetailKey(automation));
                    } catch {
                        failedKeys.push(directDetailKey(automation));
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
    }, [directDetailsToResolve, loading]);

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
    const eventTargetServerId = resolveServerIdForSessionIdFromLocalCache(props.sessionId);
    const canHandOffExistingSessionEvent = availability.kind === 'ready' && eventTargetServerId !== null;
    const handleAddEventAutomation = React.useCallback(() => {
        if (!eventTargetServerId) return;
        const dataId = storeTempData({
            replacePersistedDraftSelections: true,
            eventAutomationInitialTarget: {
                kind: 'existingSession' as const,
                sessionId: props.sessionId,
                serverId: eventTargetServerId,
            },
        });
        navigateWithBlurOnWeb(() => router.push(`/new?automation=1&dataId=${dataId}` as any));
    }, [eventTargetServerId, props.sessionId, router]);

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

    return (
        <View style={styles.container}>
            <ItemList style={{ paddingTop: 0 }}>
                <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                    {refreshFailed || hasUnresolvedDirectDetailFailure ? (
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
                    ) : null}
                    {linked.length === 0 ? (
                        directDetailsToResolve.length > 0 ? (
                            <View style={styles.resolvingLinks}>
                                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                            </View>
                        ) : (
                            <AutomationsEmptyState
                                title={t('automations.session.emptyTitle')}
                                body={t('automations.session.emptyBody')}
                            />
                        )
                    ) : (
                        <AutomationListGroup
                            title={t('sessionInfo.automationsTitle')}
                            automations={linked}
                            mutationsEnabled={!refreshFailed}
                            runNow={runNow}
                        />
                    )}

                    <ItemGroup title={t('common.actions')}>
                        <Item
                            title={t('automations.session.addAutomation')}
                            subtitle={addAutomationUnavailableReason ?? undefined}
                            icon={<Icon name="plus" size={29} color={theme.colors.accent.blue} />}
                            onPress={() => navigateWithBlurOnWeb(() => router.push(`/session/${props.sessionId}/automations/new` as any))}
                            disabled={availability.kind !== 'ready'}
                        />
                        <Item
                            testID="session-automations-add-event-automation"
                            title={t('automations.session.addEventAutomation')}
                            subtitle={canHandOffExistingSessionEvent ? undefined : addAutomationUnavailableReason ?? undefined}
                            icon={<Icon name="lightning" size={29} color={theme.colors.accent.blue} />}
                            onPress={handleAddEventAutomation}
                            disabled={!canHandOffExistingSessionEvent}
                        />
                    </ItemGroup>
                </View>
            </ItemList>
        </View>
    );
}
