import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

installSettingsViewCommonModuleMocks({ storage: 'real', text: async () => vi.importActual<typeof import('@/text')>('@/text') });
const native = vi.hoisted(() => ({
    scheduleNotificationAsync: vi.fn(async (_request: Parameters<typeof import('expo-notifications')['scheduleNotificationAsync']>[0]) => 'scheduled-reminder'),
    cancelScheduledNotificationAsync: vi.fn(async (_identifier: string) => undefined),
}));
// Only Expo's OS transport is replaced; inventory, Settings and reminder owners remain real.
vi.mock('expo-notifications', () => ({ ...native, SchedulableTriggerInputTypes: { DATE: 'date' } }));

// Prepare the real application graph during collection, like the settings integration tests.
await loadSyncSingletonForTests();

afterEach(async () => { await standardCleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('managed Machine deletion reminder Account preference', () => {
    it('updates Inbox attention and the same OS schedule while unrelated settings do no work', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const previous = storage.getState();
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const day = 24 * 60 * 60 * 1_000;
        const deadline = now + 3 * day;
        const homeId = 'srv_deletion_preferences';
        let machine = ManagedMachineV1Schema.parse({ id: 'retained', homeId, custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Build box', choices: {} },
            resource: { contributionRef: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'native' } },
            allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { observedAt: now, availability: 'present', power: 'stopped', storage: 'retained',
                deletionNotices: [{ kind: 'stopped-storage', at: deadline,
                    rule: { kind: 'after-stop', afterMs: 14 * day }, consequence: 'disk-deleted' }] },
        });
        const homes = await serveActionHomes({ homes: [{ key: 'reminders',
            serverUrl: 'https://deletion-preferences.test', serverIdentityId: homeId, accountId: 'owner', currentAccount: true,
            settings: { managedMachineDeletionReminderLeadTimeMs: day },
        }], route: request => {
            if (request.path === '/v1/machines/managed/actions/list') {
                const archived = request.body && typeof request.body === 'object' && 'archived' in request.body && request.body.archived;
                return Response.json({ machines: archived ? [] : [machine] });
            }
            return undefined;
        } });
        onTestFinished(async () => {
            storage.setState({ settings: previous.settings, settingsScope: previous.settingsScope,
                profileScope: previous.profileScope });
            await homes.dispose();
        });
        const { useManagedMachineDeletionAttention } = await import('@/activity/source/useManagedMachineDeletionSource');
        const { ManagedMachineDeletionNotificationRuntime } = await import('./ManagedMachineDeletionNotificationRuntime');
        const serverId = homes.homes.reminders!.id;
        const serverIds = [serverId];
        let attention: ReturnType<typeof useManagedMachineDeletionAttention> = [];
        let commits = 0;
        function Attention() { attention = useManagedMachineDeletionAttention(serverId); return null; }
        const screen = await renderScreen(<React.Profiler id="reminder-consumers" onRender={() => { commits += 1; }}>
            <Attention />
            <ManagedMachineDeletionNotificationRuntime serverIds={serverIds} />
        </React.Profiler>);
        onTestFinished(() => screen.unmount());
        await vi.waitFor(() => expect(native.scheduleNotificationAsync).toHaveBeenCalled());
        const identifier = `managed-machine-deletion:${JSON.stringify([serverId, 'owner', machine.id])}`;
        expect(native.scheduleNotificationAsync).toHaveBeenLastCalledWith(expect.objectContaining({
            identifier, trigger: { type: 'date', date: new Date(deadline - day) },
        }));
        expect(attention).toEqual([]);

        const settledAttention = attention;
        const settledCommits = commits;
        const schedules = native.scheduleNotificationAsync.mock.calls.length;
        const cancellations = native.cancelScheduledNotificationAsync.mock.calls.length;
        const inventoryReads = homes.requests.filter(request => request.path === '/v1/machines/managed/actions/list').length;
        for (let version = 2; version <= 6; version += 1) {
            await act(async () => storage.getState().applySettings({
                ...storage.getState().settings, analyticsOptOut: version % 2 === 0,
            }, version));
        }
        expect(commits).toBe(settledCommits);
        expect(attention).toBe(settledAttention);
        expect(native.scheduleNotificationAsync).toHaveBeenCalledTimes(schedules);
        expect(native.cancelScheduledNotificationAsync).toHaveBeenCalledTimes(cancellations);
        expect(homes.requests.filter(request => request.path === '/v1/machines/managed/actions/list')).toHaveLength(inventoryReads);

        await act(async () => storage.getState().applySettings({
            ...storage.getState().settings, managedMachineDeletionReminderLeadTimeMs: 4 * day,
        }, 7));
        await vi.waitFor(() => expect(attention).toHaveLength(1));
        expect(attention[0]!.reminder).toMatchObject({ remindAt: deadline - 4 * day, due: true });
        await vi.waitFor(() => expect(native.scheduleNotificationAsync).toHaveBeenLastCalledWith(expect.objectContaining({ identifier, trigger: null })));

        await act(async () => storage.getState().applySettings({
            ...storage.getState().settings, managedMachineDeletionReminderLeadTimeMs: 0,
        }, 8));
        await vi.waitFor(() => expect(native.scheduleNotificationAsync).toHaveBeenLastCalledWith(expect.objectContaining({
            identifier, trigger: { type: 'date', date: new Date(deadline) },
        })));
        expect(attention).toEqual([]);
        expect(native.cancelScheduledNotificationAsync.mock.calls.every(([id]) => id === identifier)).toBe(true);

        machine = ManagedMachineV1Schema.parse({ ...machine, observation: { ...machine.observation, deletionNotices: [] } });
        const beforeWithdrawal = native.cancelScheduledNotificationAsync.mock.calls.length;
        const scheduledBeforeWithdrawal = native.scheduleNotificationAsync.mock.calls.length;
        await act(async () => publishHomeAccountChange(serverId));
        await vi.waitFor(() => expect(native.cancelScheduledNotificationAsync.mock.calls.length).toBeGreaterThan(beforeWithdrawal));
        expect(native.cancelScheduledNotificationAsync).toHaveBeenLastCalledWith(identifier);
        expect(native.scheduleNotificationAsync).toHaveBeenCalledTimes(scheduledBeforeWithdrawal);
        expect(attention).toEqual([]);
    });
});
