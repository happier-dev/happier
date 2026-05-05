import Constants from 'expo-constants';
import {
    DEFAULT_LIVE_ACTIVITY_REMOTE_UPDATE_CAPABILITY_DIAGNOSTICS,
    accountSettingsParse,
    resolveLiveActivityRemoteUpdateMode,
    type LiveActivityRemoteTransportMode,
    type LiveActivityRemoteUpdateCapabilityDiagnostics,
    type LiveActivityRemoteUpdateMode,
} from '@happier-dev/protocol';

import { markLiveActivityTargetEnded, registerLiveActivityTarget } from '@/sync/api/session/apiLiveActivityTargets';
import type { ServerFeaturesMainSelectionSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { AttentionDeviceOverridesV1Schema } from '@/sync/domains/settings/attentionDeviceOverridesV1';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import type { Settings } from '@/sync/domains/settings/settings';
import { loadLastRegisteredExpoPushToken } from '@/sync/domains/state/pushTokenRegistration';

import type { LiveActivitySnapshot } from '../liveActivities/buildLiveActivitySnapshots';
import {
    createLiveActivityRemoteTargetRegistry,
    registerLiveActivityBackgroundWakeTarget,
    registerLiveActivityRemoteTargetFromTokenEvent,
    type LiveActivityRemoteClientMetadata,
    type LiveActivityRemoteRegistrationPlan,
} from '../liveActivities/registerLiveActivityRemoteTarget';
import { resolveCurrentLiveActivityPushSupport } from '../liveActivities/resolveLiveActivityPushSupport';
import { resolveLiveActivityBackgroundWakeStaticConfigSupported } from '../backgroundWake/defineLiveActivityBackgroundWakeTask';

export type LiveActivityPushTokenEvent = Readonly<{
    activityId: string;
    pushToken: string;
}>;

export type LiveActivityHandleWithRemoteTargetSupport = Readonly<{
    addPushTokenListener?: (listener: (event: LiveActivityPushTokenEvent) => void) => { remove: () => void };
    getPushToken?: () => Promise<string | null>;
}>;

export type LiveActivityPushTokenSubscription = Readonly<{ remove: () => void }>;

const DEFAULT_LIVE_ACTIVITY_APNS_ENVIRONMENT: LiveActivityRemoteClientMetadata['environment'] = 'sandbox';

function isLiveActivityRemoteTransportMode(
    mode: LiveActivityRemoteUpdateMode,
): mode is LiveActivityRemoteTransportMode {
    return mode === 'hosted_happier_relay'
        || mode === 'direct_apns'
        || mode === 'background_wake_best_effort';
}

function resolveServerRemoteUpdateDiagnostics(params: Readonly<{
    snapshot: LiveActivitySnapshot;
    serverFeaturesSnapshot: ServerFeaturesMainSelectionSnapshot;
}>): LiveActivityRemoteUpdateCapabilityDiagnostics {
    const serverSnapshot = params.serverFeaturesSnapshot.snapshotsByServerId[params.snapshot.serverId];
    if (serverSnapshot?.status !== 'ready') {
        return DEFAULT_LIVE_ACTIVITY_REMOTE_UPDATE_CAPABILITY_DIAGNOSTICS;
    }
    return serverSnapshot.features.capabilities.liveActivities.remoteUpdates;
}

export function resolveLiveActivityRemoteRegistrationPlan(params: Readonly<{
    snapshot: LiveActivitySnapshot;
    settings: Settings;
    localSettings: LocalSettings;
    serverFeaturesSnapshot: ServerFeaturesMainSelectionSnapshot;
}>): LiveActivityRemoteRegistrationPlan {
    const attentionPolicy = accountSettingsParse(params.settings).attentionDeliveryPolicyV1;
    const remotePolicy = attentionPolicy.liveActivityRemoteUpdates;
    const deviceOverrides = AttentionDeviceOverridesV1Schema.parse(
        (params.localSettings as Readonly<Record<string, unknown>>).attentionDeviceOverridesV1,
    );
    const deviceLiveActivityOverrides = deviceOverrides.liveActivities;

    if (!remotePolicy.enabled || !deviceLiveActivityOverrides.registerRemoteUpdateTargets) {
        return { mode: 'disabled', status: 'disabled', reasons: [] };
    }
    if (deviceLiveActivityOverrides.remoteUpdateModeOverride === 'disabled') {
        return { mode: 'disabled', status: 'disabled', reasons: [] };
    }
    if (deviceLiveActivityOverrides.remoteUpdateModeOverride === 'local_only') {
        return { mode: 'local_only', status: 'local_only', reasons: [] };
    }

    const diagnostics = resolveServerRemoteUpdateDiagnostics({
        snapshot: params.snapshot,
        serverFeaturesSnapshot: params.serverFeaturesSnapshot,
    });
    const resolution = resolveLiveActivityRemoteUpdateMode({
        preferredMode: remotePolicy.preferredMode,
        diagnostics,
        allowFallback: remotePolicy.allowBackgroundWakeFallback
            || deviceLiveActivityOverrides.allowBackgroundWakeFallback,
    });
    if (resolution.mode === 'disabled') {
        return { mode: 'disabled', status: 'disabled', reasons: [] };
    }
    if (resolution.mode === 'local_only') {
        const unavailableReasons = isLiveActivityRemoteTransportMode(remotePolicy.preferredMode)
            ? diagnostics.modes[remotePolicy.preferredMode].reasons
            : [];
        return { mode: 'local_only', status: 'local_only', reasons: unavailableReasons };
    }

    const modeDiagnostics = diagnostics.modes[resolution.mode];
    return {
        mode: resolution.mode,
        status: modeDiagnostics.available ? 'remote_available' : 'blocked',
        reasons: modeDiagnostics.reasons,
    };
}

function resolveLiveActivityApnsEnvironment(): LiveActivityRemoteClientMetadata['environment'] {
    const extra = Constants.expoConfig?.extra as Readonly<{
        app?: Readonly<{ happierLiveActivityApnsEnvironment?: unknown }>;
        happierLiveActivityApnsEnvironment?: unknown;
    }> | undefined;
    const configured = String(
        process.env.EXPO_PUBLIC_HAPPIER_IOS_APNS_ENVIRONMENT
            ?? extra?.app?.happierLiveActivityApnsEnvironment
            ?? extra?.happierLiveActivityApnsEnvironment
            ?? '',
    ).trim().toLowerCase();
    if (configured === 'production') return 'production';
    if (configured === 'sandbox') return 'sandbox';
    return DEFAULT_LIVE_ACTIVITY_APNS_ENVIRONMENT;
}

function resolveLiveActivityRemoteClientMetadata(): LiveActivityRemoteClientMetadata {
    const constantsWithInstallation = Constants as typeof Constants & Readonly<{ installationId?: string | null }>;
    return {
        deviceId: constantsWithInstallation.installationId ?? null,
        bundleId: Constants.expoConfig?.ios?.bundleIdentifier ?? null,
        environment: resolveLiveActivityApnsEnvironment(),
    };
}

export function removeLiveActivityPushTokenSubscription(
    subscriptions: Map<string, LiveActivityPushTokenSubscription>,
    activityKey: string,
): void {
    const subscription = subscriptions.get(activityKey);
    if (!subscription) return;
    subscription.remove();
    subscriptions.delete(activityKey);
}

export async function markLiveActivityRemoteTargetEnded(params: Readonly<{
    registry: ReturnType<typeof createLiveActivityRemoteTargetRegistry>;
    activityInstanceKey: string;
    serverId: string | null | undefined;
}>): Promise<void> {
    await params.registry.markEnded({
        activityInstanceKey: params.activityInstanceKey,
        markTargetEnded: (targetId) => markLiveActivityTargetEnded(targetId, {
            serverId: params.serverId ?? undefined,
        }),
    });
}

function markLiveActivityRemoteTargetEndedBestEffort(params: Readonly<{
    registry: ReturnType<typeof createLiveActivityRemoteTargetRegistry>;
    activityInstanceKey: string;
    serverId: string | null | undefined;
}>): void {
    void markLiveActivityRemoteTargetEnded(params).catch(() => undefined);
}

function rememberRegisteredRemoteTarget(
    registry: ReturnType<typeof createLiveActivityRemoteTargetRegistry>,
    result: Awaited<ReturnType<typeof registerLiveActivityRemoteTargetFromTokenEvent>>,
): void {
    if (result.status !== 'registered') return;
    registry.remember({
        activityInstanceKey: result.activityInstanceKey,
        targetId: result.targetId,
        mode: result.mode,
    });
}

async function registerLiveActivityRemoteTargetEvent(params: Readonly<{
    snapshot: LiveActivitySnapshot;
    event: LiveActivityPushTokenEvent;
    plan: LiveActivityRemoteRegistrationPlan;
    pushSupport: ReturnType<typeof resolveCurrentLiveActivityPushSupport>;
    remoteTargetRegistry: ReturnType<typeof createLiveActivityRemoteTargetRegistry>;
}>): Promise<void> {
    const previousTarget = params.remoteTargetRegistry.getTarget(params.snapshot.activityInstanceKey);
    const result = await registerLiveActivityRemoteTargetFromTokenEvent({
        snapshot: params.snapshot,
        event: params.event,
        registrationPlan: params.plan,
        pushSupport: params.pushSupport,
        clientMetadata: resolveLiveActivityRemoteClientMetadata(),
        registerTarget: registerLiveActivityTarget,
    });

    if (
        result.status === 'registered'
        && previousTarget
        && previousTarget.targetId !== result.targetId
    ) {
        void markLiveActivityTargetEnded(previousTarget.targetId, {
            serverId: params.snapshot.serverId,
        }).catch(() => undefined);
    }
    rememberRegisteredRemoteTarget(params.remoteTargetRegistry, result);
}

function registerCurrentLiveActivityPushToken(params: Readonly<{
    handle: LiveActivityHandleWithRemoteTargetSupport;
    snapshot: LiveActivitySnapshot;
    plan: LiveActivityRemoteRegistrationPlan;
    pushSupport: ReturnType<typeof resolveCurrentLiveActivityPushSupport>;
    remoteTargetRegistry: ReturnType<typeof createLiveActivityRemoteTargetRegistry>;
}>): void {
    if (typeof params.handle.getPushToken !== 'function') return;
    void (async () => {
        const pushToken = await params.handle.getPushToken?.();
        if (!pushToken) return;
        await registerLiveActivityRemoteTargetEvent({
            snapshot: params.snapshot,
            event: {
                activityId: params.snapshot.activityInstanceKey,
                pushToken,
            },
            plan: params.plan,
            pushSupport: params.pushSupport,
            remoteTargetRegistry: params.remoteTargetRegistry,
        });
    })().catch(() => undefined);
}

export function reconcileLiveActivityRemoteTargetRegistration(params: Readonly<{
    handle: LiveActivityHandleWithRemoteTargetSupport;
    snapshot: LiveActivitySnapshot;
    settings: Settings;
    localSettings: LocalSettings;
    serverFeaturesSnapshot: ServerFeaturesMainSelectionSnapshot;
    pushTokenSubscriptions: Map<string, LiveActivityPushTokenSubscription>;
    remoteTargetRegistry: ReturnType<typeof createLiveActivityRemoteTargetRegistry>;
}>): void {
    const activityKey = params.snapshot.activityInstanceKey;
    const plan = resolveLiveActivityRemoteRegistrationPlan({
        snapshot: params.snapshot,
        settings: params.settings,
        localSettings: params.localSettings,
        serverFeaturesSnapshot: params.serverFeaturesSnapshot,
    });
    if (plan.status !== 'remote_available') {
        removeLiveActivityPushTokenSubscription(params.pushTokenSubscriptions, activityKey);
        markLiveActivityRemoteTargetEndedBestEffort({
            registry: params.remoteTargetRegistry,
            activityInstanceKey: activityKey,
            serverId: params.snapshot.serverId,
        });
        return;
    }

    const existingTarget = params.remoteTargetRegistry.getTarget(activityKey);
    if (existingTarget && existingTarget.mode !== plan.mode) {
        markLiveActivityRemoteTargetEndedBestEffort({
            registry: params.remoteTargetRegistry,
            activityInstanceKey: activityKey,
            serverId: params.snapshot.serverId,
        });
        removeLiveActivityPushTokenSubscription(params.pushTokenSubscriptions, activityKey);
    }

    if (plan.mode === 'background_wake_best_effort') {
        removeLiveActivityPushTokenSubscription(params.pushTokenSubscriptions, activityKey);
        if (!resolveLiveActivityBackgroundWakeStaticConfigSupported()) {
            markLiveActivityRemoteTargetEndedBestEffort({
                registry: params.remoteTargetRegistry,
                activityInstanceKey: activityKey,
                serverId: params.snapshot.serverId,
            });
            return;
        }
        if (existingTarget?.mode === 'background_wake_best_effort') {
            return;
        }

        void (async () => {
            const result = await registerLiveActivityBackgroundWakeTarget({
                snapshot: params.snapshot,
                registrationPlan: plan,
                clientMetadata: resolveLiveActivityRemoteClientMetadata(),
                expoPushToken: loadLastRegisteredExpoPushToken(),
                registerTarget: registerLiveActivityTarget,
            });
            rememberRegisteredRemoteTarget(params.remoteTargetRegistry, result);
        })().catch(() => undefined);
        return;
    }

    const tokenApisAvailable = typeof params.handle.addPushTokenListener === 'function';
    const pushSupport = resolveCurrentLiveActivityPushSupport({ tokenApisAvailable });
    if (!pushSupport.canRegisterRemoteTargets || !params.handle.addPushTokenListener) {
        removeLiveActivityPushTokenSubscription(params.pushTokenSubscriptions, activityKey);
        markLiveActivityRemoteTargetEndedBestEffort({
            registry: params.remoteTargetRegistry,
            activityInstanceKey: activityKey,
            serverId: params.snapshot.serverId,
        });
        return;
    }
    if (params.pushTokenSubscriptions.has(activityKey)) {
        return;
    }

    let subscription: LiveActivityPushTokenSubscription;
    try {
        subscription = params.handle.addPushTokenListener((event) => {
            void registerLiveActivityRemoteTargetEvent({
                snapshot: params.snapshot,
                event,
                plan,
                pushSupport,
                remoteTargetRegistry: params.remoteTargetRegistry,
            }).catch(() => undefined);
        });
    } catch {
        return;
    }
    params.pushTokenSubscriptions.set(activityKey, subscription);
    registerCurrentLiveActivityPushToken({
        handle: params.handle,
        snapshot: params.snapshot,
        plan,
        pushSupport,
        remoteTargetRegistry: params.remoteTargetRegistry,
    });
}
