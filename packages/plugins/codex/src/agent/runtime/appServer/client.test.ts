import { describe, expect, it } from 'vitest';

import type {
    ExecClientHandleV1,
    ExecClientSpecV1,
    ExecRunOptionsV1,
    ExecRuntimeServiceV1,
    JsonRpcClientV1,
} from '@happier-dev/plugin-sdk';

import { createCodexAppServerClient } from './client';

function createCapturingExec(
    clientOverrides: Partial<JsonRpcClientV1> = {},
): Readonly<{
    exec: ExecRuntimeServiceV1;
    specs: ExecClientSpecV1[];
    requests: Array<Readonly<{ method: string; params: unknown; timeoutMs?: number }>>;
    notifications: Array<Readonly<{ method: string; params: unknown }>>;
}> {
    const specs: ExecClientSpecV1[] = [];
    const requests: Array<Readonly<{ method: string; params: unknown; timeoutMs?: number }>> = [];
    const notifications: Array<Readonly<{ method: string; params: unknown }>> = [];
    const client: JsonRpcClientV1 = {
        async request(method, params, options) {
            requests.push({ method, params, timeoutMs: options?.timeoutMs });
            return { ok: true };
        },
        async notify(method, params) {
            notifications.push({ method, params });
        },
        registerRequestHandler() {
            return () => undefined;
        },
        registerNotificationHandler() {
            return () => undefined;
        },
        ...clientOverrides,
    };
    const handle: ExecClientHandleV1<JsonRpcClientV1> = {
        client,
        process: {
            pid: 123,
            exit: Promise.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
            writeStdin: async () => undefined,
            kill: () => undefined,
            dispose: async () => undefined,
        },
        status: 'running',
        onExit: () => () => undefined,
        dispose: async () => undefined,
    };
    return {
        specs,
        requests,
        notifications,
        exec: {
            systemTools: {
                resolve: async () => {
                    throw new Error('system tool resolution is not used by Codex app-server client tests');
                },
            },
            run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
            spawn: async () => handle.process,
            spawnClient: async (spec: ExecClientSpecV1, _options?: ExecRunOptionsV1) => {
                specs.push(spec);
                return handle;
            },
        },
    };
}

describe('createCodexAppServerClient', () => {
    it('builds a strict-LF JSON-RPC spawn-client spec with Codex launch policy and sanitized env', async () => {
        const capture = createCapturingExec();

        const client = await createCodexAppServerClient({
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
            launch: {
                kind: 'agent-cli',
                agentId: 'codex',
                cwd: '/worktree',
                args: [
                    'app-server',
                    '--listen',
                    'stdio://',
                    '-c',
                    'model="gpt-5.4"',
                ],
                env: {
                    HAPPIER_CODEX_PATH: '/tmp/fake-codex-app-server.mjs',
                    HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '4321',
                },
            },
            transport: {
                kind: 'stdio',
                framing: { kind: 'strict-lf-json' },
                encoding: 'utf8',
            },
            protocol: { kind: 'json-rpc-2.0' },
            lifecycle: {
                requestTimeoutMs: 4321,
                diagnostics: {
                    rpcLog: {
                        kind: 'file',
                        path: '/home/test/codex-rpc.jsonl',
                        maxBytes: 1234,
                        rotateCount: 3,
                    },
                },
            },
        });
        const launchEnv = capture.specs[0]?.launch.kind === 'agent-cli' ? capture.specs[0].launch.env : {};
        expect(launchEnv).not.toHaveProperty('CODEX_THREAD_ID');
        expect(launchEnv).not.toHaveProperty('CODEX_INTERNAL_ORIGINATOR_OVERRIDE');
        expect(launchEnv).not.toHaveProperty('HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH');
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
            timeoutMs: 4321,
        });
        expect(capture.notifications).toContainEqual({ method: 'initialized', params: {} });
    });

    it('preserves Codex default params and handler null-result quirks over generic JSON-RPC', async () => {
        let registeredRequest: ((params: unknown) => Promise<unknown> | unknown) | null = null;
        let registeredNotification: ((params: unknown) => Promise<void> | void) | null = null;
        const capture = createCapturingExec({
            registerRequestHandler(_method, handler) {
                registeredRequest = handler;
                return () => {
                    registeredRequest = null;
                };
            },
            registerNotificationHandler(_method, handler) {
                registeredNotification = handler;
                return () => {
                    registeredNotification = null;
                };
            },
        });
        const client = await createCodexAppServerClient({
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
        const client = await createCodexAppServerClient({
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
});
