import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
// The Sync bridge owns the store graph; Account stores and writers load after it, as in the other composed writer tests.
await loadSyncSingletonForTests();
const { storage, useSettingMutable } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { useApplySettings } = await import('./settingsWriters');
const { createSecretSettingsTestHarness } = await import('@/components/settings/secrets/secretSettingsTestHarness');

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalState = storage.getState();
afterEach(() => {
    standardCleanup();
    storage.setState(originalState, true);
});

// Real Home/Account/Settings Action owners; only HTTP and credential storage are synthetic.
async function createAccount() {
    return await createSecretSettingsTestHarness({ settings: settingsParse({
        useProfiles: false,
        actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
    }) });
}

async function moveToAnotherAccount(serverId: string) {
    await act(async () => { storage.setState({ settingsScope: { serverId, accountId: 'another-account' } }); });
}

describe('useApplySettings Account scope binding', () => {
    it('rejects an unsupported key before writing any of the requested preferences', async () => {
        const account = await createAccount();
        try {
            const hook = await renderHook(() => useApplySettings());
            const writes = account.settingsWrites.length;
            const change = { useProfiles: true, unsupported: true };

            await act(async () => {
                await expect(hook.getCurrent()(change)).rejects.toMatchObject({ code: 'setting_not_found' });
            });

            expect(account.persistedSettings.useProfiles).toBe(false);
            expect(account.settingsWrites).toHaveLength(writes);
        } finally { await account.dispose(); }
    });

    it('propagates the Settings Action refusal for an invalid declared value', async () => {
        const account = await createAccount();
        try {
            const hook = await renderHook(() => useApplySettings());
            const invalid = 'true' as unknown as boolean;
            await act(async () => {
                await expect(hook.getCurrent()({ useProfiles: invalid })).rejects.toMatchObject({ code: 'invalid_setting_value' });
            });
            expect(account.persistedSettings.useProfiles).toBe(false);
        } finally { await account.dispose(); }
    });

    it('writes through the writer for the current Account and refuses it once the rendered Account is retired', async () => {
        const account = await createAccount();
        try {
            const hook = await renderHook(() => useApplySettings());
            const writerA = hook.getCurrent();
            await act(async () => { await writerA({ useProfiles: true }); });
            await vi.waitFor(() => expect(account.persistedSettings.useProfiles).toBe(true));
            const writes = account.settingsWrites.length;

            await moveToAnotherAccount(account.scope.serverId);
            expect(hook.getCurrent()).not.toBe(writerA);
            await act(async () => {
                await expect(writerA({ useProfiles: false })).rejects.toMatchObject({ code: 'action_account_scope_changed' });
            });

            expect(account.persistedSettings.useProfiles).toBe(true);
            expect(account.settingsWrites).toHaveLength(writes);
        } finally { await account.dispose(); }
    });

    it('keeps a retained useSettingMutable setter bound to the Account that rendered it', async () => {
        const account = await createAccount();
        try {
            const hook = await renderHook(() => useSettingMutable('useProfiles'));
            const setterA = hook.getCurrent()[1];
            await act(async () => { setterA(true); });
            await vi.waitFor(() => expect(account.persistedSettings.useProfiles).toBe(true));
            const writes = account.settingsWrites.length;

            await moveToAnotherAccount(account.scope.serverId);
            expect(hook.getCurrent()[1]).not.toBe(setterA);
            await act(async () => { setterA(false); });

            expect(account.persistedSettings.useProfiles).toBe(true);
            expect(account.settingsWrites).toHaveLength(writes);
        } finally { await account.dispose(); }
    });

    it('applies a retained setting updater to the current Account value', async () => {
        const account = await createAccount();
        try {
            const hook = await renderHook(() => useSettingMutable('useProfiles'));
            const setter = hook.getCurrent()[1];
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, useProfiles: true })); });

            await act(async () => { setter(current => !current); });

            await vi.waitFor(() => expect(account.persistedSettings.useProfiles).toBe(false));
        } finally { await account.dispose(); }
    });

    it('does not evaluate a retained updater against a different Account', async () => {
        const account = await createAccount();
        try {
            const hook = await renderHook(() => useSettingMutable('useProfiles'));
            const setter = hook.getCurrent()[1];
            const writes = account.settingsWrites.length;
            await moveToAnotherAccount(account.scope.serverId);
            const update = vi.fn((current: boolean) => !current);

            await act(async () => { setter(update); });

            expect(update).not.toHaveBeenCalled();
            expect(account.settingsWrites).toHaveLength(writes);
        } finally { await account.dispose(); }
    });

    it('does not write a setting updater that declines the current value', async () => {
        const account = await createAccount();
        try {
            const hook = await renderHook(() => useSettingMutable('useProfiles'));
            const writes = account.settingsWrites.length;

            await act(async () => { hook.getCurrent()[1](() => null); });

            expect(account.settingsWrites).toHaveLength(writes);
        } finally { await account.dispose(); }
    });
});
