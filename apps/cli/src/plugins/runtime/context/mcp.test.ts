import { describe, expect, it, vi } from 'vitest';

import type {
    ExecClientHandleV1,
    ExecLaunchInputV1,
    ExecRuntimeServiceV1,
    ManagedServerHandleV1,
    ManagedServerRuntimeServiceV1,
} from '@happier-dev/plugin-sdk';

import { createPluginMcpService } from './mcp';

describe('createPluginMcpService', () => {
    const launch: ExecLaunchInputV1 = {
        kind: 'resolvedExecutable',
        executablePath: '/bin/echo',
        args: ['mcp'],
    };

    it('creates stdio clients through ctx.exec.spawnClient and disposes them idempotently', async () => {
        const clientDispose = vi.fn(async () => undefined);
        const request = vi.fn(async () => ({ ok: true }));
        const notify = vi.fn(async () => undefined);
        const clientHandle: ExecClientHandleV1 = {
            process: {
                pid: 123,
                exit: Promise.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
                writeStdin: async () => undefined,
                kill: () => undefined,
                dispose: async () => undefined,
            },
            request,
            notify,
            dispose: clientDispose,
        };
        const exec: ExecRuntimeServiceV1 = {
            run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
            spawn: async () => clientHandle.process,
            spawnClient: vi.fn(async () => clientHandle),
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

        expect(exec.spawnClient).toHaveBeenCalledWith(launch, expect.objectContaining({
            signal: undefined,
        }));

        await expect(handle.request?.({ method: 'ping' })).resolves.toEqual({ ok: true });
        await expect(handle.notify?.({ method: 'initialized' })).resolves.toBeUndefined();
        expect(request).toHaveBeenCalledWith({ method: 'ping' });
        expect(notify).toHaveBeenCalledWith({ method: 'initialized' });

        await handle.dispose();
        await handle.dispose();

        expect(clientDispose).toHaveBeenCalledTimes(1);
    });

    it('rejects stdio clients that do not expose MCP request and notify methods', async () => {
        const clientDispose = vi.fn(async () => undefined);
        const clientHandle: ExecClientHandleV1 = {
            process: {
                pid: 123,
                exit: Promise.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
                writeStdin: async () => undefined,
                kill: () => undefined,
                dispose: async () => undefined,
            },
            dispose: clientDispose,
        };
        const exec: ExecRuntimeServiceV1 = {
            run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
            spawn: async () => clientHandle.process,
            spawnClient: vi.fn(async () => clientHandle),
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
            process: {
                pid: 123,
                exit: Promise.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
                writeStdin: async () => undefined,
                kill: () => undefined,
                dispose: async () => undefined,
            },
            request: async () => ({ ok: true }),
            notify: async () => undefined,
            dispose: clientDispose,
        };
        const exec: ExecRuntimeServiceV1 = {
            run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
            spawn: async () => clientHandle.process,
            spawnClient: vi.fn(async () => clientHandle),
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
        const startHostedServer = vi.fn(async () => ({
            id: 'acme.hosted',
            spec: {
                id: 'acme.hosted',
                name: 'acme-hosted',
                transport: { kind: 'hosted' as const },
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
        });

        expect(startHostedServer).toHaveBeenCalledWith({
            id: 'acme.hosted',
            name: 'acme-hosted',
            transport: { kind: 'hosted' },
        });

        await handle.dispose();
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
