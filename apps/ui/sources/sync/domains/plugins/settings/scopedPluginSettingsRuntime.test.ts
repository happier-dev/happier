import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { PluginSettingsContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/settings';
import { qualifyPluginAccountSecretBindingKey } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { act } from 'react-test-renderer';
import { renderHook, standardCleanup } from '@/dev/testkit';

const runtime = vi.hoisted(() => ({
    token: 'token-a',
    serverFetch: vi.fn(),
    daemonSettingsWatch: vi.fn(),
}));

vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytes: (length: number) => new Uint8Array(length),
}));

vi.mock('@/platform/randomUUID', () => ({ randomUUID: () => 'test-id' }));

vi.mock('@/sync/http/client', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/http/client')>();
    return {
        ...original,
        serverFetch: (path: string, ...args: Parameters<typeof original.serverFetch> extends [unknown, ...infer Rest] ? Rest : never) => (
            path === '/v1/account/encryption' || path.startsWith('/v1/account/plugin-settings/')
                ? runtime.serverFetch(path, ...args)
                : original.serverFetch(path, ...args)
        ),
    };
});

vi.mock('@/sync/ops/machineContributionRegistryProjection', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/ops/machineContributionRegistryProjection')>()),
    machinePluginSecretDelete: vi.fn(),
    machinePluginSecretSet: vi.fn(),
    machinePluginSecretStatus: vi.fn(),
    machinePluginSettingsGet: vi.fn(),
    machinePluginSettingsSet: vi.fn(),
    watchMachinePluginSettingsChanges: runtime.daemonSettingsWatch,
}));

installDisconnectedServerSocketBoundary();
const { scopedPluginSettingsStorageAdapterForTests: scopedPluginSettingsAdapter, scopedPluginAccountSecretSettingsAdapter } = await import('./scopedPluginSettingsRuntime');
const { storage } = await import('@/sync/domains/state/storage');
const { useScopedPluginSettingsProjection } = await import('./scopedPluginSettingsProjection');
const { projectAccountDeclaredPluginSettingsGroups } = await import('./accountDeclaredPluginSettings');
const { executeScopedPluginSettingsAdministrationAction } = await import('@/sync/ops/actions/pluginSettingsAdministrationAction');
const { watchActiveScopedPluginSettingsChanges } = await import('./scopedPluginSettingsChangeWatch');
const tokenA = createAccountTokenForTests('account-a');
const tokenB = createAccountTokenForTests('account-b');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

const ACCOUNT_TARGET = Object.freeze({
    kind: 'account' as const,
    serverIdentityId: 'srv_plugin_settings_runtime',
});

const DAEMON_TARGET = Object.freeze({
    kind: 'daemon' as const,
    serverIdentityId: 'srv_plugin_settings_runtime',
    machineId: 'machine-a',
    serverId: 'server-a',
});

const ACCOUNT_FIELDS = Object.freeze([{ key: 'endpoint', redacted: false }]);

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((accept) => { resolve = accept; });
    return { promise, resolve };
}

function jsonResponse(body: () => Promise<unknown>, status = 200) {
    return Object.freeze({ ok: status >= 200 && status < 300, status, json: body });
}

beforeEach(async () => {
    runtime.token = tokenA;
    runtime.serverFetch.mockResolvedValue(Response.json({ mode: 'plain', updatedAt: 1 }));
    connection = await restoreServerAccountForTest({
        serverUrl: 'https://server-a.example.test',
        serverIdentityId: ACCOUNT_TARGET.serverIdentityId,
        credentials: { get token() { return runtime.token; } },
        request: async (url) => new URL(String(url)).pathname === '/v1/account/encryption'
            ? Response.json({ mode: 'plain', updatedAt: 1 }) : null,
    });
    runtime.serverFetch.mockReset();
    runtime.daemonSettingsWatch.mockReset();
});

afterEach(async () => {
    await connection?.dispose();
    connection = null;
});

describe('scopedPluginSettingsAdapter Account currentness', () => {
    it('only invalidates the mounted Account secret reader for Saved Secret or binding changes', () => {
        const scope = { kind: 'account' as const };
        const onInvalidated = vi.fn();
        const watch = scopedPluginAccountSecretSettingsAdapter.watch?.({
            pluginId: 'acme.settings', scope, target: ACCOUNT_TARGET, onInvalidated,
        });
        try {
            const state = storage.getState();
            const { settings } = state;
            const settingsVersion = state.settingsVersion ?? 0;
            state.applySettings({ ...settings, showLineNumbers: !settings.showLineNumbers }, settingsVersion + 1);
            expect(onInvalidated).not.toHaveBeenCalled();
            expect(runtime.serverFetch).not.toHaveBeenCalled();

            const target = { pluginId: 'acme.settings', localId: 'token' };
            const current = storage.getState();
            current.applySettings({ ...current.settings, pluginSecretBindingsV1: {
                [qualifyPluginAccountSecretBindingKey(target)]: { ...target, custody: 'account', savedSecretId: 'saved-secret' },
            } }, settingsVersion + 2);
            expect(onInvalidated).toHaveBeenCalledTimes(1);

            const bound = storage.getState();
            bound.applySettings({ ...bound.settings, secrets: [{
                id: 'saved-secret', name: 'Plugin token', kind: 'other',
                encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'YQ' } }, createdAt: 1, updatedAt: 1,
            }] }, settingsVersion + 3);
            expect(onInvalidated).toHaveBeenCalledTimes(2);
            expect(runtime.serverFetch).not.toHaveBeenCalled();
        } finally {
            watch?.dispose();
        }
    });

    it.each(['updated', 'conflict'] as const)('refreshes only the mounted plugin projection after a public Action receives %s', async status => {
        let revision = 4;
        let values: Readonly<Record<string, unknown>> = { endpoint: 'before' };
        const reads: string[] = [];
        runtime.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') return jsonResponse(async () => ({ mode: 'plain', updatedAt: 1 }));
            if (init?.method === 'GET') {
                reads.push(path);
                return jsonResponse(async () => ({ status: 'present', revision,
                    content: { t: 'plain', v: { v: 1, values: path.endsWith('/acme.settings') ? values : { endpoint: 'unrelated' } } } }));
            }
            if (path === '/v1/account/plugin-settings/acme.settings' && init?.method === 'POST') {
                revision += 1;
                values = { endpoint: status === 'updated' ? 'after' : 'concurrent-winner' };
                return jsonResponse(async () => ({ status, revision }));
            }
            throw new Error(`Unexpected Account Settings request: ${path}`);
        });
        const scope = { kind: 'account' as const };
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        const groups = projectAccountDeclaredPluginSettingsGroups({ pluginId: 'acme.settings', declaration: { id: 'acme.settings',
            contributes: { settings: [PluginSettingsContributionV2Schema.parse({ id: 'preferences', title: 'Preferences', scope: 'account',
                target: { kind: 'plugin' }, fields: [{ id: 'endpoint', title: 'Endpoint', schema: { type: 'string' } }] })] } } });
        const hook = await renderHook(() => ({
            selected: useScopedPluginSettingsProjection({ pluginId: 'acme.settings', scope, target: ACCOUNT_TARGET,
                perActiveServerIdentityId: null, accountLifetime, fields: ACCOUNT_FIELDS, enabled: true, adapter: scopedPluginSettingsAdapter }),
            unrelated: useScopedPluginSettingsProjection({ pluginId: 'acme.other', scope, target: ACCOUNT_TARGET,
                perActiveServerIdentityId: null, accountLifetime, fields: ACCOUNT_FIELDS, enabled: true, adapter: scopedPluginSettingsAdapter }),
        }));
        try {
            expect(hook.getCurrent().selected.state.values).toEqual({ endpoint: 'before' });
            const unrelated = hook.getCurrent().unrelated.state;
            const unrelatedReads = reads.filter(path => path.endsWith('/acme.other')).length;
            await act(async () => {
                const result = await executeScopedPluginSettingsAdministrationAction({ actionId: 'plugins.settings.set',
                    input: { pluginId: 'acme.settings', scope, target: { kind: 'account' }, localId: 'endpoint', value: 'after' }, context: { surface: 'ui' },
                    target: ACCOUNT_TARGET, groups, adapter: scopedPluginSettingsAdapter, secretAdapter: scopedPluginSettingsAdapter,
                    assertCurrent() {} });
                expect(result, JSON.stringify(result)).toMatchObject(status === 'updated' ? { ok: true }
                    : { ok: false, errorCode: 'plugin_settings_revision_conflict' });
            });
            expect(values).toEqual({ endpoint: status === 'updated' ? 'after' : 'concurrent-winner' });
            expect(hook.getCurrent().selected.state.values).toEqual({ endpoint: status === 'updated' ? 'after' : 'concurrent-winner' });
            expect(hook.getCurrent().unrelated.state).toBe(unrelated);
            expect(reads.filter(path => path.endsWith('/acme.other'))).toHaveLength(unrelatedReads);
        } finally { standardCleanup(); }
    });

    it('rechecks the captured Settings intent after the final encryption-mode read before issuing a write', async () => {
        let intentCurrent = true;
        let encryptionReads = 0;
        const entered = deferred<void>();
        const released = deferred<void>();
        const writes: unknown[] = [];
        runtime.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') {
                encryptionReads += 1;
                if (encryptionReads === 2) { entered.resolve(); await released.promise; }
                return jsonResponse(async () => ({ mode: 'plain', updatedAt: 1 }));
            }
            if (init?.method === 'POST') {
                writes.push(init.body);
                return jsonResponse(async () => ({ status: 'updated', revision: 5 }));
            }
            return jsonResponse(async () => ({ status: 'present', revision: 4,
                content: { t: 'plain', v: { v: 1, values: { endpoint: 'old' } } } }));
        });
        const pending = scopedPluginSettingsAdapter.write({ pluginId: 'acme.settings', scope: { kind: 'account' }, target: ACCOUNT_TARGET,
            fields: ACCOUNT_FIELDS, fieldId: 'endpoint', mutation: { kind: 'set', value: 'new' },
            expectedRevision: { kind: 'account', value: 4 }, isCurrent: () => intentCurrent });
        await entered.promise;
        intentCurrent = false;
        released.resolve();
        expect(await pending).toEqual({ status: 'unavailable', reason: 'transport' });
        expect(writes).toEqual([]);
    });
    it('never retargets an Account A read-modify-write to Account B', async () => {
        const writes: string[] = [];
        runtime.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') return jsonResponse(async () => ({ mode: 'plain', updatedAt: 1 }));
            if (init?.method === 'POST') {
                writes.push(String((init.headers as Record<string, string>).Authorization));
                return jsonResponse(async () => ({ status: 'updated', revision: 5 }));
            }
            return jsonResponse(async () => ({
                status: 'present', revision: 4,
                content: { t: 'plain', v: { v: 1, values: { retained: 'Account A private value' } } },
            }));
        });
        const mutation = {
            kind: 'set' as const,
            get value() {
                runtime.token = tokenB;
                return 'new endpoint';
            },
        };
        await expect(scopedPluginSettingsAdapter.write({
            pluginId: 'acme.settings', scope: { kind: 'account' }, target: ACCOUNT_TARGET,
            fields: ACCOUNT_FIELDS, fieldId: 'endpoint', mutation,
            expectedRevision: { kind: 'account', value: 4 },
        })).resolves.toEqual({ status: 'unavailable', reason: 'transport' });
        expect(writes).toEqual([]);
    });

    it.each(['conflict', 'lost'] as const)('preserves %s settlement after Account retirement without another Account readback', async (settlement) => {
        const readTokens: string[] = [];
        runtime.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') return jsonResponse(async () => ({ mode: 'plain', updatedAt: 1 }));
            if (init?.method === 'POST') {
                runtime.token = tokenB;
                if (settlement === 'lost') throw new Error('Response lost after dispatch');
                return jsonResponse(async () => ({ status: 'conflict', revision: 5 }));
            }
            readTokens.push(String((init?.headers as Record<string, string>).Authorization));
            return jsonResponse(async () => ({ status: 'absent' }));
        });
        await expect(scopedPluginSettingsAdapter.write({
            pluginId: 'acme.settings', scope: { kind: 'account' }, target: ACCOUNT_TARGET,
            fields: ACCOUNT_FIELDS, fieldId: 'endpoint', mutation: { kind: 'set', value: 'new endpoint' },
            expectedRevision: { kind: 'account', value: 'absent' },
        })).resolves.toEqual({ status: settlement === 'lost' ? 'outcomeUnknown' : 'conflict' });
        expect(readTokens).toEqual([`Bearer ${tokenA}`]);
    });

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
            serverIdentityId: 'srv_plugin_settings_runtime',
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

        retireActiveServerAccountScopeLifetime();
        delayedRecord.resolve({
            status: 'present',
            revision: 4,
            content: { t: 'plain', v: { v: 1, values: { endpoint: 'account-a-value' } } },
        });

        await expect(read).resolves.toEqual({ status: 'unavailable', reason: 'transport' });
    });

    it('preserves content-free settlement after the Account lifetime becomes stale during mutation JSON decoding', async () => {
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

        retireActiveServerAccountScopeLifetime();
        const replacementLifetime = captureActiveServerAccountScopeLifetime();
        if (!replacementLifetime) throw new Error('Expected replacement Account lifetime');
        let invalidations = 0;
        const watch = watchActiveScopedPluginSettingsChanges({ pluginId: 'acme.settings', target: ACCOUNT_TARGET,
            lifetime: replacementLifetime, onInvalidated() { invalidations += 1; } });
        delayedMutation.resolve({ status: 'updated', revision: 1 });

        await expect(write).resolves.toEqual({ status: 'applied', revision: { kind: 'account', value: 1 } });
        expect(invalidations).toBe(0);
        watch.dispose();
    });

    it('does not accept a success-shaped mutation body from a non-success HTTP response', async () => {
        runtime.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') {
                return jsonResponse(async () => ({ mode: 'plain', updatedAt: 1 }));
            }
            if (path === '/v1/account/plugin-settings/acme.settings' && init?.method === 'GET') {
                return jsonResponse(async () => ({ status: 'absent' }));
            }
            if (path === '/v1/account/plugin-settings/acme.settings' && init?.method === 'POST') {
                return jsonResponse(async () => ({ status: 'updated', revision: 1 }), 409);
            }
            throw new Error(`Unexpected Account Settings request: ${path}`);
        });

        await expect(scopedPluginSettingsAdapter.write({
            pluginId: 'acme.settings',
            scope: { kind: 'account' },
            target: ACCOUNT_TARGET,
            fields: ACCOUNT_FIELDS,
            fieldId: 'endpoint',
            mutation: { kind: 'set', value: 'account-a-value' },
            expectedRevision: { kind: 'account', value: 'absent' },
        })).resolves.toEqual({
            status: 'outcomeUnknown',
            snapshot: {
                scope: { kind: 'account' },
                target: ACCOUNT_TARGET,
                revision: { kind: 'account', value: 'absent' },
                values: {},
            },
        });
    });
});
