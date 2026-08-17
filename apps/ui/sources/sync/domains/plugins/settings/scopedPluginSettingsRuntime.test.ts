import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
    current: true,
    serverFetch: vi.fn(),
    daemonSettingsWatch: vi.fn(),
}));

const lifetime = vi.hoisted(() => Object.freeze({
    scope: Object.freeze({ serverId: 'server-a', accountId: 'account-a' }),
    isCurrent: () => runtime.current,
    onRetire: () => Object.freeze({ dispose(): void {} }),
}));

vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytes: (length: number) => new Uint8Array(length),
}));

vi.mock('@/platform/randomUUID', () => ({ randomUUID: () => 'test-id' }));

vi.mock('@/sync/domains/settings/scope/accountSettingsScope', () => ({
    areAccountSettingsScopesEqual: () => false,
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => lifetime,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({ settingsScope: null, settingsVersion: -1, settings: {} }),
        subscribe: () => () => {},
    },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'server-a',
        serverUrl: 'https://server-a.example.test',
        generation: 1,
    }),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    areServerProfileIdentifiersEquivalent: (left: string, right: string) => left === right,
    getServerProfileById: () => ({ serverIdentityId: 'server-identity-a' }),
    resolveServerProfileForPortableIdentity: () => ({
        kind: 'resolved',
        profile: { id: 'server-a' },
    }),
}));

vi.mock('@/sync/http/client', () => ({ serverFetch: runtime.serverFetch }));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machinePluginSecretDelete: vi.fn(),
    machinePluginSecretSet: vi.fn(),
    machinePluginSecretStatus: vi.fn(),
    machinePluginSettingsGet: vi.fn(),
    machinePluginSettingsSet: vi.fn(),
    watchMachinePluginSettingsChanges: runtime.daemonSettingsWatch,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        encryption: null,
        getCredentials: () => ({ token: 'token-a' }),
        mutateAccountSettingsOnce: vi.fn(),
    },
}));

vi.mock('./scopedPluginSettingsChangeWatch', () => ({
    watchActiveScopedPluginSettingsChanges: () => ({ dispose(): void {} }),
}));

import { scopedPluginSettingsAdapter } from './scopedPluginSettingsRuntime';

const ACCOUNT_TARGET = Object.freeze({
    kind: 'account' as const,
    serverIdentityId: 'server-identity-a',
});

const DAEMON_TARGET = Object.freeze({
    kind: 'daemon' as const,
    serverIdentityId: 'server-identity-a',
    machineId: 'machine-a',
    serverId: 'server-a',
});

const ACCOUNT_FIELDS = Object.freeze([{ key: 'endpoint', redacted: false }]);

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((accept) => { resolve = accept; });
    return { promise, resolve };
}

function jsonResponse(body: () => Promise<unknown>) {
    return Object.freeze({ ok: true, json: body });
}

beforeEach(() => {
    runtime.current = true;
    runtime.serverFetch.mockReset();
    runtime.daemonSettingsWatch.mockReset();
});

describe('scopedPluginSettingsAdapter Account currentness', () => {
    it('binds an exact daemon Settings record to the machine invalidation transport', () => {
        const onInvalidated = vi.fn();
        const dispose = vi.fn();
        runtime.daemonSettingsWatch.mockImplementation((machineId: string, input: { onInvalidated(): void }) => {
            input.onInvalidated();
            return { dispose };
        });

        const watch = scopedPluginSettingsAdapter.watch?.({
            pluginId: 'acme.settings',
            scope: { kind: 'daemon' },
            target: DAEMON_TARGET,
            onInvalidated,
        });

        expect(runtime.daemonSettingsWatch).toHaveBeenCalledWith('machine-a', {
            serverId: 'server-a',
            serverIdentityId: 'server-identity-a',
            pluginId: 'acme.settings',
            onInvalidated,
        });
        expect(onInvalidated).toHaveBeenCalledTimes(1);
        watch?.dispose();
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('classifies a lost Account record acknowledgement at the transport owner and returns one safe readback without replay', async () => {
        let record: unknown = {
            status: 'present',
            revision: 4,
            content: { t: 'plain', v: { v: 1, values: { endpoint: 'https://before.example.test' } } },
        };
        runtime.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') {
                return jsonResponse(async () => ({ mode: 'plain', updatedAt: 1 }));
            }
            if (path === '/v1/account/plugin-settings/acme.settings' && init?.method === 'GET') {
                return jsonResponse(async () => record);
            }
            if (path === '/v1/account/plugin-settings/acme.settings' && init?.method === 'POST') {
                record = {
                    status: 'present',
                    revision: 5,
                    content: {
                        t: 'plain',
                        v: { v: 1, values: { endpoint: 'https://possibly-applied.example.test' } },
                    },
                };
                throw new Error('response lost after Account record commit');
            }
            throw new Error(`Unexpected Account Settings request: ${path}`);
        });

        await expect(scopedPluginSettingsAdapter.write({
            pluginId: 'acme.settings',
            scope: { kind: 'account' },
            target: ACCOUNT_TARGET,
            fields: ACCOUNT_FIELDS,
            fieldId: 'endpoint',
            mutation: { kind: 'set', value: 'https://possibly-applied.example.test' },
            expectedRevision: { kind: 'account', value: 4 },
        })).resolves.toEqual({
            status: 'outcomeUnknown',
            snapshot: {
                scope: { kind: 'account' },
                target: ACCOUNT_TARGET,
                revision: { kind: 'account', value: 5 },
                values: { endpoint: 'https://possibly-applied.example.test' },
            },
        });
        expect(runtime.serverFetch.mock.calls.filter(([path, init]) => (
            path === '/v1/account/plugin-settings/acme.settings' && init?.method === 'POST'
        ))).toHaveLength(1);
        expect(runtime.serverFetch.mock.calls.filter(([path, init]) => (
            path === '/v1/account/plugin-settings/acme.settings' && init?.method === 'GET'
        ))).toHaveLength(2);
    });

    it('fails closed when an Account record becomes stale while its JSON body is decoding', async () => {
        const delayedRecord = deferred<unknown>();
        runtime.serverFetch
            .mockResolvedValueOnce(jsonResponse(async () => ({ mode: 'plain', updatedAt: 1 })))
            .mockResolvedValueOnce(jsonResponse(() => delayedRecord.promise));

        const read = scopedPluginSettingsAdapter.read({
            pluginId: 'acme.settings',
            scope: { kind: 'account' },
            target: ACCOUNT_TARGET,
            fields: ACCOUNT_FIELDS,
        });
        await vi.waitFor(() => expect(runtime.serverFetch).toHaveBeenCalledTimes(2));

        runtime.current = false;
        delayedRecord.resolve({
            status: 'present',
            revision: 4,
            content: { t: 'plain', v: { v: 1, values: { endpoint: 'account-a-value' } } },
        });

        await expect(read).resolves.toEqual({ status: 'unavailable', reason: 'transport' });
    });

    it('does not report a completed write after the Account lifetime becomes stale during mutation JSON decoding', async () => {
        const delayedMutation = deferred<unknown>();
        runtime.serverFetch
            .mockResolvedValueOnce(jsonResponse(async () => ({ mode: 'plain', updatedAt: 1 })))
            .mockResolvedValueOnce(jsonResponse(async () => ({ status: 'absent' })))
            .mockResolvedValueOnce(jsonResponse(async () => ({ mode: 'plain', updatedAt: 1 })))
            .mockResolvedValueOnce(jsonResponse(() => delayedMutation.promise));

        const write = scopedPluginSettingsAdapter.write({
            pluginId: 'acme.settings',
            scope: { kind: 'account' },
            target: ACCOUNT_TARGET,
            fields: ACCOUNT_FIELDS,
            fieldId: 'endpoint',
            mutation: { kind: 'set', value: 'account-a-value' },
            expectedRevision: { kind: 'account', value: 'absent' },
        });
        await vi.waitFor(() => expect(runtime.serverFetch).toHaveBeenCalledTimes(4));

        runtime.current = false;
        delayedMutation.resolve({ status: 'updated', revision: 1 });

        await expect(write).resolves.toEqual({ status: 'unavailable', reason: 'transport' });
    });
});
