import {
    buildActivityOverviewFromCandidates,
    buildStableActivityOverviewFingerprint,
} from '@/activity/attention/buildActivityOverviewSnapshot';
import * as React from 'react';
import { AppState, Platform } from 'react-native';
import { router } from 'expo-router';
import { addUserInteractionListener } from 'expo-widgets';
import { HAPPIER_FOCUS_LIVE_ACTIVITY_NAME } from '@happier-dev/protocol/activity/live/remoteUpdates';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { FeatureId } from '@happier-dev/protocol/features/catalog';

import {
    type ActivityInteractionIdentity,
    resolveActivityInteractionCommand,
} from '@/activity/actions/resolveActivityInteractionCommand';
import {
    ACTIVITY_SURFACE_TARGETS,
    createActivitySurfaceSessionRoute,
    parseActivitySurfaceSessionTarget,
} from '@/activity/actions/activitySurfaceTargets';
import { buildActivitySurfaceSnapshot, type ActivitySurfaceSnapshot } from '@/activity/presentation/activitySurfaceSnapshot';
import {
    buildActivityOverviewFromSource,
} from '@/activity/source/buildActivityOverviewFromSource';
import { useActivityAttentionSource } from '@/activity/source/useActivityAttentionSource';
import { resolveActivitySurfaceDeliveryAdmission } from '@/activity/delivery/resolveActivitySurfaceDeliveryAdmission';
import { useExactHomeAccountSettings } from '@/activity/delivery/useExactHomeAccountSettings';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { resolveLocalFeaturePolicyEnabled, type FeatureLocalPolicySettings } from '@/sync/domains/features/featureLocalPolicy';
import { useServerFeaturesMainSelectionSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { useLocalSettings, useSetting } from '@/sync/domains/state/storage';
import { activityInstanceKey, sessionAddressKey } from '@/sync/domains/session/sessionAddress';

import {
    buildStableLiveActivitySnapshotFingerprint,
    type LiveActivitySnapshot,
} from '../liveActivities/buildLiveActivitySnapshots';
import {
    readLiveActivityAuthorizationDiagnostics,
    type LiveActivityAuthorizationDiagnostics,
} from '../liveActivities/readLiveActivityAuthorizationDiagnostics';
import { resolveLiveActivityReconciliationState } from '../liveActivities/resolveLiveActivityReconciliationState';
import {
    resolveLiveActivityRuntimeVisibility,
    resolveLiveActivityUpdateBudget,
    shouldApplyLiveActivityUpdate,
} from '../liveActivities/resolveLiveActivityUpdateBudget';
import {
    createLiveActivityRemoteTargetRegistry,
} from '../liveActivities/registerLiveActivityRemoteTarget';
import { resolveIosActivitySurfacePolicies } from './resolveIosActivitySurfacePolicies';
import {
    markLiveActivityRemoteTargetEnded,
    reconcileLiveActivityRemoteTargetRegistration,
    removeLiveActivityPushTokenSubscription,
    resolveLiveActivityRemoteRegistrationPlan,
    type LiveActivityPushTokenEvent,
    type LiveActivityPushTokenSubscription,
} from './liveActivityRemoteTargetRuntime';
import {
    clearLiveActivityBackgroundWakeCurrentStates,
    forgetLiveActivityBackgroundWakeCurrentState,
    rememberLiveActivityBackgroundWakeSnapshot,
    syncLiveActivityBackgroundWakeTaskRegistration,
} from '../backgroundWake/defineLiveActivityBackgroundWakeTask';

type ActivitySurfaceWidgetModules = typeof import('./iosActivityWidgetModules');
type IosActivityInteractionEvent = Readonly<{
    source: string;
    target: string;
    timestamp: number;
    type: string;
    data?: unknown;
}>;
type LiveActivityHandle = Readonly<{
    update: (props: LiveActivitySnapshot, staleDate?: Date) => Promise<void>;
    end: (
        dismissalPolicy?: 'default' | 'immediate' | { after: Date },
        props?: LiveActivitySnapshot,
        contentDate?: Date,
    ) => Promise<void>;
    addPushTokenListener?: (listener: (event: LiveActivityPushTokenEvent) => void) => { remove: () => void };
    getPushToken?: () => Promise<string | null>;
}>;

const LIVE_ACTIVITY_START_RETRY_DELAY_MS = 60_000;
const LIVE_ACTIVITY_GRACEFUL_DISMISSAL_MS = 5 * 60_000;
const LIVE_ACTIVITY_ACTIVE_CAP_MS = 8 * 60 * 60_000;
type LiveActivityDismissalPolicy = 'default' | 'immediate' | { after: Date };

function isClientFeatureEnabled(featureId: FeatureId, settings: FeatureLocalPolicySettings): boolean {
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

function updateWidgetSnapshotSafely(
    widget: Readonly<{ updateSnapshot: (snapshot: ActivitySurfaceSnapshot) => void }>,
    snapshot: ActivitySurfaceSnapshot,
): void {
    try {
        widget.updateSnapshot(snapshot);
    } catch {
        // Widget bridge failures must not surface as app-level runtime errors.
    }
}

async function endLiveActivityHandle(
    handle: LiveActivityHandle,
    dismissalPolicy: LiveActivityDismissalPolicy,
    contentDate: Date,
): Promise<void> {
    try {
        await handle.end(dismissalPolicy, undefined, contentDate);
    } catch {
        // The native activity may already have been dismissed or expired. The
        // JS reconciler still drops the handle so future starts do not target
        // an orphaned bridge object.
    }
}

function isUrgentLiveActivitySnapshot(snapshot: LiveActivitySnapshot | undefined): boolean {
    return snapshot?.attentionState === 'permission_required' || snapshot?.attentionState === 'action_required';
}

function resolveLiveActivityDismissalPolicy(
    snapshot: LiveActivitySnapshot | undefined,
    contentDate: Date,
): LiveActivityDismissalPolicy {
    if (snapshot === undefined || isUrgentLiveActivitySnapshot(snapshot)) {
        return 'immediate';
    }

    return { after: new Date(contentDate.getTime() + LIVE_ACTIVITY_GRACEFUL_DISMISSAL_MS) };
}

async function endAllLiveActivities(
    handles: Map<string, LiveActivityHandle>,
    snapshots: Map<string, LiveActivitySnapshot>,
    lastAppliedAt: Map<string, number>,
    startedAt: Map<string, number>,
    pushTokenSubscriptions: Map<string, LiveActivityPushTokenSubscription>,
    remoteTargetRegistry: ReturnType<typeof createLiveActivityRemoteTargetRegistry>,
    contentDate: Date,
): Promise<void> {
    const activityKeys = new Set([
        ...handles.keys(),
        ...snapshots.keys(),
        ...remoteTargetRegistry.listTargets().map((target) => target.activityInstanceKey),
    ]);
    await Promise.all(Array.from(activityKeys).map(async (activityKey) => {
        const handle = handles.get(activityKey);
        const snapshot = snapshots.get(activityKey);
        if (handle) {
            await endLiveActivityHandle(handle, resolveLiveActivityDismissalPolicy(snapshot, contentDate), contentDate);
        }
        removeLiveActivityPushTokenSubscription(pushTokenSubscriptions, activityKey);
        forgetLiveActivityBackgroundWakeCurrentState(activityKey);
        const retainedTarget = remoteTargetRegistry.listTargets()
            .find((target) => target.activityInstanceKey === activityKey);
        await markLiveActivityRemoteTargetEnded({
            registry: remoteTargetRegistry,
            activityInstanceKey: activityKey,
            serverId: snapshot?.serverId ?? retainedTarget?.serverId,
        }).catch(() => undefined);
        handles.delete(activityKey);
        snapshots.delete(activityKey);
        lastAppliedAt.delete(activityKey);
        startedAt.delete(activityKey);
    }));
    pushTokenSubscriptions.clear();
}

function buildActivityInteractionData(params: Readonly<{
    source: string;
    target: string;
    data?: unknown;
    widgetSnapshot: ActivitySurfaceSnapshot;
    liveSnapshots: readonly LiveActivitySnapshot[];
}>): Readonly<{
    defaultTarget: string;
    primarySessionId: string | null;
    serverId?: string | null;
    sessionId?: string | null;
    activityName?: string | null;
    activityInstanceKey?: string | null;
}> {
    const eventData = isRecord(params.data) ? params.data : {};
    if (params.source === 'HappierFocusLiveActivity') {
        const singleLiveActivitySnapshot = params.liveSnapshots.length === 1
            ? params.liveSnapshots[0] ?? null
            : null;
        return {
            defaultTarget: singleLiveActivitySnapshot?.defaultTarget ?? ACTIVITY_SURFACE_TARGETS.openInbox,
            primarySessionId: singleLiveActivitySnapshot?.sessionId ?? null,
            serverId: singleLiveActivitySnapshot?.serverId ?? null,
            sessionId: singleLiveActivitySnapshot?.sessionId ?? null,
            activityName: singleLiveActivitySnapshot?.activityName ?? null,
            activityInstanceKey: singleLiveActivitySnapshot?.activityInstanceKey ?? null,
            ...eventData,
        };
    }

    const targetIdentity = parseActivitySurfaceSessionTarget(params.target);
    const targetedSessions = targetIdentity
        ? params.widgetSnapshot.sessions.filter((session) =>
            session.sessionId === targetIdentity.sessionId
                && (!targetIdentity.serverId || session.serverId === targetIdentity.serverId)
        )
        : [];
    const targetedSession = targetedSessions.length === 1 ? targetedSessions[0] ?? null : null;
    const primarySession = targetedSession ?? params.widgetSnapshot.primary;

    return {
        defaultTarget: params.widgetSnapshot.defaultTarget,
        primarySessionId: params.widgetSnapshot.primary?.sessionId ?? null,
        serverId: primarySession?.serverId ?? null,
        sessionId: primarySession?.sessionId ?? null,
        ...eventData,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildKnownActivityInteractionIdentities(params: Readonly<{
    sourceOverview: ReturnType<typeof buildActivityOverviewFromSource>;
    widgetSnapshot: ActivitySurfaceSnapshot;
    liveSnapshots: readonly LiveActivitySnapshot[];
}>): readonly ActivityInteractionIdentity[] {
    const identities = new Map<string, ActivityInteractionIdentity>();
    for (const candidate of params.sourceOverview.candidates) {
        const serverId = (typeof candidate.serverId === 'string' ? candidate.serverId.trim() : '') || null;
        const identity = {
            serverId,
            sessionId: candidate.sessionId,
            activityName: candidate.activityName ?? undefined,
            activityInstanceKey: candidate.activityInstanceKey ?? undefined,
        };
        identities.set(JSON.stringify([
            activityInstanceKey(
                { serverId: identity.serverId, sessionId: identity.sessionId },
                identity.activityName ?? 'source',
            ),
            'source',
            identity.activityName ?? null,
            identity.activityInstanceKey ?? null,
        ]), identity);
    }
    for (const snapshot of params.liveSnapshots) {
        const identity = {
            serverId: snapshot.serverId,
            sessionId: snapshot.sessionId,
            activityName: snapshot.activityName,
            activityInstanceKey: snapshot.activityInstanceKey,
        };
        identities.set(JSON.stringify([
            activityInstanceKey(
                { serverId: identity.serverId, sessionId: identity.sessionId },
                identity.activityName,
            ),
            'live',
            identity.activityName,
            identity.activityInstanceKey,
        ]), identity);
    }
    for (const session of params.widgetSnapshot.sessions) {
        const serverId = (typeof session.serverId === 'string' ? session.serverId.trim() : '') || null;
        const identity = {
            serverId,
            sessionId: session.sessionId,
        };
        identities.set(JSON.stringify([
            activityInstanceKey(
                { serverId: identity.serverId, sessionId: identity.sessionId },
                'widget',
            ),
            'widget',
        ]), identity);
    }
    return Array.from(identities.values());
}

function resolveRouteServerId(serverId: string | null | undefined): string | null {
    const normalized = typeof serverId === 'string' ? serverId.trim() : '';
    return normalized || null;
}

function buildWidgetBridgeFingerprint(params: Readonly<{
    sourceOverview: ReturnType<typeof buildActivityOverviewFromSource>;
    widgetPolicy: ReturnType<typeof resolveIosActivitySurfacePolicies>['widgetPolicy'];
    deliveryFingerprint: string;
}>): string {
    return JSON.stringify({
        source: buildStableActivityOverviewFingerprint(params.sourceOverview),
        // An exact-Home Account policy mutation changes admission or privacy without
        // changing the attention source, so the bridge must resync on it too.
        delivery: params.deliveryFingerprint,
        enabled: params.widgetPolicy.widgets.enabled,
        privacyMode: params.widgetPolicy.privacyMode,
        showPreviewText: params.widgetPolicy.widgets.showPreviewText,
        tapTarget: params.widgetPolicy.tapTarget,
    });
}

/** Opaque exact-address key shared by the widget admission and interaction gates. */
function activitySurfaceAddressKey(serverId: string | null | undefined, sessionId: string): string {
    const normalized = typeof serverId === 'string' ? serverId.trim() : '';
    return sessionAddressKey({ serverId: normalized, sessionId });
}

function hasVerifiedLiveActivityIdentity(params: Readonly<{
    identity: ActivityInteractionIdentity | null;
    liveSnapshots: readonly LiveActivitySnapshot[];
    previewableLiveActivityKeys: ReadonlySet<string>;
}>): boolean {
    if (!params.identity) return false;
    return params.liveSnapshots.some((snapshot) =>
        snapshot.serverId === params.identity!.serverId
            && snapshot.sessionId === params.identity!.sessionId
            && (!params.identity!.activityName || snapshot.activityName === params.identity!.activityName)
            && (!params.identity!.activityInstanceKey || snapshot.activityInstanceKey === params.identity!.activityInstanceKey)
            && snapshot.allowActionButtons
            // A card its own Home only permits as status or title never carries an action.
            && params.previewableLiveActivityKeys.has(snapshot.activityInstanceKey)
    );
}

function hasVerifiedWidgetIdentity(params: Readonly<{
    identity: ActivityInteractionIdentity | null;
    widgetSnapshot: ActivitySurfaceSnapshot;
    previewableWidgetAddressKeys: ReadonlySet<string>;
}>): boolean {
    if (!params.identity) return false;
    return params.widgetSnapshot.sessions.some((session) => {
        const serverId = (typeof session.serverId === 'string' ? session.serverId.trim() : '') || null;
        return serverId === params.identity!.serverId
            && session.sessionId === params.identity!.sessionId
            && params.previewableWidgetAddressKeys.has(
                activitySurfaceAddressKey(session.serverId, session.sessionId),
            );
    });
}

function hasExecutableSourceIdentity(params: Readonly<{
    identity: ActivityInteractionIdentity | null;
    sourceOverview: ReturnType<typeof buildActivityOverviewFromSource>;
}>): boolean {
    if (!params.identity) return false;
    return params.sourceOverview.candidates.some((candidate) =>
        candidate.directActionCapability?.canExecute === true
            && candidate.serverId === params.identity!.serverId
            && candidate.sessionId === params.identity!.sessionId
            && (!params.identity!.activityName || candidate.activityName === params.identity!.activityName)
            && (!params.identity!.activityInstanceKey || candidate.activityInstanceKey === params.identity!.activityInstanceKey)
    );
}

function canExecuteIosDirectAction(params: Readonly<{
    event: IosActivityInteractionEvent;
    identity: ActivityInteractionIdentity | null;
    sourceOverview: ReturnType<typeof buildActivityOverviewFromSource>;
    widgetSnapshot: ActivitySurfaceSnapshot;
    liveSnapshots: readonly LiveActivitySnapshot[];
    previewableLiveActivityKeys: ReadonlySet<string>;
    previewableWidgetAddressKeys: ReadonlySet<string>;
}>): boolean {
    if (!hasExecutableSourceIdentity({
        identity: params.identity,
        sourceOverview: params.sourceOverview,
    })) {
        return false;
    }

    if (params.event.source === 'HappierFocusLiveActivity') {
        return hasVerifiedLiveActivityIdentity({
            identity: params.identity,
            liveSnapshots: params.liveSnapshots,
            previewableLiveActivityKeys: params.previewableLiveActivityKeys,
        });
    }

    return hasVerifiedWidgetIdentity({
        identity: params.identity,
        widgetSnapshot: params.widgetSnapshot,
        previewableWidgetAddressKeys: params.previewableWidgetAddressKeys,
    });
}

function canAttemptIosDirectActionFromSurface(params: Readonly<{
    event: IosActivityInteractionEvent;
    liveSnapshots: readonly LiveActivitySnapshot[];
    liveActivityPolicy: ReturnType<typeof resolveIosActivitySurfacePolicies>['liveActivityPolicy'];
    previewableLiveActivityKeys: ReadonlySet<string>;
    previewableWidgetAddressKeys: ReadonlySet<string>;
}>): boolean {
    if (params.event.source === 'HappierFocusLiveActivity') {
        return params.liveSnapshots.some((snapshot) =>
            snapshot.allowActionButtons
                && params.previewableLiveActivityKeys.has(snapshot.activityInstanceKey));
    }

    return params.previewableWidgetAddressKeys.size > 0
        && params.liveActivityPolicy.liveActivities.allowActionButtons;
}

function resolveLiveActivitySnapshotUpdateBudget(params: Readonly<{
    snapshot: LiveActivitySnapshot;
    runtimeVisibility: ReturnType<typeof resolveLiveActivityRuntimeVisibility>;
    frequentUpdates: LiveActivityAuthorizationDiagnostics['frequentUpdates'];
}>): LiveActivitySnapshot {
    const updateBudget = resolveLiveActivityUpdateBudget({
        attentionState: params.snapshot.attentionState,
        runtimeVisibility: params.runtimeVisibility,
        frequentUpdates: params.frequentUpdates,
    });
    if (
        params.snapshot.presentationTemplate === updateBudget.template
        && params.snapshot.apnsPriority === updateBudget.apnsPriority
    ) {
        return params.snapshot;
    }
    return {
        ...params.snapshot,
        presentationTemplate: updateBudget.template,
        apnsPriority: updateBudget.apnsPriority,
    };
}

function createUnavailableAuthorizationDiagnostics(): LiveActivityAuthorizationDiagnostics {
    return {
        source: 'unavailable',
        activities: 'unavailable',
        frequentUpdates: 'unavailable',
    };
}

type LiveActivityAuthorizationCheckState = Readonly<{
    diagnostics: LiveActivityAuthorizationDiagnostics;
    checkedAppStateStatus: string | null;
}>;

function createInitialLiveActivityAuthorizationCheckState(): LiveActivityAuthorizationCheckState {
    return {
        diagnostics: createUnavailableAuthorizationDiagnostics(),
        checkedAppStateStatus: null,
    };
}

export function ActivitySurfacesRuntime(): React.ReactElement | null {
    const activitySource = useActivityAttentionSource();
    const resolveAccountSettings = useExactHomeAccountSettings(activitySource.audienceScopes);
    const isDataReady = activitySource.isDataReady;
    const experiments = useSetting('experiments');
    const featureToggles = useSetting('featureToggles');
    const localSettings = useLocalSettings();
    const activityNowMs = Date.now();
    const [appStateStatus, setAppStateStatus] = React.useState(() => AppState.currentState);
    const [liveActivityAuthorizationCheck, setLiveActivityAuthorizationCheck] = React.useState(
        createInitialLiveActivityAuthorizationCheckState,
    );
    const liveActivityAuthorizationDiagnostics = liveActivityAuthorizationCheck.diagnostics;
    const isLiveActivityAuthorizationCurrent =
        liveActivityAuthorizationCheck.checkedAppStateStatus === appStateStatus;
    const runtimeVisibility = React.useMemo(() =>
        resolveLiveActivityRuntimeVisibility({ appStateStatus }),
    [appStateStatus]);

    const policies = React.useMemo(() => {
        const settings = { experiments, featureToggles };
        const resolved = resolveIosActivitySurfacePolicies({ localSettings });
        return {
            liveActivityPolicy: {
                ...resolved.liveActivityPolicy,
                liveActivities: {
                    ...resolved.liveActivityPolicy.liveActivities,
                    enabled: resolved.liveActivityPolicy.liveActivities.enabled
                        && isClientFeatureEnabled('app.ui.liveActivities', settings),
                },
            },
            widgetPolicy: {
                ...resolved.widgetPolicy,
                widgets: {
                    ...resolved.widgetPolicy.widgets,
                    enabled: resolved.widgetPolicy.widgets.enabled
                        && isClientFeatureEnabled('app.ui.homeScreenWidgets', settings),
                },
            },
        };
    }, [experiments, featureToggles, localSettings]);
    const liveActivityPolicy = policies.liveActivityPolicy;
    const widgetPolicy = policies.widgetPolicy;

    const sourceOverview = React.useMemo(() => {
        return buildActivityOverviewFromSource({
            source: activitySource,
            nowMs: activityNowMs,
            activityName: HAPPIER_FOCUS_LIVE_ACTIVITY_NAME,
            directActionsEnabled: liveActivityPolicy.liveActivities.allowActionButtons,
        });
    }, [activityNowMs, activitySource, liveActivityPolicy.liveActivities.allowActionButtons]);

    // Each candidate is admitted and privacy-projected by its own Home's Account
    // delivery plan before any surface selects or presents it. A Home whose exact
    // Account policy is unavailable is absent from both surfaces.
    const deliveryNow = React.useMemo(() => new Date(activityNowMs), [activityNowMs]);
    const liveActivityAdmission = React.useMemo(() => resolveActivitySurfaceDeliveryAdmission({
        candidates: sourceOverview.candidates,
        surface: 'live_activity',
        resolveAccountSettings,
        localSettings,
        now: deliveryNow,
    }), [deliveryNow, localSettings, resolveAccountSettings, sourceOverview]);
    const widgetAdmission = React.useMemo(() => resolveActivitySurfaceDeliveryAdmission({
        candidates: sourceOverview.candidates,
        surface: 'home_widget',
        resolveAccountSettings,
        localSettings,
        now: deliveryNow,
    }), [deliveryNow, localSettings, resolveAccountSettings, sourceOverview]);
    const liveActivityOverview = React.useMemo(
        () => buildActivityOverviewFromCandidates(liveActivityAdmission.candidates),
        [liveActivityAdmission],
    );
    const widgetOverview = React.useMemo(
        () => buildActivityOverviewFromCandidates(widgetAdmission.candidates),
        [widgetAdmission],
    );
    const previewableLiveActivityKeys = React.useMemo(() => new Set(liveActivityAdmission.candidates
        .filter((candidate) => liveActivityAdmission.privacyModeFor(candidate) === 'include_preview')
        .flatMap((candidate) => (candidate.activityInstanceKey ? [candidate.activityInstanceKey] : []))),
    [liveActivityAdmission]);
    const previewableWidgetAddressKeys = React.useMemo(() => new Set(widgetAdmission.candidates
        .filter((candidate) => widgetAdmission.privacyModeFor(candidate) === 'include_preview')
        .map((candidate) => activitySurfaceAddressKey(candidate.serverId, candidate.sessionId))),
    [widgetAdmission]);
    const liveActivityTiming = liveActivityOverview.candidates[0]?.surfaceTiming?.liveActivity ?? null;
    const liveActivitySessions = React.useMemo(() => {
        return liveActivityOverview.candidates.map((candidate) => candidate.session);
    }, [liveActivityOverview]);
    const widgetSessions = React.useMemo(() => {
        return widgetOverview.candidates.map((candidate) => candidate.session);
    }, [widgetOverview]);

    const widgetSnapshot = React.useMemo(() => {
        return buildActivitySurfaceSnapshot({
            sessions: widgetSessions,
            overview: widgetOverview,
            policy: widgetPolicy,
            nowMs: activityNowMs,
            resolveCandidatePrivacyMode: widgetAdmission.privacyModeFor,
        });
    }, [activityNowMs, widgetAdmission, widgetOverview, widgetSessions, widgetPolicy]);

    const preferredLiveActivityPrimaryAddressRef = React.useRef<Readonly<{
        serverId: string;
        sessionId: string;
    }> | null>(null);
    const preferredLiveActivityPrimaryActivityInstanceKeyRef = React.useRef<string | null>(null);
    const preferredLiveActivityPrimaryChangedAtMsRef = React.useRef<number | null>(null);
    const liveActivityReconciliationState = React.useMemo(() => {
        return resolveLiveActivityReconciliationState({
            sessions: liveActivitySessions,
            overview: liveActivityOverview,
            policy: liveActivityPolicy,
            resolveCandidatePrivacyMode: liveActivityAdmission.privacyModeFor,
            currentPreferredPrimaryAddress: preferredLiveActivityPrimaryAddressRef.current,
            currentPreferredPrimaryActivityInstanceKey: preferredLiveActivityPrimaryActivityInstanceKeyRef.current,
            currentPreferredPrimaryChangedAtMs: preferredLiveActivityPrimaryChangedAtMsRef.current,
            dwellMs: liveActivityTiming?.dwellMs,
            staleAfterMs: liveActivityTiming?.staleAfterMs,
            nowMs: activityNowMs,
        });
    }, [
        activityNowMs,
        liveActivityAdmission,
        liveActivityOverview,
        liveActivityPolicy,
        liveActivitySessions,
        liveActivityTiming,
    ]);
    const liveSnapshots = liveActivityReconciliationState.snapshots;

    const widgetSnapshotRef = React.useRef(widgetSnapshot);
    const liveSnapshotsRef = React.useRef(liveSnapshots);
    const liveActivityHandlesRef = React.useRef(new Map<string, LiveActivityHandle>());
    const liveActivityLastSnapshotsRef = React.useRef(new Map<string, LiveActivitySnapshot>());
    const liveActivityLastAppliedAtRef = React.useRef(new Map<string, number>());
    const liveActivityStartedAtRef = React.useRef(new Map<string, number>());
    const liveActivityStartFailuresRef = React.useRef(new Map<string, number>());
    const liveActivityPushTokenSubscriptionsRef = React.useRef(new Map<string, LiveActivityPushTokenSubscription>());
    const liveActivityRemoteTargetRegistryRef = React.useRef(createLiveActivityRemoteTargetRegistry());
    const widgetModulesRef = React.useRef<ActivitySurfaceWidgetModules | null>(null);
    const widgetBridgeFingerprintRef = React.useRef<string | null>(null);
    const actionExecutorRef = React.useRef(createDefaultActionExecutor());
    const clearedExistingLiveActivitiesRef = React.useRef(false);
    const reconcileRunIdRef = React.useRef(0);
    const liveActivityServerIdKey = React.useMemo(() => {
        return Array.from(new Set(liveSnapshots.map((snapshot) => snapshot.serverId)))
            .filter((serverId): serverId is string => typeof serverId === 'string' && serverId.length > 0)
            .sort()
            .join('\0');
    }, [liveSnapshots]);
    const liveActivityServerIds = React.useMemo(() => (
        liveActivityServerIdKey ? liveActivityServerIdKey.split('\0') : []
    ), [liveActivityServerIdKey]);
    const serverFeaturesSnapshot = useServerFeaturesMainSelectionSnapshot(liveActivityServerIds, {
        enabled: Platform.OS === 'ios' && liveActivityServerIds.length > 0,
    });
    const backgroundWakeFallbackEnabled = React.useMemo(() => {
        if (Platform.OS !== 'ios' || !liveActivityPolicy.liveActivities.enabled) return false;
        return liveSnapshots.some((snapshot) => {
            const plan = resolveLiveActivityRemoteRegistrationPlan({
                snapshot,
                accountSettings: resolveAccountSettings(snapshot.serverId),
                localSettings,
                serverFeaturesSnapshot,
            });
            return plan.mode === 'background_wake_best_effort' && plan.status === 'remote_available';
        });
    }, [
        liveActivityPolicy.liveActivities.enabled,
        liveSnapshots,
        localSettings,
        resolveAccountSettings,
        serverFeaturesSnapshot,
    ]);

    React.useEffect(() => {
        widgetSnapshotRef.current = widgetSnapshot;
    }, [widgetSnapshot]);

    React.useEffect(() => {
        liveSnapshotsRef.current = liveSnapshots;
    }, [liveSnapshots]);

    React.useLayoutEffect(() => {
        preferredLiveActivityPrimaryAddressRef.current = liveActivityReconciliationState.preferredPrimaryAddress;
        preferredLiveActivityPrimaryActivityInstanceKeyRef.current =
            liveActivityReconciliationState.preferredPrimaryActivityInstanceKey;
        preferredLiveActivityPrimaryChangedAtMsRef.current =
            liveActivityReconciliationState.preferredPrimaryChangedAtMs;
    }, [
        liveActivityReconciliationState.preferredPrimaryActivityInstanceKey,
        liveActivityReconciliationState.preferredPrimaryChangedAtMs,
        liveActivityReconciliationState.preferredPrimaryAddress,
    ]);

    React.useEffect(() => {
        if (Platform.OS !== 'ios') return;

        void syncLiveActivityBackgroundWakeTaskRegistration({
            fallbackEnabled: backgroundWakeFallbackEnabled,
        });
    }, [backgroundWakeFallbackEnabled]);

    React.useEffect(() => {
        if (Platform.OS !== 'ios') return;

        const subscription = AppState.addEventListener('change', (nextStatus) => {
            setAppStateStatus(nextStatus);
        });
        return () => {
            subscription.remove();
        };
    }, []);

    React.useEffect(() => {
        if (Platform.OS !== 'ios') return;

        let cancelled = false;
        const checkedAppStateStatus = appStateStatus;
        void (async () => {
            const diagnostics = await readLiveActivityAuthorizationDiagnostics();
            if (!cancelled) {
                setLiveActivityAuthorizationCheck({
                    diagnostics,
                    checkedAppStateStatus,
                });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [appStateStatus]);

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

            const snapshotToApply = widgetPolicy.widgets.enabled
                ? widgetSnapshotRef.current
                : createEmptyWidgetSnapshot(widgetSnapshotRef.current);
            const widgetBridgeFingerprint = buildWidgetBridgeFingerprint({
                sourceOverview: widgetOverview,
                widgetPolicy,
                deliveryFingerprint: widgetAdmission.fingerprint,
            });

            if (widgetBridgeFingerprintRef.current !== widgetBridgeFingerprint) {
                widgetBridgeFingerprintRef.current = widgetBridgeFingerprint;
                updateWidgetSnapshotSafely(modules.HappierFocusWidget, snapshotToApply);
                updateWidgetSnapshotSafely(modules.HappierSessionsWidget, snapshotToApply);
            }

            const liveActivityFactory = modules.HappierFocusLiveActivity;
            if (liveActivityPolicy.liveActivities.enabled && !isLiveActivityAuthorizationCurrent) {
                return;
            }

            const liveSnapshotsToApply = liveActivityPolicy.liveActivities.enabled ? liveSnapshotsRef.current : [];
            const authorizedLiveSnapshotsToApply = liveActivityAuthorizationDiagnostics.activities === 'disabled'
                ? []
                : liveSnapshotsToApply;
            const liveActivityHandles = liveActivityHandlesRef.current;
            const liveActivityLastSnapshots = liveActivityLastSnapshotsRef.current;
            const liveActivityLastAppliedAt = liveActivityLastAppliedAtRef.current;
            const liveActivityStartedAt = liveActivityStartedAtRef.current;
            const liveActivityPushTokenSubscriptions = liveActivityPushTokenSubscriptionsRef.current;
            const liveActivityRemoteTargetRegistry = liveActivityRemoteTargetRegistryRef.current;
            const contentDate = new Date(widgetSnapshotRef.current.generatedAt);

            if (!clearedExistingLiveActivitiesRef.current) {
                const existingInstances = liveActivityFactory.getInstances();
                liveActivityHandles.clear();
                liveActivityLastSnapshots.clear();
                liveActivityLastAppliedAt.clear();
                liveActivityStartedAt.clear();
                liveActivityPushTokenSubscriptions.forEach((subscription) => subscription.remove());
                liveActivityPushTokenSubscriptions.clear();
                liveActivityRemoteTargetRegistry.clear();
                clearLiveActivityBackgroundWakeCurrentStates();

                if (authorizedLiveSnapshotsToApply.length > 0) {
                    await Promise.all(existingInstances.map((instance) =>
                        endLiveActivityHandle(instance, 'immediate', contentDate)
                    ));
                    if (isStale()) return;
                    clearedExistingLiveActivitiesRef.current = true;
                } else if (isDataReady || !liveActivityPolicy.liveActivities.enabled) {
                    await Promise.all(existingInstances.map((instance) =>
                        endLiveActivityHandle(instance, 'immediate', contentDate)
                    ));
                    if (isStale()) return;
                    clearedExistingLiveActivitiesRef.current = true;
                } else {
                    return;
                }
            }

            if (authorizedLiveSnapshotsToApply.length === 0) {
                await endAllLiveActivities(
                    liveActivityHandles,
                    liveActivityLastSnapshots,
                    liveActivityLastAppliedAt,
                    liveActivityStartedAt,
                    liveActivityPushTokenSubscriptions,
                    liveActivityRemoteTargetRegistry,
                    contentDate,
                );
                if (isStale()) return;
                return;
            }

            const desiredActivityKeys = new Set(authorizedLiveSnapshotsToApply.map((snapshot) => snapshot.activityInstanceKey));
            const staleActivityKeys = Array.from(new Set([
                ...liveActivityHandles.keys(),
                ...liveActivityLastSnapshots.keys(),
            ])).filter((activityKey) => !desiredActivityKeys.has(activityKey));

            await Promise.all(staleActivityKeys.map(async (activityKey) => {
                const handle = liveActivityHandles.get(activityKey);
                if (handle) {
                    await endLiveActivityHandle(
                        handle,
                        resolveLiveActivityDismissalPolicy(liveActivityLastSnapshots.get(activityKey), contentDate),
                        contentDate,
                    );
                }
                removeLiveActivityPushTokenSubscription(liveActivityPushTokenSubscriptions, activityKey);
                liveActivityHandles.delete(activityKey);
                liveActivityLastSnapshots.delete(activityKey);
                liveActivityLastAppliedAt.delete(activityKey);
                liveActivityStartedAt.delete(activityKey);
                forgetLiveActivityBackgroundWakeCurrentState(activityKey);
            }));
            // Remote cleanup is deliberately separate from native/local teardown. A failed call
            // leaves the exact target in this same registry and every later reconciliation retries
            // it. There is no timer, outbox, second registry or synthetic lifecycle.
            const undesiredRemoteActivityKeys = new Set(liveActivityRemoteTargetRegistry.listTargets()
                .map((target) => target.activityInstanceKey)
                .filter((activityKey) => !desiredActivityKeys.has(activityKey)));
            await Promise.all([...undesiredRemoteActivityKeys]
                .map((activityInstanceKey) => markLiveActivityRemoteTargetEnded({
                    registry: liveActivityRemoteTargetRegistry,
                    activityInstanceKey,
                    serverId: liveActivityRemoteTargetRegistry.listTargets()
                        .find((target) => target.activityInstanceKey === activityInstanceKey)?.serverId,
                }).catch(() => undefined)));
            if (isStale()) return;

            for (const candidateSnapshot of authorizedLiveSnapshotsToApply) {
                if (isStale()) return;
                const snapshot = resolveLiveActivitySnapshotUpdateBudget({
                    snapshot: candidateSnapshot,
                    runtimeVisibility,
                    frequentUpdates: liveActivityAuthorizationDiagnostics.frequentUpdates,
                });
                const activityKey = snapshot.activityInstanceKey;
                let existingHandle = liveActivityHandles.get(activityKey);
                const startedAtMs = liveActivityStartedAt.get(activityKey);
                if (
                    existingHandle
                    && typeof startedAtMs === 'number'
                    && activityNowMs - startedAtMs >= LIVE_ACTIVITY_ACTIVE_CAP_MS
                ) {
                    await endLiveActivityHandle(existingHandle, 'immediate', contentDate);
                    removeLiveActivityPushTokenSubscription(liveActivityPushTokenSubscriptions, activityKey);
                    forgetLiveActivityBackgroundWakeCurrentState(activityKey);
                    await markLiveActivityRemoteTargetEnded({
                        registry: liveActivityRemoteTargetRegistry,
                        activityInstanceKey: activityKey,
                        serverId: liveActivityLastSnapshots.get(activityKey)?.serverId,
                    }).catch(() => undefined);
                    liveActivityHandles.delete(activityKey);
                    liveActivityLastSnapshots.delete(activityKey);
                    liveActivityLastAppliedAt.delete(activityKey);
                    liveActivityStartedAt.delete(activityKey);
                    existingHandle = undefined;
                    if (isStale()) return;
                }
                if (existingHandle) {
                    reconcileLiveActivityRemoteTargetRegistration({
                        handle: existingHandle,
                        snapshot,
                        accountSettings: resolveAccountSettings(snapshot.serverId),
                        localSettings,
                        serverFeaturesSnapshot,
                        pushTokenSubscriptions: liveActivityPushTokenSubscriptions,
                        remoteTargetRegistry: liveActivityRemoteTargetRegistry,
                    });
                    const previousSnapshot = liveActivityLastSnapshots.get(activityKey);
                    if (
                        previousSnapshot
                        && buildStableLiveActivitySnapshotFingerprint(previousSnapshot)
                            === buildStableLiveActivitySnapshotFingerprint(snapshot)
                    ) {
                        continue;
                    }
                    const updateBudget = resolveLiveActivityUpdateBudget({
                        attentionState: snapshot.attentionState,
                        runtimeVisibility,
                        frequentUpdates: liveActivityAuthorizationDiagnostics.frequentUpdates,
                    });
                    if (!shouldApplyLiveActivityUpdate({
                        budget: updateBudget,
                        lastAppliedAtMs: liveActivityLastAppliedAt.get(activityKey),
                        nowMs: activityNowMs,
                    })) {
                        continue;
                    }

                    try {
                        await existingHandle.update(snapshot, new Date(snapshot.staleAt));
                        liveActivityLastSnapshots.set(activityKey, snapshot);
                        liveActivityLastAppliedAt.set(activityKey, activityNowMs);
                        rememberLiveActivityBackgroundWakeSnapshot(snapshot);
                        liveActivityStartFailuresRef.current.delete(activityKey);
                    } catch {
                        liveActivityHandles.delete(activityKey);
                        liveActivityLastSnapshots.delete(activityKey);
                        liveActivityLastAppliedAt.delete(activityKey);
                        liveActivityStartedAt.delete(activityKey);
                        forgetLiveActivityBackgroundWakeCurrentState(activityKey);
                        liveActivityStartFailuresRef.current.set(activityKey, Date.now());
                    }
                    continue;
                }

                const failedAtMs = liveActivityStartFailuresRef.current.get(activityKey);
                if (
                    typeof failedAtMs === 'number'
                    && Date.now() - failedAtMs < LIVE_ACTIVITY_START_RETRY_DELAY_MS
                ) {
                    continue;
                }

                try {
                    const nextHandle = liveActivityFactory.start(
                        snapshot,
                        createActivitySurfaceSessionRoute(
                            snapshot.sessionId,
                            resolveRouteServerId(snapshot.serverId),
                        ),
                        new Date(snapshot.staleAt),
                    );
                    liveActivityStartFailuresRef.current.delete(activityKey);
                    liveActivityHandles.set(activityKey, nextHandle);
                    liveActivityLastSnapshots.set(activityKey, snapshot);
                    liveActivityLastAppliedAt.set(activityKey, activityNowMs);
                    liveActivityStartedAt.set(activityKey, activityNowMs);
                    rememberLiveActivityBackgroundWakeSnapshot(snapshot);
                    reconcileLiveActivityRemoteTargetRegistration({
                        handle: nextHandle,
                        snapshot,
                        accountSettings: resolveAccountSettings(snapshot.serverId),
                        localSettings,
                        serverFeaturesSnapshot,
                        pushTokenSubscriptions: liveActivityPushTokenSubscriptions,
                        remoteTargetRegistry: liveActivityRemoteTargetRegistry,
                    });
                } catch {
                    liveActivityStartFailuresRef.current.set(activityKey, Date.now());
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [
        activityNowMs,
        isDataReady,
        liveActivityAuthorizationDiagnostics.activities,
        isLiveActivityAuthorizationCurrent,
        liveActivityAuthorizationDiagnostics.frequentUpdates,
        liveActivityPolicy.liveActivities.enabled,
        widgetPolicy.widgets.enabled,
        liveSnapshots,
        localSettings,
        resolveAccountSettings,
        runtimeVisibility,
        serverFeaturesSnapshot,
        widgetAdmission,
        widgetOverview,
        widgetSnapshot,
        widgetPolicy,
    ]);

    React.useEffect(() => {
        return () => {
            if (Platform.OS !== 'ios') return;

            const modules = widgetModulesRef.current;
            if (!modules) return;

            const clearSnapshot = createEmptyWidgetSnapshot(widgetSnapshotRef.current);
            const contentDate = new Date();
            const liveActivityHandles = liveActivityHandlesRef.current;
            const liveActivityPushTokenSubscriptions = liveActivityPushTokenSubscriptionsRef.current;
            const liveActivityRemoteTargetRegistry = liveActivityRemoteTargetRegistryRef.current;

            updateWidgetSnapshotSafely(modules.HappierFocusWidget, clearSnapshot);
            updateWidgetSnapshotSafely(modules.HappierSessionsWidget, clearSnapshot);

            void (async () => {
                const activityHandles = new Set<LiveActivityHandle>([
                    ...Array.from(liveActivityHandles.values()),
                    ...modules.HappierFocusLiveActivity.getInstances(),
                ]);
                await Promise.all(Array.from(activityHandles).map((handle) =>
                    endLiveActivityHandle(handle, 'immediate', contentDate)
                ));
                // A failed remote end keeps its exact target in the registry for the incumbent
                // reconnect lifecycle to retry; it must never strand this device's local teardown.
                await Promise.all(Array.from(liveActivityLastSnapshotsRef.current.values()).map((snapshot) =>
                    markLiveActivityRemoteTargetEnded({
                        registry: liveActivityRemoteTargetRegistry,
                        activityInstanceKey: snapshot.activityInstanceKey,
                        serverId: snapshot.serverId,
                    }).catch(() => undefined)
                ));
                clearLiveActivityBackgroundWakeCurrentStates();
                liveActivityPushTokenSubscriptions.forEach((subscription) => subscription.remove());
                liveActivityPushTokenSubscriptions.clear();
                liveActivityHandles.clear();
                liveActivityLastSnapshotsRef.current.clear();
                liveActivityLastAppliedAtRef.current.clear();
                liveActivityStartedAtRef.current.clear();
            })();
        };
    }, []);

    React.useEffect(() => {
        if (Platform.OS !== 'ios') return;

        let subscription: { remove: () => void };
        try {
            subscription = addUserInteractionListener((event: IosActivityInteractionEvent) => {
                const interactionData = buildActivityInteractionData({
                    source: event.source,
                    target: event.target,
                    data: event.data,
                    widgetSnapshot: widgetSnapshotRef.current,
                    liveSnapshots: liveSnapshotsRef.current,
                });
                const directActionsEnabled = canAttemptIosDirectActionFromSurface({
                    event,
                    liveSnapshots: liveSnapshotsRef.current,
                    liveActivityPolicy,
                    previewableLiveActivityKeys,
                    previewableWidgetAddressKeys,
                });
                const command = resolveActivityInteractionCommand({
                    actionIdentifier: event.target,
                    defaultActionIdentifier: interactionData.defaultTarget,
                    data: interactionData,
                    knownIdentities: buildKnownActivityInteractionIdentities({
                        sourceOverview,
                        widgetSnapshot: widgetSnapshotRef.current,
                        liveSnapshots: liveSnapshotsRef.current,
                    }),
                    directActionsEnabled,
                    surfaceName: event.source,
                });
                if (command.kind === 'executeAction') {
                    if (canExecuteIosDirectAction({
                        event,
                        identity: command.identity,
                        sourceOverview,
                        widgetSnapshot: widgetSnapshotRef.current,
                        liveSnapshots: liveSnapshotsRef.current,
                        previewableLiveActivityKeys,
                        previewableWidgetAddressKeys,
                    })) {
                        const serverId = resolveRouteServerId(command.identity?.serverId ?? command.target.serverId);
                        void actionExecutorRef.current.execute(command.actionId as ActionId, command.payload, {
                            surface: 'ui',
                            defaultSessionId: command.defaultSessionId,
                            ...(serverId ? { serverId } : {}),
                        }).catch(() => undefined);
                        return;
                    }
                    const fallbackSessionId = command.identity?.sessionId ?? command.target.sessionId;
                    if (fallbackSessionId) {
                        router.push(createActivitySurfaceSessionRoute(
                            fallbackSessionId,
                            resolveRouteServerId(command.identity?.serverId ?? command.target.serverId),
                        ));
                    }
                    return;
                }

                if (command.kind === 'ignore') {
                    return;
                }

                router.push(command.route);
            });
        } catch {
            return () => undefined;
        }

        return () => {
            subscription.remove();
        };
    }, [
        liveActivityPolicy,
        previewableLiveActivityKeys,
        previewableWidgetAddressKeys,
        sourceOverview,
    ]);

    return null;
}

export default ActivitySurfacesRuntime;
