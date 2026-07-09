import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    ExecProcessHandleV1,
    ExecRunResultV1,
    ExecRuntimeServiceV1,
    FetchRuntimeResponseV1,
    ManagedServerSpecV1,
} from '@happier-dev/plugin-sdk';

import { createPluginManagedServerService } from './server';

function createResponse(ok = true): FetchRuntimeResponseV1 {
    return {
        ok,
        status: ok ? 200 : 503,
        statusText: ok ? 'OK' : 'Unavailable',
        headers: {},
        text: async () => '',
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
    };
}

function createProcessHandle(params: Readonly<{
    pid?: number | null;
    exit?: Promise<Readonly<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string }>>;
}> = {}): ExecProcessHandleV1 {
    return {
        pid: params.pid ?? 123,
        exit: params.exit ?? new Promise(() => undefined),
        writeStdin: vi.fn(async () => undefined),
        kill: vi.fn(),
        dispose: vi.fn(async () => undefined),
    };
}

function createExecService(handle: ExecProcessHandleV1 = createProcessHandle()): ExecRuntimeServiceV1 {
    return {
        spawn: vi.fn(async () => handle),
        run: vi.fn(async () => ({
            exitCode: 0,
            signal: null,
            stdout: '',
            stderr: '',
        })),
        spawnClient: vi.fn(),
    } as unknown as ExecRuntimeServiceV1;
}

function createDeferredExit(): Readonly<{
    exit: Promise<ExecRunResultV1>;
    resolve: (result: ExecRunResultV1) => void;
}> {
    let resolve!: (result: ExecRunResultV1) => void;
    const exit = new Promise<ExecRunResultV1>((resolver) => {
        resolve = resolver;
    });
    return { exit, resolve };
}

describe('createPluginManagedServerService', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('attaches to an external server without spawning or disposing a process', async () => {
        const exec = createExecService();
        const fetch = vi.fn(async () => createResponse());
        vi.stubGlobal('fetch', fetch);

        const service = createPluginManagedServerService({ exec });
        const handle = await service.supervise({
            id: 'opencode-server',
            mode: {
                kind: 'external-attach',
                baseUrl: 'http://127.0.0.1:49152',
            },
            launch: { kind: 'binary', executablePath: '/bin/false' },
            healthCheck: {
                kind: 'http',
                url: 'http://127.0.0.1:49152/global/health',
                path: '/global/health',
            },
        } satisfies ManagedServerSpecV1);

        await expect(handle.waitUntilHealthy()).resolves.toMatchObject({
            id: 'opencode-server',
            mode: 'external-attach',
            baseUrl: 'http://127.0.0.1:49152',
            port: 49152,
            pid: null,
            state: 'healthy',
        });
        expect(exec.spawn).not.toHaveBeenCalled();
        await handle.dispose();
        expect(exec.spawn).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:49152/global/health', expect.any(Object));
    });

    it('threads the managed-spawn endpoint into launch args, env, health, and snapshot', async () => {
        const exec = createExecService();
        const fetch = vi.fn(async () => createResponse());
        vi.stubGlobal('fetch', fetch);

        const service = createPluginManagedServerService({ exec });
        const handle = await service.supervise({
            id: 'opencode-server',
            mode: {
                kind: 'managed-spawn',
                host: '127.0.0.1',
                port: 49153,
                portArg: '--port',
                baseUrlEnvKey: 'HAPPIER_OPENCODE_SERVER_URL',
                credential: {
                    envKey: 'OPENCODE_SERVER_PASSWORD',
                    value: 'managed-secret',
                    httpHeader: {
                        name: 'authorization',
                        value: 'Bearer managed-secret',
                    },
                },
            },
            launch: {
                kind: 'agent-cli',
                agentId: 'opencode',
                args: ['serve', '--hostname', '127.0.0.1'],
                env: { EXISTING: '1' },
            },
            healthCheck: {
                kind: 'http',
                path: '/global/health',
            },
        } satisfies ManagedServerSpecV1);

        expect(exec.spawn).toHaveBeenCalledWith(expect.objectContaining({
            args: ['serve', '--hostname', '127.0.0.1', '--port', '49153'],
            env: {
                EXISTING: '1',
                HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:49153',
                OPENCODE_SERVER_PASSWORD: 'managed-secret',
            },
        }), expect.any(Object));
        await expect(handle.waitUntilHealthy()).resolves.toMatchObject({
            mode: 'managed-spawn',
            baseUrl: 'http://127.0.0.1:49153',
            port: 49153,
            credentialEnvKey: 'OPENCODE_SERVER_PASSWORD',
            diagnostics: expect.objectContaining({
                healthCheckUrl: 'http://127.0.0.1:49153/global/health',
            }),
        });
        expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:49153/global/health', expect.objectContaining({
            headers: expect.objectContaining({
                authorization: 'Bearer managed-secret',
            }),
        }));
    });

    it('rejects mismatched managed-spawn baseUrl and port before spawning', async () => {
        const exec = createExecService();
        const service = createPluginManagedServerService({ exec });

        await expect(service.supervise({
            id: 'opencode-server',
            mode: {
                kind: 'managed-spawn',
                host: '127.0.0.1',
                port: 49153,
                baseUrl: 'http://127.0.0.1:49154',
                portArg: '--port',
            },
            launch: {
                kind: 'agent-cli',
                agentId: 'opencode',
                args: ['serve', '--hostname', '127.0.0.1'],
            },
            healthCheck: {
                kind: 'http',
                path: '/global/health',
            },
        } satisfies ManagedServerSpecV1)).rejects.toThrow(/baseUrl port.*managed-spawn port/u);
        expect(exec.spawn).not.toHaveBeenCalled();
    });

    it('does not accept a healthy HTTP response after the spawned process exits', async () => {
        const handle = createProcessHandle({
            exit: Promise.resolve({
                exitCode: 1,
                signal: null,
                stdout: '',
                stderr: 'EADDRINUSE bind failed',
            }),
        });
        const exec = createExecService(handle);
        vi.stubGlobal('fetch', vi.fn(async () => createResponse()));

        const service = createPluginManagedServerService({ exec });
        const managedServer = await service.supervise({
            id: 'opencode-server',
            mode: {
                kind: 'managed-spawn',
                host: '127.0.0.1',
                port: 49154,
                portArg: '--port',
            },
            launch: {
                kind: 'agent-cli',
                agentId: 'opencode',
                args: ['serve', '--hostname', '127.0.0.1'],
            },
            healthCheck: {
                kind: 'http',
                path: '/global/health',
            },
        } satisfies ManagedServerSpecV1);

        await expect(managedServer.waitUntilHealthy()).rejects.toThrow(/exited before becoming healthy/u);
        expect(managedServer.snapshot()).toMatchObject({
            state: 'unhealthy',
            diagnostics: expect.objectContaining({
                exitCode: 1,
                stderrTail: 'EADDRINUSE bind failed',
            }),
        });
    });

    it('marks a healthy managed server unhealthy when the spawned process exits', async () => {
        const deferred = createDeferredExit();
        const exec = createExecService(createProcessHandle({ exit: deferred.exit }));
        vi.stubGlobal('fetch', vi.fn(async () => createResponse()));

        const service = createPluginManagedServerService({ exec });
        const managedServer = await service.supervise({
            id: 'opencode-server',
            mode: {
                kind: 'managed-spawn',
                host: '127.0.0.1',
                port: 49155,
                portArg: '--port',
            },
            launch: {
                kind: 'agent-cli',
                agentId: 'opencode',
                args: ['serve', '--hostname', '127.0.0.1'],
            },
            healthCheck: {
                kind: 'http',
                path: '/global/health',
            },
        } satisfies ManagedServerSpecV1);

        await expect(managedServer.waitUntilHealthy()).resolves.toMatchObject({
            state: 'healthy',
        });

        deferred.resolve({
            exitCode: 1,
            signal: null,
            stdout: '',
            stderr: 'server crashed after ready',
        });
        await deferred.exit;
        await Promise.resolve();

        expect(managedServer.snapshot()).toMatchObject({
            state: 'unhealthy',
            diagnostics: expect.objectContaining({
                exitCode: 1,
                stderrTail: 'server crashed after ready',
            }),
        });
    });

    it('redacts credential header values from startup exit diagnostics', async () => {
        const handle = createProcessHandle({
            exit: Promise.resolve({
                exitCode: 1,
                signal: null,
                stdout: '',
                stderr: 'failed with OPENCODE_SERVER_PASSWORD=env-secret and Authorization: Bearer header-secret',
            }),
        });
        const exec = createExecService(handle);
        vi.stubGlobal('fetch', vi.fn(async () => createResponse()));

        const service = createPluginManagedServerService({ exec });
        const managedServer = await service.supervise({
            id: 'opencode-server',
            mode: {
                kind: 'managed-spawn',
                host: '127.0.0.1',
                port: 49156,
                portArg: '--port',
                credential: {
                    envKey: 'OPENCODE_SERVER_PASSWORD',
                    value: 'env-secret',
                    httpHeader: {
                        name: 'authorization',
                        value: 'Bearer header-secret',
                    },
                },
            },
            launch: {
                kind: 'agent-cli',
                agentId: 'opencode',
                args: ['serve', '--hostname', '127.0.0.1'],
            },
            healthCheck: {
                kind: 'http',
                path: '/global/health',
            },
        } satisfies ManagedServerSpecV1);

        await expect(managedServer.waitUntilHealthy()).rejects.toThrow(/exited before becoming healthy/u);

        const snapshot = managedServer.snapshot();
        expect(snapshot.lastErrorMessage).not.toContain('env-secret');
        expect(snapshot.lastErrorMessage).not.toContain('header-secret');
        expect(snapshot.diagnostics?.stderrTail).not.toContain('env-secret');
        expect(snapshot.diagnostics?.stderrTail).not.toContain('header-secret');
    });

    it('redacts secret-shaped HTTP health query values from snapshots while keeping useful URL context', async () => {
        const exec = createExecService();
        const fetch = vi.fn(async () => createResponse());
        vi.stubGlobal('fetch', fetch);

        const service = createPluginManagedServerService({ exec });
        const handle = await service.supervise({
            id: 'opencode-server',
            mode: {
                kind: 'external-attach',
                baseUrl: 'http://127.0.0.1:49157',
            },
            healthCheck: {
                kind: 'http',
                url: 'http://127.0.0.1:49157/global/health?token=url-secret&visible=yes',
            },
        } satisfies ManagedServerSpecV1);

        await expect(handle.waitUntilHealthy()).resolves.toMatchObject({
            state: 'healthy',
            diagnostics: expect.objectContaining({
                healthCheckUrl: expect.stringContaining('visible=yes'),
            }),
        });
        const healthCheckUrl = handle.snapshot().diagnostics?.healthCheckUrl ?? '';
        expect(healthCheckUrl).not.toContain('url-secret');
        expect(healthCheckUrl).toContain('token=');
        expect(fetch).toHaveBeenCalledWith(
            'http://127.0.0.1:49157/global/health?token=url-secret&visible=yes',
            expect.any(Object),
        );
    });

    it('redacts generic launch, health, stdout, and stderr secrets from process exit diagnostics', async () => {
        const handle = createProcessHandle({
            exit: Promise.resolve({
                exitCode: 1,
                signal: null,
                stdout: 'stdout safe detail API_KEY=stdout-env-secret password=stdout-password-secret',
                stderr: [
                    'stderr safe detail',
                    'API_KEY=env-secret',
                    '--token arg-secret',
                    '--password=arg-password-secret',
                    'Authorization: Bearer health-header-secret',
                    'Cookie: sid=cookie-secret',
                    'password=stderr-password-secret',
                    'Bearer standalone-bearer-secret',
                    'sk-managedserversecret',
                    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature',
                    'http://127.0.0.1:49158/global/health?client_secret=url-secret&visible=yes',
                ].join('\n'),
            }),
        });
        const exec = createExecService(handle);
        vi.stubGlobal('fetch', vi.fn(async () => createResponse()));

        const service = createPluginManagedServerService({ exec });
        const managedServer = await service.supervise({
            id: 'opencode-server',
            mode: {
                kind: 'managed-spawn',
                host: '127.0.0.1',
                port: 49158,
            },
            launch: {
                kind: 'agent-cli',
                agentId: 'opencode',
                args: ['serve', '--token', 'arg-secret', '--label', 'visible-label', '--password=arg-password-secret'],
                env: {
                    API_KEY: 'env-secret',
                    VISIBLE_SETTING: 'visible-env',
                },
            },
            healthCheck: {
                kind: 'http',
                url: 'http://127.0.0.1:49158/global/health?client_secret=url-secret&visible=yes',
                headers: {
                    Authorization: 'Bearer health-header-secret',
                    Cookie: 'sid=cookie-secret',
                },
            },
        } satisfies ManagedServerSpecV1);

        await expect(managedServer.waitUntilHealthy()).rejects.toThrow(/exited before becoming healthy/u);

        const snapshot = managedServer.snapshot();
        const diagnostics = snapshot.diagnostics as (typeof snapshot.diagnostics & { stdoutTail?: string }) | undefined;
        const diagnosticText = [
            snapshot.lastErrorMessage,
            diagnostics?.healthCheckUrl,
            diagnostics?.stderrTail,
            diagnostics?.stdoutTail,
        ].join('\n');

        expect(diagnosticText).toContain('stderr safe detail');
        expect(diagnosticText).toContain('stdout safe detail');
        expect(diagnosticText).toContain('visible=yes');
        expect(diagnosticText).not.toContain('env-secret');
        expect(diagnosticText).not.toContain('stdout-env-secret');
        expect(diagnosticText).not.toContain('arg-secret');
        expect(diagnosticText).not.toContain('arg-password-secret');
        expect(diagnosticText).not.toContain('health-header-secret');
        expect(diagnosticText).not.toContain('cookie-secret');
        expect(diagnosticText).not.toContain('stderr-password-secret');
        expect(diagnosticText).not.toContain('stdout-password-secret');
        expect(diagnosticText).not.toContain('standalone-bearer-secret');
        expect(diagnosticText).not.toContain('sk-managedserversecret');
        expect(diagnosticText).not.toContain('eyJhbGciOiJIUzI1NiJ9');
        expect(diagnosticText).not.toContain('url-secret');
    });
});
