import { describe, expect, it } from 'vitest';
import type {
    LiveActivityRemoteUpdateCapabilityDiagnostics,
} from '@happier-dev/protocol';

async function loadModule() {
    return import('./liveActivityRemoteUpdateDiagnostics').catch(() => null);
}

function buildDiagnostics(
    overrides: Partial<LiveActivityRemoteUpdateCapabilityDiagnostics> = {},
): LiveActivityRemoteUpdateCapabilityDiagnostics {
    return {
        modes: {
            hosted_happier_relay: {
                available: false,
                reasons: ['hosted_relay_not_allowed'],
                configurationDiagnostics: [],
            },
            direct_apns: {
                available: false,
                reasons: ['direct_apns_not_configured'],
                configurationDiagnostics: ['apns_private_key_missing'],
            },
            background_wake_best_effort: {
                available: false,
                reasons: ['background_wake_disabled'],
                configurationDiagnostics: [],
            },
        },
        capabilities: {
            perActivityUpdate: {
                id: 'per_activity_update',
                status: 'supported_when_configured',
                events: ['update', 'end'],
                targetKinds: ['activitykit_update_token'],
                availableModes: [],
                reasons: [],
            },
            pushToStart: {
                id: 'push_to_start',
                status: 'future_unsupported',
                events: ['start'],
                targetKinds: ['activitykit_push_to_start_token'],
                availableModes: [],
                reasons: ['not_in_phase_9_5'],
            },
            broadcastChannel: {
                id: 'broadcast_channel',
                status: 'future_unsupported',
                events: [],
                targetKinds: [],
                availableModes: [],
                reasons: ['private_per_session_surface_not_broadcast'],
            },
        },
        ...overrides,
    };
}

describe('liveActivityRemoteUpdateDiagnostics', () => {
    it('distinguishes hosted relay disabled from hosted relay configured-but-blocked diagnostics', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const disabledRows = mod.buildLiveActivityRemoteUpdateDiagnosticsRows({
            preferredMode: 'hosted_happier_relay',
            allowBackgroundWakeFallback: false,
            deviceModeOverride: 'account',
            diagnostics: buildDiagnostics(),
        });

        expect(disabledRows.find((row) => row.id === 'hosted_relay')).toMatchObject({
            detailKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.unavailable',
            subtitleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.hostedRelayDisabledSubtitle',
        });

        const blockedRows = mod.buildLiveActivityRemoteUpdateDiagnosticsRows({
            preferredMode: 'hosted_happier_relay',
            allowBackgroundWakeFallback: false,
            deviceModeOverride: 'account',
            diagnostics: buildDiagnostics({
                modes: {
                    hosted_happier_relay: {
                        available: false,
                        reasons: ['hosted_relay_provider_blocked'],
                        configurationDiagnostics: [],
                    },
                    direct_apns: {
                        available: false,
                        reasons: ['direct_apns_not_configured'],
                        configurationDiagnostics: [],
                    },
                    background_wake_best_effort: {
                        available: false,
                        reasons: ['background_wake_disabled'],
                        configurationDiagnostics: [],
                    },
                },
            }),
        });

        expect(blockedRows.find((row) => row.id === 'hosted_relay')).toMatchObject({
            detailKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.blocked',
            subtitleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.hostedRelayBlockedSubtitle',
        });
    });

    it('summarizes direct APNs credential state without exposing secret material', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const rows = mod.buildLiveActivityRemoteUpdateDiagnosticsRows({
            preferredMode: 'direct_apns',
            allowBackgroundWakeFallback: false,
            deviceModeOverride: 'account',
            diagnostics: buildDiagnostics(),
        });

        expect(rows.find((row) => row.id === 'direct_apns')).toMatchObject({
            detailKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.missingCredentials',
            diagnosticKeys: ['apns_private_key_missing'],
        });
        expect(JSON.stringify(rows)).not.toContain('PRIVATE KEY');
        expect(JSON.stringify(rows)).not.toContain('rawToken');
    });

    it('labels background wake as best-effort and keeps local-only copy runtime-scoped', async () => {
        const mod = await loadModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const rows = mod.buildLiveActivityRemoteUpdateDiagnosticsRows({
            preferredMode: 'background_wake_best_effort',
            allowBackgroundWakeFallback: true,
            deviceModeOverride: 'account',
            diagnostics: buildDiagnostics({
                modes: {
                    hosted_happier_relay: {
                        available: false,
                        reasons: ['hosted_relay_provider_blocked'],
                        configurationDiagnostics: [],
                    },
                    direct_apns: {
                        available: false,
                        reasons: ['direct_apns_not_configured'],
                        configurationDiagnostics: [],
                    },
                    background_wake_best_effort: {
                        available: true,
                        reasons: [],
                        configurationDiagnostics: [],
                    },
                },
            }),
        });

        expect(rows.find((row) => row.id === 'background_wake')).toMatchObject({
            detailKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.details.bestEffort',
            subtitleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.backgroundWakeBestEffortSubtitle',
        });
        expect(rows.find((row) => row.id === 'local_only')).toMatchObject({
            subtitleKey: 'settingsNotifications.activitySurfaces.liveActivities.remoteUpdates.localOnlyRuntimeSubtitle',
        });
    });
});
