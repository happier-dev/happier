import { describe, expect, it, vi } from 'vitest';
import {
    FeaturesResponseSchema,
    buildLiveActivityRemoteUpdateCapabilityDiagnostics,
} from '@happier-dev/protocol';

import { settingsDefaults } from '@/sync/domains/settings/settings';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';

import type { LiveActivitySnapshot } from '../liveActivities/buildLiveActivitySnapshots';
import { createLiveActivityRemoteTargetRegistry } from '../liveActivities/registerLiveActivityRemoteTarget';
import {
    reconcileLiveActivityRemoteTargetRegistration,
    type LiveActivityPushTokenSubscription,
} from './liveActivityRemoteTargetRuntime';

vi.mock('expo-constants', () => ({
    default: {
        expoConfig: {
            ios: {
                bundleIdentifier: 'dev.happier.custom',
            },
            plugins: [
                ['expo-widgets', { enablePushNotifications: true, widgets: [] }],
            ],
        },
        installationId: 'device-1',
    },
}));

vi.mock('@/sync/api/session/apiLiveActivityTargets', () => ({
    registerLiveActivityTarget: vi.fn(async () => ({ targetId: 'target-direct-1' })),
    markLiveActivityTargetEnded: vi.fn(async () => undefined),
}));

vi.mock('@/sync/domains/state/pushTokenRegistration', () => ({
    loadLastRegisteredExpoPushToken: () => null,
}));

function createLiveActivitySnapshot(): LiveActivitySnapshot {
    return {
        version: 1,
        generatedAt: 1_000,
        staleAt: 31_000,
        serverId: 'server-a',
        sessionId: 'permission',
        activityName: 'HappierFocusLiveActivity',
        activityInstanceKey: 'server-a:HappierFocusLiveActivity:permission',
        title: 'Permission required',
        subtitle: null,
        previewText: null,
        statusText: null,
        attentionState: 'permission_required',
        presentationTemplate: 'urgentAttention',
        apnsPriority: 10,
        relevanceScore: 100,
        defaultTarget: 'open-session:permission?serverId=server-a',
        sessionTarget: 'open-session:permission?serverId=server-a',
        overflowCount: 0,
        totalAttentionCount: 1,
        allowActionButtons: true,
        labels: {
            title: 'Live Activities',
            openLabel: 'Open',
            inboxLabel: 'Inbox',
            attentionLabel: 'Attention',
        },
    };
}

describe('liveActivityRemoteTargetRuntime', () => {
    it('continues without a remote token listener when ActivityKit listener attachment fails', () => {
        const pushTokenSubscriptions = new Map<string, LiveActivityPushTokenSubscription>();
        const featuresPayload = FeaturesResponseSchema.parse({
            features: {},
            capabilities: {
                liveActivities: {
                    remoteUpdates: buildLiveActivityRemoteUpdateCapabilityDiagnostics({
                        expoWidgetsPushNotificationsEnabled: true,
                        hostedRelay: {
                            allowed: false,
                            capabilityAvailable: false,
                            providerImplemented: false,
                        },
                        directApns: {
                            configured: true,
                        },
                        backgroundWake: {
                            enabled: false,
                        },
                    }),
                },
            },
        });

        expect(() => {
            reconcileLiveActivityRemoteTargetRegistration({
                handle: {
                    addPushTokenListener: () => {
                        throw new Error('ActivityKit token listener unavailable');
                    },
                },
                snapshot: createLiveActivitySnapshot(),
                settings: {
                    ...settingsDefaults,
                    attentionDeliveryPolicyV1: {
                        ...settingsDefaults.attentionDeliveryPolicyV1,
                        v: 1,
                        liveActivityRemoteUpdates: {
                            ...settingsDefaults.attentionDeliveryPolicyV1.liveActivityRemoteUpdates,
                            enabled: true,
                            preferredMode: 'direct_apns',
                            allowBackgroundWakeFallback: false,
                        },
                    },
                },
                localSettings: {
                    ...localSettingsDefaults,
                    attentionDeviceOverridesV1: {
                        ...localSettingsDefaults.attentionDeviceOverridesV1,
                        v: 1,
                        liveActivities: {
                            ...localSettingsDefaults.attentionDeviceOverridesV1.liveActivities,
                            registerRemoteUpdateTargets: true,
                        },
                    },
                },
                serverFeaturesSnapshot: {
                    status: 'ready',
                    serverIds: ['server-a'],
                    snapshotsByServerId: {
                        'server-a': {
                            status: 'ready',
                            features: featuresPayload,
                        },
                    },
                },
                pushTokenSubscriptions,
                remoteTargetRegistry: createLiveActivityRemoteTargetRegistry(),
            });
        }).not.toThrow();

        expect(pushTokenSubscriptions.size).toBe(0);
    });
});
