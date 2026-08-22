import { describe, expect, it, vi } from 'vitest';

import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
    ExecService,
    PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type {
    PluginJsonRpcClient,
    PluginProtocolClientHandle,
    PluginProtocolClientSpec,
} from '@happier-dev/plugin-sdk/exec/protocol-clients';

import { createCodexNativeAppServerClient } from './client';
import { createCodexAppServerRealtimeConversation } from './realtime';

function processResult(stdout: string, options?: Readonly<{
    exitCode?: number;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
    requestedBy?: PluginProcessResult['termination']['requestedBy'];
}>): PluginProcessResult {
    return {
        termination: {
            observed: { kind: 'exit', exitCode: options?.exitCode ?? 0 },
            requestedBy: options?.requestedBy ?? { kind: 'none' },
        },
        stdout: new TextEncoder().encode(stdout),
        stderr: new Uint8Array(),
        stdoutTruncated: options?.stdoutTruncated ?? false,
        stderrTruncated: options?.stderrTruncated ?? false,
    };
}

function createCapturingExec(
    clientOverrides: Partial<PluginJsonRpcClient> = {},
    featureListResult: PluginProcessResult | Error = processResult(
        'realtime_conversation                under development  false\n',
    ),
    versionResult: PluginProcessResult | Error = processResult('codex-cli 0.145.0\n'),
): Readonly<{
    exec: ExecService;
    specs: PluginProtocolClientSpec[];
    requests: Array<Readonly<{ method: string; params: unknown; timeoutMs?: number | null }>>;
    notifications: Array<Readonly<{ method: string; params: unknown }>>;
    emitExit(result: PluginProcessResult): void;
}> {
    const specs: PluginProtocolClientSpec[] = [];
    const requests: Array<Readonly<{ method: string; params: unknown; timeoutMs?: number | null }>> = [];
    const notifications: Array<Readonly<{ method: string; params: unknown }>> = [];
    let settleExit: ((result: PluginProcessResult) => void) | null = null;
    const wait = new Promise<PluginProcessResult>((resolve) => {
        settleExit = resolve;
    });
    const client: PluginJsonRpcClient = {
        async request(method, params, options) {
            requests.push({ method, params: params ?? {}, timeoutMs: options?.timeoutMs });
            return { ok: true };
        },
        async notify(method, params) {
            notifications.push({ method, params: params ?? {} });
        },
        onRequest() {
            return { dispose: () => undefined };
        },
        onNotification() {
            return { dispose: () => undefined };
        },
        dispose: async () => undefined,
        ...clientOverrides,
    };
    const handle: PluginProtocolClientHandle<'jsonRpc'> = {
        client,
        process: {
            pid: 123,
            write: async () => undefined,
            closeStdin: async () => undefined,
            wait: () => wait,
            onOutput: () => ({ dispose: () => undefined }),
            dispose: async () => undefined,
        },
        wait: () => wait,
        dispose: async () => undefined,
    };
    return {
        specs,
        requests,
        notifications,
        emitExit(result) {
            settleExit?.(result);
        },
        exec: {
            run: vi.fn(async (request: Parameters<ExecService['run']>[0]) => {
                if (request.args.length === 1 && request.args[0] === '--version') {
                    if (versionResult instanceof Error) throw versionResult;
                    return versionResult;
                }
                if (featureListResult instanceof Error) throw featureListResult;
                return featureListResult;
            }),
            systemTools: {
                resolve: vi.fn(async () => ({
                    executable: { kind: 'systemTool', id: 'codex-cli' },
                    executablePath: '/fixture/codex',
                })),
            },
            clients: {
                spawn: async (spec: PluginProtocolClientSpec) => {
                    specs.push(spec);
                    return handle;
                },
            },
        } as unknown as ExecService,
    };
}

describe('createCodexAppServerClient', () => {
    it('resolves the declared Codex system tool before every native app-server launch path', async () => {
        const capture = createCapturingExec();
        const resolvedExecutable = Object.freeze({
            kind: 'systemTool' as const,
            id: 'codex-cli',
        });
        const resolveSystemTool = vi.fn(async () => ({
            executable: resolvedExecutable,
            executablePath: '/fixture/codex',
        }));
        const run = vi.fn(async (request: Parameters<ExecService['run']>[0]) => {
            if (request.executable !== resolvedExecutable) {
                throw new Error('Codex capability probe bypassed the resolved system-tool grant');
            }
            return request.args.length === 1 && request.args[0] === '--version'
                ? processResult('codex-cli 0.145.0\n')
                : processResult('realtime_conversation                under development  false\n');
        });
        const spawn = vi.fn(async (
            spec: Parameters<ExecService['clients']['spawn']>[0],
        ) => {
            if (spec.launch.executable !== resolvedExecutable) {
                throw new Error('Codex app-server launch bypassed the resolved system-tool grant');
            }
            return await capture.exec.clients.spawn(spec);
        });
        const exec = {
            ...capture.exec,
            run,
            clients: { spawn },
            systemTools: { resolve: resolveSystemTool },
        } as unknown as ExecService;

        const client = await createCodexNativeAppServerClient({ exec, processEnv: {} });
        await client.dispose();

        expect(resolveSystemTool).toHaveBeenCalledOnce();
        expect(resolveSystemTool).toHaveBeenCalledWith({
            toolId: 'codex-cli',
            purpose: 'Launch the Codex native app-server',
        });
        expect(run).toHaveBeenCalledTimes(2);
        expect(spawn).toHaveBeenCalledOnce();
    });

    it('launches the native app-server through the stable invocation exec service', async () => {
        const specs: PluginProtocolClientSpec[] = [];
        const requests: Array<Readonly<{ method: string; params?: JsonValue }>> = [];
        const notifications: Array<Readonly<{ method: string; params?: JsonValue }>> = [];
        const client: PluginJsonRpcClient = {
            async request(method, params) {
                requests.push({ method, ...(params === undefined ? {} : { params }) });
                return { ok: true };
            },
            async notify(method, params) {
                notifications.push({ method, ...(params === undefined ? {} : { params }) });
            },
            onRequest: () => ({ dispose: () => undefined }),
            onNotification: () => ({ dispose: () => undefined }),
            dispose: async () => undefined,
        };
        const never = new Promise<Awaited<ReturnType<PluginProtocolClientHandle<'jsonRpc'>['wait']>>>(() => undefined);
        const handle: PluginProtocolClientHandle<'jsonRpc'> = {
            client,
            process: {
                pid: 123,
                write: async () => undefined,
                closeStdin: async () => undefined,
                wait: () => never,
                onOutput: () => ({ dispose: () => undefined }),
                dispose: async () => undefined,
            },
            wait: () => never,
            dispose: async () => undefined,
        };
        const exec = {
            run: vi.fn(async (request: Parameters<ExecService['run']>[0]) => (
                request.args.length === 1 && request.args[0] === '--version'
                    ? processResult('codex-cli 0.145.0\n')
                    : processResult(
                        'realtime_conversation                under development  false\n',
                    )
            )),
            systemTools: {
                resolve: vi.fn(async () => ({
                    executable: { kind: 'systemTool', id: 'codex-cli' },
                    executablePath: '/fixture/codex',
                })),
            },
            clients: {
                spawn: vi.fn(async (spec: PluginProtocolClientSpec) => {
                    specs.push(spec);
                    return handle;
                }),
            },
        } as unknown as ExecService;

        const nativeClient = await createCodexNativeAppServerClient({
            exec,
            cwd: '/worktree',
            processEnv: {
                CODEX_THREAD_ID: 'must-not-leak',
                OPENAI_API_KEY: 'native-key',
            },
            configOverrides: ['model="gpt-5.4"'],
        });
        await nativeClient.dispose();

        expect(specs).toEqual([{
            kind: 'jsonRpc',
            launch: {
                executable: { kind: 'systemTool', id: 'codex-cli' },
                args: [
                    'app-server',
                    '--listen',
                    'stdio://',
                    '--enable',
                    'realtime_conversation',
                    '-c',
                    'model="gpt-5.4"',
                ],
                cwd: { root: 'workspace', relativePath: '' },
                env: { OPENAI_API_KEY: 'native-key' },
            },
            framing: 'jsonLines',
            maxFrameBytes: 32 * 1024 * 1024,
            requestTimeoutMs: 15_000,
        }]);
        expect(requests[0]).toEqual({
            method: 'initialize',
            params: {
                clientInfo: {
                    name: 'happier_cli',
                    title: 'Happier',
                    version: '0.1.0',
                },
                capabilities: { experimentalApi: true },
            },
        });
        expect(notifications).toEqual([{ method: 'initialized' }]);
    });

    it('preserves the sticky host exit channel on the wrapped client', async () => {
        const capture = createCapturingExec();
        const client = await createCodexNativeAppServerClient({ exec: capture.exec, processEnv: {} });
        const exits: Array<Readonly<{ exitCode: number | null; signal: string | null }>> = [];
        client.onExit((result) => exits.push(result));

        capture.emitExit({
            termination: {
                observed: { kind: 'exit', exitCode: 17 },
                requestedBy: { kind: 'none' },
            },
            stdout: new Uint8Array(),
            stderr: new TextEncoder().encode('crashed'),
            stdoutTruncated: false,
            stderrTruncated: false,
        });

        await vi.waitFor(() => expect(exits).toEqual([{ exitCode: 17, signal: null }]));
    });

    it('builds a strict-LF JSON-RPC spawn-client spec with Codex launch policy and sanitized env', async () => {
        const capture = createCapturingExec();

        const client = await createCodexNativeAppServerClient({
            exec: capture.exec,
            cwd: '/worktree',
            processEnv: {
                HOME: '/home/test',
                HAPPIER_CODEX_APP_SERVER_BIN: '/tmp/fake-codex-app-server.mjs',
                HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH: '~/codex-rpc.jsonl',
                HAPPIER_CODEX_APP_SERVER_RPC_LOG_MAX_BYTES: '1234',
                HAPPIER_CODEX_APP_SERVER_RPC_LOG_ROTATE_COUNT: '3',
                HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '4321',
                CODEX_THREAD_ID: 'parent-thread',
                CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'originator',
                HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: '[{"serviceId":"openai-codex"}]',
                HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON: '["CODEX_HOME"]',
                HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON: '["CODEX_HOME"]',
            },
            configOverrides: ['model="gpt-5.4"'],
        });

        await client.dispose();

        expect(capture.specs).toHaveLength(1);
        expect(capture.specs[0]).toMatchObject({
            kind: 'jsonRpc',
            launch: {
                executable: { kind: 'systemTool', id: 'codex-cli' },
                cwd: { root: 'workspace', relativePath: '' },
                args: [
                    'app-server',
                    '--listen',
                    'stdio://',
                    '--enable',
                    'realtime_conversation',
                    '-c',
                    'model="gpt-5.4"',
                ],
                env: {
                    HAPPIER_CODEX_PATH: '/tmp/fake-codex-app-server.mjs',
                },
            },
            framing: 'jsonLines',
            requestTimeoutMs: 4321,
        });
        const launchEnv = capture.specs[0]?.launch.env ?? {};
        expect(launchEnv).not.toHaveProperty('CODEX_THREAD_ID');
        expect(launchEnv).not.toHaveProperty('CODEX_INTERNAL_ORIGINATOR_OVERRIDE');
        expect(launchEnv).not.toHaveProperty('HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH');
        expect(launchEnv).not.toHaveProperty('HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS');
        expect(launchEnv).not.toHaveProperty('HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON');
        expect(launchEnv).not.toHaveProperty('HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON');
        expect(launchEnv).not.toHaveProperty('HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON');
        expect(capture.requests[0]).toMatchObject({
            method: 'initialize',
            params: {
                clientInfo: {
                    name: 'happier_cli',
                    title: 'Happier',
                    version: '0.1.0',
                },
                capabilities: {
                    experimentalApi: true,
                },
            },
            timeoutMs: 45_000,
        });
        expect(capture.notifications).toContainEqual({ method: 'initialized', params: {} });
    });

    it('disables local request timers only while creating a fork-only app-server client', async () => {
        const capture = createCapturingExec();

        const client = await createCodexNativeAppServerClient({
            exec: capture.exec,
            processEnv: {},
            forkOnly: true,
        });
        await client.dispose();

        expect(capture.requests).toContainEqual(expect.objectContaining({
            method: 'initialize',
            timeoutMs: null,
        }));
    });

    it.each([
        '0.145.0',
        '0.146.0',
    ] as const)('validates Codex %s and realtime capability on the same resolved system tool', async (
        codexCliVersion,
    ) => {
        const capture = createCapturingExec(
            {},
            processResult('realtime_conversation                under development  false\n'),
            processResult(`codex-cli ${codexCliVersion}\n`),
        );

        const client = await createCodexNativeAppServerClient({
            exec: capture.exec,
            cwd: '/worktree',
            processEnv: {},
        });
        await client.dispose();

        expect(capture.exec.run).toHaveBeenCalledWith({
            executable: { kind: 'systemTool', id: 'codex-cli' },
            args: ['--version'],
            cwd: { root: 'workspace', relativePath: '' },
            env: {},
            timeoutMs: 15_000,
        });
        expect(capture.exec.run).toHaveBeenCalledWith({
            executable: { kind: 'systemTool', id: 'codex-cli' },
            args: ['features', 'list'],
            cwd: { root: 'workspace', relativePath: '' },
            env: {},
            timeoutMs: 15_000,
        });
        expect(capture.exec.run).toHaveBeenCalledTimes(2);
        expect(capture.specs[0]?.launch.args).toEqual([
            'app-server',
            '--listen',
            'stdio://',
            '--enable',
            'realtime_conversation',
        ]);
        expect(client.launchFeatures).toEqual({
            realtimeConversationAdvertised: true,
            codexCliVersion,
            realtimeConversationVersionSupported: true,
        });
    });

    it('makes exact Codex 0.146.0 realtime available through the loaded client', async () => {
        const capture = createCapturingExec(
            {
                request: vi.fn(async (method) => method === 'experimentalFeature/list'
                    ? {
                        data: [{ name: 'realtime_conversation', enabled: true }],
                        nextCursor: null,
                    }
                    : {}),
            },
            processResult('realtime_conversation                under development  false\n'),
            processResult('codex-cli 0.146.0\n'),
        );
        const client = await createCodexNativeAppServerClient({
            exec: capture.exec,
            processEnv: {},
        });
        const conversation = createCodexAppServerRealtimeConversation({
            getClient: async () => client,
            getThreadId: () => 'thread-1',
            isDisposed: () => false,
        });

        await expect(conversation.inspect()).resolves.toEqual({
            status: 'available',
            transport: 'webrtc',
        });
        expect(capture.specs[0]?.launch.args).toEqual([
            'app-server',
            '--listen',
            'stdio://',
            '--enable',
            'realtime_conversation',
        ]);
        await client.dispose();
    });

    it.each([
        ['older supported-provider line', 'codex-cli 0.144.9\n', '0.144.9'],
        ['unvalidated patch release', 'codex-cli 0.145.1\n', '0.145.1'],
        ['unvalidated newer patch', 'codex-cli 0.146.1\n', '0.146.1'],
        ['newer release line', 'codex-cli 0.147.0\n', '0.147.0'],
        ['prerelease', 'codex-cli 0.145.0-alpha.1\n', null],
        [
            'extraneous prerelease output',
            'notice: prior stable 0.145.0\ncodex-cli 0.145.0-alpha.1\n',
            null,
        ],
    ] as const)('keeps ordinary app-server available without enabling realtime on %s', async (
        _label,
        versionOutput,
        expectedParsedVersion,
    ) => {
        const capture = createCapturingExec(
            {},
            processResult('realtime_conversation                under development  false\n'),
            processResult(versionOutput),
        );

        const client = await createCodexNativeAppServerClient({
            exec: capture.exec,
            processEnv: {},
        });
        await client.dispose();

        expect(capture.exec.run).toHaveBeenCalledTimes(2);
        expect(capture.specs[0]?.launch.args).toEqual([
            'app-server',
            '--listen',
            'stdio://',
        ]);
        expect(client.launchFeatures).toEqual({
            realtimeConversationAdvertised: true,
            codexCliVersion: expectedParsedVersion,
            realtimeConversationVersionSupported: false,
        });
    });

    it.each([
        ['malformed output', processResult('codex-cli unknown\n')],
        ['nonzero exit', processResult('codex-cli 0.145.0\n', { exitCode: 2 })],
        ['truncated stdout', processResult('codex-cli 0.145.0\n', { stdoutTruncated: true })],
        ['truncated stderr', processResult('codex-cli 0.145.0\n', { stderrTruncated: true })],
        ['timed-out process', processResult('codex-cli 0.145.0\n', {
            requestedBy: { kind: 'timeout' },
        })],
        ['thrown version probe', new Error('version probe failed: sk-private-version-probe')],
    ])('keeps ordinary app-server available but fails realtime version support closed for %s', async (
        _label,
        versionResult,
    ) => {
        const capture = createCapturingExec(
            {},
            processResult('realtime_conversation                under development  false\n'),
            versionResult,
        );

        const client = await createCodexNativeAppServerClient({
            exec: capture.exec,
            processEnv: {},
        });
        await client.dispose();

        expect(capture.exec.run).toHaveBeenCalledTimes(2);
        expect(capture.specs[0]?.launch.args).toEqual([
            'app-server',
            '--listen',
            'stdio://',
        ]);
        expect(client.launchFeatures).toEqual({
            realtimeConversationAdvertised: true,
            codexCliVersion: null,
            realtimeConversationVersionSupported: false,
        });
    });

    it.each([
        ['missing feature', processResult('apps stable true\n')],
        ['failed feature probe', processResult('', { exitCode: 2 })],
        ['truncated feature probe', processResult(
            'realtime_conversation under development false\n',
            { stdoutTruncated: true },
        )],
        ['stderr-truncated feature probe', processResult(
            'realtime_conversation under development false\n',
            { stderrTruncated: true },
        )],
        ['timed-out feature probe', processResult(
            'realtime_conversation under development false\n',
            { requestedBy: { kind: 'timeout' } },
        )],
        ['thrown feature probe', new Error('feature probe failed: sk-private-feature-probe')],
    ])('does not enable realtime when the exact executable probe is unusable: %s', async (
        _label,
        featureListResult,
    ) => {
        const capture = createCapturingExec({}, featureListResult);

        const client = await createCodexNativeAppServerClient({
            exec: capture.exec,
            processEnv: {},
        });
        await client.dispose();

        expect(capture.exec.run).toHaveBeenCalledTimes(2);
        expect(capture.specs[0]?.launch.args).toEqual([
            'app-server',
            '--listen',
            'stdio://',
        ]);
        expect(client.launchFeatures).toEqual({
            realtimeConversationAdvertised: false,
            codexCliVersion: '0.145.0',
            realtimeConversationVersionSupported: true,
        });
    });

    it('classifies a rejected realtime-enabled launch without retrying or leaking the provider error', async () => {
        const capture = createCapturingExec();
        const spawn = vi.spyOn(capture.exec.clients, 'spawn')
            .mockRejectedValueOnce(new Error('unsupported --enable value: sk-private-launch'));

        await expect(createCodexNativeAppServerClient({
            exec: capture.exec,
            processEnv: {},
        })).rejects.toMatchObject({
            code: 'CODEX_REALTIME_ENABLED_LAUNCH_UNAVAILABLE',
            message: 'The realtime-enabled Codex app-server launch was unavailable.',
        });
        await expect(createCodexNativeAppServerClient({
            exec: {
                ...capture.exec,
                clients: {
                    spawn: vi.fn().mockRejectedValueOnce(
                        new Error('unsupported --enable value: sk-private-launch'),
                    ),
                },
            },
            processEnv: {},
        })).rejects.not.toThrow('sk-private-launch');

        expect(spawn).toHaveBeenCalledOnce();
        expect(spawn.mock.calls[0]?.[0].launch.args).toEqual([
            'app-server',
            '--listen',
            'stdio://',
            '--enable',
            'realtime_conversation',
        ]);
    });

    it('classifies realtime-enabled launch failure observed during initialization', async () => {
        const capture = createCapturingExec({
            request: vi.fn(async (method) => {
                if (method === 'initialize') {
                    throw new Error('protocol closed after rejected flag: sk-private-initialize');
                }
                return { ok: true };
            }),
        });

        await expect(createCodexNativeAppServerClient({
            exec: capture.exec,
            processEnv: {},
        })).rejects.toMatchObject({
            code: 'CODEX_REALTIME_ENABLED_LAUNCH_UNAVAILABLE',
            message: 'The realtime-enabled Codex app-server launch was unavailable.',
        });
        await expect(createCodexNativeAppServerClient({
            exec: capture.exec,
            processEnv: {},
        })).rejects.not.toThrow('sk-private-initialize');
    });

    it('does not classify ordinary or aborted app-server launch failures as realtime enablement failures', async () => {
        const ordinaryCapture = createCapturingExec(
            {},
            processResult('realtime_conversation                under development  false\n'),
            processResult('codex-cli 0.146.1\n'),
        );
        vi.spyOn(ordinaryCapture.exec.clients, 'spawn')
            .mockRejectedValueOnce(new Error('ordinary app-server launch failed'));

        await expect(createCodexNativeAppServerClient({
            exec: ordinaryCapture.exec,
            processEnv: {},
        })).rejects.toThrow('ordinary app-server launch failed');

        const abortController = new AbortController();
        const abortedCapture = createCapturingExec();
        vi.spyOn(abortedCapture.exec.clients, 'spawn').mockImplementationOnce(async () => {
            abortController.abort();
            throw new Error('realtime launch aborted');
        });

        await expect(createCodexNativeAppServerClient({
            exec: abortedCapture.exec,
            processEnv: {},
            signal: abortController.signal,
        })).rejects.toThrow('realtime launch aborted');
    });

    it('preserves Codex default params and handler null-result quirks over generic JSON-RPC', async () => {
        let registeredRequest: ((params: unknown) => Promise<unknown> | unknown) | null = null;
        let registeredNotification: ((params: unknown) => Promise<void> | void) | null = null;
        const capture = createCapturingExec({
            onRequest(method, handler) {
                registeredRequest = (params) => handler({
                    id: 1,
                    method,
                    params: params as JsonValue,
                });
                return { dispose: () => {
                    registeredRequest = null;
                } };
            },
            onNotification(handler) {
                registeredNotification = (params) => handler({
                    method: 'turn/started',
                    params: params as JsonValue,
                });
                return { dispose: () => {
                    registeredNotification = null;
                } };
            },
        });
        const client = await createCodexNativeAppServerClient({
            exec: capture.exec,
            processEnv: {
                HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '250',
                HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '5000',
            },
        });

        const unregisterRequest = client.registerRequestHandler('server/compute', () => undefined);
        const notificationCalls: unknown[] = [];
        const unregisterNotification = client.registerNotificationHandler('turn/started', (params) => {
            notificationCalls.push(params);
        });

        await expect(client.request('thread/start')).resolves.toEqual({ ok: true });
        await client.notify('client/trigger');
        await expect(registeredRequest?.({ suffix: 'one' })).resolves.toBeNull();
        await registeredNotification?.({ suffix: 'two' });
        unregisterRequest();
        unregisterNotification();
        await client.dispose();

        expect(capture.requests.at(-1)).toEqual({
            method: 'thread/start',
            params: {},
            timeoutMs: 5000,
        });
        expect(capture.notifications.at(-1)).toEqual({
            method: 'client/trigger',
            params: {},
        });
        expect(notificationCalls).toEqual([{ suffix: 'two' }]);
        expect(registeredRequest).toBeNull();
        expect(registeredNotification).toBeNull();
    });

    it('passes request-specific timeout overrides through to the JSON-RPC client', async () => {
        const capture = createCapturingExec();
        const client = await createCodexNativeAppServerClient({
            exec: capture.exec,
            processEnv: {
                HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '250',
            },
        });

        await expect(client.request('slow/request', undefined, { timeoutMs: 1200 })).resolves.toEqual({ ok: true });
        await client.dispose();

        expect(capture.requests.at(-1)).toEqual({
            method: 'slow/request',
            params: {},
            timeoutMs: 1200,
        });
    });

    it('passes the realtime-start policy timeout through to the JSON-RPC client', async () => {
        const capture = createCapturingExec();
        const client = await createCodexNativeAppServerClient({
            exec: capture.exec,
            processEnv: {},
        });

        await expect(client.request('thread/realtime/start')).resolves.toEqual({ ok: true });
        await client.dispose();

        expect(capture.requests.at(-1)).toEqual({
            method: 'thread/realtime/start',
            params: {},
            timeoutMs: 45_000,
        });
    });
});
