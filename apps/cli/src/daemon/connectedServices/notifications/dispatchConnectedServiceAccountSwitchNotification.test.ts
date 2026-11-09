import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';

import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { dispatchConnectedServiceAccountSwitchNotificationAsync } from './dispatchConnectedServiceAccountSwitchNotification';
import { dispatchConnectedServiceCredentialHealthNotificationAsync, dispatchConnectedServiceCredentialHealthNotificationsAsync } from './dispatchConnectedServiceCredentialHealthNotification';
import { commitConnectedServiceAccountSwitchSessionEvent } from '../runtimeAuth/commitConnectedServiceAccountSwitchSessionEvent';
import { type ConnectedServiceNotificationAccountReader, type ConnectedServiceNotificationProfileSummary } from './connectedServiceNotificationLabels';

function createAccountReader(profiles: readonly ConnectedServiceNotificationProfileSummary[]) {
    return vi.fn<ConnectedServiceNotificationAccountReader>(async ({ accounts }) => ({
        accounts: accounts.map((ref) => {
            const profile = profiles.find((candidate) => candidate.profileId === ref.accountId);
            return { ref, displayName: profile?.displayName ?? undefined, providerIdentity: {
                email: profile?.providerEmail, accountId: profile?.providerAccountId,
            } };
        }),
    }));
}

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
            serviceId: 'happier.agent.codex/openai-codex',
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
            serviceId: 'happier.agent.codex/openai-codex',
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
            listQualifiedConnectedAccounts: createAccountReader([
                    { profileId: 'primary', status: 'connected' as const, providerEmail: 'main@example.test' },
                    { profileId: 'backup', status: 'connected' as const, providerEmail: 'backup@example.test' },
                ]),
            source: {
                sessionId: 'session-1',
                sessionTitle: 'Fix checkout flow',
                // Both runtime quota snapshots and the event carry the qualified service identity.
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

    it('loads only the two foreign qualified accounts named by a switch', async () => {
        const sendToAllDevicesAsync = vi.fn(async () => true);
        const listQualifiedConnectedAccounts = createAccountReader([{ profileId: 'primary', displayName: 'Research' }, { profileId: 'backup', displayName: 'Personal' }]);
        await dispatchConnectedServiceAccountSwitchNotificationAsync({
            settings,
            expoPushSender: { sendToAllDevicesAsync },
            settingsSecretsReadKeys: [],
            runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
            listQualifiedConnectedAccounts,
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
        expect(listQualifiedConnectedAccounts).toHaveBeenCalledExactlyOnceWith({ accounts: [
            { service: { pluginId: 'acme.custom', localId: 'openai-codex' }, accountId: 'primary' },
            { service: { pluginId: 'acme.custom', localId: 'openai-codex' }, accountId: 'backup' },
        ] });
        expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
            expect.any(String),
            expect.not.stringContaining('private@example.test'),
            expect.objectContaining({
                serviceId: 'acme.custom/openai-codex',
                fromProfileLabel: 'Research',
                toProfileLabel: 'Personal',
                fromUsagePercent: null,
                toUsagePercent: null,
            }),
            expect.anything(),
        );
    });

    it('shares one exact summary read between a foreign switch transcript and push', async () => {
        const stageTranscriptEvent = vi.fn(async () => ({ persisted: true as const, delivered: false }));
        const sendToAllDevicesAsync = vi.fn(async () => true);
        const listQualifiedConnectedAccounts = vi.fn(async () => ({ accounts: [
            { ref: { service: { pluginId: 'acme.custom', localId: 'service' }, accountId: 'from' }, displayName: 'Research' },
            { ref: { service: { pluginId: 'acme.custom', localId: 'service' }, accountId: 'to' }, providerIdentity: { email: 'personal@example.test' } },
        ] }));
        const source = { sessionId: 'shared-switch', serviceId: 'acme.custom/service', groupId: 'main',
            fromProfileId: 'from', toProfileId: 'to', reason: 'usage_limit' };
        const profilesById = await commitConnectedServiceAccountSwitchSessionEvent({
            mutationCustody: { stageTranscriptEvent }, sessionId: source.sessionId,
            event: { type: 'connected_service_account_switch', ...source }, listQualifiedConnectedAccounts,
        });
        await dispatchConnectedServiceAccountSwitchNotificationAsync({
            settings, expoPushSender: { sendToAllDevicesAsync }, listQualifiedConnectedAccounts, profilesById,
            runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(), source, dedupeWindowMs: 0,
        });
        expect(listQualifiedConnectedAccounts).toHaveBeenCalledTimes(1);
        expect(listQualifiedConnectedAccounts).toHaveBeenCalledWith({ accounts: [
            { service: { pluginId: 'acme.custom', localId: 'service' }, accountId: 'from' },
            { service: { pluginId: 'acme.custom', localId: 'service' }, accountId: 'to' },
        ] });
        expect(stageTranscriptEvent).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
            fromProfileLabel: 'Research', toProfileLabel: 'personal@example.test',
        }) }));
        expect(sendToAllDevicesAsync).toHaveBeenCalledWith(expect.any(String), expect.any(String),
            expect.objectContaining({ fromProfileLabel: 'Research', toProfileLabel: 'personal@example.test' }), expect.anything());
    });

    it('hydrates a foreign health target once for recipient fanout', async () => {
        const sendToAllDevicesAsync = vi.fn(async () => true);
        const listQualifiedConnectedAccounts = vi.fn(async () => ({ accounts: [
            { ref: { service: { pluginId: 'acme.custom', localId: 'service' }, accountId: 'affected' }, displayName: 'Research' },
        ] }));
        await dispatchConnectedServiceCredentialHealthNotificationsAsync({
            settings, expoPushSender: { sendToAllDevicesAsync }, listQualifiedConnectedAccounts,
            targets: ['health-foreign-one', 'health-foreign-two'].map(sessionId => ({ sessionId })),
            source: { serviceId: 'acme.custom/service', profileId: 'affected', status: 'reconnect_required' },
            dedupeWindowMs: 0,
        });
        expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(2);
        expect(listQualifiedConnectedAccounts).toHaveBeenCalledExactlyOnceWith({ accounts: [
            { service: { pluginId: 'acme.custom', localId: 'service' }, accountId: 'affected' },
        ] });
        expect(sendToAllDevicesAsync).toHaveBeenCalledWith(expect.any(String), expect.any(String),
            expect.objectContaining({ serviceId: 'acme.custom/service', profileLabel: 'Research' }), expect.anything());
    });

    it('does not read account summaries when health delivery has no enabled channel', async () => {
        setActiveAccountSettingsSnapshot({ settings, source: 'network', settingsVersion: 2, loadedAtMs: 2,
            settingsSecretsReadKeys: [], notificationChannelCatalog: {
                status: 'ready', revision: 2, diagnostics: [], channels: [],
            } });
        const listQualifiedConnectedAccounts = createAccountReader([{ profileId: 'affected', displayName: 'Research' }]);
        const sendToAllDevicesAsync = vi.fn(async () => true);
        await dispatchConnectedServiceCredentialHealthNotificationsAsync({
            settings, listQualifiedConnectedAccounts, expoPushSender: { sendToAllDevicesAsync },
            targets: [{ sessionId: 'disabled-health-one' }, { sessionId: 'disabled-health-two' }],
            source: { serviceId: 'acme.custom/service', profileId: 'affected', status: 'reconnect_required' },
        });
        expect(listQualifiedConnectedAccounts).not.toHaveBeenCalled();
        expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    });

    it('does not read account summaries for a duplicate suppressed health delivery', async () => {
        const listQualifiedConnectedAccounts = createAccountReader([{ profileId: 'affected', displayName: 'Research' }]);
        const sendToAllDevicesAsync = vi.fn(async () => true);
        const request = { settings, expoPushSender: { sendToAllDevicesAsync }, listQualifiedConnectedAccounts,
            targets: [{ sessionId: 'duplicate-health' }],
            source: { serviceId: 'acme.custom/service', profileId: 'affected', status: 'reconnect_required' as const },
            nowMs: () => 1000,
        };
        await dispatchConnectedServiceCredentialHealthNotificationsAsync(request);
        await dispatchConnectedServiceCredentialHealthNotificationsAsync(request);
        expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
        expect(listQualifiedConnectedAccounts).toHaveBeenCalledTimes(1);
    });

    it('does not read account summaries for health delivery without recipients', async () => {
        const listQualifiedConnectedAccounts = createAccountReader([{ profileId: 'affected', displayName: 'Research' }]);
        await dispatchConnectedServiceCredentialHealthNotificationsAsync({
            settings, listQualifiedConnectedAccounts, targets: [],
            source: { serviceId: 'acme.custom/service', profileId: 'affected', status: 'reconnect_required' },
        });
        expect(listQualifiedConnectedAccounts).not.toHaveBeenCalled();
    });

    it.each(['copied identifiers', 'lookup failure'] as const)('delivers neutral account names for %s', async (scenario) => {
        const sendToAllDevicesAsync = vi.fn(async (_title: string, _body: string) => true);
        const readAccounts = createAccountReader([
            { profileId: 'from-internal', displayName: 'from-internal' },
            { profileId: 'to-internal', displayName: 'provider-internal', providerAccountId: 'provider-internal' },
        ]);
        const listQualifiedConnectedAccounts: ConnectedServiceNotificationAccountReader = async (input) => {
            if (scenario === 'lookup failure') throw new Error('profile transport unavailable');
            return readAccounts(input);
        };
        await dispatchConnectedServiceAccountSwitchNotificationAsync({
            settings, expoPushSender: { sendToAllDevicesAsync }, listQualifiedConnectedAccounts,
            runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
            source: { sessionId: `switch-${scenario}`, serviceId: 'openai-codex', groupId: 'main',
                fromProfileId: 'from-internal', toProfileId: 'to-internal', reason: 'usage_limit' },
            dedupeWindowMs: 0,
        });
        await dispatchConnectedServiceCredentialHealthNotificationAsync({
            settings, expoPushSender: { sendToAllDevicesAsync }, listQualifiedConnectedAccounts,
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
            listQualifiedConnectedAccounts: createAccountReader([
                    { profileId: 'primary', status: 'connected' as const, providerEmail: 'main@example.test' },
                    { profileId: 'backup', status: 'connected' as const, providerEmail: 'backup@example.test' },
                ]),
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
            listQualifiedConnectedAccounts: createAccountReader([
                    { profileId: 'primary', status: 'connected' as const, providerEmail: 'main@example.test' },
                    { profileId: 'backup', status: 'connected' as const, providerEmail: 'backup@example.test' },
                ]),
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
            listQualifiedConnectedAccounts: createAccountReader([
                    { profileId: 'primary', status: 'connected' as const, providerEmail: 'main@example.test' },
                    { profileId: 'backup', status: 'connected' as const, providerEmail: 'backup@example.test' },
                ]),
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
