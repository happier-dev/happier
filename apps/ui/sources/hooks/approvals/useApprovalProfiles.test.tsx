import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { useApprovalProfiles } = await import('./useApprovalProfiles');
const { storage } = await import('@/sync/domains/state/storage');
const originalState = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
afterEach(async () => { await account?.dispose(); account = undefined; storage.setState(originalState, true); });

describe('approval profile Account data', () => {
    it.each(['plain', 'e2ee'] as const)('saves and deletes a %s Account profile through mounted Action admission', async mode => {
        account = await createSecretSettingsTestHarness({ mode, settings: settingsParse({
            actionsSettingsV1: { v: 1, actions: { 'session.stop': { disabledSurfaces: ['agent'] } } },
        }) });
        const disposeLoader = await installRealActionExecutorModuleLoader();
        const siblingPolicy = account.persistedSettings.actionsSettingsV1.actions['session.stop'];
        const profile = { id: 'custom:deploy', name: 'Deploy', defaultMode: 'ask' } as const;
        const hook = await renderHook(() => useApprovalProfiles(profile.id));
        try {
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
