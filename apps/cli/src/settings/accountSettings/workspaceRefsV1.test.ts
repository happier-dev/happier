import { describe, expect, it, vi } from 'vitest';

import { accountSettingsParse, type AccountSettings } from '@happier-dev/protocol';

import { createAccountSettingsService, createProjectsService } from './workspaceRefsV1';

type SettingsListener = (settings: AccountSettings | null) => void;

function makeSettings(workspaceRefsV1: AccountSettings['workspaceRefsV1']): AccountSettings {
    return accountSettingsParse({ workspaceRefsV1 });
}

function expectSettingsListener(listener: SettingsListener | null): SettingsListener {
    expect(listener).toEqual(expect.any(Function));
    if (!listener) {
        throw new Error('Expected settings listener to be registered');
    }
    return listener;
}

describe('plugin context workspace ref services', () => {
    it('resolves projects from account settings by id, machine, scope, and active session scope', async () => {
        const workspaceRefs: AccountSettings['workspaceRefsV1'] = [
            {
                id: 'workspace_a',
                serverId: 'server_a',
                machineId: 'machine_a',
                rootPath: 'C:\\Repo\\',
                label: 'Repo A',
                createdAtMs: 1,
                lastOpenedAtMs: null,
            },
            {
                id: 'workspace_b',
                serverId: 'server_a',
                machineId: 'machine_b',
                rootPath: '/other',
                label: null,
                createdAtMs: 2,
                lastOpenedAtMs: 3,
            },
        ];
        const service = createProjectsService({
            getSettings: () => makeSettings(workspaceRefs),
            getActiveScope: () => ({ serverId: 'server_a', machineId: 'machine_a', rootPath: 'c:/repo' }),
        });

        await expect(service.listAll()).resolves.toEqual(workspaceRefs);
        await expect(service.listForMachine('machine_b')).resolves.toEqual([workspaceRefs[1]]);
        await expect(service.listForCurrentMachine()).resolves.toEqual([workspaceRefs[0]]);
        await expect(service.get({ id: 'workspace_b' })).resolves.toEqual(workspaceRefs[1]);
        await expect(service.get({
            serverId: 'server_a',
            machineId: 'machine_a',
            rootPath: 'c:/repo',
        })).resolves.toEqual(workspaceRefs[0]);
        await expect(service.getActive()).resolves.toEqual(workspaceRefs[0]);
    });

    it('watches workspace refs without polling or leaking after unsubscribe', () => {
        let settings = makeSettings([]);
        let listener: ((settings: AccountSettings | null) => void) | null = null;
        const unsubscribe = vi.fn();
        const service = createProjectsService({
            getSettings: () => settings,
            subscribeSettings: (next) => {
                listener = next;
                return unsubscribe;
            },
        });
        const updates: string[][] = [];

        const subscription = service.watch((workspaceRefs) => {
            updates.push(workspaceRefs.map((ref) => ref.id));
        });
        const emitSettings = expectSettingsListener(listener);

        expect(updates).toEqual([[]]);
        settings = makeSettings([
            {
                id: 'workspace_a',
                serverId: 'server_a',
                machineId: 'machine_a',
                rootPath: '/repo',
                label: null,
                createdAtMs: 1,
                lastOpenedAtMs: null,
            },
        ]);
        emitSettings(settings);
        expect(updates).toEqual([[], ['workspace_a']]);

        subscription.unsubscribe();
        emitSettings(makeSettings([]));
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(updates).toEqual([[], ['workspace_a']]);
    });

    it('isolates project watcher listener failures from host settings delivery', () => {
        let listener: ((settings: AccountSettings | null) => void) | null = null;
        const service = createProjectsService({
            getSettings: () => makeSettings([]),
            subscribeSettings: (next) => {
                listener = next;
                return () => undefined;
            },
        });

        expect(() => service.watch(() => {
            throw new Error('plugin listener failed');
        })).not.toThrow();

        const emitSettings = expectSettingsListener(listener);
        expect(() => emitSettings(makeSettings([]))).not.toThrow();
    });

    it('updates account settings through the injected account-settings writer', async () => {
        let settings = makeSettings([]);
        const service = createAccountSettingsService({
            getSettings: () => settings,
            updateSettings: async (mutate) => {
                settings = accountSettingsParse(mutate(settings));
                return settings;
            },
        });

        await expect(service.get('workspaceRefsV1')).resolves.toEqual([]);
        await service.set('workspaceRefsV1', [
            {
                id: 'workspace_a',
                serverId: 'server_a',
                machineId: 'machine_a',
                rootPath: '/repo',
                label: null,
                createdAtMs: 1,
                lastOpenedAtMs: null,
            },
        ]);

        await expect(service.get('workspaceRefsV1')).resolves.toEqual([
            expect.objectContaining({ id: 'workspace_a', rootPath: '/repo' }),
        ]);
    });

    it('rejects malformed workspaceRefsV1 writes without mutating account settings', async () => {
        const existingRef = {
            id: 'workspace_existing',
            serverId: 'server_a',
            machineId: 'machine_a',
            rootPath: '/repo',
            label: null,
            createdAtMs: 1,
            lastOpenedAtMs: null,
        };
        let settings = makeSettings([existingRef]);
        const service = createAccountSettingsService({
            getSettings: () => settings,
            updateSettings: async (mutate) => {
                settings = accountSettingsParse(mutate(settings));
                return settings;
            },
        });

        await expect(service.set('workspaceRefsV1', [{ id: 'missing_scope' }]))
            .rejects
            .toThrow(/workspaceRefsV1/i);

        await expect(service.get('workspaceRefsV1')).resolves.toEqual([existingRef]);
    });

    it('isolates account settings listener failures from host settings delivery', () => {
        let listener: ((settings: AccountSettings | null) => void) | null = null;
        const service = createAccountSettingsService({
            getSettings: () => makeSettings([]),
            subscribeSettings: (next) => {
                listener = next;
                return () => undefined;
            },
        });

        expect(() => service.onChange(() => {
            throw new Error('plugin listener failed');
        })).not.toThrow();

        const emitSettings = expectSettingsListener(listener);
        expect(() => emitSettings(makeSettings([]))).not.toThrow();
    });
});
