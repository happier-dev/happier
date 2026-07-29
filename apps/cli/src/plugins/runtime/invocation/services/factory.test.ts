import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginServiceId, PluginStorageTransaction } from '@happier-dev/plugin-sdk/runtime';
import { describe, expect, it, vi } from 'vitest';

import {
    createLoggerAndEventsAvailablePluginInvocationServiceBinding,
    createLoggerFilesystemEventsAndExecServiceBinding,
    createPluginInvocationServicesFactory,
    createUnavailablePluginInvocationServiceBinding,
    createUnavailablePluginServicesFactory,
} from './factory';
import type { PluginInvocationLogRecord } from './logger';
import { createStablePluginEventsBroker } from './events';
import { PLUGIN_SERVICE_DESCRIPTORS } from './unavailable';
import { createStablePluginFetchHost } from '@/plugins/runtime/fetch/service';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createPluginAgentCliReadinessService } from '@/plugins/runtime/context/agents';
import { createPluginExecSystemToolResolver } from '@/plugins/runtime/exec/system/tools/resolveGrant';
import { createPluginStorageOwner } from '@/plugins/runtime/context/storage';

const seed = Object.freeze({
    plugin: Object.freeze({ id: 'acme.alpha', version: '1.2.3' }),
    contribution: Object.freeze({ id: 'run', qualifiedId: 'acme.alpha/actions/run' }),
    generation: '7',
    correlationId: 'correlation-host-owned',
    surface: 'cli' as const,
    signal: new AbortController().signal,
    isGenerationCurrent: () => true,
});

describe('unavailable plugin invocation services factory', () => {
    it('keeps concrete and unavailable service creation on the canonical descriptor owner', () => {
        for (const descriptor of Object.values(PLUGIN_SERVICE_DESCRIPTORS)) {
            expect(descriptor).toHaveProperty('createAvailable');
            expect(typeof Reflect.get(descriptor, 'createAvailable')).toBe('function');
        }
    });

    it('rejects stale generation bindings', () => {
        const createServices = createUnavailablePluginServicesFactory();

        expect(() => createServices(seed, createUnavailablePluginInvocationServiceBinding('8', 'binding')))
            .toThrow(/generation/i);
    });

    it('composes available logger and events with the other thirteen unavailable services', async () => {
        const records: PluginInvocationLogRecord[] = [];
        const services = createPluginInvocationServicesFactory({
            loggerSink: { write: (record) => { records.push(record); } },
            now: () => 123,
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
                permissionDeclarationsByPluginId: new Map(),
                activePluginIds: new Set<string>(),
            },
        })(seed, createLoggerAndEventsAvailablePluginInvocationServiceBinding('7', 'binding'));

        expect(services.availability('logger')).toEqual({ status: 'available' });
        expect(services.availability('events')).toEqual({ status: 'available' });
        expect(services.availability('storage')).toEqual({
            status: 'unavailable',
            code: 'plugin_service_unavailable',
        });
        expect(Object.keys(services.logger).sort()).toEqual(['debug', 'diagnostic', 'error', 'info', 'warn']);
        expect(Object.keys(services.events).sort()).toEqual(['emit', 'subscribe']);
        expect(Object.isFrozen(services.logger)).toBe(true);
        services.logger.error('keeps severity');
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ level: 'error', context: { plugin: { id: 'acme.alpha' } } });

        const unavailableIds = [
            'storage', 'settings', 'secrets', 'fetch', 'fs', 'exec', 'managed',
            'sessions', 'resources', 'mcp', 'notifications', 'connectedAccounts',
        ] as const;
        for (const serviceId of unavailableIds) {
            expect(services.availability(serviceId)).toMatchObject({ status: 'unavailable' });
        }
        await expect(services.events.emit('undeclared', null)).rejects.toMatchObject({
            code: 'plugin_events_undeclared',
        });
    });

    it('projects native executable readiness through the existing Agent CLI and system-tool owners', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-native-readiness-'));
        const executablePath = join(root, 'deepsec');
        await writeFile(executablePath, '#!/bin/sh\nexit 0\n', 'utf8');
        await chmod(executablePath, 0o755);
        const registeredGrants: string[] = [];
        const agentCli = createPluginAgentCliReadinessService({
            processEnv: {
                HAPPIER_CLAUDE_PATH: executablePath,
                HAPPIER_HOME_DIR: root,
                PATH: '',
            },
        });
        const systemTools = createPluginExecSystemToolResolver({
            definitions: [{
                toolId: 'deepsec-cli',
                displayName: 'DeepSec CLI',
                executablePath,
            }],
            baseEnv: { PATH: '' },
            registerGrant: (grant) => { registeredGrants.push(grant.grantId); },
            now: () => 123,
        });
        const executable = { kind: 'systemTool' as const, id: 'deepsec-cli' };
        let fallbackExecutableResolutions = 0;
        const services = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
                permissionDeclarationsByPluginId: new Map(),
                activePluginIds: new Set(),
            },
            exec: {
                agentCli,
                systemToolsForPlugin: (pluginId) => {
                    expect(pluginId).toBe('acme.alpha');
                    return systemTools;
                },
                resolveExecutable: async () => {
                    fallbackExecutableResolutions += 1;
                    return { command: executablePath };
                },
                resolvePath: async () => root,
            },
        })(seed, createLoggerFilesystemEventsAndExecServiceBinding(
            '7',
            'binding',
            [{
                required: true,
                request: {
                    id: 'deepsec-process',
                    capability: 'process',
                    reason: 'Run DeepSec',
                    scope: { executables: [executable] },
                },
            }],
            { pluginData: root, workspace: root, projects: new Map() },
        ));

        const readiness = await services.exec.agentCli.checkReadiness({
            candidates: ['claude', 'codex'],
            requirement: 'any',
            cwd: root,
        });
        expect(readiness).toEqual({ launchable: [{ agentId: 'claude' }] });
        expect(Object.keys(readiness)).toEqual(['launchable']);
        const resolved = await services.exec.systemTools.resolve({
            toolId: 'deepsec-cli',
            purpose: 'review security findings',
            cwd: root,
        });
        expect(resolved).toMatchObject({
            executable,
            executablePath,
        });
        expect(Object.keys(resolved).sort()).toEqual(['executable', 'executablePath']);
        expect(registeredGrants).toHaveLength(1);
        await expect(services.exec.run({ executable: resolved.executable }))
            .resolves.toMatchObject({ termination: { observed: { kind: 'exit', exitCode: 0 } } });
        expect(fallbackExecutableResolutions).toBe(0);
        await expect(services.exec.systemTools.resolve({
            toolId: 'undeclared',
            purpose: 'must not bypass the binding',
            cwd: root,
        })).rejects.toMatchObject({ code: 'plugin_exec_access_denied' });
        expect(registeredGrants).toHaveLength(1);
    });

    it('binds ordinary invocation storage to the plugin namespace and preserves local values across owner restart', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-invocation-storage-'));
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const events = {
            broker: createStablePluginEventsBroker(),
            declarationsByPluginId: new Map(),
            permissionDeclarationsByPluginId: new Map(),
            activePluginIds: new Set<string>(),
        };
        const binding = createLoggerAndEventsAvailablePluginInvocationServiceBinding('7', 'binding');
        const createServices = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events,
            storagePaths: paths,
        });

        const first = createServices(seed, binding);
        expect(first.availability('storage')).toEqual({ status: 'available' });
        await first.storage.local.set('counter', 1);

        const restarted = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events,
            storagePaths: resolvePluginStorePaths({ happyHomeDir }),
        })(seed, binding);
        expect(await restarted.storage.local.get('counter')).toBe(1);

        const sibling = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events,
            storagePaths: paths,
        })({
            ...seed,
            plugin: Object.freeze({ id: 'acme.beta', version: '1.2.3' }),
            contribution: Object.freeze({ id: 'run', qualifiedId: 'acme.beta/actions/run' }),
        }, binding);
        expect(await sibling.storage.local.get('counter')).toBeNull();
    });

    it('keeps host-owned settings records outside the plugin storage key surface', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-invocation-storage-reserved-'));
        const storagePaths = resolvePluginStorePaths({ happyHomeDir });
        await createPluginStorageOwner({
            pluginId: seed.plugin.id,
            paths: storagePaths,
        }).local.set('@happier/settings/v1', { revision: 1 });
        const services = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
                permissionDeclarationsByPluginId: new Map(),
                activePluginIds: new Set<string>(),
            },
            storagePaths,
        })(seed, createLoggerAndEventsAvailablePluginInvocationServiceBinding('7', 'binding'));

        await expect(services.storage.local.get('@happier/settings/v1'))
            .rejects.toMatchObject({ code: 'plugin_storage_reserved_key' });
        await expect(services.storage.local.set('@happier/settings/v1', { revision: 99 }))
            .rejects.toMatchObject({ code: 'plugin_storage_reserved_key' });
        await expect(services.storage.local.transaction(async (transaction) => {
            await transaction.delete('@happier/settings/v1');
        })).rejects.toMatchObject({ code: 'plugin_storage_reserved_key' });
        await expect(services.storage.local.list()).resolves.toEqual({ items: [] });
    });

    it('derives ordinary host-owned storage availability from the canonical service descriptor', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-invocation-storage-descriptor-'));
        const services = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
                permissionDeclarationsByPluginId: new Map(),
                activePluginIds: new Set<string>(),
            },
            storagePaths: resolvePluginStorePaths({ happyHomeDir }),
        })(seed, createLoggerAndEventsAvailablePluginInvocationServiceBinding('7', 'binding'));

        expect(services.availability('storage')).toEqual({ status: 'available' });
        await services.storage.local.set('descriptor-owned', true);
        await expect(services.storage.local.get('descriptor-owned')).resolves.toBe(true);
    });

    it('binds settings only through the canonical stable settings host', async () => {
        const binding = createLoggerAndEventsAvailablePluginInvocationServiceBinding('7', 'binding');
        const snapshot = Object.freeze({ revision: '0', values: Object.freeze({ endpoint: 'https://example.test' }) });
        const createServices = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
                permissionDeclarationsByPluginId: new Map(),
                activePluginIds: new Set<string>(),
            },
            settings: {
                hasPlugin: (pluginId) => pluginId === 'acme.alpha',
                bind: (candidateSeed) => candidateSeed.plugin.id === 'acme.alpha'
                    ? Object.freeze({
                        snapshot: async () => snapshot,
                        get: async () => null,
                        set: async () => ({ revision: '1' }),
                        reset: async () => ({ revision: '1' }),
                        describe: () => Object.freeze([]),
                        watch: () => Object.freeze({ dispose: () => {} }),
                    })
                    : null,
            },
        });

        const services = createServices(seed, binding);
        expect(services.availability('settings')).toEqual({ status: 'available' });
        await expect(services.settings.snapshot()).resolves.toBe(snapshot);
    });

    it('materializes fetch only through the canonical stable host and exact network binding', async () => {
        const adapter = vi.fn(async () => Object.freeze({
            ok: true,
            status: 200,
            statusText: 'OK',
            finalUrl: 'https://api.example.test/result',
            headers: Object.freeze({ 'content-type': 'application/octet-stream' }),
            body: null,
            text: async () => '',
            json: async () => null,
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        }));
        const binding = createLoggerAndEventsAvailablePluginInvocationServiceBinding('7', 'binding', [{
            required: true,
            request: {
                id: 'api-read',
                capability: 'network',
                reason: 'Read the declared API',
                scope: {
                    targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }],
                    methods: ['GET'],
                },
            },
        }]);
        const services = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
                permissionDeclarationsByPluginId: new Map(),
                activePluginIds: new Set<string>(),
            },
            fetch: createStablePluginFetchHost({ adapter }),
        })(seed, binding);

        expect(services.availability('fetch')).toEqual({ status: 'available' });
        await expect(services.fetch.request({
            url: 'https://api.example.test/data',
            method: 'GET',
            redirect: 'error',
        })).resolves.toEqual({
            status: 200,
            finalUrl: 'https://api.example.test/result',
            headers: { 'content-type': 'application/octet-stream' },
            body: new Uint8Array([1, 2, 3]),
        });
        expect(adapter).toHaveBeenCalledOnce();
    });

    it('commits ordinary storage transactions atomically and fences ended or stale transaction handles', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-invocation-storage-transaction-'));
        let current = true;
        const binding = createLoggerAndEventsAvailablePluginInvocationServiceBinding('7', 'binding');
        const services = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
                permissionDeclarationsByPluginId: new Map(),
                activePluginIds: new Set<string>(),
            },
            storagePaths: resolvePluginStorePaths({ happyHomeDir }),
        })({ ...seed, isGenerationCurrent: () => current }, binding);

        await expect(services.storage.local.transaction(async (transaction) => {
            await transaction.set('first', 1);
            await transaction.set('second', 2);
            throw new Error('abort transaction');
        })).rejects.toThrow('abort transaction');
        expect(await services.storage.local.get('first')).toBeNull();
        expect(await services.storage.local.get('second')).toBeNull();

        let endedHandle: PluginStorageTransaction | null = null;
        await services.storage.local.transaction(async (transaction) => {
            endedHandle = transaction;
            await transaction.set('first', 1);
        });
        await expect(endedHandle!.get('first')).rejects.toMatchObject({ code: 'plugin_storage_transaction_ended' });

        await expect(services.storage.local.transaction(async (transaction) => {
            await transaction.set('first', 3);
            current = false;
        })).rejects.toMatchObject({ code: 'plugin_generation_stale' });
        current = true;
        expect(await services.storage.local.get('first')).toBe(1);

        const rejectBeforeDeadlock = async (operation: Promise<unknown>): Promise<unknown> => await Promise.race([
            operation.then(
                () => ({ resolved: true }),
                (error: unknown) => error,
            ),
            new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 2_000)),
        ]);
        expect(await rejectBeforeDeadlock(services.storage.local.transaction(async () => {
            await services.storage.local.set('reentrant', true);
        }))).toMatchObject({ code: 'plugin_storage_transaction_reentry' });
        expect(await rejectBeforeDeadlock(services.storage.local.transaction(async () => {
            await services.storage.ephemeral.transaction(async () => undefined);
        }))).toMatchObject({ code: 'plugin_storage_transaction_reentry' });

        await services.storage.local.transaction(async (transaction) => {
            await transaction.set('first', 2);
            await services.storage.ephemeral.set('independent', true);
        });
        expect(await services.storage.local.get('first')).toBe(2);
        expect(await services.storage.ephemeral.get('independent')).toBe(true);

        await services.storage.local.set('counter', 0);
        let callbackCount = 0;
        await Promise.all(Array.from({ length: 8 }, async () => {
            await services.storage.local.transaction(async (transaction) => {
                callbackCount += 1;
                const value = await transaction.get<number>('counter') ?? 0;
                await transaction.set('counter', value + 1);
            });
        }));
        expect(callbackCount).toBe(8);
        expect(await services.storage.local.get('counter')).toBe(8);
    });

    it('rejects a logger factory binding that does not admit exactly the logger', () => {
        const createServices = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
                permissionDeclarationsByPluginId: new Map(),
                activePluginIds: new Set(),
            },
        });

        expect(() => createServices(seed, createUnavailablePluginInvocationServiceBinding('7', 'binding')))
            .toThrow(/availability/i);
    });

    it('rejects bindings whose availability claims exceed the factory services', () => {
        const createServices = createUnavailablePluginServicesFactory();
        const binding = createUnavailablePluginInvocationServiceBinding('7', 'binding');
        const availability = {
            ...binding.availability,
            logger: 'available' as const,
        } satisfies Record<PluginServiceId, 'available' | 'unavailable' | 'denied'>;

        expect(() => createServices(seed, Object.freeze({ ...binding, availability: Object.freeze(availability) })))
            .toThrow(/availability/i);
    });

    it('returns only a frozen service surface with truthful unavailable facts', () => {
        const services = createUnavailablePluginServicesFactory()(
            seed,
            createUnavailablePluginInvocationServiceBinding('7', 'binding'),
        );

        expect(Object.isFrozen(services)).toBe(true);
        expect(services.availability('logger')).toEqual({
            status: 'unavailable',
            code: 'plugin_service_unavailable',
        });
        expect(() => services.exec.agentCli.checkReadiness({
            candidates: ['claude'],
            requirement: 'any',
        })).toThrow(/unavailable/i);
        expect(() => services.exec.systemTools.resolve({
            toolId: 'fixture',
            purpose: 'unavailable host',
        })).toThrow(/unavailable/i);
    });

    it('materializes exec only from an exact process host-access binding and host resolver', async () => {
        const executable = { kind: 'systemTool' as const, id: 'fixture.node' };
        const services = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
                permissionDeclarationsByPluginId: new Map(),
                activePluginIds: new Set(),
            },
            exec: {
                resolveExecutable: async () => ({ command: process.execPath }),
                resolvePath: async () => { throw new Error('unexpected path'); },
            },
        })(seed, createLoggerFilesystemEventsAndExecServiceBinding(
            '7',
            'binding',
            [{
                required: true,
                request: {
                    id: 'process',
                    capability: 'process',
                    reason: 'Run fixture',
                    scope: { executables: [executable], envKeys: ['FIXTURE_VALUE'] },
                },
            }],
            { pluginData: '/tmp/plugin', workspace: '/tmp/workspace', projects: new Map() },
        ));

        expect(services.availability('exec')).toEqual({ status: 'available' });
        await expect(services.exec.agentCli.checkReadiness({
            candidates: ['claude'],
            requirement: 'any',
        })).rejects.toMatchObject({ code: 'plugin_exec_agent_cli_readiness_unavailable' });
        await expect(services.exec.systemTools.resolve({
            toolId: 'fixture.node',
            purpose: 'pre-resolve fixture',
        })).rejects.toMatchObject({ code: 'plugin_exec_system_tool_resolution_unavailable' });
        await expect(services.exec.run({
            executable,
            args: ['-e', 'process.stdout.write(process.env.FIXTURE_VALUE ?? "")'],
            env: { FIXTURE_VALUE: 'allowed' },
        })).resolves.toMatchObject({ termination: { observed: { kind: 'exit', exitCode: 0 } } });
    });
});
