import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, renderHook, renderWithAppProviders } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { installRealActionExecutorModuleLoader, serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { ModalProvider } from '@/modal';

// Native presentation SDKs and sockets are external boundaries; the authoring
// controls, Account projections, profile resolver and Action executor stay real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { useApprovalProfiles } = await import('./useApprovalProfiles');
const { storage } = await import('@/sync/domains/state/storage');
const { SessionAuthoringControls } = await import('@/components/sessions/authoring/controls/SessionAuthoringControls');
const originalState = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
afterEach(async () => { await account?.dispose(); account = undefined; storage.setState(originalState, true); });

describe('approval profile Account data', () => {
    it('resolves a background Home profile against that exact Account without borrowing the focused Account', async () => {
        const selectedId = 'custom:home-profile';
        const homes = await serveAccountHomes({ homes: [
            { key: 'background', serverUrl: 'https://approval-background.test', accountId: 'background-account', settings: {
                actionsSettingsV1: { v: 1, actions: {}, approvalProfiles: [{ id: selectedId, name: 'Background profile', defaultMode: 'ask' }] },
            } },
            { key: 'focused', serverUrl: 'https://approval-focused.test', accountId: 'focused-account', settings: {
                actionsSettingsV1: { v: 1, actions: {}, approvalProfiles: [{ id: selectedId, name: 'Focused profile', defaultMode: 'allow' }] },
            } },
        ], route: () => undefined });
        const hook = await renderHook(() => useApprovalProfiles(selectedId, homes.homes.background!.id));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().ready).toBe(true));
            expect(hook.getCurrent().selection).toMatchObject({ profile: { name: 'Background profile', defaultMode: 'ask' } });
        } finally { await hook.unmount(); await homes.dispose(); }
    });
    it.each(['fields', 'chips'] as const)('renders the missing-profile fallback in %s and lets the author retain inheritance, clear, or select an Account profile', async presentation => {
        const profile = { id: 'custom:deploy', name: 'Deploy', defaultMode: 'ask' } as const;
        account = await createSecretSettingsTestHarness({ mode: 'plain', settings: settingsParse({
            actionsSettingsV1: { v: 1, actions: {}, approvalProfiles: [profile] },
        }) });
        const change = vi.fn();
        const element = (approvalProfileId: string | null | undefined) => <ModalProvider><SessionAuthoringControls
            testIDPrefix="profile-authoring" presentation={presentation} fields={['approvalProfileId']}
            values={{ approvalProfileId }} onChangeField={change}
        /></ModalProvider>;
        const screen = await renderWithAppProviders(element('custom:removed'));
        try {
            await vi.waitFor(() => expect(screen.tree.root.findAllByProps({ testID: 'profile-authoring-approvalProfileId-missing' }).length).toBeGreaterThan(0));
            const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
            const picker = screen.tree.root.findByType(DropdownMenu);
            expect(picker.props.items).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: profile.id }),
                expect.objectContaining({ id: 'builtin:read-propose' }),
            ]));
            await act(async () => picker.props.onSelect(profile.id));
            expect(change).toHaveBeenLastCalledWith('approvalProfileId', profile.id);
            await act(async () => picker.props.onSelect('inherit'));
            expect(change).toHaveBeenLastCalledWith('approvalProfileId', undefined);
            await act(async () => picker.props.onSelect('__none__'));
            expect(change).toHaveBeenLastCalledWith('approvalProfileId', null);
            await screen.update(element(profile.id));
            expect(screen.tree.root.findAllByProps({ testID: 'profile-authoring-approvalProfileId-missing' })).toHaveLength(0);
        } finally { await screen.unmount(); }
    });
    it.each(['plain', 'e2ee'] as const)('saves and deletes a %s Account profile through mounted Action admission', async mode => {
        account = await createSecretSettingsTestHarness({ mode, settings: settingsParse({
            actionsSettingsV1: { v: 1, actions: { 'session.stop': { disabledSurfaces: ['agent'] } } },
        }) });
        const disposeLoader = await installRealActionExecutorModuleLoader();
        const siblingPolicy = account.persistedSettings.actionsSettingsV1.actions['session.stop'];
        const profile = { id: 'custom:deploy', name: 'Deploy', defaultMode: 'ask' } as const;
        const hook = await renderHook(() => useApprovalProfiles(profile.id));
        try {
            expect(hook.getCurrent().profiles).toContainEqual(expect.objectContaining({ id: 'builtin:read-propose' }));
            await act(async () => { expect(await hook.getCurrent().upsertProfile(profile)).toMatchObject({ ok: true }); });
            expect(account.persistedSettings.actionsSettingsV1.approvalProfiles).toEqual([profile]);
            expect(hook.getCurrent().selection).toMatchObject({ resolution: { status: 'available' } });
            await act(async () => { expect(await hook.getCurrent().deleteProfile(profile.id)).toMatchObject({ ok: true }); });
            expect(account.persistedSettings.actionsSettingsV1.approvalProfiles).toEqual([]);
            expect(account.persistedSettings.actionsSettingsV1.actions['session.stop']).toEqual(siblingPolicy);
            expect(hook.getCurrent().selection).toMatchObject({ resolution: { status: 'missing' } });
        } finally { await hook.unmount(); disposeLoader(); }
    });

    it('keeps profile projections stable on unrelated preferences and resolves removed references visibly', async () => {
        const profile = { id: 'custom:deploy', name: 'Deploy', defaultMode: 'ask' } as const;
        account = await createSecretSettingsTestHarness({ mode: 'plain', settings: settingsParse({
            actionsSettingsV1: { v: 1, actions: {}, approvalProfiles: [profile] },
        }) });
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useApprovalProfiles(profile.id); });
        const first = hook.getCurrent();
        expect(first.profiles).toContainEqual(profile);
        expect(first.selection).toMatchObject({ profile, resolution: { status: 'available' } });
        const before = renders;
        await act(async () => {
            for (let index = 0; index < 20; index += 1) storage.getState().applySettingsForScope(account!.scope,
                settingsParse({ ...storage.getState().settings, useProfiles: index % 2 === 0 }), index + 2);
        });
        expect(renders).toBe(before);
        expect(hook.getCurrent().profiles).toBe(first.profiles);
        await act(async () => { storage.getState().applySettingsForScope(account!.scope,
            settingsParse({ ...storage.getState().settings, actionsSettingsV1: { v: 1, actions: {} } }), 22); });
        expect(hook.getCurrent().selection).toMatchObject({ profile: { id: 'builtin:read-propose' },
            resolution: { status: 'missing', requestedId: profile.id, effectiveId: 'builtin:read-propose' } });
        expect(hook.getCurrent().profiles).not.toContainEqual(profile);
        await hook.unmount();
    });
});
