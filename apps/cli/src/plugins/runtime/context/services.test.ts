import { access, constants, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { FetchRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createPluginAuthService } from './auth';
import { createPluginEnvService } from './env';
import { createPluginEventsService, publishHostPluginEvent } from './events';
import { createPluginExecService } from './exec';
import { createPluginFsService } from './fs';
import { createPluginManagedServerService } from './managedServer';
import { createPluginProgressService } from './progress';
import { createPluginRetryService } from './retry';
import { createPluginSecretsService } from './secrets';
import { createPluginSettingsService } from './settings';
import {
    copyPluginSessionStorageForFork,
    createAccountSettingsBackedPluginStorageScope,
    createPluginStoragePublicShareSnapshot,
    createPluginStorageService,
} from './storage';
import { createPluginTranscriptsService } from './transcripts';
import { createPluginDisposableRegistry } from '../lifecycle/disposables';

async function makeHappyHome(): Promise<string> {
    return await mkdtemp(join(tmpdir(), 'happier-a11-'));
}

async function firstExecutablePath(candidates: readonly string[]): Promise<string> {
    for (const candidate of candidates) {
        try {
            await access(candidate, constants.X_OK);
            return candidate;
        } catch {
            // Try the next platform-specific candidate.
        }
    }
    throw new Error(`No executable candidate found: ${candidates.join(', ')}`);
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

    it('provides A.13 env and fs services through plugin-scoped access only', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const env = createPluginEnvService({
            env: {
                HAPPIER_ALLOWED: 'yes',
                SECRET_TOKEN: 'no',
            },
            allowedNames: ['HAPPIER_ALLOWED'],
        });
        const fs = createPluginFsService({
            rootDir: join(paths.storageDir, 'acme.plugin', 'fs'),
        });

        expect(env.get('HAPPIER_ALLOWED')).toBe('yes');
        expect(env.get('SECRET_TOKEN')).toBeNull();
        await fs.writeText({ path: 'notes/run.txt', contents: 'ok' });

        await expect(fs.readText({ path: 'notes/run.txt' })).resolves.toBe('ok');
        await expect(fs.writeText({ path: '../escape.txt', contents: 'no' })).rejects.toThrow(/escapes/);
    });

    it('rejects plugin filesystem symlink escapes from the scoped root', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const rootDir = join(paths.storageDir, 'acme.plugin', 'fs');
        const outsideDir = await mkdtemp(join(tmpdir(), 'happier-a13-fs-outside-'));
        await mkdir(rootDir, { recursive: true });
        await writeFile(join(outsideDir, 'secret.txt'), 'secret', 'utf8');
        await symlink(outsideDir, join(rootDir, 'outside'), 'dir');
        const fs = createPluginFsService({
            rootDir,
        });

        await expect(fs.readText({ path: 'outside/secret.txt' })).rejects.toThrow(/escapes/);
        await expect(fs.writeText({ path: 'outside/new.txt', contents: 'no' })).rejects.toThrow(/escapes/);
        await expect(fs.list({ path: 'outside' })).rejects.toThrow(/escapes/);
        await expect(fs.stat({ path: 'outside/secret.txt' })).rejects.toThrow(/escapes/);
    });

    it('enforces declared plugin filesystem read and write permissions', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const rootDir = join(paths.storageDir, 'acme.plugin', 'fs');
        const fs = createPluginFsService({
            rootDir,
            readAllowedPaths: [],
            writeAllowedPaths: ['allowed'],
        });

        await expect(fs.writeText({ path: 'allowed/run.txt', contents: 'ok' })).resolves.toBeUndefined();
        await expect(fs.writeText({ path: 'denied/run.txt', contents: 'no' })).rejects.toThrow(/permission/);
        await expect(fs.readText({ path: 'allowed/run.txt' })).rejects.toThrow(/permission/);
    });

    it('does not expose Happier environment variables without explicit manifest scopes', () => {
        const env = createPluginEnvService({
            env: {
                HAPPIER_A13_SECRET: 'hidden',
                HAPPIER_VISIBLE_ONLY_IF_DECLARED: 'hidden',
            },
        });

        expect(env.get('HAPPIER_A13_SECRET')).toBeNull();
        expect(env.list()).toEqual({});
        expect(() => env.require('HAPPIER_A13_SECRET')).toThrow(/unavailable/);
    });

    it('exposes only explicitly declared environment variable scopes', () => {
        const env = createPluginEnvService({
            env: {
                HAPPIER_DECLARED_ENV: 'visible',
                HAPPIER_A13_SECRET: 'hidden',
            },
            allowedNames: ['HAPPIER_DECLARED_ENV'],
        });

        expect(env.get('HAPPIER_DECLARED_ENV')).toBe('visible');
        expect(env.get('HAPPIER_A13_SECRET')).toBeNull();
        expect(env.list()).toEqual({ HAPPIER_DECLARED_ENV: 'visible' });
    });

    it('provides retry, progress, and transcript source handles with bounded cleanup semantics', async () => {
        const retry = createPluginRetryService();
        let attempts = 0;
        await expect(retry.wrap(async ({ attempt }) => {
            attempts = attempt;
            if (attempt === 1) {
                throw Object.assign(new Error('retry'), { code: 'ETIMEDOUT' });
            }
            return 'ok';
        }, {
            maxAttempts: 2,
            baseDelayMs: 0,
        })).resolves.toBe('ok');
        expect(attempts).toBe(2);

        const progress = createPluginProgressService();
        const handle = progress.start({ id: 'sync', label: 'Sync', total: 2 });
        progress.report('sync', { current: 1 });
        expect(handle.snapshot()).toMatchObject({ current: 1, total: 2, state: 'active' });
        progress.finish('sync', 'done');
        expect(handle.snapshot()).toMatchObject({ state: 'finished', message: 'done' });

        const release = vi.fn(async () => undefined);
        const registry = createPluginDisposableRegistry();
        const transcripts = createPluginTranscriptsService({
            append: async () => undefined,
            maxSources: 1,
            addDisposable: registry.add,
        });
        const source = await transcripts.defineSource({
            id: 'runtime',
            page: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
            readAfter: async () => ({ items: [], nextCursor: null, truncated: false }),
            acquireFollowLease: async () => ({ release }),
        });
        await expect(transcripts.defineSource({
            id: 'overflow',
            page: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
            readAfter: async () => ({ items: [], nextCursor: null, truncated: false }),
        })).rejects.toThrow(/more than 1/);
        await source.dispose();
        await source.dispose();
        expect(release).toHaveBeenCalledTimes(1);

        const retainedRelease = vi.fn(async () => undefined);
        await transcripts.defineSource({
            id: 'retained',
            page: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
            readAfter: async () => ({ items: [], nextCursor: null, truncated: false }),
            acquireFollowLease: async () => ({ release: retainedRelease }),
        });
        await registry.dispose();
        expect(retainedRelease).toHaveBeenCalledTimes(1);
    });

    it('rejects undeclared executable launches before spawning a process', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const exec = createPluginExecService({
            allowedExecutablePaths: [],
        });

        await expect(exec.run({
            kind: 'resolvedExecutable',
            executablePath: shellPath,
            args: ['-c', 'exit 0'],
        })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_PERMISSION_DENIED',
        });
    });

    it('rejects path-only executable launches before spawn even when policy contains a matching path-only scope', async () => {
        const exec = createPluginExecService({
            allowedExecutablePaths: ['git'],
        });

        await expect(exec.spawn({
            kind: 'resolvedExecutable',
            executablePath: 'git',
            args: ['--version'],
        })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_UNRESOLVED_LAUNCH',
        });
    });

    it('does not leak host environment variables into allowed exec launches', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const previous = process.env.HAPPIER_A13_SECRET;
        process.env.HAPPIER_A13_SECRET = 'leaked';
        try {
            const exec = createPluginExecService({
                allowedExecutablePaths: [shellPath],
                baseEnv: {},
            });

            await expect(exec.run({
                kind: 'resolvedExecutable',
                executablePath: shellPath,
                args: ['-c', 'printf "%s" "${HAPPIER_A13_SECRET:-}"'],
            })).resolves.toMatchObject({
                stdout: '',
            });
        } finally {
            if (previous === undefined) {
                delete process.env.HAPPIER_A13_SECRET;
            } else {
                process.env.HAPPIER_A13_SECRET = previous;
            }
        }
    });

    it('disposes spawned exec handles through the plugin lifecycle registry', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const registry = createPluginDisposableRegistry();
        const exec = createPluginExecService({
            allowedExecutablePaths: [shellPath],
            addDisposable: registry.add,
        });

        const handle = await exec.spawn({
            kind: 'resolvedExecutable',
            executablePath: shellPath,
            args: ['-c', 'sleep 30'],
        });
        await registry.dispose();

        await expect(handle.exit).resolves.toMatchObject({
            exitCode: null,
        });
        await expect(handle.dispose()).resolves.toBeUndefined();
    });

    it('does not report managed servers healthy when no health check evidence is available', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const server = createPluginManagedServerService({
            exec: createPluginExecService({
                allowedExecutablePaths: [shellPath],
            }),
        });
        const handle = await server.supervise({
            id: 'without-health',
            launch: {
                kind: 'resolvedExecutable',
                executablePath: shellPath,
                args: ['-c', 'sleep 30'],
            },
            startupTimeoutMs: 25,
        });

        await expect(handle.waitUntilHealthy({ timeoutMs: 25 })).rejects.toMatchObject({
            code: 'PLUGIN_MANAGED_SERVER_HEALTH_UNSUPPORTED',
        });
        expect(handle.snapshot()).toMatchObject({
            state: 'unhealthy',
        });
        await handle.dispose();
    });

    it('composes caller abort signals into managed server HTTP health probes', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const fetchSignals: AbortSignal[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
            if (init?.signal instanceof AbortSignal) {
                fetchSignals.push(init.signal);
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
            return new Response(null, { status: 503 });
        }));
        const server = createPluginManagedServerService({
            exec: createPluginExecService({
                allowedExecutablePaths: [shellPath],
            }),
        });
        const handle = await server.supervise({
            id: 'http-health-abort',
            launch: {
                kind: 'resolvedExecutable',
                executablePath: shellPath,
                args: ['-c', 'sleep 30'],
            },
            healthCheck: {
                kind: 'http',
                url: 'http://127.0.0.1/health',
                timeoutMs: 1_000,
            },
        });
        const controller = new AbortController();
        const wait = handle.waitUntilHealthy({
            timeoutMs: 1_000,
            signal: controller.signal,
        });
        try {
            await vi.waitFor(() => {
                expect(fetchSignals).toHaveLength(1);
            });
            controller.abort();
            expect(fetchSignals[0]?.aborted).toBe(true);
            await expect(wait).rejects.toMatchObject({
                name: 'AbortError',
            });
        } finally {
            await wait.catch(() => undefined);
            await handle.dispose();
            vi.unstubAllGlobals();
        }
    });

    it('rejects managed-server HTTP health probes for non-loopback origins', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const server = createPluginManagedServerService({
            exec: createPluginExecService({
                allowedExecutablePaths: [shellPath],
            }),
        });
        const handle = await server.supervise({
            id: 'http-health-non-loopback',
            launch: {
                kind: 'resolvedExecutable',
                executablePath: shellPath,
                args: ['-c', 'sleep 30'],
            },
            healthCheck: {
                kind: 'http',
                url: 'https://metadata.google.internal/health',
                timeoutMs: 10,
            },
            startupTimeoutMs: 10,
        });

        try {
            await expect(handle.waitUntilHealthy({ timeoutMs: 10 })).rejects.toThrow(/loopback/);
            expect(fetchMock).not.toHaveBeenCalled();
        } finally {
            await handle.dispose();
            vi.unstubAllGlobals();
        }
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
