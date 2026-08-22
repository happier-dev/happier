import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    COMPOSER_MEDIA_CONTENT_CAPABILITY_V1,
    PluginError,
    type PluginServiceId,
} from '@happier-dev/plugin-sdk';
import type { StorageTransaction } from '@happier-dev/plugin-sdk/storage';
import { describe, expect, it, vi } from 'vitest';

import {
    createLoggerAndEventsAvailablePluginInvocationServiceBinding,
    createLoggerAndFilesystemServiceBinding,
    createLoggerEventsAndExecServiceBinding,
    createPluginInvocationServicesFactory,
    createUnavailablePluginInvocationServiceBinding,
    createUnavailablePluginServicesFactory,
} from './factory';
import { createPluginActionCallerMaterializationFixture } from './actionCaller.testkit';
import type { PluginInvocationLogRecord } from './logger';
import type { PluginActionsHostExecutor } from './actions';
import { createStablePluginEventsBroker } from './events';
import { PLUGIN_SERVICE_DESCRIPTORS } from './unavailable';
import { createStablePluginHttpHost } from '@/plugins/runtime/fetch/service';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createPluginAgentCliReadinessService } from '@/plugins/runtime/context/agents';
import { createPluginExecSystemToolResolver } from '@/plugins/runtime/exec/system/tools/resolveGrant';
import { createPluginStorageOwner } from '@/plugins/runtime/context/storage';

const seedMaterialization = createPluginActionCallerMaterializationFixture('acme.alpha');

const seed = Object.freeze({
    plugin: Object.freeze({ id: 'acme.alpha', version: '1.2.3' }),
    contribution: Object.freeze({ id: 'run', qualifiedId: 'acme.alpha/actions/run' }),
    generation: '7',
    correlationId: 'correlation-host-owned',
    surface: 'cli' as const,
    resolveCurrentPluginMaterializationRef:
        seedMaterialization.resolveCurrentPluginMaterializationRef,
    signal: new AbortController().signal,
    isGenerationCurrent: () => true,
});

describe('unavailable plugin invocation services factory', () => {
    it('exposes the local storage taxonomy and omits unadmitted Account data', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-invocation-storage-taxonomy-'));
        const services = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
                activePluginIds: new Set<string>(),
            },
            storagePaths: resolvePluginStorePaths({ happyHomeDir }),
        })(seed, createLoggerAndEventsAvailablePluginInvocationServiceBinding('7', 'binding'));

        const storage = services.storage as unknown as Readonly<Record<string, unknown>>;
        expect(Object.keys(storage).sort()).toEqual([
            'daemon',
            'daemonSession',
            'ephemeral',
        ]);
        expect(storage).not.toHaveProperty('local');
        expect(storage).not.toHaveProperty('session');
        expect(storage).not.toHaveProperty('synced');

        const daemon = services.storage.daemon;
        await daemon.set('durable', { value: 1 });
        await expect(daemon.get('durable')).resolves.toEqual({ value: 1 });

        await daemon.set('ordered/a', true);
        await daemon.set('ordered/c', true);
        const firstPage = await daemon.list({ prefix: 'ordered/', limit: 1 });
        expect(firstPage.items).toEqual([{ key: 'ordered/a' }]);
        expect(firstPage.nextCursor).toEqual(expect.any(String));
        await expect(daemon.list({ prefix: 'ordered/', cursor: '1' }))
            .rejects.toMatchObject({ code: 'PLUGIN_STORAGE_CURSOR_INVALID' });

        await daemon.delete('ordered/a');
        await expect(daemon.list({
            prefix: 'ordered/',
            limit: 1,
            cursor: firstPage.nextCursor!,
        })).resolves.toEqual({ items: [{ key: 'ordered/c' }] });

        expect(storage.account).toBeUndefined();
    });

    it('keeps concrete and unavailable service creation on the canonical descriptor owner', () => {
        for (const descriptor of Object.values(PLUGIN_SERVICE_DESCRIPTORS)) {
            expect(descriptor).toHaveProperty('createAvailable');
            expect(typeof Reflect.get(descriptor, 'createAvailable')).toBe('function');
        }
    });

    it('projects Composer content through the canonical service descriptor and fails closed when unbound', async () => {
        const services = createUnavailablePluginServicesFactory()(
            seed,
            createUnavailablePluginInvocationServiceBinding('7', 'binding'),
        );

        expect(PLUGIN_SERVICE_DESCRIPTORS.composerContent).toMatchObject({
            id: 'composerContent',
            publicProperty: 'composerContent',
            availabilityOwner: 'host',
        });
        expect(services.availability('composerContent')).toEqual({
            status: 'unavailable',
            code: 'plugin_service_unavailable',
        });
        expect(services.composerContent.capabilities()).toEqual({
            [COMPOSER_MEDIA_CONTENT_CAPABILITY_V1]: {
                status: 'unavailable',
                code: 'plugin_service_unavailable',
            },
        });
        expect(() => services.composerContent.stageMedia({
            source: { root: 'workspace', relativePath: 'photo.png' },
        })).toThrow(expect.objectContaining({ code: 'plugin_service_unavailable' }));
    });

    it('binds Composer content through the descriptor with the canonical PluginPath filesystem reader', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'happier-plugin-composer-content-factory-'));
        const bind = vi.fn(() => Object.freeze({
            capabilities: () => Object.freeze({
                [COMPOSER_MEDIA_CONTENT_CAPABILITY_V1]: Object.freeze({ status: 'available' as const }),
            }),
            stageMedia: vi.fn(async () => {
                throw new Error('stageMedia was not expected in this descriptor test');
            }),
        }));
        const filesystemRoots = {
            pluginData: workspace,
            workspace,
            projects: new Map<string, string>(),
        };
        const factoryParams = {
            loggerSink: { write: () => {} },
            filesystemRoots,
            composerContent: { bind },
        } satisfies Parameters<typeof createPluginInvocationServicesFactory>[0];

        try {
            const services = createPluginInvocationServicesFactory(factoryParams)(
                seed,
                createLoggerAndFilesystemServiceBinding(
                    '7',
                    'binding',
                    [{
                        request: {
                            id: 'workspace-read',
                            capability: 'filesystem',
                            reason: 'Stage media from the selected workspace',
                            scope: {
                                locations: [{ root: 'workspace' }],
                                access: ['read'],
                            },
                        },
                    }],
                    filesystemRoots,
                ),
            );

            expect(services.availability('composerContent')).toEqual({ status: 'available' });
            expect(services.composerContent.capabilities()).toEqual({
                [COMPOSER_MEDIA_CONTENT_CAPABILITY_V1]: { status: 'available' },
            });
            expect(bind).toHaveBeenCalledWith(expect.objectContaining({
                seed,
                fileSystem: expect.objectContaining({ readFile: expect.any(Function) }),
            }));
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    it('fails closed for the contributed-Action execution-origin method when Actions are unavailable', () => {
        const services = createUnavailablePluginServicesFactory()(
            seed,
            createUnavailablePluginInvocationServiceBinding('7', 'binding'),
        );

        expect(Object.keys(services.actions).sort()).toEqual([
            'execute',
            'executeAdmittedTargetedOperation',
            'executeAdmittedTargetedOperationWithExecutionOrigin',
            'executeWithExecutionOrigin',
        ]);
        expect(() => services.actions.executeWithExecutionOrigin(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        )).toThrow(expect.objectContaining({ code: 'plugin_service_unavailable' }));
    });

    it('projects the host-stamped hook interception bypass only into hook ActionsService seeds', async () => {
        const execute = vi.fn(async (
            ..._args: Parameters<PluginActionsHostExecutor['execute']>
        ) => ({
            ok: true as const,
            result: { v: 1, ok: true as const, hits: [] },
        }));
        const createServices = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
                activePluginIds: new Set(),
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(async () => {
                throw new Error('Contributed action invocation was not expected');
            }),
        });
        const binding = createLoggerAndEventsAvailablePluginInvocationServiceBinding('7', 'binding');
        const input = {
            machineId: 'machine-1',
            query: {
                v: 1 as const,
                query: 'owner',
                scope: { type: 'global' as const },
                mode: 'hints' as const,
            },
        };

        await createServices(seed, binding).actions.execute('memory.search', input);
        await createServices(Object.freeze({
            ...seed,
            bypassActionInterception: true as const,
        }), binding).actions.execute('memory.search', input);

        expect(execute.mock.calls[0]?.[2]).not.toHaveProperty('bypassActionInterception');
        expect(execute.mock.calls[1]?.[2]).toMatchObject({ bypassActionInterception: true });
    });

    it('rejects stale generation bindings', () => {
        const createServices = createUnavailablePluginServicesFactory();

        expect(() => createServices(seed, createUnavailablePluginInvocationServiceBinding('8', 'binding')))
            .toThrow(/generation/i);
    });

    it('keeps the unavailable Sessions service shape-identical to the six-method External Sessions author service', async () => {
        const services = createUnavailablePluginServicesFactory()(
            seed,
            createUnavailablePluginInvocationServiceBinding('7', 'binding'),
        );
        const external = services.sessions.external;
        const ref = Object.freeze({
            agentId: 'codex',
            sourceId: 'codex-home',
            remoteSessionId: 'remote-session-1',
        });

        expect(Object.keys(external).sort()).toEqual([
            'attach',
            'capabilities',
            'followTranscript',
            'list',
            'readTranscript',
            'takeover',
        ]);
        expect(await external.capabilities()).toEqual({
            list: { status: 'unavailable', code: 'plugin_service_unavailable' },
            attach: { status: 'unavailable', code: 'plugin_service_unavailable' },
            takeover: { status: 'unavailable', code: 'plugin_service_unavailable' },
            transcript: { status: 'unavailable', code: 'plugin_service_unavailable' },
            follow: { status: 'unavailable', code: 'plugin_service_unavailable' },
        });
        await expect(external.followTranscript(ref, {}, () => {}))
            .resolves.toEqual({ status: 'unavailable', code: 'plugin_service_unavailable' });
        expect(() => external.list()).toThrow(expect.objectContaining({ code: 'plugin_service_unavailable' }));
        expect(() => external.attach(ref)).toThrow(expect.objectContaining({ code: 'plugin_service_unavailable' }));
        expect(() => external.readTranscript(ref, { mode: 'page', direction: 'older' }))
            .toThrow(expect.objectContaining({ code: 'plugin_service_unavailable' }));
        expect(() => external.takeover(ref, {
            targetStorageMode: 'external-linked',
            idempotencyKey: 'takeover-1',
        })).toThrow(expect.objectContaining({ code: 'plugin_service_unavailable' }));
    });

    it('composes available logger and events with every other service unavailable', async () => {
        const records: PluginInvocationLogRecord[] = [];
        const services = createPluginInvocationServicesFactory({
            loggerSink: { write: (record) => { records.push(record); } },
            now: () => 123,
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
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
        expect(Object.keys(services.events).sort()).toEqual(['host', 'plugin']);
        expect(Object.isFrozen(services.logger)).toBe(true);
        services.logger.error('keeps severity');
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ level: 'error', context: { plugin: { id: 'acme.alpha' } } });

        const unavailableIds = [
            'storage', 'settings', 'secrets', 'http', 'fs', 'exec', 'providers', 'managedServices',
            'sessions', 'resources', 'mcp', 'notifications', 'connectedAccounts', 'actions',
            'targetedContributions', 'composerContent',
        ] as const;
        for (const serviceId of unavailableIds) {
            expect(services.availability(serviceId)).toMatchObject({ status: 'unavailable' });
        }
        await expect(services.events.plugin.emit('undeclared', null)).rejects.toMatchObject({
            code: 'plugin_events_undeclared',
        });
    });

    it('binds targeted contribution observation only through its stable host owner', async () => {
        const readCurrent = vi.fn(async () => Object.freeze({
            generation: 'immutable-target-a',
            contributions: Object.freeze([]),
        }));
        const observeForSelf = vi.fn(() => Object.freeze({
            dispose: vi.fn(),
            readCurrent,
        }));
        const bind = vi.fn(() => Object.freeze({ observeForSelf }));
        const services = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
                activePluginIds: new Set<string>(),
            },
            targetedContributions: { bind },
        })(seed, createLoggerAndEventsAvailablePluginInvocationServiceBinding('7', 'binding'));

        const observation = services.targetedContributions.observeForSelf(
            {
                targetPluginId: 'acme.alpha',
                id: 'providers',
                protocol: { id: 'example-providers', version: 1 },
            },
            { onInvalidated: () => {} },
        );

        expect(services.availability('targetedContributions')).toEqual({ status: 'available' });
        expect(bind).toHaveBeenCalledWith({
            pluginId: 'acme.alpha',
            signal: seed.signal,
            isCurrent: seed.isGenerationCurrent,
        });
        await expect(observation.readCurrent()).resolves.toEqual({
            generation: 'immutable-target-a',
            contributions: [],
        });
        expect(observeForSelf).toHaveBeenCalledOnce();
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
        })(seed, createLoggerEventsAndExecServiceBinding(
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
        })).rejects.toMatchObject({ code: 'plugin_exec_system_tool_undeclared' });
        expect(registeredGrants).toHaveLength(1);
    });

    it('binds ordinary invocation storage to the plugin namespace and preserves local values across owner restart', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-invocation-storage-'));
        const paths = resolvePluginStorePaths({ happyHomeDir });
        const events = {
            broker: createStablePluginEventsBroker(),
            declarationsByPluginId: new Map(),
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
        await first.storage.daemon.set('counter', 1);

        const restarted = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events,
            storagePaths: resolvePluginStorePaths({ happyHomeDir }),
        })(seed, binding);
        expect(await restarted.storage.daemon.get('counter')).toBe(1);

        const sibling = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events,
            storagePaths: paths,
        })({
            ...seed,
            plugin: Object.freeze({ id: 'acme.beta', version: '1.2.3' }),
            contribution: Object.freeze({ id: 'run', qualifiedId: 'acme.beta/actions/run' }),
        }, binding);
        expect(await sibling.storage.daemon.get('counter')).toBeNull();
    });

    it('keeps host-owned settings records outside the plugin storage key surface', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-invocation-storage-reserved-'));
        const storagePaths = resolvePluginStorePaths({ happyHomeDir });
        await createPluginStorageOwner({
            pluginId: seed.plugin.id,
            paths: storagePaths,
        }).daemon.set('@happier/settings/v1', { revision: 1 });
        const services = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
                activePluginIds: new Set<string>(),
            },
            storagePaths,
        })(seed, createLoggerAndEventsAvailablePluginInvocationServiceBinding('7', 'binding'));

        await expect(services.storage.daemon.get('@happier/settings/v1'))
            .rejects.toMatchObject({ code: 'plugin_storage_reserved_key' });
        await expect(services.storage.daemon.set('@happier/settings/v1', { revision: 99 }))
            .rejects.toMatchObject({ code: 'plugin_storage_reserved_key' });
        await expect(services.storage.daemon.transaction(async (transaction) => {
            await transaction.delete('@happier/settings/v1');
        })).rejects.toMatchObject({ code: 'plugin_storage_reserved_key' });
        await expect(services.storage.daemon.list()).resolves.toEqual({ items: [] });
    });

    it('derives ordinary host-owned storage availability from the canonical service descriptor', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-invocation-storage-descriptor-'));
        const services = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
                activePluginIds: new Set<string>(),
            },
            storagePaths: resolvePluginStorePaths({ happyHomeDir }),
        })(seed, createLoggerAndEventsAvailablePluginInvocationServiceBinding('7', 'binding'));

        expect(services.availability('storage')).toEqual({ status: 'available' });
        await services.storage.daemon.set('descriptor-owned', true);
        await expect(services.storage.daemon.get('descriptor-owned')).resolves.toBe(true);
    });

    it('binds settings only through the canonical stable settings host', async () => {
        const binding = createLoggerAndEventsAvailablePluginInvocationServiceBinding('7', 'binding');
        const snapshot = Object.freeze({
            scope: Object.freeze({ kind: 'daemon' as const }),
            revision: '0',
            values: Object.freeze({ endpoint: 'https://example.test' }),
        });
        const createServices = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
                activePluginIds: new Set<string>(),
            },
            settings: {
                hasPlugin: (pluginId) => pluginId === 'acme.alpha',
                bind: (candidateSeed) => candidateSeed.plugin.id === 'acme.alpha'
                    ? Object.freeze({
                        forScope: () => Object.freeze({
                        snapshot: async () => snapshot,
                        get: async () => null,
                        set: async () => ({ scope: snapshot.scope, revision: '1' }),
                        reset: async () => ({ scope: snapshot.scope, revision: '1' }),
                        describe: () => Object.freeze([]),
                        watch: () => Object.freeze({ dispose: () => {} }),
                        }),
                    })
                    : null,
            },
        });

        const services = createServices(seed, binding);
        expect(services.availability('settings')).toEqual({ status: 'available' });
        await expect(services.settings.forScope({ kind: 'daemon' }).snapshot()).resolves.toBe(snapshot);
    });

    it('materializes HTTP only through the canonical stable host and exact network binding', async () => {
        const adapter = Object.freeze({
            request: vi.fn(async () => Object.freeze({
                status: 200,
                finalUrl: 'https://api.example.test/result',
                headers: Object.freeze({ 'content-type': 'application/octet-stream' }),
                body: new Uint8Array([1, 2, 3]),
            })),
            async openWebSocket(): Promise<never> {
                throw new PluginError({
                    code: 'plugin_websocket_test_adapter_unavailable',
                    message: 'WebSocket is unavailable in this HTTP request fixture',
                });
            },
        });
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
                activePluginIds: new Set<string>(),
            },
            http: createStablePluginHttpHost({ adapter }),
        })(seed, binding);

        expect(services.availability('http')).toEqual({ status: 'available' });
        expect(services).not.toHaveProperty('fetch');
        await expect(services.http.request({
            url: 'https://api.example.test/data',
            method: 'GET',
            redirect: 'error',
        })).resolves.toEqual({
            status: 200,
            finalUrl: 'https://api.example.test/result',
            headers: { 'content-type': 'application/octet-stream' },
            body: new Uint8Array([1, 2, 3]),
        });
        expect(adapter.request).toHaveBeenCalledOnce();
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
                activePluginIds: new Set<string>(),
            },
            storagePaths: resolvePluginStorePaths({ happyHomeDir }),
        })({ ...seed, isGenerationCurrent: () => current }, binding);

        await expect(services.storage.daemon.transaction(async (transaction) => {
            await transaction.set('first', 1);
            await transaction.set('second', 2);
            throw new Error('abort transaction');
        })).rejects.toThrow('abort transaction');
        expect(await services.storage.daemon.get('first')).toBeNull();
        expect(await services.storage.daemon.get('second')).toBeNull();

        let endedHandle: StorageTransaction | null = null;
        await services.storage.daemon.transaction(async (transaction) => {
            endedHandle = transaction;
            await transaction.set('first', 1);
        });
        await expect(endedHandle!.get('first')).rejects.toMatchObject({ code: 'plugin_storage_transaction_ended' });

        await expect(services.storage.daemon.transaction(async (transaction) => {
            await transaction.set('first', 3);
            current = false;
        })).rejects.toMatchObject({ code: 'plugin_generation_stale' });
        current = true;
        expect(await services.storage.daemon.get('first')).toBe(1);

        const rejectBeforeDeadlock = async (operation: Promise<unknown>): Promise<unknown> => await Promise.race([
            operation.then(
                () => ({ resolved: true }),
                (error: unknown) => error,
            ),
            new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 2_000)),
        ]);
        expect(await rejectBeforeDeadlock(services.storage.daemon.transaction(async () => {
            await services.storage.daemon.set('reentrant', true);
        }))).toMatchObject({ code: 'plugin_storage_transaction_reentry' });
        expect(await rejectBeforeDeadlock(services.storage.daemon.transaction(async () => {
            await services.storage.ephemeral.transaction(async () => undefined);
        }))).toMatchObject({ code: 'plugin_storage_transaction_reentry' });

        await services.storage.daemon.transaction(async (transaction) => {
            await transaction.set('first', 2);
            await services.storage.ephemeral.set('independent', true);
        });
        expect(await services.storage.daemon.get('first')).toBe(2);
        expect(await services.storage.ephemeral.get('independent')).toBe(true);

        await services.storage.daemon.set('counter', 0);
        let callbackCount = 0;
        await Promise.all(Array.from({ length: 8 }, async () => {
            await services.storage.daemon.transaction(async (transaction) => {
                callbackCount += 1;
                const value = await transaction.get<number>('counter') ?? 0;
                await transaction.set('counter', value + 1);
            });
        }));
        expect(callbackCount).toBe(8);
        expect(await services.storage.daemon.get('counter')).toBe(8);
    });

    it('rejects a logger factory binding that does not admit exactly the logger', () => {
        const createServices = createPluginInvocationServicesFactory({
            loggerSink: { write: () => {} },
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
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
                activePluginIds: new Set(),
            },
            exec: {
                resolveExecutable: async () => ({ command: process.execPath }),
                resolvePath: async () => { throw new Error('unexpected path'); },
            },
        })(seed, createLoggerEventsAndExecServiceBinding(
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
