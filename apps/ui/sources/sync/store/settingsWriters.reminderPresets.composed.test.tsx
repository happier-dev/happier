import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import 'fake-indexeddb/auto';
import * as React from 'react';
import { createSessionFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { useApplySessionReminderPresetIntent } = await import('./settingsWriters');
const { createSecretSettingsTestHarness } = await import('@/components/settings/secrets/secretSettingsTestHarness');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { storage } = await import('@/sync/domains/state/storage');
const { Modal } = await import('@/modal');
const { InboxSessionRowMenu } = await import('@/components/inbox/workGroups/InboxSessionRowMenu');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { useSessionRowActionMenu } = await import('@/components/sessions/shell/row/actionMenu/useSessionRowActionMenu');
const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
const originalState = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
afterEach(async () => { standardCleanup(); await account?.dispose(); account = undefined; storage.setState(originalState, true); });
const preset = { label: 'Focus', rule: { kind: 'relative_day', daysAhead: 1, minuteOfDay: 540 } } as const;

describe('reminder preset menu writer through real Settings Action admission', () => {
    it('rebases an encrypted preset write after a real Account CAS conflict without dropping the winning preset', async () => {
        const home = await createSecretSettingsTestHarness({ mode: 'e2ee', settings: settingsParse({
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        }) });
        account = home;
        const request = home.request.getMockImplementation()!;
        let conflict = true;
        const winner = { ...preset, label: 'Other device', rule: { ...preset.rule, daysAhead: 3 } };
        home.request.mockImplementation(async (url, init) => {
            if (conflict && new URL(String(url)).pathname === '/v2/account/settings' && init?.method === 'POST') {
                const input = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                conflict = false;
                home.replaceSettings(settingsParse({ ...home.persistedSettings, sessionReminderPresetsV1: [winner], analyticsOptOut: true }),
                    { version: input.expectedVersion + 1, publish: false });
            }
            return request(url, init);
        });
        const hook = await renderHook(() => useApplySessionReminderPresetIntent());
        expect(home.settingsWrites).toEqual([]);
        await act(async () => { await hook.getCurrent()({ kind: 'upsert', preset }); });
        expect(conflict).toBe(false);
        expect(home.persistedSettings.sessionReminderPresetsV1).toEqual([winner, preset]);
        expect(home.persistedSettings.analyticsOptOut).toBe(true);
    });

    it.each(['inbox', 'session'] as const)('routes %s Add to presets and Manage presets through Settings policy', async surface => {
        const home = await createSecretSettingsTestHarness({ settings: settingsParse({
            sessionReminderPresetsV1: [preset],
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        account = home;
        const session = createSessionFixture({ id: 'preset-menu-session', serverId: home.scope.serverId });
        const target = createSessionActionTarget({ session, serverId: home.scope.serverId });
        const select = surface === 'session'
            ? (await renderHook(() => useSessionRowActionMenu({ target, sessionName: 'Focus', hideInactiveSessions: false,
                iconColor: 'black', activeTags: [], knownTags: [], tagsEnabled: false, touchPrimaryPointer: false,
                setContextMenuOpen: () => {}, openTagsMenuFromContext: () => {},
            }))).getCurrent().handleMoreMenuSelect
            : (await renderScreen(<InboxSessionRowMenu session={session} settle={async () => {}} setReminder={async () => {}} />))
                .tree.findByType(DropdownMenu).props.onSelect as (id: string) => void;
        for (const kind of ['custom', 'manage-presets'] as const) {
            vi.mocked(Modal.show).mockClear();
            let selection: void | Promise<void>;
            await act(async () => { selection = select(`attention-reminder:${kind}`); });
            const config = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
            expect(config?.chrome).toMatchObject({ testID: kind === 'custom'
                ? 'session-reminder-date-time-modal' : 'session-reminder-preset-manager-modal' });
            // Native modal presentation is the boundary; the real menus supply these public callbacks.
            const props = config!.props as Readonly<{
                onSavePreset(value: typeof preset): Promise<void>;
                onSubmit(value: []): Promise<void>;
                onResolve(value: null): void;
            }>;
            const save = () => kind === 'custom' ? props.onSavePreset(preset) : props.onSubmit([]);
            await expect(save()).rejects.toThrow();
            expect(home.settingsWrites).toEqual([]);
            await act(async () => { home.replaceSettings(settingsParse({ ...home.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            })); });
            await act(async () => { await save(); });
            expect(home.persistedSettings.sessionReminderPresetsV1).toEqual(kind === 'custom' ? [preset] : []);
            props.onResolve(null);
            await selection!;
            await act(async () => { home.replaceSettings(settingsParse({ ...home.persistedSettings,
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
            })); });
        }
    });

    it('refuses preset writes when settings.set is Off', async () => {
        account = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        const hook = await renderHook(() => useApplySessionReminderPresetIntent());
        await expect(hook.getCurrent()({ kind: 'upsert', preset })).rejects.toThrow();
        expect(account.settingsWrites).toEqual([]);
        expect(account.persistedSettings.sessionReminderPresetsV1).toEqual([]);
    });

    it('waits for Ask approval, rebases on current presets, and rejects a stale manager or retired Account', async () => {
        const home = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } },
        }) });
        account = home;
        const hook = await renderHook(() => useApplySessionReminderPresetIntent());
        let pending: Promise<void> | undefined;
        await act(async () => { pending = hook.getCurrent()({ kind: 'upsert', preset }); });
        await vi.waitFor(() => expect(home.artifacts.list()).toHaveLength(1));
        const approvalId = home.artifacts.list()[0]!.id;
        expect(JSON.parse(home.artifacts.readPlainBody(approvalId)!)).toMatchObject({ actionId: 'settings.set',
            actionArgs: { anchor: 'session.reminderPresets', value: { kind: 'upsert', preset } } });
        expect(home.settingsWrites).toEqual([]);
        const concurrent = { ...preset, label: 'Other device', rule: { ...preset.rule, daysAhead: 2 } };
        await act(async () => { home.replaceSettings(settingsParse({ ...home.persistedSettings,
            sessionReminderPresetsV1: [concurrent], analyticsOptOut: true,
        })); });
        await decideApprovalAsInbox(home.scope.serverId, approvalId, 'approve');
        await act(async () => { await pending; });
        expect(home.persistedSettings.sessionReminderPresetsV1).toEqual([concurrent, preset]);
        expect(home.persistedSettings.analyticsOptOut).toBe(true);
        await act(async () => { home.replaceSettings(settingsParse({ ...home.persistedSettings,
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        })); });
        await expect(hook.getCurrent()({ kind: 'replace', expectedPresets: [preset], presets: [] })).rejects.toThrow();
        expect(home.persistedSettings.sessionReminderPresetsV1).toEqual([concurrent, preset]);
        await act(async () => { await hook.getCurrent()({ kind: 'replace', expectedPresets: [concurrent, preset], presets: [concurrent] }); });
        expect(home.persistedSettings.sessionReminderPresetsV1).toEqual([concurrent]);
        const retained = hook.getCurrent();
        await act(async () => { storage.setState({ settingsScope: { ...home.scope, accountId: 'retired' } }); });
        await expect(retained({ kind: 'upsert', preset })).rejects.toThrow();
        expect(home.persistedSettings.sessionReminderPresetsV1).toEqual([concurrent]);
    });
});
