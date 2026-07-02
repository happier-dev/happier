import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { dispatchConnectedServiceAccountSwitchNotificationAsync } from './dispatchConnectedServiceAccountSwitchNotification';

describe('dispatchConnectedServiceAccountSwitchNotificationAsync', () => {
    it('uses the session title and enriches switch notifications with profile labels and usage percentages', async () => {
        const sendToAllDevicesAsync = vi.fn(async () => {});
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
            settings: accountSettingsParse({}),
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
                serviceId: 'openai-codex',
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
            expect.stringContaining('Happier switched OpenAI accounts'),
            expect.objectContaining({
                sessionId: 'session-1',
                serviceDisplayName: 'OpenAI',
                fromProfileLabel: 'main@example.test',
                toProfileLabel: 'backup@example.test',
                fromUsagePercent: 100,
                toUsagePercent: 20,
            }),
            { sound: 'happier_soft.wav', priority: 'high', androidSoundId: 'soft' },
        );
    });
});
