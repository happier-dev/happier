import { describe, expect, it, vi } from 'vitest';

import type { Settings } from '@/sync/domains/settings/settings';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';

import { prepareAccountSettingsForDaemonSpawn } from './prepareAccountSettingsForDaemonSpawn';

const scopeA: AccountSettingsScope = Object.freeze({
    serverId: 'server-a',
    accountId: 'account-a',
});

describe('prepareAccountSettingsForDaemonSpawn', () => {
    it('flushes pending server-backed account settings and returns the acknowledged settings version', async () => {
        let version: number | null = 4;
        const flushPendingServerSettings = vi.fn(async () => {
            version = 5;
        });

        const result = await prepareAccountSettingsForDaemonSpawn({
            settingsScope: scopeA,
            pendingSettings: { renameSessions: false } as Partial<Settings>,
            getActiveSettingsScope: () => scopeA,
            getCurrentSettingsVersion: () => version,
            flushPendingServerSettings,
            clearPendingSettings: vi.fn(),
        });

        expect(flushPendingServerSettings).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ accountSettingsVersionHint: 5 });
    });

    it('does not flush when pending settings are local-only and returns the current settings version', async () => {
        const flushPendingServerSettings = vi.fn(async () => {});
        const clearPendingSettings = vi.fn();

        const result = await prepareAccountSettingsForDaemonSpawn({
            settingsScope: scopeA,
            pendingSettings: { lastUsedAgent: 'codex' } as Partial<Settings>,
            getActiveSettingsScope: () => scopeA,
            getCurrentSettingsVersion: () => 9,
            flushPendingServerSettings,
            clearPendingSettings,
        });

        expect(flushPendingServerSettings).not.toHaveBeenCalled();
        expect(clearPendingSettings).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ accountSettingsVersionHint: 9 });
    });

    it('returns the current settings version when no settings are pending', async () => {
        const result = await prepareAccountSettingsForDaemonSpawn({
            settingsScope: scopeA,
            pendingSettings: {},
            getActiveSettingsScope: () => scopeA,
            getCurrentSettingsVersion: () => 7,
            flushPendingServerSettings: vi.fn(async () => {}),
            clearPendingSettings: vi.fn(),
        });

        expect(result).toEqual({ accountSettingsVersionHint: 7 });
    });

    it('syncs account settings before spawning when no current settings version is loaded', async () => {
        let version: number | null = null;
        const flushPendingServerSettings = vi.fn(async () => {
            version = 11;
        });

        const result = await prepareAccountSettingsForDaemonSpawn({
            settingsScope: scopeA,
            pendingSettings: {},
            getActiveSettingsScope: () => scopeA,
            getCurrentSettingsVersion: () => version,
            flushPendingServerSettings,
            clearPendingSettings: vi.fn(),
        });

        expect(flushPendingServerSettings).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ accountSettingsVersionHint: 11 });
    });

    it('rejects and does not return a stale version when the settings scope changes during flush', async () => {
        const scopeB: AccountSettingsScope = { serverId: 'server-b', accountId: 'account-b' };
        let activeScope: AccountSettingsScope | null = scopeA;

        await expect(prepareAccountSettingsForDaemonSpawn({
            settingsScope: scopeA,
            pendingSettings: { renameSessions: false } as Partial<Settings>,
            getActiveSettingsScope: () => activeScope,
            getCurrentSettingsVersion: () => 5,
            flushPendingServerSettings: vi.fn(async () => {
                activeScope = scopeB;
            }),
            clearPendingSettings: vi.fn(),
        })).rejects.toThrow('Account settings scope changed while preparing session spawn');
    });
});
