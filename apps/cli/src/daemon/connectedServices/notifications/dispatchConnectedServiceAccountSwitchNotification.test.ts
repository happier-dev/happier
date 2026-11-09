import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';

import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { dispatchConnectedServiceAccountSwitchNotificationAsync } from './dispatchConnectedServiceAccountSwitchNotification';
import { dispatchConnectedServiceCredentialHealthNotificationAsync } from './dispatchConnectedServiceCredentialHealthNotification';

describe('dispatchConnectedServiceAccountSwitchNotificationAsync', () => {
    let settings: ReturnType<typeof accountSettingsParse>;

    beforeEach(() => {
        settings = accountSettingsParse({});
        setActiveAccountSettingsSnapshot({
            settings,
            source: 'network',
            settingsVersion: 1,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            notificationChannelCatalog: {
                status: 'ready',
                revision: 1,
                diagnostics: [],
                channels: [NotificationChannelRecordV1Schema.parse({
                    v: 1, id: 'push', kind: 'expo_push', enabled: true, topics: {},
                })],
            },
        });
    });

    afterEach(() => resetActiveAccountSettingsSnapshotForTests());

    it('uses the session title and enriches switch notifications with profile labels and usage percentages', async () => {
        const sendToAllDevicesAsync = vi.fn(async () => { return true; });
        const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
        runtimeQuotaSnapshots.recordSnapshot({
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'primary',
            snapshot: {
                v: 1,
                serviceId: 'openai-codex',
                profileId: 'primary',
                fetchedAt: 1_000,
                staleAfterMs: 60_000,
                planLabel: null,
                accountLabel: null,
                meters: [{
                    meterId: 'weekly',
                    label: 'Weekly',
                    unit: 'unknown',
                    remainingPct: 0,
                    utilizationPct: 100,
                    used: null,
                    limit: null,
                    resetAtMs: null,
                    resetsAt: null,
                    status: 'ok',
                    confidence: 'exact',
                    details: { limitCategory: 'usage_limit' },
                }],
            },
        });
        runtimeQuotaSnapshots.recordSnapshot({
            serviceId: 'openai-codex',
            groupId: 'main',
            profileId: 'backup',
            snapshot: {
                v: 1,
                serviceId: 'openai-codex',
                profileId: 'backup',
                fetchedAt: 1_000,
                staleAfterMs: 60_000,
                planLabel: null,
                accountLabel: null,
                meters: [{
                    meterId: 'weekly',
                    label: 'Weekly',
                    unit: 'unknown',
                    remainingPct: 80,
                    utilizationPct: 20,
                    used: null,
                    limit: null,
                    resetAtMs: null,
                    resetsAt: null,
                    status: 'ok',
                    confidence: 'exact',
                    details: { limitCategory: 'usage_limit' },
                }],
            },
        });

        await dispatchConnectedServiceAccountSwitchNotificationAsync({
            settings,
            expoPushSender: { sendToAllDevicesAsync },
            settingsSecretsReadKeys: [],
            runtimeQuotaSnapshots,
            listConnectedServiceProfiles: vi.fn(async () => ({
                serviceId: 'openai-codex' as const,
                profiles: [
                    { profileId: 'primary', status: 'connected' as const, providerEmail: 'main@example.test' },
                    { profileId: 'backup', status: 'connected' as const, providerEmail: 'backup@example.test' },
                ],
            })),
            source: {
                sessionId: 'session-1',
                sessionTitle: 'Fix checkout flow',
                // Daemon event ingress qualifies the source before dispatch;
                // quota snapshots and the released profile-list port stay scalar.
                serviceId: 'happier.agent.codex/openai-codex',
                groupId: 'main',
                fromProfileId: 'primary',
                toProfileId: 'backup',
                reason: 'usage_limit',
                limitCategory: 'usage_limit',
            },
            nowMs: () => 2_000,
            dedupeWindowMs: 0,
        });

        expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
            'Fix checkout flow',
            expect.any(String),
            expect.objectContaining({
                sessionId: 'session-1',
                serviceId: 'happier.agent.codex/openai-codex',
                serviceDisplayName: 'ChatGPT',
                reason: 'usage_limit',
                fromProfileLabel: 'main@example.test',
                toProfileLabel: 'backup@example.test',
                fromUsagePercent: 100,
                toUsagePercent: 20,
            }),
            { sound: 'happier_soft.wav', priority: 'high', androidSoundId: 'soft' },
        );
    });

    it('does not read bundled account labels for an unrelated qualified service with the same local id', async () => {
        const sendToAllDevicesAsync = vi.fn(async () => true);
        const listConnectedServiceProfiles = vi.fn(async () => ({
            serviceId: 'openai-codex' as const,
            profiles: [{ profileId: 'primary', providerEmail: 'private@example.test' }],
        }));
        await dispatchConnectedServiceAccountSwitchNotificationAsync({
            settings,
            expoPushSender: { sendToAllDevicesAsync },
            settingsSecretsReadKeys: [],
            runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
            listConnectedServiceProfiles,
            source: {
                sessionId: 'session-custom',
                serviceId: 'acme.custom/openai-codex',
                groupId: 'main',
                fromProfileId: 'primary',
                toProfileId: 'backup',
                reason: 'usage_limit',
            },
            dedupeWindowMs: 0,
        });
        expect(listConnectedServiceProfiles).not.toHaveBeenCalled();
        expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
            expect.any(String),
            expect.not.stringContaining('private@example.test'),
            expect.objectContaining({
                serviceId: 'acme.custom/openai-codex',
                fromProfileLabel: 'Connected account',
                fromUsagePercent: null,
                toUsagePercent: null,
            }),
            expect.anything(),
        );
    });

    it.each(['copied identifiers', 'lookup failure'] as const)('delivers neutral account names for %s', async (scenario) => {
        const sendToAllDevicesAsync = vi.fn(async (_title: string, _body: string) => true);
        const listConnectedServiceProfiles = async () => {
            if (scenario === 'lookup failure') throw new Error('profile transport unavailable');
            return {
                serviceId: 'openai-codex' as const,
                profiles: [
                    { profileId: 'from-internal', displayName: 'from-internal' },
                    { profileId: 'to-internal', displayName: 'provider-internal', providerAccountId: 'provider-internal' },
                ],
            };
        };
        await dispatchConnectedServiceAccountSwitchNotificationAsync({
            settings, expoPushSender: { sendToAllDevicesAsync }, listConnectedServiceProfiles,
            runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
            source: { sessionId: `switch-${scenario}`, serviceId: 'openai-codex', groupId: 'main',
                fromProfileId: 'from-internal', toProfileId: 'to-internal', reason: 'usage_limit' },
            dedupeWindowMs: 0,
        });
        await dispatchConnectedServiceCredentialHealthNotificationAsync({
            settings, expoPushSender: { sendToAllDevicesAsync }, listConnectedServiceProfiles,
            source: { sessionId: `health-${scenario}`, serviceId: 'openai-codex',
                profileId: 'to-internal', status: 'reconnect_required' },
            dedupeWindowMs: 0,
        });
        expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(2);
        for (const [title, body] of sendToAllDevicesAsync.mock.calls) {
            expect(`${title} ${body}`).toContain('Connected account');
            expect(`${title} ${body}`).not.toMatch(/from-internal|to-internal|provider-internal|openai-codex/);
        }
    });

    it('dispatches the preventive copy for a preemptive soft-threshold switch', async () => {
        const sendToAllDevicesAsync = vi.fn(async () => { return true; });
        const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

        await dispatchConnectedServiceAccountSwitchNotificationAsync({
            settings,
            expoPushSender: { sendToAllDevicesAsync },
            settingsSecretsReadKeys: [],
            runtimeQuotaSnapshots,
            listConnectedServiceProfiles: vi.fn(async () => ({
                serviceId: 'openai-codex' as const,
                profiles: [
                    { profileId: 'primary', status: 'connected' as const, providerEmail: 'main@example.test' },
                    { profileId: 'backup', status: 'connected' as const, providerEmail: 'backup@example.test' },
                ],
            })),
            source: {
                sessionId: 'session-soft',
                sessionTitle: 'Refactor billing',
                serviceId: 'openai-codex',
                groupId: 'main',
                fromProfileId: 'primary',
                toProfileId: 'backup',
                reason: 'soft_threshold',
            },
            nowMs: () => 2_000,
            dedupeWindowMs: 0,
        });

        expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
            'Refactor billing',
            expect.any(String),
            expect.objectContaining({ sessionId: 'session-soft', reason: 'soft_threshold' }),
            expect.anything(),
        );
    });

    it('suppresses external notifications for user-performed manual switches', async () => {
        const sendToAllDevicesAsync = vi.fn(async () => { return true; });
        const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

        await dispatchConnectedServiceAccountSwitchNotificationAsync({
            settings,
            expoPushSender: { sendToAllDevicesAsync },
            settingsSecretsReadKeys: [],
            runtimeQuotaSnapshots,
            listConnectedServiceProfiles: vi.fn(async () => ({
                serviceId: 'openai-codex' as const,
                profiles: [
                    { profileId: 'primary', status: 'connected' as const, providerEmail: 'main@example.test' },
                    { profileId: 'backup', status: 'connected' as const, providerEmail: 'backup@example.test' },
                ],
            })),
            source: {
                sessionId: 'session-manual',
                sessionTitle: 'Manual switch',
                serviceId: 'openai-codex',
                groupId: 'main',
                fromProfileId: 'primary',
                toProfileId: 'backup',
                reason: 'manual',
            },
            nowMs: () => 2_000,
            dedupeWindowMs: 0,
        });

        expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    });

    it('suppresses external notifications for predictive fanout maintenance switches', async () => {
        const sendToAllDevicesAsync = vi.fn(async () => { return true; });
        const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

        await dispatchConnectedServiceAccountSwitchNotificationAsync({
            settings,
            expoPushSender: { sendToAllDevicesAsync },
            settingsSecretsReadKeys: [],
            runtimeQuotaSnapshots,
            listConnectedServiceProfiles: vi.fn(async () => ({
                serviceId: 'openai-codex' as const,
                profiles: [
                    { profileId: 'primary', status: 'connected' as const, providerEmail: 'main@example.test' },
                    { profileId: 'backup', status: 'connected' as const, providerEmail: 'backup@example.test' },
                ],
            })),
            source: {
                sessionId: 'session-fanout',
                sessionTitle: 'Implement auth fanout',
                serviceId: 'openai-codex',
                groupId: 'main',
                fromProfileId: 'primary',
                toProfileId: 'backup',
                reason: 'same_provider_account_exhausted',
            },
            nowMs: () => 2_000,
            dedupeWindowMs: 0,
        });

        expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    });
});
