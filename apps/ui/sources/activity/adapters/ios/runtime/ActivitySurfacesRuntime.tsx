import * as React from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { addUserInteractionListener } from 'expo-widgets';
import type { FeatureId } from '@happier-dev/protocol';

import { ACTIVITY_SURFACE_TARGETS, createActivitySurfaceSessionRoute } from '@/activity/actions/activitySurfaceTargets';
import { parseActivityInteraction } from '@/activity/actions/parseActivityInteraction';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { buildActivitySurfaceSnapshot, type ActivitySurfaceSnapshot } from '@/activity/presentation/activitySurfaceSnapshot';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { resolveLocalFeaturePolicyEnabled } from '@/sync/domains/features/featureLocalPolicy';
import { useAllSessions, useIsDataReady, useLocalSettings, useSettings } from '@/sync/domains/state/storage';

import { type LiveActivitySnapshot } from '../liveActivities/buildLiveActivitySnapshots';
import { resolveLiveActivityReconciliationState } from '../liveActivities/resolveLiveActivityReconciliationState';

type ActivitySurfaceWidgetModules = typeof import('./iosActivityWidgetModules');
type LiveActivityHandle = Readonly<{
    update: (props: LiveActivitySnapshot) => Promise<void>;
    end: (
        dismissalPolicy?: 'default' | 'immediate' | { after: Date },
        props?: LiveActivitySnapshot,
        contentDate?: Date,
    ) => Promise<void>;
}>;

function isClientFeatureEnabled(featureId: FeatureId, settings: ReturnType<typeof useSettings>): boolean {
    return getFeatureBuildPolicyDecision(featureId) !== 'deny'
        && resolveLocalFeaturePolicyEnabled(featureId, settings);
}

function createEmptyWidgetSnapshot(snapshot: ActivitySurfaceSnapshot): ActivitySurfaceSnapshot {
    return {
        ...snapshot,
        counts: {
            unread: 0,
            permissionRequired: 0,
            actionRequired: 0,
            queuedInput: 0,
            thinking: 0,
            totalAttention: 0,
        },
        summaryCounts: {
            attentionCount: 0,
            runningCount: 0,
            permissionCount: 0,
        },
        primary: null,
        sessions: [],
    };
}

async function endAllLiveActivities(handles: Map<string, LiveActivityHandle>, contentDate: Date): Promise<void> {
    const activeHandles = Array.from(handles.values());
    await Promise.all(activeHandles.map((handle) => handle.end('immediate', undefined, contentDate)));
    handles.clear();
}

function buildActivityInteractionData(params: Readonly<{
    source: string;
    widgetSnapshot: ActivitySurfaceSnapshot;
    liveSnapshots: readonly LiveActivitySnapshot[];
}>): Readonly<{
    defaultTarget: string;
    primarySessionId: string | null;
    sessionId?: string | null;
}> {
    if (params.source === 'HappierFocusLiveActivity') {
        const singleLiveActivitySnapshot = params.liveSnapshots.length === 1
            ? params.liveSnapshots[0] ?? null
            : null;
        return {
            defaultTarget: singleLiveActivitySnapshot?.defaultTarget ?? ACTIVITY_SURFACE_TARGETS.openInbox,
            primarySessionId: singleLiveActivitySnapshot?.sessionId ?? null,
            sessionId: singleLiveActivitySnapshot?.sessionId ?? null,
        };
    }

    return {
        defaultTarget: params.widgetSnapshot.defaultTarget,
        primarySessionId: params.widgetSnapshot.primary?.sessionId ?? null,
    };
}

export function ActivitySurfacesRuntime(): React.ReactElement | null {
    const sessions = useAllSessions();
    const isDataReady = useIsDataReady();
    const settings = useSettings();
    const localSettings = useLocalSettings();

    const policy = React.useMemo(() => {
        const resolved = resolveActivitySurfacePolicy(localSettings);
        return {
            ...resolved,
            liveActivities: {
                ...resolved.liveActivities,
                enabled: resolved.liveActivities.enabled && isClientFeatureEnabled('app.ui.liveActivities', settings),
            },
            widgets: {
                ...resolved.widgets,
                enabled: resolved.widgets.enabled && isClientFeatureEnabled('app.ui.homeScreenWidgets', settings),
            },
        };
    }, [localSettings, settings]);

    const widgetSnapshot = React.useMemo(() => {
        return buildActivitySurfaceSnapshot({
            sessions,
            policy,
        });
    }, [policy, sessions]);

    const preferredLiveActivityPrimarySessionIdRef = React.useRef<string | null>(null);
    const liveActivityReconciliationState = React.useMemo(() => {
        return resolveLiveActivityReconciliationState({
            sessions,
            policy,
            currentPreferredPrimarySessionId: preferredLiveActivityPrimarySessionIdRef.current,
        });
    }, [policy, sessions]);
    const liveSnapshots = liveActivityReconciliationState.snapshots;

    const widgetSnapshotRef = React.useRef(widgetSnapshot);
    const liveSnapshotsRef = React.useRef(liveSnapshots);
    const liveActivityHandlesRef = React.useRef(new Map<string, LiveActivityHandle>());
    const widgetModulesRef = React.useRef<ActivitySurfaceWidgetModules | null>(null);
    const clearedExistingLiveActivitiesRef = React.useRef(false);
    const reconcileRunIdRef = React.useRef(0);

    React.useEffect(() => {
        widgetSnapshotRef.current = widgetSnapshot;
    }, [widgetSnapshot]);

    React.useEffect(() => {
        liveSnapshotsRef.current = liveSnapshots;
    }, [liveSnapshots]);

    React.useLayoutEffect(() => {
        preferredLiveActivityPrimarySessionIdRef.current = liveActivityReconciliationState.preferredPrimarySessionId;
    }, [liveActivityReconciliationState.preferredPrimarySessionId]);

    React.useEffect(() => {
        if (Platform.OS !== 'ios') return;

        let cancelled = false;
        const runId = reconcileRunIdRef.current + 1;
        reconcileRunIdRef.current = runId;
        const isStale = () => cancelled || reconcileRunIdRef.current !== runId;

        void (async () => {
            const modules = await import('./iosActivityWidgetModules') as ActivitySurfaceWidgetModules;
            if (isStale()) return;
            widgetModulesRef.current = modules;

            const snapshotToApply = policy.widgets.enabled
                ? widgetSnapshotRef.current
                : createEmptyWidgetSnapshot(widgetSnapshotRef.current);

            modules.HappierFocusWidget.updateSnapshot(snapshotToApply);
            modules.HappierSessionsWidget.updateSnapshot(snapshotToApply);

            const liveActivityFactory = modules.HappierFocusLiveActivity;
            const liveSnapshotsToApply = policy.liveActivities.enabled ? liveSnapshotsRef.current : [];
            const liveActivityHandles = liveActivityHandlesRef.current;
            const contentDate = new Date(widgetSnapshotRef.current.generatedAt);

            if (!clearedExistingLiveActivitiesRef.current) {
                const existingInstances = liveActivityFactory.getInstances();
                liveActivityHandles.clear();

                if (liveSnapshotsToApply.length > 0) {
                    const reusedCount = Math.min(existingInstances.length, liveSnapshotsToApply.length);

                    await Promise.all(existingInstances.slice(0, reusedCount).map((instance, index) =>
                        instance.update(liveSnapshotsToApply[index]!)
                    ));
                    if (isStale()) return;

                    for (let index = 0; index < reusedCount; index += 1) {
                        const snapshot = liveSnapshotsToApply[index];
                        if (!snapshot) continue;
                        liveActivityHandles.set(snapshot.sessionId, existingInstances[index]!);
                    }

                    const staleExistingInstances = existingInstances.slice(reusedCount);
                    await Promise.all(staleExistingInstances.map((instance) =>
                        instance.end('immediate', undefined, contentDate)
                    ));
                    if (isStale()) return;
                    clearedExistingLiveActivitiesRef.current = true;
                } else if (isDataReady || !policy.liveActivities.enabled) {
                    await Promise.all(existingInstances.map((instance) =>
                        instance.end('immediate', undefined, contentDate)
                    ));
                    if (isStale()) return;
                    clearedExistingLiveActivitiesRef.current = true;
                } else {
                    return;
                }
            }

            if (liveSnapshotsToApply.length === 0) {
                await endAllLiveActivities(liveActivityHandles, contentDate);
                if (isStale()) return;
                return;
            }

            const desiredSessionIds = new Set(liveSnapshotsToApply.map((snapshot) => snapshot.sessionId));
            const staleSessionIds = Array.from(liveActivityHandles.keys()).filter((sessionId) => !desiredSessionIds.has(sessionId));

            await Promise.all(staleSessionIds.map(async (sessionId) => {
                const handle = liveActivityHandles.get(sessionId);
                if (!handle) return;
                await handle.end('immediate', undefined, contentDate);
                liveActivityHandles.delete(sessionId);
            }));
            if (isStale()) return;

            for (const snapshot of liveSnapshotsToApply) {
                if (isStale()) return;
                const existingHandle = liveActivityHandles.get(snapshot.sessionId);
                if (existingHandle) {
                    await existingHandle.update(snapshot);
                    continue;
                }

                const nextHandle = liveActivityFactory.start(
                    snapshot,
                    createActivitySurfaceSessionRoute(snapshot.sessionId),
                );
                liveActivityHandles.set(snapshot.sessionId, nextHandle);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [isDataReady, policy.liveActivities.enabled, policy.widgets.enabled, liveSnapshots, widgetSnapshot]);

    React.useEffect(() => {
        return () => {
            if (Platform.OS !== 'ios') return;

            const modules = widgetModulesRef.current;
            if (!modules) return;

            const clearSnapshot = createEmptyWidgetSnapshot(widgetSnapshotRef.current);
            const contentDate = new Date();
            const liveActivityHandles = liveActivityHandlesRef.current;

            modules.HappierFocusWidget.updateSnapshot(clearSnapshot);
            modules.HappierSessionsWidget.updateSnapshot(clearSnapshot);

            void (async () => {
                const activityHandles = new Set<LiveActivityHandle>([
                    ...Array.from(liveActivityHandles.values()),
                    ...modules.HappierFocusLiveActivity.getInstances(),
                ]);
                await Promise.all(Array.from(activityHandles).map((handle) =>
                    handle.end('immediate', undefined, contentDate)
                ));
                liveActivityHandles.clear();
            })();
        };
    }, []);

    React.useEffect(() => {
        if (Platform.OS !== 'ios') return;

        const subscription = addUserInteractionListener((event) => {
            const interactionData = buildActivityInteractionData({
                source: event.source,
                widgetSnapshot: widgetSnapshotRef.current,
                liveSnapshots: liveSnapshotsRef.current,
            });
            const parsed = parseActivityInteraction({
                actionIdentifier: event.target,
                defaultActionIdentifier: interactionData.defaultTarget,
                data: interactionData,
            });
            if (!parsed?.route) return;
            router.push(parsed.route);
        });

        return () => {
            subscription.remove();
        };
    }, []);

    return null;
}

export default ActivitySurfacesRuntime;
