import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { RuntimeEventV1Schema } from '@happier-dev/protocol';

import type {
    AcpBackendSpecV1,
    AcpRuntimeExtensionsV1,
    ExecClientHandleV1,
    ExecClientSpecV1,
    ExecLaunchInputV1,
    ExecProcessHandleV1,
    ExecRunResultV1,
    ExecRuntimeServiceV1,
    JsonRpcClientV1,
    PluginContextV1,
} from '@happier-dev/plugin-sdk';

import {
    PluginAcpRuntimeError,
    createPluginAcpRuntimeService,
} from './runtime';

const EXIT_RESULT: ExecRunResultV1 = Object.freeze({
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
});

const PROCESS_HANDLE: ExecProcessHandleV1 = Object.freeze({
    pid: 123,
    exit: Promise.resolve(EXIT_RESULT),
    async writeStdin() {
        return undefined;
    },
    kill() {
        return undefined;
    },
    async dispose() {
        return undefined;
    },
});

const ACP_SPEC = {
    backendId: 'fixture.custom.acp',
    transport: {
        kind: 'stdio',
        launch: {
            kind: 'executable',
            command: '/bin/fixture-agent',
            args: ['--acp'],
            env: {
                FIXTURE_TRANSPORT: '1',
            },
        },
    },
    launchEnv: {
        FIXTURE_SPEC: '1',
    },
    ux: {
        name: 'Fixture ACP',
    },
} satisfies AcpBackendSpecV1;

const CLIENT_SPEC = {
    launch: {
        kind: 'binary',
        executablePath: '/bin/fixture-agent',
        args: ['--acp'],
        cwd: '/workspace',
    },
    transport: {
        kind: 'stdio',
        framing: { kind: 'strict-lf-json' },
        encoding: 'utf8',
    },
    protocol: { kind: 'json-rpc-2.0' },
} satisfies ExecClientSpecV1;

function createJsonRpcClientFixture(params?: Readonly<{
    request?: JsonRpcClientV1['request'];
    notify?: JsonRpcClientV1['notify'];
}>): JsonRpcClientV1 {
    return Object.freeze({
        request: params?.request ?? (async <TParams = unknown, TResult = unknown>(): Promise<TResult> => {
            return {} as TResult;
        }),
        notify: params?.notify ?? (async () => undefined),
        registerRequestHandler() {
            return () => undefined;
        },
        registerNotificationHandler() {
            return () => undefined;
        },
    });
}

function createExecFixture(params?: Readonly<{
    client?: JsonRpcClientV1;
}>) {
    const dispose = vi.fn(async () => undefined);
    const client = params?.client ?? createJsonRpcClientFixture();
    const handle: ExecClientHandleV1 = Object.freeze({
        client,
        process: PROCESS_HANDLE,
        status: 'running',
        onExit: () => () => undefined,
        dispose,
    });
    const spawnClientCalls: ExecClientSpecV1[] = [];
    const exec: ExecRuntimeServiceV1 = Object.freeze({
        systemTools: {
            resolve: async () => {
                throw new Error('systemTools.resolve is not used by ACP runtime tests');
            },
        },
        async run() {
            return EXIT_RESULT;
        },
        async spawn() {
            return PROCESS_HANDLE;
        },
        spawnClient: (async (input: ExecClientSpecV1) => {
            if (!('launch' in input && 'transport' in input && 'protocol' in input)) {
                throw new Error('Expected object-shaped ExecClientSpecV1');
            }
            spawnClientCalls.push(input);
            return handle;
        }) as ExecRuntimeServiceV1['spawnClient'],
    });
    return {
        client,
        dispose,
        exec,
        readSpawnClientSpec: () => {
            const spec = spawnClientCalls.at(-1);
            if (!spec) {
                throw new Error('spawnClient was not called');
            }
            return spec;
        },
        spawnClientCalls,
    };
}

function createPluginContextFixture(params?: Readonly<{
    env?: Readonly<Record<string, string>>;
}>): PluginContextV1 {
    return {
        env: {
            get: (name: string) => params?.env?.[name] ?? null,
        },
    } as unknown as PluginContextV1; // Boundary fixture: these tests exercise only ACP auth-env callback context.
}

async function withTemporaryCursorCli<T>(run: () => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), 'happier-acp-cursor-cli-'));
    const cursorPath = join(root, 'cursor-agent');
    await writeFile(cursorPath, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(cursorPath, 0o755);
    const previousCursorPath = process.env.HAPPIER_CURSOR_PATH;
    process.env.HAPPIER_CURSOR_PATH = cursorPath;
    try {
        return await run();
    } finally {
        if (previousCursorPath === undefined) {
            delete process.env.HAPPIER_CURSOR_PATH;
        } else {
            process.env.HAPPIER_CURSOR_PATH = previousCursorPath;
        }
    }
}

describe('createPluginAcpRuntimeService', () => {
    it('spawns an A.13p JSON-RPC client and dispatches provider-owned extension handlers with scoped context', async () => {
        const fixture = createExecFixture();
        const notification = vi.fn(async () => undefined);
        const service = createPluginAcpRuntimeService({
            exec: fixture.exec,
        });

        const handle = await service.createRuntime(ACP_SPEC, {
            sessionId: 'session-1',
            cwd: '/workspace',
            clientSpec: CLIENT_SPEC,
            extensions: {
                requests: {
                    'fixture/customRequest': async (params, context) => ({
                        params,
                        method: context.method,
                        requestId: context.requestId,
                        sessionId: context.sessionId,
                        backendId: context.backendId,
                        agentName: context.agentName,
                        aborted: context.signal.aborted,
                    }),
                },
                notifications: {
                    'fixture/customNotification': notification,
                },
            },
        });

        const spawned = fixture.readSpawnClientSpec();
        expect(spawned).toMatchObject({
            launch: CLIENT_SPEC.launch,
            transport: CLIENT_SPEC.transport,
            protocol: CLIENT_SPEC.protocol,
        });
        const requestHandler = spawned.handlers?.jsonRpc?.requests?.['fixture/customRequest'];
        const notificationHandler = spawned.handlers?.jsonRpc?.notifications?.['fixture/customNotification'];
        expect(requestHandler).toEqual(expect.any(Function));
        expect(notificationHandler).toEqual(expect.any(Function));

        const requestContext = {
            method: 'fixture/customRequest',
            requestId: 'child-request-42',
        };
        await expect(requestHandler?.({ value: 7 }, requestContext)).resolves.toEqual({
            params: { value: 7 },
            method: 'fixture/customRequest',
            requestId: 'child-request-42',
            sessionId: 'session-1',
            backendId: 'fixture.custom.acp',
            agentName: 'Fixture ACP',
            aborted: false,
        });
        await notificationHandler?.({ tick: true }, { method: 'fixture/customNotification' });
        expect(notification).toHaveBeenCalledWith(
            { tick: true },
            expect.objectContaining({
                method: 'fixture/customNotification',
                sessionId: 'session-1',
                backendId: 'fixture.custom.acp',
            }),
        );
        expect(handle.runtime.client).toBe(fixture.client);
    });

    it('derives a host-granted exec client spec from stdio ACP executable transport when params do not provide one', async () => {
        const fixture = createExecFixture();
        const service = createPluginAcpRuntimeService({
            exec: fixture.exec,
        });

        await service.createRuntime(ACP_SPEC, {
            sessionId: 'session-1',
            cwd: '/workspace',
        });

        expect(fixture.readSpawnClientSpec()).toMatchObject({
            launch: {
                kind: 'binary',
                executablePath: '/bin/fixture-agent',
                args: ['--acp'],
                cwd: '/workspace',
                env: {
                    FIXTURE_SPEC: '1',
                    FIXTURE_TRANSPORT: '1',
                },
            },
            transport: {
                kind: 'stdio',
                framing: { kind: 'strict-lf-json' },
            },
            protocol: { kind: 'json-rpc-2.0' },
        });
    });

    it('derives a client spec for custom ACP transport hooks and auth env without rejecting before spawn', async () => {
        const fixture = createExecFixture();
        const pluginContext = createPluginContextFixture({
            env: {
                CURSOR_API_KEY: 'cursor-secret-token',
            },
        });
        const service = createPluginAcpRuntimeService({
            exec: fixture.exec,
            readPluginContext: () => pluginContext,
        } as Parameters<typeof createPluginAcpRuntimeService>[0] & {
            readPluginContext: () => PluginContextV1;
        });
        const cursorShapedSpec = {
            ...ACP_SPEC,
            backendId: 'fixture.cursor-shaped',
            transport: {
                kind: 'stdio',
                launch: {
                    kind: 'agent-cli',
                    agentId: 'cursor',
                    args: ['--from-spec'],
                    env: {
                        FIXTURE_TRANSPORT: '1',
                    },
                },
                customHandler: {
                    onMessage: () => 'pass',
                },
            },
            auth: {
                buildAuthEnv: (ctx: PluginContextV1): Readonly<Record<string, string>> => {
                    const apiKey = ctx.env.get('CURSOR_API_KEY');
                    return apiKey ? { CURSOR_API_KEY: apiKey } : {};
                },
            },
            callbacks: {
                argvBuilder: ({ baseArgs }: Readonly<{
                    baseArgs: readonly string[];
                    cwd: string;
                }>) => [...baseArgs, 'acp'],
                envBuilder: ({ env }: Readonly<{
                    cwd: string;
                    env: Readonly<Record<string, string>>;
                }>) => ({
                    ...env,
                    CALLBACK_ENV: '1',
                }),
            },
        } satisfies AcpBackendSpecV1;

        await withTemporaryCursorCli(async () => {
            await service.createRuntime(cursorShapedSpec, {
                sessionId: 'session-1',
                cwd: '/workspace',
            });
        });

        const spawned = fixture.readSpawnClientSpec() as ExecClientSpecV1 & {
            hooks?: Readonly<{
                jsonRpc?: Readonly<{
                    onMessage?: unknown;
                }>;
            }>;
        };
        expect(spawned.launch).toMatchObject({
            kind: 'agent-cli',
            agentId: 'cursor',
            args: ['--from-spec', 'acp'],
            cwd: '/workspace',
            env: {
                FIXTURE_SPEC: '1',
                FIXTURE_TRANSPORT: '1',
                CURSOR_API_KEY: 'cursor-secret-token',
                CALLBACK_ENV: '1',
            },
        });
        expect(spawned.hooks?.jsonRpc?.onMessage).toEqual(expect.any(Function));
    });

    it('redacts auth-env callback failure diagnostics', async () => {
        const fixture = createExecFixture();
        const service = createPluginAcpRuntimeService({
            exec: fixture.exec,
            readPluginContext: () => createPluginContextFixture(),
        } as Parameters<typeof createPluginAcpRuntimeService>[0] & {
            readPluginContext: () => PluginContextV1;
        });
        const spec = {
            ...ACP_SPEC,
            auth: {
                buildAuthEnv: () => {
                    throw new Error('failed with CURSOR_API_KEY=super-secret-token');
                },
            },
        } satisfies AcpBackendSpecV1;

        await expect(service.createRuntime(spec, {
            sessionId: 'session-1',
            cwd: '/workspace',
        })).rejects.toThrow(/CURSOR_API_KEY=<redacted>/);
        await expect(service.createRuntime(spec, {
            sessionId: 'session-1',
            cwd: '/workspace',
        })).rejects.not.toThrow(/super-secret-token/);
        expect(fixture.spawnClientCalls).toEqual([]);
    });

    it('classifies preflight failures before spawning the protocol client', async () => {
        const fixture = createExecFixture();
        const service = createPluginAcpRuntimeService({
            exec: fixture.exec,
        });
        const spec = {
            ...ACP_SPEC,
            callbacks: {
                preflight: async ({ cwd }) => {
                    expect(cwd).toBe('/workspace');
                    throw new Error('preflight failed');
                },
            },
        } satisfies AcpBackendSpecV1;

        await expect(service.createRuntime(spec, {
            sessionId: 'session-1',
            cwd: '/workspace',
        })).rejects.toMatchObject({
            code: 'HAPPIER_ACP_TIER2_CALLBACK_ERROR',
            callback: 'preflight',
            backendId: 'fixture.custom.acp',
            startupFailure: true,
        });
        expect(fixture.spawnClientCalls).toEqual([]);
    });

    it('exposes shared ACP session operations over the composed A.13p runtime', async () => {
        const requests: { method: string; params: unknown }[] = [];
        const client = createJsonRpcClientFixture({
            request: async <TParams = unknown, TResult = unknown>(method: string, params?: TParams): Promise<TResult> => {
                requests.push({ method, params });
                if (method === 'session/new') {
                    return { sessionId: 'provider-session-1' } as TResult;
                }
                if (method === 'session/load') {
                    return { sessionId: 'loaded-provider-session' } as TResult;
                }
                return {} as TResult;
            },
        });
        const fixture = createExecFixture({ client });
        const service = createPluginAcpRuntimeService({
            exec: fixture.exec,
        });

        const handle = await service.createRuntime(ACP_SPEC, {
            sessionId: 'happier-session-1',
            cwd: '/workspace',
            clientSpec: CLIENT_SPEC,
        });

        await expect(handle.sessionRuntime.startOrLoadSession()).resolves.toEqual('provider-session-1');
        await handle.sessionRuntime.sendTurnPrompt('hello provider');
        await handle.sessionRuntime.updateSessionRuntimeConfig({
            modeId: 'ask',
            modelId: 'composer-2.5',
            configOptions: {
                fast: true,
            },
        });
        await handle.sessionRuntime.cancelTurn();

        expect(requests).toEqual([
            {
                method: 'session/new',
                params: {
                    cwd: '/workspace',
                },
            },
            {
                method: 'session/prompt',
                params: {
                    sessionId: 'provider-session-1',
                    prompt: 'hello provider',
                },
            },
            {
                method: 'session/set_mode',
                params: {
                    sessionId: 'provider-session-1',
                    modeId: 'ask',
                },
            },
            {
                method: 'session/set_model',
                params: {
                    sessionId: 'provider-session-1',
                    modelId: 'composer-2.5',
                },
            },
            {
                method: 'session/set_config_option',
                params: {
                    sessionId: 'provider-session-1',
                    configId: 'fast',
                    value: true,
                },
            },
            {
                method: 'session/cancel',
                params: {
                    sessionId: 'provider-session-1',
                },
            },
        ]);
    });

    it('applies the canonical singular configOption update over the composed A.13p runtime', async () => {
        const requests: { method: string; params: unknown }[] = [];
        const client = createJsonRpcClientFixture({
            request: async <TParams = unknown, TResult = unknown>(method: string, params?: TParams): Promise<TResult> => {
                requests.push({ method, params });
                if (method === 'session/new') {
                    return { sessionId: 'provider-session-1' } as TResult;
                }
                return {} as TResult;
            },
        });
        const fixture = createExecFixture({ client });
        const service = createPluginAcpRuntimeService({
            exec: fixture.exec,
        });

        const handle = await service.createRuntime(ACP_SPEC, {
            sessionId: 'happier-session-1',
            cwd: '/workspace',
            clientSpec: CLIENT_SPEC,
        });

        await handle.sessionRuntime.startOrLoadSession();
        await handle.sessionRuntime.updateSessionRuntimeConfig({
            configOption: { id: 'reasoning_effort', value: 'high' },
        });

        expect(requests).toContainEqual({
            method: 'session/set_config_option',
            params: {
                sessionId: 'provider-session-1',
                configId: 'reasoning_effort',
                value: 'high',
            },
        });
    });

    it('passes initialize meta through provider session creation', async () => {
        const requests: { method: string; params: unknown }[] = [];
        const client = createJsonRpcClientFixture({
            request: async <TParams = unknown, TResult = unknown>(method: string, params?: TParams): Promise<TResult> => {
                requests.push({ method, params });
                if (method === 'session/new') {
                    return { sessionId: 'provider-session-1' } as TResult;
                }
                return {} as TResult;
            },
        });
        const fixture = createExecFixture({ client });
        const service = createPluginAcpRuntimeService({
            exec: fixture.exec,
        });

        const handle = await service.createRuntime(ACP_SPEC, {
            sessionId: 'happier-session-1',
            cwd: '/workspace',
            clientSpec: CLIENT_SPEC,
            lifecycle: {
                initializeMeta: {
                    parameterizedModelPicker: true,
                    providerCapability: 'cursor',
                },
            },
        });
        await handle.sessionRuntime.startOrLoadSession();

        expect(requests).toEqual([
            {
                method: 'session/new',
                params: {
                    cwd: '/workspace',
                    _meta: {
                        parameterizedModelPicker: true,
                        providerCapability: 'cursor',
                    },
                },
            },
        ]);
    });

    it('runs optional initialize and authenticate before provider session creation', async () => {
        const requests: { method: string; params: unknown }[] = [];
        const client = createJsonRpcClientFixture({
            request: async <TParams = unknown, TResult = unknown>(method: string, params?: TParams): Promise<TResult> => {
                requests.push({ method, params });
                if (method === 'initialize') {
                    return {
                        authMethods: [
                            {
                                id: 'cursor_login',
                                name: 'Cursor',
                            },
                        ],
                    } as TResult;
                }
                if (method === 'session/new') {
                    return { sessionId: 'provider-session-1' } as TResult;
                }
                return {} as TResult;
            },
        });
        const fixture = createExecFixture({ client });
        const service = createPluginAcpRuntimeService({
            exec: fixture.exec,
        });

        const handle = await service.createRuntime(ACP_SPEC, {
            sessionId: 'happier-session-1',
            cwd: '/workspace',
            clientSpec: CLIENT_SPEC,
            lifecycle: {
                initialize: {
                    protocolVersion: 1,
                    clientCapabilities: {
                        sampling: true,
                    },
                },
                authenticate: {
                    methodId: 'cursor_login',
                    meta: {
                        authMethodId: 'cursor_login',
                    },
                },
                initializeMeta: {
                    parameterizedModelPicker: true,
                },
            },
        });
        await handle.sessionRuntime.startOrLoadSession();

        expect(requests).toEqual([
            {
                method: 'initialize',
                params: {
                    protocolVersion: 1,
                    clientCapabilities: {
                        sampling: true,
                        _meta: {
                            parameterizedModelPicker: true,
                        },
                    },
                },
            },
            {
                method: 'authenticate',
                params: {
                    methodId: 'cursor_login',
                    _meta: {
                        authMethodId: 'cursor_login',
                    },
                },
            },
            {
                method: 'session/new',
                params: {
                    cwd: '/workspace',
                    _meta: {
                        parameterizedModelPicker: true,
                    },
                },
            },
        ]);
    });

    it('initializes before authenticate even when only authenticate lifecycle is configured', async () => {
        const requests: { method: string; params: unknown }[] = [];
        const client = createJsonRpcClientFixture({
            request: async <TParams = unknown, TResult = unknown>(method: string, params?: TParams): Promise<TResult> => {
                requests.push({ method, params });
                if (method === 'initialize') {
                    return {
                        authMethods: [
                            {
                                id: 'cursor_login',
                                name: 'Cursor',
                            },
                        ],
                    } as TResult;
                }
                if (method === 'session/new') {
                    return { sessionId: 'provider-session-1' } as TResult;
                }
                return {} as TResult;
            },
        });
        const fixture = createExecFixture({ client });
        const service = createPluginAcpRuntimeService({
            exec: fixture.exec,
        });

        const handle = await service.createRuntime(ACP_SPEC, {
            sessionId: 'happier-session-1',
            cwd: '/workspace',
            clientSpec: CLIENT_SPEC,
            lifecycle: {
                authenticate: {
                    methodId: 'cursor_login',
                },
                initializeMeta: {
                    parameterizedModelPicker: true,
                },
            },
        });
        await handle.sessionRuntime.startOrLoadSession();

        expect(requests.map((request) => request.method)).toEqual([
            'initialize',
            'authenticate',
            'session/new',
        ]);
        expect(requests[0]).toEqual({
            method: 'initialize',
            params: {
                protocolVersion: 1,
                clientCapabilities: {
                    _meta: {
                        parameterizedModelPicker: true,
                    },
                },
            },
        });
    });

    it('fails closed when the initialized provider does not advertise the requested auth method', async () => {
        const requests: { method: string; params: unknown }[] = [];
        const client = createJsonRpcClientFixture({
            request: async <TParams = unknown, TResult = unknown>(method: string, params?: TParams): Promise<TResult> => {
                requests.push({ method, params });
                if (method === 'initialize') {
                    return {
                        authMethods: [
                            {
                                id: 'different_login',
                                name: 'Different',
                            },
                        ],
                    } as TResult;
                }
                if (method === 'session/new') {
                    return { sessionId: 'provider-session-1' } as TResult;
                }
                return {} as TResult;
            },
        });
        const fixture = createExecFixture({ client });
        const service = createPluginAcpRuntimeService({
            exec: fixture.exec,
        });

        const handle = await service.createRuntime(ACP_SPEC, {
            sessionId: 'happier-session-1',
            cwd: '/workspace',
            clientSpec: CLIENT_SPEC,
            lifecycle: {
                authenticate: {
                    methodId: 'cursor_login',
                },
            },
        });

        await expect(handle.sessionRuntime.startOrLoadSession()).rejects.toMatchObject({
            code: 'PLUGIN_ACP_SESSION_INVALID_RESULT',
        });
        expect(requests.map((request) => request.method)).toEqual(['initialize']);
    });

    it('bridges ACP session/update notifications into runtime events and turn completion', async () => {
        const requests: { method: string; params: unknown }[] = [];
        const client = createJsonRpcClientFixture({
            request: async <TParams = unknown, TResult = unknown>(method: string, params?: TParams): Promise<TResult> => {
                requests.push({ method, params });
                if (method === 'session/new') {
                    return { sessionId: 'provider-session-1' } as TResult;
                }
                return {} as TResult;
            },
        });
        const fixture = createExecFixture({ client });
        const service = createPluginAcpRuntimeService({
            exec: fixture.exec,
        });

        const handle = await service.createRuntime(ACP_SPEC, {
            sessionId: 'happier-session-1',
            cwd: '/workspace',
            clientSpec: CLIENT_SPEC,
        });
        const sessionUpdateHandler = fixture.readSpawnClientSpec().handlers?.jsonRpc?.notifications?.['session/update'];
        expect(sessionUpdateHandler).toEqual(expect.any(Function));
        const events: unknown[] = [];
        const unsubscribe = handle.sessionRuntime.subscribeRuntimeEvents((event) => {
            events.push(event);
        });

        await handle.sessionRuntime.startOrLoadSession();
        handle.sessionRuntime.beginTurnLifecycle();
        const pendingCompletion = handle.sessionRuntime.waitForTurnCompletion();
        await handle.sessionRuntime.sendTurnPrompt('hello provider');
        await sessionUpdateHandler?.({
            sessionId: 'provider-session-1',
            update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                    text: 'hello',
                },
            },
        }, { method: 'session/update' });
        await sessionUpdateHandler?.({
            sessionId: 'provider-session-1',
            update: {
                sessionUpdate: 'task_complete',
            },
        }, { method: 'session/update' });

        await expect(pendingCompletion).resolves.toBeUndefined();
        unsubscribe();
        const runtimeEvents = events.map((event) => RuntimeEventV1Schema.parse(event));
        const turnStart = runtimeEvents.find((event) => event.kind === 'turn-start');
        const messageDelta = runtimeEvents.find((event) => event.kind === 'message-delta');
        const turnComplete = runtimeEvents.find((event) => event.kind === 'turn-complete');
        expect(turnStart).toEqual(expect.objectContaining({
            kind: 'turn-start',
            sessionId: 'happier-session-1',
            turnId: expect.any(String),
            providerTurnId: expect.any(String),
        }));
        expect(messageDelta).toEqual(expect.objectContaining({
            kind: 'message-delta',
            sessionId: 'happier-session-1',
            turnId: turnStart?.turnId,
            delta: {
                text: 'hello',
            },
        }));
        expect(turnComplete).toEqual(expect.objectContaining({
            kind: 'turn-complete',
            sessionId: 'happier-session-1',
            turnId: turnStart?.turnId,
            providerTurnId: turnStart?.providerTurnId,
        }));
        expect(requests).toEqual([
            {
                method: 'session/new',
                params: {
                    cwd: '/workspace',
                },
            },
            {
                method: 'session/prompt',
                params: {
                    sessionId: 'provider-session-1',
                    prompt: 'hello provider',
                },
            },
        ]);
    });

    it('rejects active-session operations before a provider session is started', async () => {
        const requests: { method: string; params: unknown }[] = [];
        const client = createJsonRpcClientFixture({
            request: async <TParams = unknown, TResult = unknown>(method: string, params?: TParams): Promise<TResult> => {
                requests.push({ method, params });
                if (method === 'session/new') {
                    return { sessionId: 'provider-session-1' } as TResult;
                }
                return {} as TResult;
            },
        });
        const fixture = createExecFixture({ client });
        const service = createPluginAcpRuntimeService({
            exec: fixture.exec,
        });

        const handle = await service.createRuntime(ACP_SPEC, {
            sessionId: 'happier-session-1',
            cwd: '/workspace',
            clientSpec: CLIENT_SPEC,
        });

        await expect(handle.sessionRuntime.sendTurnPrompt('hello provider')).rejects.toMatchObject({
            code: 'PLUGIN_ACP_SESSION_NOT_STARTED',
        });
        await expect(handle.sessionRuntime.cancelTurn()).rejects.toMatchObject({
            code: 'PLUGIN_ACP_SESSION_NOT_STARTED',
        });
        await expect(handle.sessionRuntime.updateSessionRuntimeConfig({ modelId: 'composer-2.5' })).rejects.toMatchObject({
            code: 'PLUGIN_ACP_SESSION_NOT_STARTED',
        });
        expect(requests).toEqual([]);
    });

    it('rejects extension request handlers that return non-object results', async () => {
        const fixture = createExecFixture();
        const service = createPluginAcpRuntimeService({
            exec: fixture.exec,
        });
        const invalidExtensions = {
            requests: {
                'fixture/badResult': async () => 'not-an-object',
            },
        } as unknown as AcpRuntimeExtensionsV1; // Boundary fixture: runtime guards malformed plugin JS output.

        await service.createRuntime(ACP_SPEC, {
            sessionId: 'session-1',
            cwd: '/workspace',
            clientSpec: CLIENT_SPEC,
            extensions: invalidExtensions,
        });

        const requestHandler = fixture.readSpawnClientSpec().handlers?.jsonRpc?.requests?.['fixture/badResult'];
        await expect(requestHandler?.({}, { method: 'fixture/badResult' })).rejects.toMatchObject({
            code: 'PLUGIN_ACP_EXTENSION_INVALID_RESULT',
        });
    });

    it('rejects un-namespaced extension methods before spawning the protocol client', async () => {
        const fixture = createExecFixture();
        const service = createPluginAcpRuntimeService({
            exec: fixture.exec,
        });

        await expect(service.createRuntime(ACP_SPEC, {
            sessionId: 'session-1',
            cwd: '/workspace',
            clientSpec: CLIENT_SPEC,
            extensions: {
                requests: {
                    initialize: async () => ({}),
                },
            },
        })).rejects.toBeInstanceOf(PluginAcpRuntimeError);
        expect(fixture.spawnClientCalls).toEqual([]);
    });

    it('rejects extension methods that conflict with shared ACP handlers before spawning the protocol client', async () => {
        const fixture = createExecFixture();
        const service = createPluginAcpRuntimeService({
            exec: fixture.exec,
        });

        await expect(service.createRuntime(ACP_SPEC, {
            sessionId: 'session-1',
            cwd: '/workspace',
            clientSpec: CLIENT_SPEC,
            extensions: {
                notifications: {
                    'session/update': async () => undefined,
                },
            },
        })).rejects.toMatchObject({
            code: 'PLUGIN_ACP_EXTENSION_METHOD_CONFLICT',
        });
        expect(fixture.spawnClientCalls).toEqual([]);
    });

    it('aborts in-flight extension requests for the active turn when cancel is requested', async () => {
        const requests: { method: string; params: unknown }[] = [];
        const client = createJsonRpcClientFixture({
            request: async <TParams = unknown, TResult = unknown>(method: string, params?: TParams): Promise<TResult> => {
                requests.push({ method, params });
                if (method === 'session/new') {
                    return { sessionId: 'provider-session-1' } as TResult;
                }
                return {} as TResult;
            },
        });
        const fixture = createExecFixture({ client });
        const service = createPluginAcpRuntimeService({
            exec: fixture.exec,
        });
        const observed: { signal: AbortSignal | null } = { signal: null };
        let release!: () => void;
        const handlerFinished = new Promise<void>((resolve) => {
            release = resolve;
        });

        const handle = await service.createRuntime(ACP_SPEC, {
            sessionId: 'session-1',
            cwd: '/workspace',
            clientSpec: CLIENT_SPEC,
            extensions: {
                requests: {
                    'fixture/wait': async (_params, context) => {
                        observed.signal = context.signal;
                        await handlerFinished;
                        return { ok: true };
                    },
                },
            },
        });
        await handle.sessionRuntime.startOrLoadSession();
        handle.sessionRuntime.beginTurnLifecycle();
        const requestHandler = fixture.readSpawnClientSpec().handlers?.jsonRpc?.requests?.['fixture/wait'];
        expect(requestHandler).toEqual(expect.any(Function));
        if (!requestHandler) {
            throw new Error('Expected fixture/wait extension request handler');
        }
        const pendingOutcome = Promise.resolve(requestHandler({}, { method: 'fixture/wait' })).then(
            (value) => value,
            (error) => error,
        );

        await Promise.resolve();
        await handle.sessionRuntime.cancelTurn();
        const result = await Promise.race([
            pendingOutcome,
            new Promise((resolve) => {
                setTimeout(() => resolve('still-pending'), 50).unref?.();
            }),
        ]);
        release();

        expect(result).toMatchObject({
            code: 'PLUGIN_ACP_TURN_CANCELLED',
        });
        expect(observed.signal?.aborted).toBe(true);
        expect(requests).toEqual([
            {
                method: 'session/new',
                params: {
                    cwd: '/workspace',
                },
            },
            {
                method: 'session/cancel',
                params: {
                    sessionId: 'provider-session-1',
                },
            },
        ]);
        expect(fixture.dispose).not.toHaveBeenCalled();
    });

    it('disposes the spawned client idempotently and rejects in-flight extension requests once', async () => {
        const fixture = createExecFixture();
        const service = createPluginAcpRuntimeService({
            exec: fixture.exec,
        });
        const observed: { signal: AbortSignal | null } = { signal: null };
        let release!: () => void;
        const handlerFinished = new Promise<void>((resolve) => {
            release = resolve;
        });

        const handle = await service.createRuntime(ACP_SPEC, {
            sessionId: 'session-1',
            cwd: '/workspace',
            clientSpec: CLIENT_SPEC,
            extensions: {
                requests: {
                    'fixture/wait': async (_params, context) => {
                        observed.signal = context.signal;
                        await handlerFinished;
                        return { ok: true };
                    },
                },
            },
        });
        const requestHandler = fixture.readSpawnClientSpec().handlers?.jsonRpc?.requests?.['fixture/wait'];
        const pending = requestHandler?.({}, { method: 'fixture/wait' });

        await Promise.resolve();
        await handle.dispose('test-dispose');
        await handle.dispose('test-dispose-again');
        await expect(pending).rejects.toMatchObject({
            code: 'PLUGIN_ACP_RUNTIME_DISPOSED',
        });
        release();

        expect(observed.signal?.aborted).toBe(true);
        expect(fixture.dispose).toHaveBeenCalledTimes(1);
    });
});
