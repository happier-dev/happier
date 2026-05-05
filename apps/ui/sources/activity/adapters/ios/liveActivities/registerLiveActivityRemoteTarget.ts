import type {
    LiveActivityRemoteTransportMode,
    LiveActivityRemoteUpdateCapabilityReason,
    LiveActivityRemoteUpdateMode,
} from '@happier-dev/protocol';

import type {
    LiveActivityTargetRegistrationInput,
    LiveActivityTargetRegistrationResult,
} from '@/sync/api/session/apiLiveActivityTargets';

import type { LiveActivitySnapshot } from './buildLiveActivitySnapshots';
import type { LiveActivityPushSupport, LiveActivityPushSupportReason } from './resolveLiveActivityPushSupport';

export type LiveActivityRemoteRegistrationPlan = Readonly<{
    mode: LiveActivityRemoteUpdateMode;
    status: 'remote_available' | 'blocked' | 'local_only' | 'disabled';
    reasons: readonly (LiveActivityRemoteUpdateCapabilityReason | LiveActivityPushSupportReason)[];
}>;

export type LiveActivityRemoteClientMetadata = Readonly<{
    deviceId: string | null;
    bundleId: string | null;
    environment: 'sandbox' | 'production' | null;
    clientServerUrl?: string | null;
}>;

export type LiveActivityPushTokenEvent = Readonly<{
    activityId: string;
    pushToken: string;
}>;

export type LiveActivityRemoteRegistrationSkipReason =
    | LiveActivityPushSupportReason
    | LiveActivityRemoteUpdateCapabilityReason
    | 'remote_updates_disabled'
    | 'remote_updates_local_only'
    | 'activitykit_client_metadata_missing'
    | 'direct_apns_client_metadata_missing'
    | 'background_wake_client_metadata_missing'
    | 'background_wake_expo_push_token_missing'
    | 'background_wake_runtime_task_blocked';

export type LiveActivityRemoteRegistrationResult =
    | Readonly<{ status: 'registered'; targetId: string; activityInstanceKey: string; mode: LiveActivityRemoteTransportMode }>
    | Readonly<{ status: 'skipped'; reason: LiveActivityRemoteRegistrationSkipReason; mode: LiveActivityRemoteUpdateMode }>;

type RegisterLiveActivityTarget = (
    input: LiveActivityTargetRegistrationInput,
) => Promise<LiveActivityTargetRegistrationResult>;

function firstReason(
    reasons: readonly (LiveActivityRemoteUpdateCapabilityReason | LiveActivityPushSupportReason)[],
    fallback: LiveActivityRemoteRegistrationSkipReason,
): LiveActivityRemoteRegistrationSkipReason {
    return (reasons[0] ?? fallback) as LiveActivityRemoteRegistrationSkipReason;
}

function normalizeNonEmpty(value: string | null | undefined): string | null {
    const normalized = String(value ?? '').trim();
    return normalized.length > 0 ? normalized : null;
}

function resolvePushSupportBlocker(pushSupport: LiveActivityPushSupport): LiveActivityPushSupportReason | null {
    return pushSupport.reasons[0] ?? null;
}

export async function registerLiveActivityRemoteTargetFromTokenEvent(params: Readonly<{
    snapshot: LiveActivitySnapshot;
    event: LiveActivityPushTokenEvent;
    registrationPlan: LiveActivityRemoteRegistrationPlan;
    pushSupport: LiveActivityPushSupport;
    clientMetadata: LiveActivityRemoteClientMetadata;
    registerTarget: RegisterLiveActivityTarget;
}>): Promise<LiveActivityRemoteRegistrationResult> {
    const mode = params.registrationPlan.mode;

    if (params.registrationPlan.status === 'disabled' || mode === 'disabled') {
        return { status: 'skipped', reason: 'remote_updates_disabled', mode };
    }
    if (params.registrationPlan.status === 'local_only' || mode === 'local_only') {
        return { status: 'skipped', reason: 'remote_updates_local_only', mode };
    }
    if (params.registrationPlan.status === 'blocked') {
        return {
            status: 'skipped',
            reason: firstReason(params.registrationPlan.reasons, 'remote_updates_local_only'),
            mode,
        };
    }
    if (!params.pushSupport.canRegisterRemoteTargets) {
        return {
            status: 'skipped',
            reason: resolvePushSupportBlocker(params.pushSupport) ?? 'expo_widgets_token_api_missing',
            mode,
        };
    }
    if (mode === 'background_wake_best_effort') {
        return {
            status: 'skipped',
            reason: 'background_wake_runtime_task_blocked',
            mode,
        };
    }
    if (mode !== 'direct_apns' && mode !== 'hosted_happier_relay') {
        return {
            status: 'skipped',
            reason: firstReason(params.registrationPlan.reasons, 'remote_updates_local_only'),
            mode,
        };
    }

    const deviceId = normalizeNonEmpty(params.clientMetadata.deviceId);
    const bundleId = normalizeNonEmpty(params.clientMetadata.bundleId);
    const environment = params.clientMetadata.environment;
    const activityId = normalizeNonEmpty(params.event.activityId);
    const rawToken = normalizeNonEmpty(params.event.pushToken);

    if (!deviceId || !bundleId || !environment || !activityId || !rawToken) {
        return {
            status: 'skipped',
            reason: mode === 'direct_apns'
                ? 'direct_apns_client_metadata_missing'
                : 'activitykit_client_metadata_missing',
            mode,
        };
    }

    const result = await params.registerTarget({
        deviceId,
        serverId: params.snapshot.serverId,
        sessionId: params.snapshot.sessionId,
        activityInstanceKey: params.snapshot.activityInstanceKey,
        activityId,
        activityName: params.snapshot.activityName,
        transportMode: mode,
        tokenKind: 'activitykit_update_token',
        rawToken,
        bundleId,
        environment,
        clientServerUrl: normalizeNonEmpty(params.clientMetadata.clientServerUrl) ?? undefined,
    });

    return {
        status: 'registered',
        targetId: result.targetId,
        activityInstanceKey: params.snapshot.activityInstanceKey,
        mode,
    };
}

export async function registerLiveActivityBackgroundWakeTarget(params: Readonly<{
    snapshot: LiveActivitySnapshot;
    registrationPlan: LiveActivityRemoteRegistrationPlan;
    clientMetadata: LiveActivityRemoteClientMetadata;
    expoPushToken: string | null | undefined;
    registerTarget: RegisterLiveActivityTarget;
}>): Promise<LiveActivityRemoteRegistrationResult> {
    const mode = params.registrationPlan.mode;

    if (params.registrationPlan.status === 'disabled' || mode === 'disabled') {
        return { status: 'skipped', reason: 'remote_updates_disabled', mode };
    }
    if (params.registrationPlan.status === 'local_only' || mode === 'local_only') {
        return { status: 'skipped', reason: 'remote_updates_local_only', mode };
    }
    if (params.registrationPlan.status === 'blocked') {
        return {
            status: 'skipped',
            reason: firstReason(params.registrationPlan.reasons, 'remote_updates_local_only'),
            mode,
        };
    }
    if (mode !== 'background_wake_best_effort') {
        return {
            status: 'skipped',
            reason: firstReason(params.registrationPlan.reasons, 'remote_updates_local_only'),
            mode,
        };
    }

    const deviceId = normalizeNonEmpty(params.clientMetadata.deviceId);
    const expoPushToken = normalizeNonEmpty(params.expoPushToken);

    if (!deviceId) {
        return {
            status: 'skipped',
            reason: 'background_wake_client_metadata_missing',
            mode,
        };
    }
    if (!expoPushToken) {
        return {
            status: 'skipped',
            reason: 'background_wake_expo_push_token_missing',
            mode,
        };
    }

    const result = await params.registerTarget({
        deviceId,
        serverId: params.snapshot.serverId,
        sessionId: params.snapshot.sessionId,
        activityInstanceKey: params.snapshot.activityInstanceKey,
        activityId: params.snapshot.activityInstanceKey,
        activityName: params.snapshot.activityName,
        transportMode: 'background_wake_best_effort',
        tokenKind: 'expo_push_token',
        expoPushToken,
        clientServerUrl: normalizeNonEmpty(params.clientMetadata.clientServerUrl) ?? undefined,
    });

    return {
        status: 'registered',
        targetId: result.targetId,
        activityInstanceKey: params.snapshot.activityInstanceKey,
        mode: 'background_wake_best_effort',
    };
}

export type LiveActivityRemoteTargetRegistry = Readonly<{
    remember: (target: Readonly<{
        activityInstanceKey: string;
        targetId: string;
        mode: LiveActivityRemoteTransportMode;
    }>) => void;
    getTarget: (activityInstanceKey: string) => Readonly<{
        targetId: string;
        mode: LiveActivityRemoteTransportMode;
    }> | null;
    getTargetId: (activityInstanceKey: string) => string | null;
    markEnded: (params: Readonly<{
        activityInstanceKey: string;
        markTargetEnded: (targetId: string) => Promise<void>;
    }>) => Promise<void>;
    clear: () => void;
}>;

export function createLiveActivityRemoteTargetRegistry(): LiveActivityRemoteTargetRegistry {
    const targetsByActivityKey = new Map<string, Readonly<{
        targetId: string;
        mode: LiveActivityRemoteTransportMode;
    }>>();

    return {
        remember(target) {
            const activityInstanceKey = normalizeNonEmpty(target.activityInstanceKey);
            const targetId = normalizeNonEmpty(target.targetId);
            if (!activityInstanceKey || !targetId) return;
            targetsByActivityKey.set(activityInstanceKey, {
                targetId,
                mode: target.mode,
            });
        },
        getTarget(activityInstanceKey) {
            return targetsByActivityKey.get(activityInstanceKey) ?? null;
        },
        getTargetId(activityInstanceKey) {
            return targetsByActivityKey.get(activityInstanceKey)?.targetId ?? null;
        },
        async markEnded(params) {
            const target = targetsByActivityKey.get(params.activityInstanceKey);
            if (!target) return;
            targetsByActivityKey.delete(params.activityInstanceKey);
            await params.markTargetEnded(target.targetId);
        },
        clear() {
            targetsByActivityKey.clear();
        },
    };
}
