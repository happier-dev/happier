import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { FetchRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createPluginAuthService } from './auth';
import { createPluginEventsService, publishHostPluginEvent } from './events';
import { createPluginSecretsService } from './secrets';
import { createPluginSettingsService } from './settings';
import {
    copyPluginSessionStorageForFork,
    createAccountSettingsBackedPluginStorageScope,
    createPluginStoragePublicShareSnapshot,
    createPluginStorageService,
} from './storage';

async function makeHappyHome(): Promise<string> {
    return await mkdtemp(join(tmpdir(), 'happier-a11-'));
}

describe('A.11 plugin context services', () => {
    it('scopes storage by plugin id and keeps ephemeral/session/local/synced behavior distinct', async () => {
        const happyHomeDir = await makeHappyHome();
        const syncedValues = new Map<string, unknown>();
        const service = createPluginStorageService({
            pluginId: 'acme.plugin',
            paths: resolvePluginStorePaths({ happyHomeDir }),
            sessionId: 'session-source',
            synced: {
                get: async <T = unknown>(key: string): Promise<T | null> =>
                    syncedValues.has(key) ? syncedValues.get(key) as T : null,
                set: async (key, value) => {
                    syncedValues.set(key, value);
                },
                delete: async (key) => {
                    syncedValues.delete(key);
                },
                listKeys: async () => [...syncedValues.keys()],
            },
        });

        await service.ephemeral.set('volatile', { ok: true });
        await service.session.set('turn', { session: true });
        await service.local.set('durable', { local: true });
        await service.synced.set('account', { synced: true });

        expect(await service.ephemeral.get('volatile')).toEqual({ ok: true });
        expect(await service.session.get('turn')).toEqual({ session: true });
        expect(await service.local.get('durable')).toEqual({ local: true });
        expect(await service.synced.get('account')).toEqual({ synced: true });

        const restarted = createPluginStorageService({
            pluginId: 'acme.plugin',
            paths: resolvePluginStorePaths({ happyHomeDir }),
            sessionId: 'session-source',
        });
        expect(await restarted.ephemeral.get('volatile')).toBeNull();
        expect(await restarted.session.get('turn')).toEqual({ session: true });
        expect(await restarted.local.get('durable')).toEqual({ local: true });
        await expect(restarted.synced.get('account')).rejects.toMatchObject({
            code: 'PLUGIN_STORAGE_SYNCED_UNAVAILABLE',
        });
    });

    it('deep-copies session storage on fork and strips it from public share snapshots', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const source = createPluginStorageService({
            pluginId: 'acme.plugin',
            paths,
            sessionId: 'session-source',
        });
        await source.session.set('draft', { nested: { value: 1 } });
        await source.local.set('deviceOnly', { value: true });

        await copyPluginSessionStorageForFork({
            paths,
            sourceSessionId: 'session-source',
            targetSessionId: 'session-target',
        });
        await source.session.set('draft', { nested: { value: 2 } });

        const target = createPluginStorageService({
            pluginId: 'acme.plugin',
            paths,
            sessionId: 'session-target',
        });
        expect(await target.session.get('draft')).toEqual({ nested: { value: 1 } });

        const unbound = createPluginStorageService({
            pluginId: 'acme.plugin',
            paths,
        });
        await expect(unbound.session.listKeys()).rejects.toMatchObject({
            code: 'PLUGIN_STORAGE_SESSION_UNAVAILABLE',
        });
        await expect(createPluginStoragePublicShareSnapshot({ paths })).resolves.toEqual({
            t: 'happier_plugin_public_share_storage_snapshot_v1',
            plugins: [],
        });
    });

    it('backs synced storage with account settings while preserving unknown account fields', async () => {
        let settings: Record<string, unknown> = { existing: true };
        const synced = createAccountSettingsBackedPluginStorageScope({
            pluginId: 'acme.plugin',
            getSettings: () => settings,
            updateSettings: async (mutate) => {
                settings = mutate(settings);
                return settings;
            },
        });

        await synced.set('shared', { ok: true });

        expect(await synced.get('shared')).toEqual({ ok: true });
        expect(await synced.listKeys()).toEqual(['shared']);
        expect(settings.existing).toBe(true);

        await synced.delete('shared');
        expect(await synced.get('shared')).toBeNull();
    });

    it('validates settings writes while preserving unknown plugin-owned keys and descriptor projection semantics', async () => {
        const happyHomeDir = await makeHappyHome();
        const storage = createPluginStorageService({
            pluginId: 'acme.plugin',
            paths: resolvePluginStorePaths({ happyHomeDir }),
        });
        const changes: unknown[] = [];
        const settings = createPluginSettingsService({
            pluginId: 'acme.plugin',
            storage: storage.local,
            descriptors: [
                {
                    id: 'endpoint',
                    kind: 'settings.field',
                    version: '1.0.0',
                    valueSchema: { type: 'string' },
                    control: 'text',
                    displayKey: 'plugins.acme.endpoint.label',
                    capabilityGates: [],
                    permissionGates: [],
                    redaction: 'none',
                    hidden: false,
                    clearWhenEmpty: 'omit',
                    order: 2,
                },
                {
                    id: 'notes',
                    kind: 'settings.field',
                    version: '1.0.0',
                    valueSchema: { type: 'string' },
                    control: 'textarea',
                    displayKey: 'plugins.acme.notes.label',
                    capabilityGates: [],
                    permissionGates: [],
                    redaction: 'none',
                    hidden: false,
                    clearWhenEmpty: 'persist',
                    order: 1,
                },
                {
                    id: 'enabled',
                    kind: 'settings.field',
                    version: '1.0.0',
                    valueSchema: { type: 'boolean' },
                    control: 'switch',
                    displayKey: 'plugins.acme.enabled.label',
                    capabilityGates: [],
                    permissionGates: [],
                    redaction: 'none',
                    defaultBooleanValue: false,
                    clearWhenEmpty: 'persist',
                    hidden: true,
                    order: 3,
                },
            ],
        });
        const subscription = settings.onChange((next) => changes.push(next));

        await storage.local.set('settings', { unknownPluginKey: 123 });
        await settings.set('endpoint', 'https://example.test');
        await settings.set('enabled', false);
        await settings.set('endpoint', '');
        await settings.set('notes', '');

        expect(await settings.get()).toEqual({
            unknownPluginKey: 123,
            enabled: false,
            notes: '',
        });
        await expect(settings.set('enabled', 'false')).rejects.toMatchObject({
            code: 'PLUGIN_SETTINGS_VALIDATION_FAILED',
        });
        expect(settings.projectForm().fields.map((field) => field.id)).toEqual(['notes', 'endpoint']);
        expect(settings.describeFields().find((field) => field.id === 'enabled')).toMatchObject({
            hidden: true,
            defaultBooleanValue: false,
        });
        expect(changes.length).toBeGreaterThan(0);
        subscription.unsubscribe();
    });

    it('stores secrets per plugin namespace without exposing values in list output', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const fixedKey = new Uint8Array(32).fill(7);
        const randomBytes = (length: number) => new Uint8Array(length).fill(3);
        const left = createPluginSecretsService({
            pluginId: 'left.plugin',
            paths,
            secretKey: fixedKey,
            randomBytes,
        });
        const right = createPluginSecretsService({
            pluginId: 'right.plugin',
            paths,
            secretKey: fixedKey,
            randomBytes,
        });

        await left.set('shared-name', 'left-secret');
        await right.set('shared-name', 'right-secret');

        expect(await left.get('shared-name')).toBe('left-secret');
        expect(await right.get('shared-name')).toBe('right-secret');
        expect(await left.list()).toEqual([{ name: 'shared-name' }]);

        const secretFile = join(paths.secretsDir, 'left.plugin', 'secrets.v1.json');
        const raw = await readFile(secretFile, 'utf8');
        expect(raw).not.toContain('left-secret');
        if (process.platform !== 'win32') {
            expect((await stat(secretFile)).mode & 0o777).toBe(0o600);
        }
    });

    it('enforces plugin event prefixes, reserved host namespaces, and subscribe capabilities', async () => {
        const bus = createPluginEventsService({
            pluginId: 'acme.plugin',
            canSubscribe: (eventName) => eventName === '@happier/session/ready',
        });
        const listener = vi.fn();
        const subscription = bus.subscribe('@happier/session/ready', listener);

        await publishHostPluginEvent('@happier/session/ready', { sessionId: 'session-1' });
        await expect(bus.emit('acme.plugin.taskComplete', { id: 1 })).resolves.toBeUndefined();
        await expect(bus.emit('@happier/runtime/reload', {})).rejects.toMatchObject({
            code: 'PLUGIN_EVENTS_RESERVED_NAMESPACE',
        });
        await expect(bus.emit('other.plugin.taskComplete', {})).rejects.toMatchObject({
            code: 'PLUGIN_EVENTS_PREFIX_REQUIRED',
        });
        expect(() => bus.subscribe('@happier/runtime/reload', listener)).toThrowError(/capability/i);
        expect(listener).toHaveBeenCalledWith({
            name: '@happier/session/ready',
            payload: { sessionId: 'session-1' },
        });

        subscription.unsubscribe();
    });

    it('routes plugin events through the shared ctx.events bus instead of a per-context listener map', async () => {
        const publisher = createPluginEventsService({
            pluginId: 'acme.plugin',
            canSubscribe: (eventName) => eventName === 'acme.plugin.taskComplete',
        });
        const subscriber = createPluginEventsService({
            pluginId: 'acme.plugin',
            canSubscribe: (eventName) => eventName === 'acme.plugin.taskComplete',
        });
        const listener = vi.fn();
        const subscription = subscriber.subscribe('acme.plugin.taskComplete', listener);

        await publisher.emit('acme.plugin.taskComplete', { id: 1 });

        expect(listener).toHaveBeenCalledWith({
            name: 'acme.plugin.taskComplete',
            payload: { id: 1 },
        });
        subscription.unsubscribe();
    });

    it('exposes narrow auth identity, change subscription, and service materialization only', async () => {
        const materialize = vi.fn(async () => ({ env: { TOKEN: 'value' } }));
        const auth = createPluginAuthService({
            getIdentity: async () => ({ accountId: 'acct-1', email: 'user@example.test' }),
            materialize,
        });
        const changed = vi.fn();
        const subscription = auth.onChange(changed);

        expect(await auth.getIdentity()).toEqual({ accountId: 'acct-1', email: 'user@example.test' });
        await expect(auth.services.materialize({ serviceId: 'openai-codex', profileId: 'default' })).resolves.toEqual({
            env: { TOKEN: 'value' },
        });
        expect('getConnectedServices' in auth).toBe(false);
        expect('startConnect' in auth).toBe(false);
        expect('disconnect' in auth).toBe(false);

        subscription.unsubscribe();
    });
});

export function createFetchRuntimeResponse(body: unknown): Awaited<ReturnType<FetchRuntimeServiceV1>> {
    return Object.freeze({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: Object.freeze({}),
        body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        json: async () => body,
        arrayBuffer: async () => new ArrayBuffer(0),
    });
}
