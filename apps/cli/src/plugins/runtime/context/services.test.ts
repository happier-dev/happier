import { access, chmod, constants, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ExecLaunchInputV1, ExecRuntimeServiceV1, FetchRuntimeServiceV1, ManagedServerSpecV1 } from '@happier-dev/plugin-sdk';
import {
    SESSION_PROVIDER_HOOK_EVENT_ID_V1,
    type TypedEventV1,
} from '@happier-dev/protocol';

import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createPluginAuthService } from './auth';
import { createPluginEnvService } from './env';
import {
    canPluginSubscribeToEvent,
    createPluginEventsBroker,
    createPluginEventsService,
    publishHostPluginEvent,
} from './events';
import { createPluginExecService } from './exec';
import { createPluginFsService } from './fs';
import { createPluginManagedServerService } from './managed/server';
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
import { createPluginTerminalHostService } from './terminalHost';
import { createPluginTranscriptsService } from './transcripts';
import { createTranscriptFileFollowPathGrantRegistry } from './transcripts/fileFollowGrants';
import { createPluginDisposableRegistry } from '../lifecycle/disposables';
import type {
    TerminalControlPort,
    TerminalHostAdapter,
    TerminalHostHandle,
    TerminalInputInjectionResult,
    TerminalPromptInput,
} from '@happier-dev/agents';

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

    it('enforces slash event ids, reserved host namespaces, and canonical subscribe permissions', async () => {
        const bus = createPluginEventsService({
            pluginId: 'acme.plugin',
            declaredEventIds: ['task-complete'],
            canSubscribe: (eventName) => canPluginSubscribeToEvent({
                pluginId: 'acme.plugin',
                eventName,
                permissions: new Set(['events.session.subscribe']),
            }),
        });
        const listener = vi.fn();
        const subscription = bus.subscribe('@happier/session/ready', listener);

        await publishHostPluginEvent('@happier/session/ready', { sessionId: 'session-1' });
        await expect(bus.emit({ id: 'task-complete', payload: { id: 1 } })).resolves.toBeUndefined();
        await expect(bus.emit({ id: '@happier/runtime/reload', payload: {} })).rejects.toMatchObject({
            code: 'PLUGIN_EVENTS_RESERVED_NAMESPACE',
        });
        await expect(publishHostPluginEvent('@happier/session', {})).rejects.toMatchObject({
            code: 'PLUGIN_EVENTS_HOST_NAMESPACE_REQUIRED',
        });
        await expect(bus.emit({ id: 'other.plugin/task-complete', payload: {} })).rejects.toMatchObject({
            code: 'PLUGIN_EVENTS_PREFIX_REQUIRED',
        });
        await expect(bus.emit({ id: 'acme.plugin.task-complete', payload: {} })).rejects.toMatchObject({
            code: 'PLUGIN_EVENTS_INVALID_ID',
        });
        expect(() => bus.subscribe('@happier/runtime/reload', listener)).toThrowError(/capability/i);
        expect(listener).toHaveBeenCalledWith({
            id: '@happier/session/ready',
            payload: { sessionId: 'session-1' },
            envelope: expect.objectContaining({
                emittedAt: expect.any(String),
                sequence: expect.any(Number),
                source: {
                    kind: 'host',
                    namespace: 'session',
                },
            }),
        });

        subscription.unsubscribe();
    });

    it('validates emitted plugin events against manifest-declared payload schemas', async () => {
        const publisherParams = {
            pluginId: 'acme.plugin',
            eventDeclarations: [
                {
                    id: 'task-complete',
                    payloadSchema: {
                        type: 'object',
                        required: ['checkpointId'],
                        properties: {
                            checkpointId: { type: 'string' },
                            attempt: { type: 'integer' },
                        },
                    },
                },
            ],
        } satisfies Parameters<typeof createPluginEventsService>[0] & Readonly<{
            eventDeclarations: readonly Readonly<{
                id: string;
                payloadSchema: Readonly<Record<string, unknown>>;
            }>[];
        }>;
        const publisher = createPluginEventsService(publisherParams);

        await expect(publisher.emit({
            id: 'task-complete',
            payload: { checkpointId: 'checkpoint-1', attempt: 1, extra: true },
        })).resolves.toBeUndefined();
        await expect(publisher.emit({
            id: 'task-complete',
            payload: { attempt: 1 },
        })).rejects.toMatchObject({
            code: 'PLUGIN_EVENTS_INVALID_PAYLOAD',
        });
        await expect(publisher.emit({
            id: 'task-complete',
            payload: { checkpointId: 1 },
        })).rejects.toMatchObject({
            code: 'PLUGIN_EVENTS_INVALID_PAYLOAD',
        });
    });

    it('uses final hierarchical event subscription permission names', () => {
        expect(canPluginSubscribeToEvent({
            pluginId: 'acme.plugin',
            eventName: '@happier/session/ready',
            permissions: new Set(['events.session.subscribe']),
        })).toBe(true);
        expect(canPluginSubscribeToEvent({
            pluginId: 'acme.plugin',
            eventName: '@happier/session/ready',
            permissions: new Set(['session.subscribe']),
        })).toBe(false);
        expect(canPluginSubscribeToEvent({
            pluginId: 'acme.plugin',
            eventName: '@happier/runtime/',
            permissions: new Set(['events.runtime.subscribe']),
        })).toBe(true);
        expect(canPluginSubscribeToEvent({
            pluginId: 'acme.plugin',
            eventName: '@happier/runtime/',
            permissions: new Set(['events.session.subscribe']),
        })).toBe(false);
        expect(canPluginSubscribeToEvent({
            pluginId: 'acme.plugin',
            eventName: 'other.plugin/task-complete',
            permissionDeclarations: [
                {
                    capability: 'events.plugin.subscribe',
                    scope: 'other.plugin',
                },
            ],
        })).toBe(true);
        expect(canPluginSubscribeToEvent({
            pluginId: 'acme.plugin',
            eventName: 'other.plugin/task-complete',
            permissions: new Set(['events.plugin.subscribe']),
        })).toBe(false);
        expect(canPluginSubscribeToEvent({
            pluginId: 'acme.plugin',
            eventName: 'other.plugin/task-complete',
            permissions: new Set(['events.subscribe']),
        })).toBe(false);
    });

    it('does not replay host session events to later subscribers', async () => {
        const staleReplayOptions = {
            replay: {
                maxEvents: 8,
                ttlMs: 60_000,
                shouldReplay: (event: TypedEventV1) => event.id.startsWith('@happier/session/'),
            },
        } as unknown as Parameters<typeof createPluginEventsBroker>[0];
        const broker = createPluginEventsBroker(staleReplayOptions);
        const payload = {
            providerId: 'claude',
            sessionId: 'happier-session-1',
            providerSessionId: 'provider-session-1',
            eventName: 'SessionStart',
            providerPayload: { session_id: 'provider-session-1' },
        };

        await broker.emit({
            id: SESSION_PROVIDER_HOOK_EVENT_ID_V1,
            payload,
            envelope: {
                emittedAt: new Date().toISOString(),
                source: { kind: 'host', namespace: 'session' },
            },
        });

        const listener = vi.fn();
        const bus = createPluginEventsService({
            pluginId: 'acme.plugin',
            broker,
            canSubscribe: (eventName) => canPluginSubscribeToEvent({
                pluginId: 'acme.plugin',
                eventName,
                permissions: new Set(['events.session.subscribe']),
            }),
        });
        bus.subscribe(SESSION_PROVIDER_HOOK_EVENT_ID_V1, listener);
        await Promise.resolve();

        expect(listener).not.toHaveBeenCalled();
    });

    it('allows scoped cross-plugin subscriptions when plugin ids contain dots', async () => {
        const broker = createPluginEventsBroker();
        const publisher = createPluginEventsService({
            pluginId: 'other.plugin',
            declaredEventIds: ['task-complete'],
            broker,
        });
        const subscriber = createPluginEventsService({
            pluginId: 'acme.plugin',
            broker,
            canSubscribe: (eventName) => canPluginSubscribeToEvent({
                pluginId: 'acme.plugin',
                eventName,
                permissionDeclarations: [
                    {
                        capability: 'events.plugin.subscribe',
                        scope: 'other.plugin',
                    },
                ],
            }),
        });
        const listener = vi.fn();

        const subscription = subscriber.subscribe('other.plugin/task-complete', listener);
        await publisher.emit({ id: 'task-complete', payload: { id: 1 } });

        expect(listener).toHaveBeenCalledWith({
            id: 'other.plugin/task-complete',
            payload: { id: 1 },
            envelope: expect.objectContaining({
                source: {
                    kind: 'plugin',
                    pluginId: 'other.plugin',
                },
            }),
        });
        expect(() => subscriber.subscribe('other.plugin.task-complete', listener)).toThrowError(/slash grammar/i);
        expect(() => subscriber.subscribe('other.plugin/task.complete', listener)).toThrowError(/slash grammar/i);
        expect(() => subscriber.subscribe({ pathPrefix: 'other.plugin/task.complete' }, listener)).toThrowError(/slash grammar/i);

        subscription.unsubscribe();
    });

    it('fails cross-plugin subscriptions when the target plugin is not installed at subscription time', () => {
        const subscriber = createPluginEventsService({
            pluginId: 'acme.plugin',
            availablePluginIds: new Set(['acme.plugin']),
            canSubscribe: (eventName) => canPluginSubscribeToEvent({
                pluginId: 'acme.plugin',
                eventName,
                permissionDeclarations: [
                    {
                        capability: 'events.plugin.subscribe',
                        scope: 'missing.plugin',
                    },
                ],
            }),
        });
        const listener = vi.fn();

        expect(() => subscriber.subscribe('missing.plugin/task-complete', listener)).toThrowError(/not installed|unavailable/i);
    });

    it('routes typed plugin events through the shared ctx.events bus while isolating subscriber failures', async () => {
        const subscriberErrors: unknown[] = [];
        const broker = createPluginEventsBroker({
            onSubscriberError: (error) => {
                subscriberErrors.push(error);
            },
        });
        const publisher = createPluginEventsService({
            pluginId: 'acme.plugin',
            declaredEventIds: ['task-complete'],
            broker,
        });
        const subscriber = createPluginEventsService({
            pluginId: 'acme.plugin',
            declaredEventIds: ['task-complete'],
            broker,
            canSubscribe: (eventName) => eventName === 'acme.plugin/task-complete',
        });
        const listener = vi.fn();
        const failingListener = vi.fn(async () => {
            throw new Error('subscriber failed');
        });
        const subscription = subscriber.subscribe('acme.plugin/task-complete', listener);
        const failingSubscription = subscriber.subscribe('acme.plugin/task-complete', failingListener);

        await expect(publisher.emit({ id: 'task-complete', payload: { id: 1 } })).resolves.toBeUndefined();

        expect(listener).toHaveBeenCalledWith({
            id: 'acme.plugin/task-complete',
            payload: { id: 1 },
            envelope: expect.objectContaining({
                emittedAt: expect.any(String),
                sequence: expect.any(Number),
                source: {
                    kind: 'plugin',
                    pluginId: 'acme.plugin',
                },
            }),
        });
        expect(failingListener).toHaveBeenCalledOnce();
        await vi.waitFor(() => {
            expect(subscriberErrors).toEqual([
                expect.objectContaining({
                    eventId: 'acme.plugin/task-complete',
                    pluginId: 'acme.plugin',
                    error: expect.any(Error),
                }),
            ]);
        });
        failingSubscription.unsubscribe();
        subscription.unsubscribe();
    });

    it('accepts event publication without waiting for slow subscribers', async () => {
        const broker = createPluginEventsBroker();
        const publisher = createPluginEventsService({
            pluginId: 'acme.plugin',
            declaredEventIds: ['task-complete'],
            broker,
        });
        const subscriber = createPluginEventsService({
            pluginId: 'acme.plugin',
            declaredEventIds: ['task-complete'],
            broker,
            canSubscribe: (eventName) => eventName === 'acme.plugin/task-complete',
        });
        const slowListener = vi.fn(() => new Promise<void>(() => undefined));
        const subscription = subscriber.subscribe('acme.plugin/task-complete', slowListener);

        await expect(Promise.race([
            publisher.emit({ id: 'task-complete', payload: { id: 1 } }).then(() => 'accepted' as const),
            new Promise<'blocked'>((resolve) => {
                setTimeout(() => resolve('blocked'), 25);
            }),
        ])).resolves.toBe('accepted');
        expect(slowListener).toHaveBeenCalledOnce();

        subscription.unsubscribe();
    });

    it('disposes event subscriptions through the plugin disposable owner', async () => {
        const broker = createPluginEventsBroker();
        const publisher = createPluginEventsService({
            pluginId: 'acme.plugin',
            declaredEventIds: ['task-complete'],
            broker,
        });
        const disposableRegistry = createPluginDisposableRegistry();
        const subscriberParams = {
            pluginId: 'acme.plugin',
            declaredEventIds: ['task-complete'],
            broker,
            canSubscribe: (eventName: string) => eventName === 'acme.plugin/task-complete',
            addDisposable: disposableRegistry.add,
        };
        const subscriber = createPluginEventsService(subscriberParams);
        const listener = vi.fn();

        const subscription = subscriber.subscribe('acme.plugin/task-complete', listener);
        expect(subscription).toHaveProperty('unsubscribe');
        await disposableRegistry.dispose();
        await publisher.emit({ id: 'task-complete', payload: { id: 1 } });

        expect(listener).not.toHaveBeenCalled();
    });

    it('removes event subscriptions when a delivery permission recheck fails', async () => {
        const broker = createPluginEventsBroker();
        const publisher = createPluginEventsService({
            pluginId: 'acme.plugin',
            declaredEventIds: ['task-complete'],
            broker,
        });
        let allowSubscription = true;
        const subscriber = createPluginEventsService({
            pluginId: 'acme.plugin',
            declaredEventIds: ['task-complete'],
            broker,
            canSubscribe: (eventName) => allowSubscription && eventName === 'acme.plugin/task-complete',
        });
        const listener = vi.fn();

        subscriber.subscribe('acme.plugin/task-complete', listener);
        await publisher.emit({ id: 'task-complete', payload: { id: 1 } });
        await vi.waitFor(() => {
            expect(listener).toHaveBeenCalledTimes(1);
        });

        allowSubscription = false;
        await publisher.emit({ id: 'task-complete', payload: { id: 2 } });
        await new Promise((resolve) => setTimeout(resolve, 0));

        allowSubscription = true;
        await publisher.emit({ id: 'task-complete', payload: { id: 3 } });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(listener).toHaveBeenCalledTimes(1);
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

    it('exposes terminal host control only through a host-owned capability-gated wrapper', async () => {
        const handle: TerminalHostHandle = {
            kind: 'tmux',
            sessionName: 'claude-session',
            paneId: '0',
            attachMetadata: {
                attachStrategy: 'terminal_host',
                topology: 'exclusive',
                locality: 'same_machine',
                maxClients: null,
                requiresLocalAttachmentInfo: true,
                liveProbe: 'required',
            },
        };
        const injected: TerminalInputInjectionResult = {
            status: 'injected',
            injectedAt: 123,
            bytesWritten: 5,
            hostKind: 'tmux',
            hostSessionName: 'claude-session',
            paneId: '0',
        };
        const createOrAttachHost = vi.fn<NonNullable<TerminalHostAdapter['createOrAttachHost']>>(async () => handle);
        const injectUserPrompt = vi.fn<NonNullable<TerminalHostAdapter['injectUserPrompt']>>(async () => injected);
        const adapter: TerminalHostAdapter = {
            kind: 'tmux',
            createOrAttachHost,
            injectUserPrompt,
            interruptTurn: vi.fn(async () => undefined),
            evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 456 })),
            captureInputState: vi.fn(async () => ({ stable: true, currentInput: '', observedAt: 789 })),
            dispose: vi.fn(async () => undefined),
        };
        const service = createPluginTerminalHostService({
            hasCapability: (capability) => capability === 'terminalHost' || capability === 'terminal.host.control',
            resolveTerminalHost: (preference) => ({
                status: 'resolved',
                adapter,
                reason: preference === 'tmux' ? 'tmux_forced' : 'tmux_available',
            }),
            resolveAgentCliLaunch: (launch) => ({
                command: '/usr/local/bin/claude',
                args: ['--dangerously-skip-permissions'],
                env: { CLAUDE_CONFIG_DIR: '/tmp/claude-config' },
            }),
        });

        await expect(service.resolve({ preference: 'auto' })).resolves.toEqual({
            status: 'resolved',
            hostKind: 'tmux',
            reason: 'tmux_available',
        });
        const terminalHandle = await service.createOrAttachHost({
            preference: 'tmux',
            sessionName: 'claude-session',
            workingDirectory: '/workspace',
            launch: {
                kind: 'agent-cli',
                agentId: 'claude',
                args: ['--continue'],
                env: { EXTRA: '1' },
            },
            isolatedEnv: true,
        });
        const prompt: TerminalPromptInput = {
            text: 'hello',
            multiline: false,
            origin: { kind: 'ui_pending', nonce: 'nonce-1' },
            scheduling: {},
        };

        await expect(service.injectUserPrompt(terminalHandle, prompt)).resolves.toBe(injected);
        expect(createOrAttachHost).toHaveBeenCalledWith({
            sessionName: 'claude-session',
            workingDirectory: '/workspace',
            spawnArgv: ['/usr/local/bin/claude', '--dangerously-skip-permissions', '--continue'],
            spawnEnv: {
                CLAUDE_CONFIG_DIR: '/tmp/claude-config',
                EXTRA: '1',
            },
            isolatedEnv: true,
        });
        expect(injectUserPrompt).toHaveBeenCalledWith(handle, prompt);

        const disabled = createPluginTerminalHostService({
            hasCapability: () => false,
            resolveTerminalHost: () => ({ status: 'disabled', reason: 'no_host_available', message: 'No host.' }),
            resolveAgentCliLaunch: () => {
                throw new Error('not reached');
            },
        });
        await expect(disabled.resolve({ preference: 'auto' })).rejects.toMatchObject({
            code: 'PLUGIN_TERMINAL_HOST_CAPABILITY_REQUIRED',
        });
        const missingPermission = createPluginTerminalHostService({
            hasCapability: (capability) => capability === 'terminalHost',
            resolveTerminalHost: () => ({ status: 'resolved', adapter, reason: 'tmux_available' }),
            resolveAgentCliLaunch: () => ({
                command: '/usr/local/bin/claude',
                args: [],
            }),
        });
        await expect(missingPermission.resolve({ preference: 'auto' })).rejects.toMatchObject({
            code: 'PLUGIN_TERMINAL_HOST_CAPABILITY_REQUIRED',
        });
    });

    it('exposes the terminal control port through the active adapter and returns null when unsupported', async () => {
        const handle: TerminalHostHandle = {
            kind: 'tmux',
            sessionName: 'claude-session',
            paneId: '0',
            attachMetadata: {
                attachStrategy: 'terminal_host',
                topology: 'exclusive',
                locality: 'same_machine',
                maxClients: null,
                requiresLocalAttachmentInfo: true,
                liveProbe: 'required',
            },
        };
        const controlPort: TerminalControlPort = {
            hostKind: 'tmux',
            sendLiteralText: vi.fn(async () => ({ status: 'sent' as const, at: 1 })),
            sendRawSequence: vi.fn(async () => ({ status: 'sent' as const, at: 1 })),
            sendSpecialKey: vi.fn(async () => ({ status: 'sent' as const, at: 1 })),
            captureScreen: vi.fn(async () => ({
                status: 'captured' as const,
                capture: { text: '', capturedAtMs: 1, hostKind: 'tmux' as const },
            })),
        };
        const createControlPort = vi.fn<NonNullable<TerminalHostAdapter['createControlPort']>>(() => controlPort);
        const baseAdapter = {
            kind: 'tmux' as const,
            createOrAttachHost: vi.fn(async () => handle),
            injectUserPrompt: vi.fn(async (): Promise<TerminalInputInjectionResult> => ({
                status: 'injected',
                injectedAt: 1,
                bytesWritten: 1,
                hostKind: 'tmux',
                hostSessionName: 'claude-session',
                paneId: '0',
            })),
            interruptTurn: vi.fn(async () => undefined),
            evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
            dispose: vi.fn(async () => undefined),
        };
        const makeService = (adapter: TerminalHostAdapter) => createPluginTerminalHostService({
            hasCapability: (capability) => capability === 'terminalHost' || capability === 'terminal.host.control',
            resolveTerminalHost: () => ({ status: 'resolved', adapter, reason: 'tmux_available' }),
            resolveAgentCliLaunch: () => ({ command: '/usr/local/bin/claude', args: [] }),
        });
        const launchRequest = {
            preference: 'tmux' as const,
            sessionName: 'claude-session',
            workingDirectory: '/workspace',
            launch: { kind: 'agent-cli' as const, agentId: 'claude' },
            isolatedEnv: true,
        };

        const service = makeService({ ...baseAdapter, createControlPort });
        const activeHandle = await service.createOrAttachHost(launchRequest);
        await expect(service.controlPort(activeHandle)).resolves.toBe(controlPort);
        expect(createControlPort).toHaveBeenCalledWith(handle);

        const withoutControl = makeService(baseAdapter);
        const plainHandle = await withoutControl.createOrAttachHost(launchRequest);
        await expect(withoutControl.controlPort(plainHandle)).resolves.toBeNull();

        // Inactive handles must be rejected like every other handle-scoped method.
        await expect(makeService({ ...baseAdapter, createControlPort }).controlPort(handle)).rejects.toMatchObject({
            code: 'PLUGIN_TERMINAL_HOST_HANDLE_NOT_ACTIVE',
        });
    });

    it('creates host-owned plugin temp directories with scoped read write and cleanup', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const fs = createPluginFsService({
            rootDir: join(paths.storageDir, 'acme.plugin', 'fs'),
        });

        const temp = await fs.createTempDirectory({ prefix: 'happier-deepsec-' });
        const textPath = await temp.createTextFile({
            suffix: '.files.txt',
            contents: 'src/auth.ts\n',
        });

        expect(textPath).toContain('happier-deepsec-');
        await expect(temp.readText({ path: textPath })).resolves.toBe('src/auth.ts\n');
        await expect(temp.createTextFile({ suffix: '/escape.txt', contents: 'no' })).rejects.toThrow(/suffix/);
        await expect(temp.readText({ path: join(tmpdir(), 'outside.txt') })).rejects.toThrow(/escapes/);

        await temp.cleanup();
        await expect(stat(temp.path)).rejects.toMatchObject({ code: 'ENOENT' });
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

    it('materializes scoped path list files from the host root and blocks symlink escapes', async () => {
        const happyHomeDir = await makeHappyHome();
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const repoRoot = await mkdtemp(join(tmpdir(), 'happier-a11-scoped-repo-'));
        const outsideDir = await mkdtemp(join(tmpdir(), 'happier-a11-scoped-outside-'));
        await mkdir(join(repoRoot, 'src'), { recursive: true });
        await writeFile(join(repoRoot, 'src', 'auth.ts'), 'export const auth = true;\n', 'utf8');
        await writeFile(join(repoRoot, 'src', 'api.ts'), 'export const api = true;\n', 'utf8');
        await writeFile(join(outsideDir, 'secret.ts'), 'export const secret = true;\n', 'utf8');
        await symlink(outsideDir, join(repoRoot, 'src', 'outside'), 'dir');
        const fs = createPluginFsService({
            rootDir: join(paths.storageDir, 'acme.plugin', 'fs'),
            readScopedRootDir: () => repoRoot,
        });
        const temp = await fs.createTempDirectory({ prefix: 'happier-deepsec-' });

        const created = await temp.createScopedPathListFile({
            suffix: '.files.txt',
            paths: [' src/auth.ts ', './src\\api.ts', 'src/auth.ts'],
        });

        expect(created).toMatchObject({
            status: 'created',
            paths: ['src/auth.ts', 'src/api.ts'],
        });
        if (created.status !== 'created') {
            throw new Error('Expected scoped path list file to be created');
        }
        await expect(readFile(created.path, 'utf8')).resolves.toBe('src/auth.ts\nsrc/api.ts\n');

        await expect(temp.createScopedPathListFile({
            suffix: '.files.txt',
            paths: ['src/outside/secret.ts'],
        })).resolves.toEqual({
            status: 'blocked',
            diagnostics: [
                expect.objectContaining({
                    code: 'path_escape',
                    path: 'src/outside/secret.ts',
                }),
            ],
        });

        await temp.cleanup();
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
        expect(transcripts.fileFollow).toHaveProperty('follow');
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

    it('threads transcript file-follow grants through the nested transcripts service scope', async () => {
        const root = await makeHappyHome();
        const filePath = join(root, 'session.jsonl');
        await writeFile(filePath, '{"line":true}\n', 'utf8');
        const received: string[] = [];
        const fileFollowPathGrants = createTranscriptFileFollowPathGrantRegistry();
        await fileFollowPathGrants.grant({
            pluginId: 'acme.transcript',
            runtimeId: 'runtime-1',
            sessionId: 'session-1',
            path: filePath,
            reason: 'testFixture',
            evidence: { kind: 'testOnly' },
        });
        const transcripts = createPluginTranscriptsService({
            append: async () => undefined,
            pluginId: 'acme.transcript',
            runtimeId: 'runtime-1',
            readSessionId: () => 'session-1',
            fileFollowPathGrants,
        });

        const handle = await transcripts.fileFollow.follow({
            path: filePath,
            startAt: 'beginning',
            onLine: (line) => {
                received.push(line.line);
            },
        });
        await handle.close();

        expect(received).toEqual(['{"line":true}']);
    });

    it('rejects plugin-authored resolvedExecutable launches before spawning a process', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const exec = createPluginExecService({
            allowedExecutablePaths: [shellPath],
        });

        await expect(exec.run({
            kind: 'resolvedExecutable',
            executablePath: shellPath,
            args: ['-c', 'exit 0'],
        } as unknown as ExecLaunchInputV1)).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_UNRESOLVED_LAUNCH',
        });
    });

    it('rejects path-only executable launches before spawn even when policy contains a matching path-only scope', async () => {
        const exec = createPluginExecService({
            allowedExecutablePaths: ['git'],
        });

        await expect(exec.spawn({
            kind: 'binary',
            executablePath: 'git',
            args: ['--version'],
        })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_UNRESOLVED_LAUNCH',
        });
    });

    it('rejects Windows package-manager shims before spawn even when explicitly allowed by path', async () => {
        const npmShimPath = '/tmp/npm.cmd';
        const exec = createPluginExecService({
            allowedExecutablePaths: [npmShimPath],
        });

        await expect(exec.spawn({
            kind: 'binary',
            executablePath: npmShimPath,
            args: ['--version'],
        })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_PATH_ONLY_RUNTIME_DENIED',
        });
    });

    it('denies package-manager shim system-tool paths before issuing a grant', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-system-tool-shim-'));
        const npmShimPath = join(root, 'NPM.CMD');
        await writeFile(npmShimPath, '#!/bin/sh\nexit 0\n');
        await chmod(npmShimPath, 0o755);
        const exec = createPluginExecService({
            systemTools: [
                {
                    toolId: 'acme.package-manager',
                    displayName: 'Acme Package Manager',
                    executablePath: npmShimPath,
                    lookupNames: ['npm'],
                },
            ],
        });

        await expect(exec.systemTools.resolve({
            toolId: 'acme.package-manager',
            purpose: 'verify package-manager deny before grant',
        })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_SYSTEM_TOOL_DENIED',
            diagnostics: [
                expect.objectContaining({
                    code: 'system_tool_denied',
                    severity: 'error',
                }),
            ],
        });
    });

    it('rejects Bun path-only runtime launches before spawn even when explicitly allowed by path', async () => {
        const bunPath = '/tmp/bun';
        const exec = createPluginExecService({
            allowedExecutablePaths: [bunPath],
        });

        await expect(exec.spawn({
            kind: 'binary',
            executablePath: bunPath,
            args: ['--version'],
        })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_PATH_ONLY_RUNTIME_DENIED',
        });
    });

    it('returns structured remediation for a missing required system tool', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-missing-system-tool-'));
        const missingPath = join(root, 'missing-tool');
        const exec = createPluginExecService({
            systemTools: [
                {
                    toolId: 'acme.audit',
                    displayName: 'Acme Audit',
                    executablePath: missingPath,
                    source: 'system',
                },
            ],
        });
        const systemTools = exec.systemTools;

        await expect(systemTools.resolve({
            toolId: 'acme.audit',
            purpose: 'review security findings',
        })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_SYSTEM_TOOL_UNAVAILABLE',
            diagnostics: [
                expect.objectContaining({
                    code: 'system_tool_missing',
                    severity: 'error',
                    messageKey: 'plugins.exec.systemTools.missing',
                    detail: expect.objectContaining({
                        toolId: 'acme.audit',
                    }),
                }),
            ],
        });
    });

    it('does not grant a fallback executable when system-tool resolution is aborted after it starts', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const root = await mkdtemp(join(tmpdir(), 'happier-aborted-system-tool-'));
        const missingPreferredPath = join(root, 'missing-tool');
        const exec = createPluginExecService({
            systemTools: [
                {
                    toolId: 'acme.abort',
                    displayName: 'Acme Abort',
                    executablePath: shellPath,
                    source: 'system',
                },
            ],
        });
        const controller = new AbortController();
        const resolvePromise = exec.systemTools.resolve({
            toolId: 'acme.abort',
            purpose: 'verify abort fail closed',
            preferredPath: missingPreferredPath,
            signal: controller.signal,
        });

        controller.abort();

        await expect(resolvePromise).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_SYSTEM_TOOL_ABORTED',
        });
        await expect(exec.run({
            kind: 'binary',
            executablePath: shellPath,
            args: ['-c', 'printf should-not-run'],
        })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_PERMISSION_DENIED',
        });
    });

    it('allows ctx.exec.run with the exact launch returned by systemTools.resolve', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const exec = createPluginExecService({
            systemTools: [
                {
                    toolId: 'acme.echo',
                    displayName: 'Acme Echo',
                    executablePath: shellPath,
                    source: 'user_config',
                },
            ],
        });
        const systemTools = exec.systemTools;

        const grant = await systemTools.resolve({
            toolId: 'acme.echo',
            purpose: 'echo fixture text',
        });

        expect(grant).toMatchObject({
            toolId: 'acme.echo',
            source: 'user_config',
            executablePath: shellPath,
            launch: {
                kind: 'binary',
                executablePath: shellPath,
            },
        });
        await expect(exec.run({
            kind: 'binary',
            executablePath: grant.executablePath,
            args: ['-c', 'printf granted'],
        })).resolves.toMatchObject({
            stdout: 'granted',
        });
    });

    it('resolves manifest lookup names through the host PATH without exposing PATH to child launches', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-system-tool-path-'));
        const toolPath = join(root, 'acme-audit');
        await writeFile(
            toolPath,
            [
                '#!/bin/sh',
                'printf "%s" "${PATH:-}"',
                '',
            ].join('\n'),
            'utf8',
        );
        await chmod(toolPath, 0o755);
        const previousPath = process.env.PATH;
        process.env.PATH = root;
        try {
            const exec = createPluginExecService({
                systemTools: [
                    {
                        toolId: 'acme.audit',
                        displayName: 'Acme Audit',
                        lookupNames: ['acme-audit'],
                        source: 'system',
                    },
                ],
                baseEnv: {},
            });

            const grant = await exec.systemTools.resolve({
                toolId: 'acme.audit',
                purpose: 'verify host lookup',
            });

            expect(grant.executablePath).toBe(toolPath);
            const result = await exec.run(grant.launch);
            expect(result.stdout).not.toContain(root);
        } finally {
            process.env.PATH = previousPath;
        }
    });

    it('honors a declared preferred command name through host lookup without treating it as a path', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-system-tool-command-'));
        const defaultToolPath = join(root, 'acme-default');
        const overrideToolPath = join(root, 'acme-override');
        await writeFile(defaultToolPath, ['#!/bin/sh', 'printf default', ''].join('\n'), 'utf8');
        await writeFile(overrideToolPath, ['#!/bin/sh', 'printf override', ''].join('\n'), 'utf8');
        await chmod(defaultToolPath, 0o755);
        await chmod(overrideToolPath, 0o755);
        const previousPath = process.env.PATH;
        process.env.PATH = root;
        try {
            const exec = createPluginExecService({
                systemTools: [
                    {
                        toolId: 'acme.audit',
                        displayName: 'Acme Audit',
                        lookupNames: ['acme-default', 'acme-override'],
                        source: 'system',
                    },
                ],
                baseEnv: {},
            });

            const grant = await exec.systemTools.resolve({
                toolId: 'acme.audit',
                purpose: 'verify command override',
                preferredCommand: 'acme-override',
            });

            expect(grant.executablePath).toBe(overrideToolPath);
            await expect(exec.run(grant.launch)).resolves.toMatchObject({
                stdout: 'override',
            });
        } finally {
            process.env.PATH = previousPath;
        }
    });

    it('rejects preferred command names that are not declared lookup names', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-system-tool-command-denied-'));
        const defaultToolPath = join(root, 'acme-default');
        await writeFile(defaultToolPath, ['#!/bin/sh', 'printf default', ''].join('\n'), 'utf8');
        await chmod(defaultToolPath, 0o755);
        const previousPath = process.env.PATH;
        process.env.PATH = root;
        try {
            const exec = createPluginExecService({
                systemTools: [
                    {
                        toolId: 'acme.audit',
                        displayName: 'Acme Audit',
                        lookupNames: ['acme-default'],
                        source: 'system',
                    },
                ],
                baseEnv: {},
            });

            await expect(exec.systemTools.resolve({
                toolId: 'acme.audit',
                purpose: 'verify command override rejection',
                preferredCommand: 'acme-other',
            })).rejects.toMatchObject({
                code: 'PLUGIN_EXEC_SYSTEM_TOOL_INVALID_COMMAND',
            });
        } finally {
            process.env.PATH = previousPath;
        }
    });

    it('rejects an ungranted binary path even when a plugin guesses a valid executable', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const exec = createPluginExecService({
            systemTools: [
                {
                    toolId: 'acme.echo',
                    displayName: 'Acme Echo',
                    executablePath: shellPath,
                    source: 'system',
                },
            ],
        });

        await expect(exec.run({
            kind: 'binary',
            executablePath: shellPath,
            args: ['-c', 'printf should-not-run'],
        })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_PERMISSION_DENIED',
        });
    });

    it('sanitizes system-tool diagnostics without leaking secret environment values', async () => {
        const exec = createPluginExecService({
            systemTools: [
                {
                    toolId: 'acme.secret',
                    displayName: 'Acme Secret',
                    executablePath: '/tmp/missing-tool?TOKEN=super-secret',
                    source: 'user_config',
                },
            ],
        });
        const systemTools = exec.systemTools;

        await expect(systemTools.resolve({
            toolId: 'acme.secret',
            purpose: 'verify sanitizer',
        })).rejects.toMatchObject({
            diagnostics: [
                expect.objectContaining({
                    detail: expect.not.objectContaining({
                        executablePath: expect.stringContaining('super-secret'),
                    }),
                }),
            ],
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
                kind: 'binary',
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
            kind: 'binary',
            executablePath: shellPath,
            args: ['-c', 'sleep 30'],
        });
        await registry.dispose();

        await expect(handle.exit).resolves.toMatchObject({
            exitCode: null,
        });
        await expect(handle.dispose()).resolves.toBeUndefined();
    });

    it('disposes spawned process trees instead of leaving grandchildren alive', async () => {
        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const root = await mkdtemp(join(tmpdir(), 'happier-exec-process-tree-'));
        const pidFile = join(root, 'grandchild.pid');
        const exec = createPluginExecService({
            allowedExecutablePaths: [shellPath],
        });
        const handle = await exec.spawn({
            kind: 'binary',
            executablePath: shellPath,
            args: [
                '-c',
                [
                    `${JSON.stringify(shellPath)} -c 'trap "exit 0" TERM; while true; do sleep 1; done' &`,
                    `echo $! > ${JSON.stringify(pidFile)}`,
                    'wait',
                ].join('\n'),
            ],
        });
        try {
            await vi.waitFor(async () => {
                expect((await readFile(pidFile, 'utf8')).trim()).toMatch(/^\d+$/);
            });
            const grandchildPid = Number((await readFile(pidFile, 'utf8')).trim());

            await handle.dispose();

            await vi.waitFor(() => {
                expect(() => process.kill(grandchildPid, 0)).toThrow();
            });
        } finally {
            await handle.dispose();
        }
    });

    it('escalates process-tree disposal when a child ignores SIGTERM', async () => {
        if (process.platform === 'win32') {
            return;
        }

        const shellPath = await firstExecutablePath(['/bin/sh', '/usr/bin/sh']);
        const root = await mkdtemp(join(tmpdir(), 'happier-exec-process-tree-escalate-'));
        const pidFile = join(root, 'stubborn-child.pid');
        const exec = createPluginExecService({
            allowedExecutablePaths: [shellPath],
        });
        const handle = await exec.spawn({
            kind: 'binary',
            executablePath: shellPath,
            args: [
                '-c',
                [
                    `${JSON.stringify(shellPath)} -c 'trap "" TERM; echo $$ > ${JSON.stringify(pidFile)}; while true; do sleep 1; done' &`,
                    'wait',
                ].join('\n'),
            ],
        });
        let disposePromise: Promise<void> | null = null;
        try {
            await vi.waitFor(async () => {
                expect((await readFile(pidFile, 'utf8')).trim()).toMatch(/^\d+$/);
            });
            const childPid = Number((await readFile(pidFile, 'utf8')).trim());
            disposePromise = handle.dispose();

            await expect(Promise.race([
                disposePromise.then(() => 'disposed' as const),
                new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
            ])).resolves.toBe('disposed');
            await vi.waitFor(() => {
                expect(() => process.kill(childPid, 0)).toThrow();
            });
        } finally {
            if (handle.pid) {
                try {
                    process.kill(-handle.pid, 'SIGKILL');
                } catch {
                    // The shared process-tree cleanup may already have removed the process group.
                }
            }
            await disposePromise?.catch(() => undefined);
        }
    }, 10_000);

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
                kind: 'binary',
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

    it('rejects any unsupported managed-server restart value before spawning', async () => {
        const spawn = vi.fn(async () => {
            throw new Error('unsupported restart must be rejected before spawn');
        });
        const exec: ExecRuntimeServiceV1 = {
            systemTools: {
                async resolve() {
                    throw new Error('system tools are not used by managed-server supervision');
                },
            },
            async run() {
                throw new Error('health checks are not reached for unsupported restart values');
            },
            spawn,
            spawnClient: vi.fn(async () => {
                throw new Error('managed-server supervision does not spawn protocol clients');
            }) as ExecRuntimeServiceV1['spawnClient'],
        };
        const server = createPluginManagedServerService({ exec });

        await expect(server.supervise({
            id: 'bad-restart',
            launch: { kind: 'binary', executablePath: '/bin/true' },
            restart: 'always',
        } as unknown as ManagedServerSpecV1)).rejects.toMatchObject({
            code: 'PLUGIN_MANAGED_SERVER_RESTART_UNSUPPORTED',
        });
        expect(spawn).not.toHaveBeenCalled();
    });

    it('removes managed-server polling abort listeners after successful delay intervals', async () => {
        const controller = new AbortController();
        const addAbortListener = vi.spyOn(controller.signal, 'addEventListener');
        const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener');
        let healthAttempts = 0;
        const exec: ExecRuntimeServiceV1 = {
            systemTools: {
                async resolve() {
                    throw new Error('system tools are not used by managed-server supervision');
                },
            },
            run: vi.fn(async () => {
                healthAttempts += 1;
                return {
                    exitCode: healthAttempts >= 3 ? 0 : 1,
                    signal: null,
                    stdout: '',
                    stderr: '',
                };
            }),
            spawn: vi.fn(async () => ({
                pid: 123,
                exit: Promise.resolve({
                    exitCode: 0,
                    signal: null,
                    stdout: '',
                    stderr: '',
                }),
                writeStdin: vi.fn(async () => undefined),
                kill: vi.fn(),
                dispose: vi.fn(async () => undefined),
            })),
            spawnClient: vi.fn(async () => {
                throw new Error('managed-server supervision does not spawn protocol clients');
            }) as ExecRuntimeServiceV1['spawnClient'],
        };
        const server = createPluginManagedServerService({ exec });
        const handle = await server.supervise({
            id: 'command-health-listener-cleanup',
            launch: { kind: 'binary', executablePath: '/bin/true' },
            healthCheck: {
                kind: 'command',
                launch: { kind: 'binary', executablePath: '/bin/true' },
                timeoutMs: 1_000,
            },
            startupTimeoutMs: 1_000,
        });

        await expect(handle.waitUntilHealthy({
            timeoutMs: 1_000,
            signal: controller.signal,
        })).resolves.toMatchObject({
            state: 'healthy',
        });

        const addedAbortListenerCount = addAbortListener.mock.calls.filter(([eventName]) => eventName === 'abort').length;
        const removedAbortListenerCount = removeAbortListener.mock.calls.filter(([eventName]) => eventName === 'abort').length;
        expect(addedAbortListenerCount).toBeGreaterThan(0);
        expect(removedAbortListenerCount).toBe(addedAbortListenerCount);
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
                kind: 'binary',
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

    it('removes managed-server HTTP health probe abort listeners after successful retry loops', async () => {
        const controller = new AbortController();
        const addAbortListener = vi.spyOn(controller.signal, 'addEventListener');
        const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener');
        let healthAttempts = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            healthAttempts += 1;
            return new Response(null, { status: healthAttempts >= 3 ? 200 : 503 });
        }));
        const exec: ExecRuntimeServiceV1 = {
            systemTools: {
                async resolve() {
                    throw new Error('system tools are not used by managed-server supervision');
                },
            },
            async run() {
                throw new Error('command health checks are not used by this test');
            },
            spawn: vi.fn(async () => ({
                pid: 123,
                exit: Promise.resolve({
                    exitCode: 0,
                    signal: null,
                    stdout: '',
                    stderr: '',
                }),
                writeStdin: vi.fn(async () => undefined),
                kill: vi.fn(),
                dispose: vi.fn(async () => undefined),
            })),
            spawnClient: vi.fn(async () => {
                throw new Error('managed-server supervision does not spawn protocol clients');
            }) as ExecRuntimeServiceV1['spawnClient'],
        };
        const server = createPluginManagedServerService({ exec });
        const handle = await server.supervise({
            id: 'http-health-listener-cleanup',
            launch: { kind: 'binary', executablePath: '/bin/true' },
            healthCheck: {
                kind: 'http',
                url: 'http://127.0.0.1/health',
                timeoutMs: 1_000,
            },
            startupTimeoutMs: 1_000,
        });

        try {
            await expect(handle.waitUntilHealthy({
                timeoutMs: 1_000,
                signal: controller.signal,
            })).resolves.toMatchObject({
                state: 'healthy',
            });

            const addedAbortListenerCount = addAbortListener.mock.calls.filter(([eventName]) => eventName === 'abort').length;
            const removedAbortListenerCount = removeAbortListener.mock.calls.filter(([eventName]) => eventName === 'abort').length;
            expect(addedAbortListenerCount).toBeGreaterThan(0);
            expect(removedAbortListenerCount).toBe(addedAbortListenerCount);
        } finally {
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
                kind: 'binary',
                executablePath: shellPath,
                args: ['-c', 'sleep 30'],
            },
            healthCheck: {
                kind: 'http',
                url: 'http://127.example.test/health',
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
