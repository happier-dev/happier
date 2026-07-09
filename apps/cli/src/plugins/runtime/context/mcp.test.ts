import { describe, expect, it, vi } from 'vitest';

import type {
    ExecClientHandleV1,
    ExecClientSpecV1,
    ExecLaunchInputV1,
    ExecRuntimeServiceV1,
    JsonRpcClientV1,
    ManagedServerHandleV1,
    ManagedServerRuntimeServiceV1,
} from '@happier-dev/plugin-sdk';

import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { createPluginMcpService } from './mcp';
import { createSessionScopedMcpServices } from './session/services/mcp';

function createJsonRpcClientFixture(result: unknown = undefined): JsonRpcClientV1 {
    return {
        async request<TParams = unknown, TResult = unknown>(): Promise<TResult> {
            return result as TResult;
        },
        async notify(): Promise<void> {
            return undefined;
        },
        registerRequestHandler: () => () => undefined,
        registerNotificationHandler: () => () => undefined,
    };
}

class FakeSessionRpcHandlerManager {
    handlers = new Map<string, (payload: any) => any>();

    registerHandler(name: string, handler: any) {
        this.handlers.set(name, handler);
    }
}

class FakePermissionSession {
    sessionId = 'session-mcp-integration';
    rpcHandlerManager = new FakeSessionRpcHandlerManager();
    agentState: any = { requests: {}, completedRequests: {} };

    getAgentStateSnapshot() {
        return this.agentState;
    }

    updateAgentState(updater: any) {
        this.agentState = updater(this.agentState);
        return this.agentState;
    }

    getMetadataSnapshot() {
        return null;
    }
}

async function settledState<T>(promise: Promise<T>): Promise<'pending' | 'fulfilled' | 'rejected'> {
    const pending = Symbol('pending');
    const result = await Promise.race([
        promise.then(() => 'fulfilled' as const, () => 'rejected' as const),
        Promise.resolve(pending),
    ]);
    return result === pending ? 'pending' : result;
}

async function flushAsyncPermissionPublication(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('createPluginMcpService', () => {
    const launch: ExecLaunchInputV1 = {
        kind: 'binary',
        executablePath: '/bin/echo',
        args: ['mcp'],
    };

    it('creates stdio clients through ctx.exec.spawnClient and disposes them idempotently', async () => {
        const clientDispose = vi.fn(async () => undefined);
        const request = vi.fn(async () => ({ ok: true }));
        const notify = vi.fn(async () => undefined);
        const clientHandle: ExecClientHandleV1 = {
            client: {
                request: request as JsonRpcClientV1['request'],
                notify: notify as JsonRpcClientV1['notify'],
                registerRequestHandler: () => () => undefined,
                registerNotificationHandler: () => () => undefined,
            },
            process: {
                pid: 123,
                exit: Promise.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
                writeStdin: async () => undefined,
                kill: () => undefined,
                dispose: async () => undefined,
            },
            status: 'running',
            onExit: () => () => undefined,
            dispose: clientDispose,
        };
        const exec: ExecRuntimeServiceV1 = {
            systemTools: {
                resolve: async () => {
                    throw new Error('systemTools.resolve is not used by MCP tests');
                },
            },
            run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
            spawn: async () => clientHandle.process,
            spawnClient: vi.fn(async (_spec: ExecClientSpecV1) => clientHandle) as unknown as ExecRuntimeServiceV1['spawnClient'],
        };
        const service = createPluginMcpService({
            pluginId: 'acme',
            exec,
            managedServer: {} as ManagedServerRuntimeServiceV1,
        });

        const handle = await service.createClient({
            id: 'acme.client',
            transport: {
                kind: 'stdio',
                launch,
            },
        });

        expect(exec.spawnClient).toHaveBeenCalledWith(expect.objectContaining({
            launch,
            transport: expect.objectContaining({
                kind: 'stdio',
                framing: { kind: 'strict-lf-json' },
            }),
            protocol: { kind: 'json-rpc-2.0' },
        }), expect.objectContaining({
            signal: undefined,
        }));

        await expect(handle.request?.({ method: 'ping' })).resolves.toEqual({ ok: true });
        await expect(handle.notify?.({ method: 'initialized' })).resolves.toBeUndefined();
        expect(request).toHaveBeenCalledWith('ping', undefined);
        expect(notify).toHaveBeenCalledWith('initialized', undefined);

        await handle.dispose();
        await handle.dispose();

        expect(clientDispose).toHaveBeenCalledTimes(1);
    });

    it('rejects stdio clients that do not expose MCP request and notify methods', async () => {
        const clientDispose = vi.fn(async () => undefined);
        const clientHandle: ExecClientHandleV1 = {
            client: {} as JsonRpcClientV1,
            process: {
                pid: 123,
                exit: Promise.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
                writeStdin: async () => undefined,
                kill: () => undefined,
                dispose: async () => undefined,
            },
            status: 'running',
            onExit: () => () => undefined,
            dispose: clientDispose,
        };
        const exec: ExecRuntimeServiceV1 = {
            systemTools: {
                resolve: async () => {
                    throw new Error('systemTools.resolve is not used by MCP tests');
                },
            },
            run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
            spawn: async () => clientHandle.process,
            spawnClient: vi.fn(async (_spec: ExecClientSpecV1) => clientHandle) as unknown as ExecRuntimeServiceV1['spawnClient'],
        };
        const service = createPluginMcpService({
            pluginId: 'acme',
            exec,
            managedServer: {} as ManagedServerRuntimeServiceV1,
        });

        await expect(service.createClient({
            id: 'acme.client',
            transport: {
                kind: 'stdio',
                launch,
            },
        })).rejects.toThrow(/does not expose MCP request\/notify methods/);

        expect(clientDispose).toHaveBeenCalledTimes(1);
    });

    it('rejects managed clients instead of returning server-only handles', async () => {
        const managedServer: ManagedServerRuntimeServiceV1 = {
            supervise: vi.fn(async () => {
                throw new Error('managed clients must not supervise before rejection');
            }),
        };
        const service = createPluginMcpService({
            pluginId: 'acme',
            exec: {} as ExecRuntimeServiceV1,
            managedServer,
        });

        await expect(service.createClient({
            id: 'acme.managed',
            transport: {
                kind: 'managed',
                server: {
                    id: 'acme.server',
                    launch,
                },
            },
        })).rejects.toThrow(/Unsupported MCP client transport 'managed'/);

        expect(managedServer.supervise).not.toHaveBeenCalled();
    });

    it('disposes created stdio clients when the MCP service is aborted', async () => {
        const abortController = new AbortController();
        const clientDispose = vi.fn(async () => undefined);
        const clientHandle: ExecClientHandleV1 = {
            client: createJsonRpcClientFixture({ ok: true }),
            process: {
                pid: 123,
                exit: Promise.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
                writeStdin: async () => undefined,
                kill: () => undefined,
                dispose: async () => undefined,
            },
            status: 'running',
            onExit: () => () => undefined,
            dispose: clientDispose,
        };
        const exec: ExecRuntimeServiceV1 = {
            systemTools: {
                resolve: async () => {
                    throw new Error('systemTools.resolve is not used by MCP tests');
                },
            },
            run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
            spawn: async () => clientHandle.process,
            spawnClient: vi.fn(async (_spec: ExecClientSpecV1) => clientHandle) as unknown as ExecRuntimeServiceV1['spawnClient'],
        };
        const service = createPluginMcpService({
            pluginId: 'acme',
            exec,
            managedServer: {} as ManagedServerRuntimeServiceV1,
            signal: abortController.signal,
        });

        const handle = await service.createClient({
            id: 'acme.client',
            transport: {
                kind: 'stdio',
                launch,
            },
        });

        abortController.abort();
        await Promise.resolve();
        expect(clientDispose).toHaveBeenCalledTimes(1);

        await handle.dispose();

        expect(clientDispose).toHaveBeenCalledTimes(1);
    });

    it('starts managed MCP servers through ctx.managedServer and disposes them idempotently', async () => {
        const managedDispose = vi.fn(async () => undefined);
        const managedHandle: ManagedServerHandleV1 = {
            snapshot: () => ({
                id: 'acme.server',
                state: 'healthy',
                pid: 123,
                startedAt: 1,
                lastHealthyAt: 2,
                lastErrorMessage: null,
            }),
            waitUntilHealthy: async () => ({
                id: 'acme.server',
                state: 'healthy',
                pid: 123,
                startedAt: 1,
                lastHealthyAt: 2,
                lastErrorMessage: null,
            }),
            dispose: managedDispose,
        };
        const managedServer: ManagedServerRuntimeServiceV1 = {
            supervise: vi.fn(async () => managedHandle),
        };
        const service = createPluginMcpService({
            pluginId: 'acme',
            exec: {} as ExecRuntimeServiceV1,
            managedServer,
        });

        const handle = await service.startServer({
            id: 'acme.server',
            name: 'acme-server',
            transport: {
                kind: 'managed',
                server: {
                    id: 'acme.server',
                    launch,
                },
            },
        });

        expect(managedServer.supervise).toHaveBeenCalledWith({
            id: 'acme.server',
            launch,
        });

        await handle.dispose();
        await handle.dispose();

        expect(managedDispose).toHaveBeenCalledTimes(1);
    });

    it('starts hosted MCP servers through the host substrate adapter and disposes them idempotently', async () => {
        const hostedDispose = vi.fn(async () => undefined);
        const hostedToolHandler = vi.fn(async () => ({
            content: [{ type: 'text' as const, text: 'ok' }],
        }));
        const startHostedServer = vi.fn(async () => ({
            id: 'acme.hosted',
            spec: {
                id: 'acme.hosted',
                name: 'acme-hosted',
                transport: { kind: 'hosted' as const },
                hosted: {
                    tools: [
                        {
                            name: 'ext.acme.echo',
                            handler: hostedToolHandler,
                        },
                    ],
                },
            },
            dispose: hostedDispose,
        }));
        const service = createPluginMcpService({
            pluginId: 'acme',
            exec: {} as ExecRuntimeServiceV1,
            managedServer: {} as ManagedServerRuntimeServiceV1,
            startHostedServer,
        });

        const handle = await service.startServer({
            id: 'acme.hosted',
            name: 'acme-hosted',
            transport: { kind: 'hosted' },
            hosted: {
                tools: [
                    {
                        name: 'ext.acme.echo',
                        handler: hostedToolHandler,
                    },
                ],
            },
        });

        expect(startHostedServer).toHaveBeenCalledWith({
            id: 'acme.hosted',
            name: 'acme-hosted',
            transport: { kind: 'hosted' },
            hosted: {
                tools: [
                    {
                        name: 'ext.acme.echo',
                        handler: hostedToolHandler,
                    },
                ],
            },
        });

        await handle.dispose();
        await handle.dispose();

        expect(hostedDispose).toHaveBeenCalledTimes(1);
    });

    it('rejects secret-bearing hosted server specs before invoking the host substrate adapter', async () => {
        const startHostedServer = vi.fn(async () => ({
            id: 'acme.hosted',
            dispose: async () => undefined,
        }));
        const service = createPluginMcpService({
            pluginId: 'acme',
            exec: {} as ExecRuntimeServiceV1,
            managedServer: {} as ManagedServerRuntimeServiceV1,
            startHostedServer,
        });

        await expect(service.startServer({
            id: 'acme.hosted',
            name: 'acme-hosted',
            transport: { kind: 'hosted' },
            hosted: {
                apiToken: 'raw-secret',
                tools: [
                    {
                        name: 'ext.acme.echo',
                        handler: async () => ({ content: [{ type: 'text', text: 'unexpected' }] }),
                    },
                ],
            } as unknown as never,
        })).rejects.toThrow(/raw secret material/i);

        expect(startHostedServer).not.toHaveBeenCalled();
    });

    it('preserves sanitized hosted runtime endpoint metadata returned by the host adapter', async () => {
        const hostedDispose = vi.fn(async () => undefined);
        const endpoint = Object.freeze({
            kind: 'loopbackHttp' as const,
            url: 'http://127.0.0.1:49152',
            host: '127.0.0.1' as const,
            port: 49152,
        });
        const startHostedServer = vi.fn(async () => ({
            id: 'acme.hosted',
            spec: {
                id: 'acme.hosted',
                name: 'acme-hosted',
                transport: {
                    kind: 'hosted' as const,
                    exposure: { kind: 'loopbackHttp' as const, requested: true as const },
                },
            },
            endpoint,
            dispose: hostedDispose,
        }));
        const service = createPluginMcpService({
            pluginId: 'acme',
            exec: {} as ExecRuntimeServiceV1,
            managedServer: {} as ManagedServerRuntimeServiceV1,
            startHostedServer,
        });

        const handle = await service.startServer({
            id: 'acme.hosted',
            name: 'acme-hosted',
            transport: {
                kind: 'hosted',
                exposure: { kind: 'loopbackHttp', requested: true },
            },
        });

        expect(startHostedServer).toHaveBeenCalledWith({
            id: 'acme.hosted',
            name: 'acme-hosted',
            transport: {
                kind: 'hosted',
                exposure: { kind: 'loopbackHttp', requested: true },
            },
        });
        expect('endpoint' in handle ? handle.endpoint : null).toEqual(endpoint);

        await handle.dispose();

        expect(hostedDispose).toHaveBeenCalledTimes(1);
    });

    it('rejects endpoint clients until host MCP handshake support is wired', async () => {
        const service = createPluginMcpService({
            pluginId: 'acme',
            exec: {} as ExecRuntimeServiceV1,
            managedServer: {} as ManagedServerRuntimeServiceV1,
        });

        await expect(service.createClient({
            id: 'acme.remote',
            transport: {
                kind: 'http',
                url: 'https://mcp.example.test',
            },
        })).rejects.toThrow(/Unsupported MCP client transport/);
    });

    it('lists and resolves only scoped plugin MCP specs', async () => {
        const service = createPluginMcpService({
            pluginId: 'acme',
            exec: {} as ExecRuntimeServiceV1,
            managedServer: {} as ManagedServerRuntimeServiceV1,
            listSpecs: async () => [
                {
                    id: 'acme.hosted',
                    name: 'acme-hosted',
                    transport: { kind: 'hosted' },
                },
            ],
            resolveForSession: async (input) => input.sessionId === 'session-1'
                ? [
                    {
                        id: 'acme.hosted',
                        name: 'acme-hosted',
                        scope: {
                            sessionId: input.sessionId,
                            accountId: input.accountId,
                            workspaceId: input.workspaceId,
                            directory: input.directory,
                        },
                        transport: { kind: 'hosted' },
                    },
                ]
                : [],
        });

        await expect(service.list()).resolves.toEqual([
            {
                id: 'acme.hosted',
                name: 'acme-hosted',
                transport: { kind: 'hosted' },
            },
        ]);
        await expect(service.resolveForSession({
            sessionId: 'session-1',
            accountId: 'account-1',
            workspaceId: 'workspace-1',
            directory: '/repo',
        })).resolves.toEqual([
            {
                id: 'acme.hosted',
                name: 'acme-hosted',
                scope: {
                    sessionId: 'session-1',
                    accountId: 'account-1',
                    workspaceId: 'workspace-1',
                    directory: '/repo',
                },
                transport: { kind: 'hosted' },
            },
        ]);
    });
});

describe('createSessionScopedMcpServices permission integration', () => {
    it('routes MCP elicitation through provider-enforced permission responses with plugin owner isolation', async () => {
        const session = new FakePermissionSession();
        const permissionHandler = new ProviderEnforcedPermissionHandler(session as any, {
            logPrefix: '[SessionMcpIntegration]',
        });
        const ownerA = { kind: 'plugin' as const, pluginId: 'plugin-a', runtimeId: 'runtime-a' };
        const ownerB = { kind: 'plugin' as const, pluginId: 'plugin-b', runtimeId: 'runtime-b' };
        const serviceA = createSessionScopedMcpServices({
            owner: ownerA,
            readScope: async () => ({ permissionHandler }),
        });
        const serviceB = createSessionScopedMcpServices({
            owner: ownerB,
            readScope: async () => ({ permissionHandler }),
        });
        const respond = session.rpcHandlerManager.handlers.get('permission');
        expect(respond).toBeTypeOf('function');

        const input = { command: 'printf happier-permission-wave3' };
        const approvedForSession = serviceA.elicit({
            requestId: 'mcp-allow-session',
            serverName: 'shell',
            toolName: 'run_command',
            input,
        });

        await flushAsyncPermissionPublication();
        expect(session.agentState.requests['mcp-allow-session']).toMatchObject({
            tool: 'mcp__shell__run_command',
            arguments: input,
            owner: ownerA,
        });

        await respond?.({
            id: 'mcp-allow-session',
            approved: true,
            decision: 'approved_for_session',
            answers: { confirmation: 'yes' },
        });
        await expect(approvedForSession).resolves.toEqual({
            status: 'accepted',
            decision: 'approved_for_session',
            content: { confirmation: 'yes' },
        });
        expect(session.agentState.completedRequests['mcp-allow-session']).toMatchObject({
            status: 'approved',
            decision: 'approved_for_session',
            owner: ownerA,
        });

        await expect(serviceA.elicit({
            requestId: 'mcp-auto-owner-a',
            serverName: 'shell',
            toolName: 'run_command',
            input,
        })).resolves.toEqual({
            status: 'accepted',
            decision: 'approved_for_session',
        });
        expect(session.agentState.requests['mcp-auto-owner-a']).toBeUndefined();
        expect(session.agentState.completedRequests['mcp-auto-owner-a']).toMatchObject({
            status: 'approved',
            decision: 'approved_for_session',
            owner: ownerA,
        });

        const ownerBRequest = serviceB.elicit({
            requestId: 'mcp-owner-b',
            serverName: 'shell',
            toolName: 'run_command',
            input,
        });
        await flushAsyncPermissionPublication();
        expect(await settledState(ownerBRequest)).toBe('pending');
        expect(session.agentState.requests['mcp-owner-b']).toMatchObject({
            tool: 'mcp__shell__run_command',
            arguments: input,
            owner: ownerB,
        });
        await respond?.({ id: 'mcp-owner-b', approved: false, decision: 'denied' });
        await expect(ownerBRequest).resolves.toEqual({
            status: 'declined',
            decision: 'denied',
        });

        const cancelled = serviceB.elicit({
            requestId: 'mcp-cancelled',
            serverName: 'shell',
            toolName: 'run_command',
            input: { command: 'printf cancelled' },
        });
        await flushAsyncPermissionPublication();
        await respond?.({ id: 'mcp-cancelled', approved: false, decision: 'abort' });
        await expect(cancelled).resolves.toEqual({
            status: 'cancelled',
            decision: 'abort',
        });
    });
});
