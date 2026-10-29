import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type {
    ExecService,
    PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type {
    PluginJsonRpcClient,
    PluginJsonRpcConnectionSpec,
    PluginProtocolClientHandle,
    PluginProtocolClientSpec,
} from '@happier-dev/plugin-sdk/exec/protocol-clients';

import { createCodexNativeAppServerClient } from './client';
import { buildCodexAppServerConfigOverrides } from './config/overrides';
import { createCodexAppServerRealtimeConversation } from './realtime';
import { PLUGIN_MANIFEST } from '../../../manifest.js';

type AgentNativeLaunchQualifier = NonNullable<NonNullable<Parameters<ExecService['spawn']>[1]>['nativeLaunch']>;

const osBoundary = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async importOriginal => {
    const os = await importOriginal<typeof import('node:os')>();
    return { ...os, userInfo: () => ({ ...os.userInfo(), homedir: osBoundary.home }) };
});
beforeEach(async () => { osBoundary.home = await mkdtemp(join(tmpdir(), 'codex-client-startup-home-')); });
afterEach(async () => { await rm(osBoundary.home, { recursive: true, force: true }); });

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
): Readonly<{
    exec: ExecService;
    specs: PluginProtocolClientSpec[];
    connections: PluginJsonRpcConnectionSpec[];
    requests: Array<Readonly<{ method: string; params: unknown; timeoutMs?: number | null }>>;
    notifications: Array<Readonly<{ method: string; params: unknown }>>;
    emitExit(result: PluginProcessResult): void;
}> {
    const specs: PluginProtocolClientSpec[] = [];
    const connections: PluginJsonRpcConnectionSpec[] = [];
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
        onNotificationReceived: () => ({ dispose: () => undefined }),
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
        connections,
        requests,
        notifications,
        emitExit(result) {
            settleExit?.(result);
        },
        exec: {
            run: vi.fn(async (request: Parameters<ExecService['run']>[0]) => {
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
                async connectJsonRpc(spec: PluginJsonRpcConnectionSpec) {
                    connections.push(spec);
                    let close!: () => void;
                    const closed = new Promise<void>(resolve => { close = resolve; });
                    return { client, closed, async dispose() { close(); } };
                },
                spawn: async (spec: PluginProtocolClientSpec) => {
                    specs.push(spec);
                    return handle;
                },
            },
        } as unknown as ExecService,
    };
}

describe('createCodexAppServerClient', () => {
    it.skipIf(process.platform !== 'linux')('pins projected SQLite in the real stdio launch and admits both warm clients before either initializes', async () => {
        await mkdir(join(osBoundary.home, '.codex'));
        await writeFile(join(osBoundary.home, '.codex', 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
        const cwd = join(osBoundary.home, 'project');
        await mkdir(join(cwd, '.git'), { recursive: true });
        await writeFile(join(cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        const sqliteHome = join(osBoundary.home, 'shared-sqlite');
        const processEnv = { CODEX_HOME: join(osBoundary.home, 'auth'), CODEX_SQLITE_HOME: sqliteHome };
        await mkdir(sqliteHome);
        const captures = [0, 1, 2].map(() => createCapturingExec());
        for (const capture of captures) {
            vi.spyOn(capture.exec, 'run').mockImplementation(async request => processResult(request.args[0] === '--version'
                ? 'codex-cli 0.162.1\n' : ''));
        }
        await writeFile(join(sqliteHome, 'state_5.sqlite'), 'SQLite format 3\0');
        const first = await createCodexNativeAppServerClient({ exec: captures[0]!.exec, processEnv, cwd });
        await first.dispose();
        let release = () => {};
        const initialized = new Promise<void>(resolve => { release = resolve; });
        const entered: number[] = [];
        for (const [index, capture] of captures.slice(1).entries()) {
            vi.spyOn(capture.exec.clients, 'spawn').mockImplementation(async (spec) => {
                expect(spec.launch.args).toContain(`sqlite_home=${JSON.stringify(sqliteHome)}`);
                const handle = createCapturingExec({ async request(method) {
                    if (method === 'initialize') { entered.push(index); await initialized; }
                    return { ok: true };
                } });
                return await handle.exec.clients.spawn(spec);
            });
        }
        const opening = Promise.allSettled(captures.slice(1).map(capture => createCodexNativeAppServerClient({ exec: capture.exec, processEnv, cwd })));
        try { await vi.waitFor(() => expect(entered).toHaveLength(2)); }
        finally {
            release();
            const results = await opening;
            await Promise.all(results.map(async result => { if (result.status === 'fulfilled') await result.value.dispose(); }));
            expect(results.every(result => result.status === 'fulfilled')).toBe(true);
        }
    });
    it('accepts confinement on the exact runtime selected by the managed install recipe', async () => {
        const recipe = PLUGIN_MANIFEST.contributes.agents[0]?.cli.install.managed;
        expect(recipe).toMatchObject({ kind: 'github_release_binary', releaseTag: 'rust-v0.162.1' });
        const version = recipe && 'releaseTag' in recipe && typeof recipe.releaseTag === 'string'
            ? recipe.releaseTag.replace(/^rust-v/u, '') : '';
        const capture = createCapturingExec({
            async request(method): Promise<JsonValue> {
                if (method === 'initialize') return { userAgent: `happier_cli/${version} (fixture)` };
                return { config: { mcp_servers: {}, features: { code_mode: { excluded_tool_namespaces: ['functions'] } } } };
            },
        }, processResult(JSON.stringify({ models: [{ slug: 'fixture', tool_mode: 'code_mode_only' }] })));
        const client = await createCodexNativeAppServerClient({
            exec: capture.exec, processEnv: {}, toolRestrictionRequired: true,
            configOverrides: buildCodexAppServerConfigOverrides({}, { unlistedTools: 'deny', allowedTools: [] }),
        });
        await client.dispose();
    });
    it('preserves typed host native launch refusals when realtime is advertised', async () => {
        const capture = createCapturingExec({}, processResult('realtime_conversation stable true\n'));
        const refusal = new PluginError({ code: 'native_environment_launch_required', message: 'Native launch was refused' });
        vi.spyOn(capture.exec.clients, 'spawn').mockRejectedValueOnce(refusal);
        await expect(createCodexNativeAppServerClient({ exec: capture.exec, processEnv: {} })).rejects.toBe(refusal);
    });
    it.each([undefined, { kind: 'daemonProxy' as const }])('qualifies only a cold stdio launch, preserving nonactivating probes and proxy attachment (%j)', async (transport) => {
        const capture = createCapturingExec();
        const spawn = vi.spyOn(capture.exec.clients, 'spawn');
        // Opaque host-issued value represented only at the genuine Exec boundary.
        const nativeLaunch = Object.freeze({}) as AgentNativeLaunchQualifier;
        const controller = new AbortController();
        const client = await createCodexNativeAppServerClient({
            exec: capture.exec, processEnv: {}, nativeLaunch, signal: controller.signal,
            ...(transport ? { transport } : {}),
        });
        expect(spawn.mock.calls[0]?.[1]).toEqual({
            signal: controller.signal,
            ...(transport ? {} : { nativeLaunch }),
        });
        for (const call of vi.mocked(capture.exec.run).mock.calls) {
            expect(call[1]).toEqual({ signal: controller.signal });
        }
        await client.dispose();
    });
    it('refuses enabled native MCP entries from the selected session cwd outside the injected subset', async () => {
        const capture = createCapturingExec({
            async request(method, params): Promise<JsonValue> {
                if (method === 'initialize') return { userAgent: 'happier_cli/0.162.1 (fixture)' };
                const selectedCwd = params !== null && typeof params === 'object' && !Array.isArray(params)
                    && 'cwd' in params && params.cwd === '/workspace';
                return { config: { mcp_servers: selectedCwd ? { projectOnly: { enabled: true } } : {}, features: { code_mode: { excluded_tool_namespaces: ['functions'] } } } };
            },
        }, processResult(JSON.stringify({ models: [{ slug: 'fixture', tool_mode: 'code_mode_only' }] })));
        await expect(createCodexNativeAppServerClient({
            exec: capture.exec, cwd: '/workspace', processEnv: {}, toolRestrictionRequired: true,
            toolRestrictionAllowedMcpServerKeys: [],
        })).rejects.toMatchObject({ code: 'codex_tool_restriction_unsupported_runtime' });
    });
    it.each(['0.159.2', '0.163.0'])('refuses empty-deny confinement on unverified runtime %s instead of trusting echoed config', async (version) => {
        const capture = createCapturingExec({
            async request(method): Promise<JsonValue> {
                if (method === 'initialize') return { userAgent: `happier_cli/${version} (fixture)` };
                return { config: { features: { code_mode: { excluded_tool_namespaces: ['functions'] } } } };
            },
        });
        await expect(createCodexNativeAppServerClient({
            exec: capture.exec, processEnv: {},
            toolRestrictionRequired: true,
            configOverrides: buildCodexAppServerConfigOverrides({}, { unlistedTools: 'deny', allowedTools: [] }),
        })).rejects.toMatchObject({
            code: 'codex_tool_restriction_unsupported_runtime',
            message: expect.stringContaining('machines.agents.install'),
        });
    });
    it('serializes the native spawn through initialization without locking ongoing clients', async () => {
        // Exec is the host-owned process/protocol boundary. Simulate the native
        // SQLite startup exclusion there, retaining the plugin's real admission.
        let nativeInitializing = false;
        let releaseInitialization: () => void = () => undefined;
        const initializationReady = new Promise<void>(resolve => { releaseInitialization = resolve; });
        const captures = [0, 1].map(() => createCapturingExec({
            async request(method) {
                if (method === 'initialize') {
                    await initializationReady;
                    nativeInitializing = false;
                }
                return { ok: true };
            },
        }));
        for (const capture of captures) {
            const spawn = capture.exec.clients.spawn.bind(capture.exec.clients);
            vi.spyOn(capture.exec.clients, 'spawn').mockImplementation(async (spec, options) => {
                if (nativeInitializing) throw new Error('native_sqlite_startup_conflict');
                nativeInitializing = true;
                return await spawn(spec, options);
            });
        }
        const clients: Awaited<ReturnType<typeof createCodexNativeAppServerClient>>[] = [];
        const debug = vi.fn();
        const opening = Promise.allSettled(captures.map(async capture => {
            const client = await createCodexNativeAppServerClient({ exec: capture.exec, processEnv: {}, logger: { debug } });
            clients.push(client);
            return await client.request('test/ping');
        }));
        try {
            await vi.waitFor(() => expect(debug).toHaveBeenCalledTimes(1));
            releaseInitialization();
            const outcomes = await opening;
            expect(outcomes).toEqual([
                { status: 'fulfilled', value: { ok: true } },
                { status: 'fulfilled', value: { ok: true } },
            ]);
            expect(debug).toHaveBeenCalledTimes(1);
            // Admission can observe an occupied path before its owner record
            // is readable. The canonical reporter preserves that as null.
            const observation = debug.mock.calls[0]?.[1];
            expect(debug).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
                waitedForMs: expect.any(Number),
            }));
            expect(observation).toEqual(expect.objectContaining(observation?.pid === null
                ? { pid: null, heldForMs: null }
                : { pid: process.pid, heldForMs: expect.any(Number) }));
        } finally {
            releaseInitialization();
            await opening;
            await Promise.all(clients.map(client => client.dispose()));
        }
    });

    it('attaches to the native daemon through managed WebSocket framing without probing or starting an app-server', async () => {
        const capture = createCapturingExec();
        const client = await createCodexNativeAppServerClient({ exec: capture.exec, processEnv: {}, transport: { kind: 'daemonProxy' } });
        try {
            expect(capture.specs).toHaveLength(1);
            expect(capture.specs[0]).toMatchObject({ kind: 'jsonRpc', framing: 'webSocket', launch: { args: ['app-server', 'proxy'] } });
            expect(capture.exec.run).not.toHaveBeenCalled();
            expect(capture.requests[0]).toMatchObject({ method: 'initialize' });
        } finally { await client.dispose(); }
    });

    it('connects an explicit native socket through the managed host without another native server launch', async () => {
        const capture = createCapturingExec({ async request(method) {
            return method === 'thread/read' ? { thread: { id: 'native-thread', name: 'λ😀 Native title' } } : {};
        } });
        const controller = new AbortController();
        const connectJsonRpc = vi.fn(capture.exec.clients.connectJsonRpc);
        const client = await createCodexNativeAppServerClient({ exec: { ...capture.exec, clients: { ...capture.exec.clients, connectJsonRpc } },
            processEnv: { CODEX_HOME: '/fixture/native-home' }, signal: controller.signal,
            nativeLaunch: Object.freeze({}) as AgentNativeLaunchQualifier,
            configOverrides: ['server.setting="retained-by-server"'], disableUserMcpServers: true,
            transport: { kind: 'unixWebSocket', socketPath: '/fixture/exact-native.sock', realtimeConversationAdvertised: true },
        });
        try {
            await expect(client.request('thread/read', { threadId: 'native-thread', includeTurns: false }))
                .resolves.toEqual({ thread: { id: 'native-thread', name: 'λ😀 Native title' } });
            expect(capture.connections.map(connection => connection.endpoint)).toEqual([
                { kind: 'unixWebSocket', socketPath: '/fixture/exact-native.sock' },
            ]);
            expect(capture.specs).toEqual([]);
            expect(connectJsonRpc).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal });
            expect(capture.exec.run).not.toHaveBeenCalled();
            expect(client.launchFeatures.realtimeConversationAdvertised).toBe(true);
        } finally { await client.dispose(); }
    });

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
            return processResult('realtime_conversation                under development  false\n');
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
            onNotificationReceived: () => ({ dispose: () => undefined }),
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
            run: vi.fn(async (_request: Parameters<ExecService['run']>[0]) => (
                processResult('realtime_conversation                under development  false\n')
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
            maxFrameBytes: 128 * 1024 * 1024,
            requestTimeoutMs: 60_000,
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
            timeoutMs: 60_000,
        });
        expect(capture.notifications).toContainEqual({ method: 'initialized', params: {} });
    });

    it('keeps the shared startup timeout when initialization is operation-cancellable', async () => {
        const capture = createCapturingExec();
        const controller = new AbortController();

        const client = await createCodexNativeAppServerClient({
            exec: capture.exec,
            processEnv: {},
            signal: controller.signal,
        });
        await client.dispose();

        expect(capture.requests).toContainEqual(expect.objectContaining({
            method: 'initialize',
            timeoutMs: 60_000,
        }));
    });

    it('allows an operation owner to disable only the initialization timeout while retaining cancellation', async () => {
        const request = vi.fn(async () => ({ ok: true }));
        const capture = createCapturingExec({ request });
        const controller = new AbortController();

        const client = await createCodexNativeAppServerClient({
            exec: capture.exec,
            processEnv: {},
            signal: controller.signal,
            initializeRequestOptions: {
                signal: controller.signal,
                timeoutMs: null,
            },
        });
        await client.dispose();

        expect(request).toHaveBeenCalledWith(
            'initialize',
            expect.objectContaining({ capabilities: { experimentalApi: true } }),
            { signal: controller.signal, timeoutMs: null },
        );
    });

    it('forwards a caller AbortSignal to the native protocol client request', async () => {
        const request = vi.fn(async () => ({ ok: true }));
        const capture = createCapturingExec({ request });
        const client = await createCodexNativeAppServerClient({
            exec: capture.exec,
            processEnv: {},
        });
        const controller = new AbortController();

        await client.request(
            'thread/fork',
            { threadId: 'parent-thread', persistExtendedHistory: true },
            { timeoutMs: null, signal: controller.signal },
        );
        await client.dispose();

        expect(request).toHaveBeenLastCalledWith(
            'thread/fork',
            { threadId: 'parent-thread', persistExtendedHistory: true },
            { timeoutMs: null, signal: controller.signal },
        );
    });

    it('disables the wrapped protocol deadline for every thread/resume request', async () => {
        const capture = createCapturingExec();
        const client = await createCodexNativeAppServerClient({
            exec: capture.exec,
            processEnv: {
                HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '250',
                HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '250',
            },
        });

        await client.request('thread/resume', { threadId: 'thread-slow' });
        await client.dispose();

        expect(capture.requests).toContainEqual(expect.objectContaining({
            method: 'thread/resume',
            timeoutMs: null,
        }));
    });

    it('enables an advertised realtime feature independently of startup version probing', async () => {
        const capture = createCapturingExec(
            {},
            processResult('realtime_conversation                under development  false\n'),
        );

        const client = await createCodexNativeAppServerClient({
            exec: capture.exec,
            cwd: '/worktree',
            processEnv: {},
        });
        await client.dispose();

        expect(capture.exec.run).toHaveBeenCalledWith({
            executable: { kind: 'systemTool', id: 'codex-cli' },
            args: ['features', 'list'],
            cwd: { root: 'workspace', relativePath: '' },
            env: {},
            timeoutMs: 60_000,
        });
        expect(capture.specs[0]?.launch.args).toEqual([
            'app-server',
            '--listen',
            'stdio://',
            '--enable',
            'realtime_conversation',
        ]);
        expect(client.launchFeatures).toEqual({
            realtimeConversationAdvertised: true,
        });
    });

    it('makes a feature-enabled Codex runtime available through the loaded client', async () => {
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
    ])('does not enable realtime when the feature probe is unusable: %s', async (
        _label,
        featureListResult,
    ) => {
        const capture = createCapturingExec({}, featureListResult);

        const client = await createCodexNativeAppServerClient({
            exec: capture.exec,
            processEnv: {},
        });
        await client.dispose();

        expect(capture.specs[0]?.launch.args).toEqual([
            'app-server',
            '--listen',
            'stdio://',
        ]);
        expect(client.launchFeatures).toEqual({
            realtimeConversationAdvertised: false,
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
        const ordinaryCapture = createCapturingExec({}, processResult('apps stable true\n'));
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
            timeoutMs: null,
        });
        expect(capture.notifications.at(-1)).toEqual({
            method: 'client/trigger',
            params: {},
        });
        expect(notificationCalls).toEqual([{ suffix: 'two' }]);
        expect(registeredRequest).toBeNull();
        expect(registeredNotification).toBeNull();
    });

    it('forwards native receipt time independently of ordered notification processing', async () => {
        const transport: {
            receive?: Parameters<PluginJsonRpcClient['onNotification']>[0];
            received?: Parameters<PluginJsonRpcClient['onNotificationReceived']>[0];
        } = {};
        const capture = createCapturingExec({
            onNotification(handler) { transport.receive = handler; return { dispose() {} }; },
            onNotificationReceived(handler) { transport.received = handler; return { dispose() { delete transport.received; } }; },
        });
        const client = await createCodexNativeAppServerClient({ exec: capture.exec, processEnv: {} });
        const receipts: Array<{ method: string; receivedAtMs: number }> = [];
        expect(transport.received).toBeUndefined();
        const unsubscribe = client.onNativeEvent((method, _params, receivedAtMs) => receipts.push({ method, receivedAtMs }));
        let release!: () => void;
        client.registerNotificationHandler('item/completed', () => new Promise<void>(resolve => { release = resolve; }));
        try {
            if (!transport.receive) throw new Error('Missing ordered notification callback');
            const processing = transport.receive({ method: 'item/completed' });
            transport.received?.({ method: 'error', params: { threadId: 'native-thread' }, receivedAtMs: 1234 });
            expect(receipts).toContainEqual({ method: 'error', receivedAtMs: 1234 });
            release();
            await processing;
        } finally {
            release?.();
            unsubscribe();
            expect(transport.received).toBeUndefined();
            await client.dispose();
        }
    });

    it('publishes all synchronous notification handlers before the following notification', async () => {
        const transport: { receive?: Parameters<PluginJsonRpcClient['onNotification']>[0] } = {};
        const capture = createCapturingExec({
            onNotification(handler) {
                transport.receive = handler;
                return { dispose: () => { delete transport.receive; } };
            },
        });
        const client = await createCodexNativeAppServerClient({ exec: capture.exec, processEnv: {} });
        try {
            const output: string[] = [];
            client.registerNotificationHandler('item/completed', () => undefined);
            client.registerNotificationHandler('item/completed', () => { output.push('corrected final'); });
            client.registerNotificationHandler('item/agentMessage/delta', () => { output.push('following delta'); });
            if (!transport.receive) throw new Error('Missing JSON-RPC notification subscription');
            const completed = transport.receive({ method: 'item/completed' });
            const following = transport.receive({ method: 'item/agentMessage/delta' });
            await Promise.all([completed, following]);
            expect(output).toEqual(['corrected final', 'following delta']);
        } finally {
            await client.dispose();
        }
    });

    it('awaits asynchronous notification handlers and propagates their failure', async () => {
        const transport: { receive?: Parameters<PluginJsonRpcClient['onNotification']>[0] } = {};
        const capture = createCapturingExec({
            onNotification(handler) {
                transport.receive = handler;
                return { dispose: () => { delete transport.receive; } };
            },
        });
        const client = await createCodexNativeAppServerClient({ exec: capture.exec, processEnv: {} });
        try {
            let finish: () => void = () => { throw new Error('Handler has not started'); };
            const output: string[] = [];
            client.registerNotificationHandler('item/completed', () => new Promise<void>((resolve) => {
                finish = () => { output.push('async completed'); resolve(); };
            }));
            client.registerNotificationHandler('item/completed', () => { output.push('following handler'); });
            if (!transport.receive) throw new Error('Missing JSON-RPC notification subscription');
            const completed = transport.receive({ method: 'item/completed' });
            expect(output).toEqual([]);
            finish();
            await completed;
            expect(output).toEqual(['async completed', 'following handler']);

            const failure = new Error('Notification failed');
            client.registerNotificationHandler('turn/completed', async () => { throw failure; });
            await expect(transport.receive({ method: 'turn/completed' })).rejects.toBe(failure);
        } finally {
            await client.dispose();
        }
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
            timeoutMs: 60_000,
        });
    });
});
