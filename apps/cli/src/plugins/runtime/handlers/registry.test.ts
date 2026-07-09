import { describe, expect, it, vi } from 'vitest';

import type {
    PluginActionHandlerRequest,
    PluginHandlerServicesV1,
    PluginHookHandlerContextV1,
} from '@happier-dev/plugin-sdk';
import type { PluginApiHookRegistration } from '../api/types';
import { createActivatedHandlerRegistry } from './registry';

function createHandlerServicesFixture(): PluginHandlerServicesV1 {
    const values = new Map<string, unknown>();
    const storageScope = Object.freeze({
        get: async <T = unknown>(key: string): Promise<T | null> => (values.get(key) as T | undefined) ?? null,
        set: async (key: string, value: unknown) => {
            values.set(key, value);
        },
        delete: async (key: string) => {
            values.delete(key);
        },
        listKeys: async () => Object.freeze([...values.keys()]),
    });
    return Object.freeze({
        storage: Object.freeze({
            ephemeral: storageScope,
            session: storageScope,
            local: storageScope,
            synced: storageScope,
        }),
        settings: Object.freeze({
            get: async <T = unknown>(key?: string): Promise<Readonly<Record<string, unknown>> | T | null> => {
                if (key === undefined) {
                    return Object.freeze({});
                }
                return (values.get(`settings:${key}`) as T | undefined) ?? null;
            },
            set: async (key: string, value: unknown) => {
                values.set(`settings:${key}`, value);
            },
            onChange: () => Object.freeze({ unsubscribe: () => undefined }),
            describeFields: () => Object.freeze([]),
            projectForm: () => Object.freeze({ storageScope: 'pluginLocal', fields: Object.freeze([]) }),
        }),
        logger: Object.freeze({
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
        }),
        events: Object.freeze({
            emit: async () => undefined,
            subscribe: () => Object.freeze({ unsubscribe: () => undefined }),
        }),
    });
}

function createEntry(overrides: Partial<Parameters<typeof createActivatedHandlerRegistry>[0]['entries'][number]>) {
    return {
        pluginId: 'acme.context',
        provenance: 'external',
        source: { kind: 'path' },
        manifestPath: '/tmp/acme/.happier-plugin/plugin.json',
        manifestDigest: 'digest',
        daemonEntryPath: '/tmp/acme/daemon.mjs',
        actions: [],
        tools: [],
        commands: [],
        hooks: [],
        lifecycleHandlers: [],
        ...overrides,
    } as Parameters<typeof createActivatedHandlerRegistry>[0]['entries'][number];
}

describe('createActivatedHandlerRegistry', () => {
    it('orders activation-registered hook handlers by ascending priority then plugin id', () => {
        const registry = createActivatedHandlerRegistry({
            entries: [
                {
                    pluginId: 'beta.plugin',
                    provenance: 'external',
                    source: { kind: 'path' },
                    manifestPath: '/tmp/beta/.happier-plugin/plugin.json',
                    manifestDigest: 'digest-beta',
                    daemonEntryPath: '/tmp/beta/daemon.mjs',
                    actions: [],
                    tools: [],
                    commands: [],
                    hooks: [{
                        hookId: 'agent.context.before',
                        category: 'augmentation',
                        scope: 'agent',
                        executionKind: 'augment',
                        priority: 10,
                        handler: vi.fn(),
                    }],
                    lifecycleHandlers: [],
                },
                {
                    pluginId: 'alpha.plugin',
                    provenance: 'external',
                    source: { kind: 'path' },
                    manifestPath: '/tmp/alpha/.happier-plugin/plugin.json',
                    manifestDigest: 'digest-alpha',
                    daemonEntryPath: '/tmp/alpha/daemon.mjs',
                    actions: [],
                    tools: [],
                    commands: [],
                    hooks: [{
                        hookId: 'agent.context.before',
                        category: 'augmentation',
                        scope: 'agent',
                        executionKind: 'augment',
                        priority: 10,
                        handler: vi.fn(),
                    }],
                    lifecycleHandlers: [],
                },
                {
                    pluginId: 'zeta.plugin',
                    provenance: 'external',
                    source: { kind: 'path' },
                    manifestPath: '/tmp/zeta/.happier-plugin/plugin.json',
                    manifestDigest: 'digest-zeta',
                    daemonEntryPath: '/tmp/zeta/daemon.mjs',
                    actions: [],
                    tools: [],
                    commands: [],
                    hooks: [{
                        hookId: 'agent.context.before',
                        category: 'augmentation',
                        scope: 'agent',
                        executionKind: 'augment',
                        priority: 1,
                        handler: vi.fn(),
                    }],
                    lifecycleHandlers: [],
                },
            ],
        });

        expect(registry.hookHandlersByHookId.get('agent.context.before')?.map((handler) => handler.pluginId))
            .toEqual(['zeta.plugin', 'alpha.plugin', 'beta.plugin']);
    });

    it('preserves dispatcher-provided hook context for activation-registered hooks', async () => {
        const handler = vi.fn((payload: unknown, context: unknown) => ({
            payload,
            context,
        }));
        const hookRegistration: PluginApiHookRegistration<'agent.resolvePrerequisites'> = {
            hookId: 'agent.resolvePrerequisites',
            category: 'decision',
            scope: 'agent',
            executionKind: 'decide',
            handler,
        };
        const registry = createActivatedHandlerRegistry({
            entries: [{
                pluginId: 'acme.context',
                provenance: 'external',
                source: { kind: 'path' },
                manifestPath: '/tmp/acme/.happier-plugin/plugin.json',
                manifestDigest: 'digest',
                daemonEntryPath: '/tmp/acme/daemon.mjs',
                actions: [],
                tools: [],
                commands: [],
                hooks: [hookRegistration],
                lifecycleHandlers: [],
            }],
        });

        const runtimeHandler = registry.hookHandlersByHookId.get('agent.resolvePrerequisites')?.[0]?.handler;
        await expect(runtimeHandler?.(
            { payload: { backendId: 'claude' } },
            { tools: { marker: 'daemon-tools' } },
        )).resolves.toEqual({
            payload: { backendId: 'claude' },
            context: {
                hookId: 'agent.resolvePrerequisites',
                tools: { marker: 'daemon-tools' },
            },
        });
    });

    it('adds scoped services to tool handler request context', async () => {
        const services = createHandlerServicesFixture();
        const registry = createActivatedHandlerRegistry({
            entries: [createEntry({
                tools: [{
                    id: 'session_notes_add',
                    handler: async (request: PluginActionHandlerRequest) => {
                        const note = String((request.input as { note: string }).note);
                        await request.context.storage.local.set('latestNote', note);
                        const stored = await request.context.storage.local.get<string>('latestNote');
                        return {
                            ok: true,
                            data: {
                                stored,
                                sameSettings: request.context.settings === services.settings,
                                sameLogger: request.context.logger === services.logger,
                                sameEvents: request.context.events === services.events,
                            },
                        };
                    },
                }],
                handlerServices: services,
            } as unknown as Partial<Parameters<typeof createActivatedHandlerRegistry>[0]['entries'][number]>)],
        });

        const handler = registry.actionHandlersByActionId.get('session_notes_add');
        await expect(handler?.({
            actionId: 'session_notes_add',
            pluginId: 'acme.context',
            input: { note: 'remember context services' },
            context: { surface: 'agent' },
            provenance: {},
        })).resolves.toEqual({
            ok: true,
            data: {
                stored: 'remember context services',
                sameSettings: true,
                sameLogger: true,
                sameEvents: true,
            },
        });
    });

    it('adds the same scoped services shape to action handler request context', async () => {
        const services = createHandlerServicesFixture();
        const registry = createActivatedHandlerRegistry({
            entries: [createEntry({
                actions: [{
                    id: 'sessionNotes.list',
                    handler: async (request: PluginActionHandlerRequest) => {
                        await request.context.storage.local.set('listed', true);
                        return {
                            ok: true,
                            data: {
                                listed: await request.context.storage.local.get<boolean>('listed'),
                                settings: request.context.settings,
                                logger: request.context.logger,
                                events: request.context.events,
                            },
                        };
                    },
                }],
                handlerServices: services,
            } as unknown as Partial<Parameters<typeof createActivatedHandlerRegistry>[0]['entries'][number]>)],
        });

        const handler = registry.actionHandlersByActionId.get('sessionNotes.list');
        await expect(handler?.({
            actionId: 'sessionNotes.list',
            pluginId: 'acme.context',
            input: {},
            context: { surface: 'cli' },
            provenance: {},
        })).resolves.toEqual({
            ok: true,
            data: {
                listed: true,
                settings: services.settings,
                logger: services.logger,
                events: services.events,
            },
        });
    });

    it('adds the same scoped services shape to hook handler context', async () => {
        const services = createHandlerServicesFixture();
        const registry = createActivatedHandlerRegistry({
            entries: [createEntry({
                hooks: [{
                    hookId: 'session.spawned',
                    category: 'lifecycle',
                    scope: 'session',
                    executionKind: 'observe',
                    handler: async (_payload: unknown, context: PluginHookHandlerContextV1<'session.spawned'>) => {
                        await context.storage.local.set('spawned', context.hookId);
                        return await context.storage.local.get('spawned');
                    },
                }],
                handlerServices: services,
            } as unknown as Partial<Parameters<typeof createActivatedHandlerRegistry>[0]['entries'][number]>)],
        });

        const handler = registry.hookHandlersByHookId.get('session.spawned')?.[0]?.handler;
        await expect(handler?.({ payload: {} }, { signal: undefined })).resolves.toBe('session.spawned');
    });
});
