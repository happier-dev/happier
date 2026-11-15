import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { accountSettingsParse, ActionsSettingsV1Schema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { renderSessionInputContextPromptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import { normalizeInteractionTransientQuestionsV1 } from '@happier-dev/protocol/plugins/interactions/transientV1';
import { SessionFollowUpdateEnvelopeV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowUpdateEnvelopeV1';
import Ajv from 'ajv';
import { z } from 'zod/mini';
import { request } from 'node:http';
import * as childProcess from 'node:child_process';
import { assignInjectedServerKeys, buildCodexAppServerConfigOverrides } from '../../../../packages/plugins/codex/src/agent/runtime/appServer/config/overrides';

const daemonCatalogBoundary = vi.hoisted(() => ({ read: vi.fn() }));
const socketRemovalBoundary = vi.hoisted(() => ({ path: '', failNext: false }));

// Filesystem removal is the system boundary. The real MCP listener, bearer
// retirement and cleanup retry owner remain in this test's path.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
        if (String(args[0]) === socketRemovalBoundary.path && socketRemovalBoundary.failNext) {
            socketRemovalBoundary.failNext = false;
            throw Object.assign(new Error('fixture socket removal unavailable'), { code: 'EACCES' });
        }
        return actual.rm(...args);
    } };
});

// Native child-process calls are the OS boundary. Keep their genuine behavior
// unless this test explicitly supplies synthetic ACL command output.
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, execFile: vi.fn(actual.execFile) };
});

// The daemon control transport is outside the Session process; MCP/HTTP owners
// and catalog admission below it remain real.
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/daemon/controlClient')>(),
    readDaemonPluginCatalog: daemonCatalogBoundary.read,
    // An available daemon with no contributed metadata Action returns unmatched;
    // the real Session Action owner then serves its built-in catalog.
    requestDaemonPluginActionExecution: async () => ({ matched: false }),
}));

import { registerHappierSessionAgentToolRpc, startHappyServer } from '@/mcp/startHappyServer';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { SESSION_MCP_CONTEXT_FILE_ENV } from './runtime/sessionMcpLocalTransport';
import { connectSessionMcpClient, readSessionMcpContextFromEnvironment } from './runtime/sessionMcpLocalClient';
import { McpError, ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { waitForExecutionRun } from '@/session/services/executionRuns';
import { ExecutionRunWaitConditionSchema, waitForExecutionRunTerminal } from '@happier-dev/protocol/execution/runs/waitForTerminal';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { sessionMcpAuthorizationHeaders, sessionMcpTestTransport } from '@/mcp/runtime/sessionMcpClient.testkit';

function sendLocalSessionRequest(socketPath: string, authorization?: string, body = '{', method = 'POST') {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ socketPath, path: '/mcp', method, headers: {
            'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(authorization ? { authorization } : {}),
        } }, response => {
            let responseBody = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { responseBody += chunk; });
            response.on('end', () => resolve({ status: response.statusCode!, body: responseBody }));
        });
        req.on('error', reject);
        req.end(method === 'POST' ? body : undefined);
    });
}

async function settleMcpTest(failures: unknown[], cleanups: readonly Readonly<{
    phase: string; run(): void | Promise<void>;
}>[]): Promise<void> {
    for (const cleanup of cleanups) {
        try { await cleanup.run(); }
        catch (cause) { failures.push(new Error(`MCP test cleanup phase: ${cleanup.phase}`, { cause })); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'MCP test request and cleanup failures');
}

describe('startHappyServer notification stream', () => {
    it.skipIf(process.platform === 'win32')('keeps failed socket retirement retryable until its actual directory is removed', async () => {
        daemonCatalogBoundary.read.mockReset();
        daemonCatalogBoundary.read.mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
        const session = createMutableApiSessionClientFixture({ sessionId: 'socket-cleanup-retry' });
        const server = await startHappyServer(session, { localTransport: { agentUid: process.getuid!() } });
        if (!server.localContext || !('socketPath' in server.localContext)) throw new Error('missing_local_context');
        const context = server.localContext;
        socketRemovalBoundary.path = dirname(context.socketPath);
        socketRemovalBoundary.failNext = true;
        try {
            const initialized = await sendLocalSessionRequest(context.socketPath, `Bearer ${context.bearerToken}`,
                JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
                    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'retirement-client', version: '1' },
                } }));
            expect(initialized.status).toBe(200);
            await expect(server.stop()).rejects.toMatchObject({ code: 'EACCES' });
            expect(server.localContext).toBeUndefined();
            await expect(stat(socketRemovalBoundary.path)).resolves.toBeDefined();
            await expect(sendLocalSessionRequest(context.socketPath, `Bearer ${context.bearerToken}`))
                .rejects.toBeDefined();
            await expect(server.stop()).resolves.toBeUndefined();
            await expect(stat(socketRemovalBoundary.path)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            socketRemovalBoundary.failNext = false;
            await server.stop().catch(() => undefined);
            const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
            await actual.rm(socketRemovalBoundary.path, { recursive: true, force: true });
            socketRemovalBoundary.path = '';
            await session.close();
        }
    });
    it('admits only the bearer holder on the non-isolated (Windows) loopback MCP endpoint', async () => {
        daemonCatalogBoundary.read.mockReset();
        daemonCatalogBoundary.read.mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
        const session = createMutableApiSessionClientFixture({ sessionId: 'non-isolated-windows-path' });
        const server = await startHappyServer(session);
        const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
            protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'intruder', version: '1' } } });
        const post = (headers: Record<string, string>) => fetch(server.url, { method: 'POST', body: initialize,
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } });
        try {
            expect(new URL(server.url).hostname).toBe('127.0.0.1');
            expect([(await post({})).status, (await post({ authorization: 'Bearer wrong' })).status]).toEqual([401, 401]);
            // The context file the Agent can read names the endpoint only; the relay's bearer rides
            // its MCP client config, so a bearer-less client is refused.
            const context = await readSessionMcpContextFromEnvironment({ [SESSION_MCP_CONTEXT_FILE_ENV]: server.contextFilePath });
            if (!server.localContext || !('url' in server.localContext)) throw new Error('missing loopback context');
            expect(context).toEqual({ v: 1, url: server.localContext.url });
            await expect(connectSessionMcpClient(context)).rejects.toMatchObject({ code: 'not_authenticated' });
            const { client, close } = await connectSessionMcpClient(server.localContext);
            try {
                expect((await client.listTools()).tools.map(tool => tool.name)).toContain('action_spec_get');
                expect((await client.listResources()).resources.length).toBeGreaterThan(0);
            } finally { await close(); }
        } finally { await server.stop(); await session.close(); }
        expect(server.localContext).toBeUndefined();
    });

    it.skipIf(process.platform === 'win32')('keeps headerless reinitializing request/response clients working', async () => {
        daemonCatalogBoundary.read.mockReset();
        daemonCatalogBoundary.read.mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
        const session = createMutableApiSessionClientFixture({ sessionId: 'stateless-local' });
        const server = await startHappyServer(session, { localTransport: { agentUid: process.getuid!() } });
        try {
            if (!server.localContext || !('socketPath' in server.localContext)) throw new Error('missing_local_context');
            const context = server.localContext;
            const send = (body: unknown) => sendLocalSessionRequest(context.socketPath, `Bearer ${context.bearerToken}`, JSON.stringify(body));
            for (const id of [1, 2]) {
                const initialized = await send({ jsonrpc: '2.0', id, method: 'initialize', params: {
                    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'headerless-client', version: '1' },
                } });
                expect(initialized.status).toBe(200);
                expect(initialized.body).toContain('protocolVersion');
                const tools = await send({ jsonrpc: '2.0', id: id + 10, method: 'tools/list', params: {} });
                expect(tools.status).toBe(200);
                expect(tools.body).toContain('action_spec_get');
            }
        } finally { await server.stop(); await session.close(); }
    });

    it.skipIf(process.platform === 'win32')('keeps authenticated watch feeds for the MCP notification session, not the subscribe response', async () => {
        daemonCatalogBoundary.read.mockReset();
        daemonCatalogBoundary.read.mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
        const session = createMutableApiSessionClientFixture({ sessionId: 'watch-session', metadata: createTestMetadata(),
            serverBinding: { serverId: 'home', serverUrl: 'http://watch-fixture.invalid' } });
        const listeners = new Set<() => void>();
        let reads = 0;
        let snapshot = ExecutionRunGetResponseSchema.parse({ run: { runId: 'run', callId: 'call', sidechainId: 'call',
            intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
            retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', startedAtMs: 1, status: 'running' } });
        const unused = async () => { throw new Error('watch_must_not_mutate_runs'); };
        // Only daemon RPC/storage and its change feed are substituted. Both
        // native wait owners, Action admission, MCP and Unix HTTP run for real.
        const wait = async (raw: unknown, options?: Parameters<NonNullable<ActionExecutorDeps['executionRunWait']>>[2]) => {
            const request = z.parse(z.object({ runId: z.string(), condition: z.optional(ExecutionRunWaitConditionSchema) }), raw);
            return await waitForExecutionRun({ credentials: { token: 'watch-test-only', encryption: null },
                machineId: 'machine', runId: request.runId, condition: request.condition, timeoutMs: null,
                signal: options?.signal, onSnapshot: options?.onSnapshot,
                invokeWait: async (raw, signal) => {
                    const input = z.parse(z.object({ condition: ExecutionRunWaitConditionSchema, after: z.optional(ExecutionRunGetResponseSchema) }), raw);
                    return await waitForExecutionRunTerminal({ runId: request.runId, condition: input.condition, after: input.after,
                        timeoutMs: null, signal, readRun: async () => { reads++; return { ok: true, data: snapshot }; },
                        waitForTerminal: unused,
                        waitForChange: (_runId, signal) => new Promise<void>((resolve, reject) => {
                            const finish = () => { listeners.delete(change); signal?.removeEventListener('abort', abort); };
                            const change = () => { finish(); resolve(); };
                            const abort = () => { finish(); reject(signal?.reason); };
                            listeners.add(change); signal?.addEventListener('abort', abort, { once: true });
                            if (signal?.aborted) abort();
                        }),
                    });
                },
            });
        };
        const client = Object.assign(session, {
            getWorkDepth: () => 0,
            getActiveTurnPermissionWitness: () => ({ turnId: 'watch-turn', workDepth: 0,
                causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } } as const),
            executionRuns: { start: unused, list: unused, get: unused, send: unused, stop: unused, action: unused, wait },
        });
        const server = await startHappyServer(client, { localTransport: { agentUid: process.getuid!() },
            sessionCredentials: { token: 'watch-test-only', encryption: null }, accountSettings: accountSettingsParse({}) });
        let connection: Awaited<ReturnType<typeof connectSessionMcpClient>> | undefined;
        try {
            if (!server.localContext || !('socketPath' in server.localContext)) throw new Error('missing_local_context');
            connection = await connectSessionMcpClient(server.localContext);
            const notifications: string[] = [];
            connection.client.setNotificationHandler(ResourceUpdatedNotificationSchema, n => { notifications.push(n.params.uri); });
            const input = { target: { kind: 'execution_run', serverId: 'home', machineId: 'machine', sessionId: session.sessionId, runId: 'run' }, condition: { kind: 'needs_attention' } };
            const uri = 'happier://watch/' + Buffer.from(JSON.stringify(input)).toString('base64url');
            expect(reads).toBe(0);
            const subscribe = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'resources/subscribe', params: { uri } });
            expect((await sendLocalSessionRequest(server.localContext.socketPath, undefined, subscribe)).status).toBe(401);
            expect((await sendLocalSessionRequest(server.localContext.socketPath, 'Bearer wrong', subscribe)).status).toBe(401);
            expect(reads).toBe(0);
            await connection.client.readResource({ uri }).catch((error: unknown) => {
                if (error instanceof McpError) throw new Error(`watch baseline refused: ${JSON.stringify(error.data)}`, { cause: error });
                throw error;
            });
            expect(listeners.size).toBe(0);
            const admittedReads = reads;
            for (const target of [
                { ...input.target, serverId: 'other-home' },
                { ...input.target, sessionId: 'other-session' },
            ]) {
                const otherUri = 'happier://watch/' + Buffer.from(JSON.stringify({ ...input, target })).toString('base64url');
                await expect(connection.client.readResource({ uri: otherUri })).rejects.toMatchObject({
                    data: { disposition: 'unsupported_condition' },
                });
            }
            expect(reads).toBe(admittedReads);
            await connection.client.subscribeResource({ uri });
            await expect.poll(() => listeners.size).toBe(1);
            snapshot = { ...snapshot, run: { ...snapshot.run, attention: { kind: 'permission_required', requestIds: ['permission'] } } };
            for (const change of [...listeners]) change();
            await expect.poll(() => notifications).toEqual([uri]);
            const fresh = await connection.client.readResource({ uri });
            expect(fresh.contents[0]).toMatchObject({ text: expect.stringContaining('permission_required') });
            await connection.client.unsubscribeResource({ uri });
            await expect.poll(() => listeners.size).toBe(0);
            const idleReads = reads;
            for (const change of [...listeners]) change();
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(reads).toBe(idleReads);
            expect(notifications).toEqual([uri]);
            await connection.client.subscribeResource({ uri });
            await expect.poll(() => listeners.size).toBe(1);
            await connection.close();
            await expect.poll(() => listeners.size).toBe(0);
        } finally { await connection?.close(); await server.stop(); await session.close(); }
    });

    it.skipIf(process.platform === 'win32')('serves the real SDK over its transient context file without a TCP listener', async () => {
        daemonCatalogBoundary.read.mockReset();
        daemonCatalogBoundary.read.mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
        const session = createMutableApiSessionClientFixture({ sessionId: 'sdk-local-session' });
        const server = await startHappyServer(session, { localTransport: { agentUid: process.getuid!() } });
        let connection: Awaited<ReturnType<typeof connectSessionMcpClient>> | undefined;
        try {
            expect(server.contextFilePath).toEqual(expect.any(String));
            const context = await readSessionMcpContextFromEnvironment({
                [SESSION_MCP_CONTEXT_FILE_ENV]: server.contextFilePath,
            });
            if (!server.localContext || !('socketPath' in server.localContext)) throw new Error('missing socket context');
            // The Agent-visible file names the socket only (the Agent tree is admitted by peer proof);
            // an out-of-tree consumer holding the in-memory bearer connects.
            expect(context).toEqual({ v: 1, socketPath: server.localContext.socketPath });
            expect((await stat(server.contextFilePath!)).mode & 0o777).toBe(0o600);
            connection = await connectSessionMcpClient(server.localContext);
            expect((await connection.client.listTools()).tools.map(tool => tool.name)).toContain('action_spec_get');
            expect((await connection.client.listResources()).resources.length).toBeGreaterThan(0);
        } finally {
            await connection?.close();
            await server.stop();
            await session.close();
        }
        expect(existsSync(server.contextFilePath!)).toBe(false);
        expect(server.localContext).toBeUndefined();
        await expect(readSessionMcpContextFromEnvironment({
            [SESSION_MCP_CONTEXT_FILE_ENV]: server.contextFilePath,
        })).rejects.toMatchObject({ code: 'mcp_socket_access_unavailable' });
    });

    it.skipIf(process.platform !== 'linux')('separates Session bindings and retires old endpoint and bearer on recreation', async () => {
        daemonCatalogBoundary.read.mockReset();
        daemonCatalogBoundary.read.mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
        const sessionA = createMutableApiSessionClientFixture({ sessionId: 'binding-a' });
        const sessionB = createMutableApiSessionClientFixture({ sessionId: 'binding-b' });
        const servers: Awaited<ReturnType<typeof startHappyServer>>[] = [];
        try {
            const open = async (session: typeof sessionA) => {
                const server = await startHappyServer(session, { localTransport: { agentUid: process.getuid!() } });
                servers.push(server);
                expect(server.localContext).toBeDefined();
                if (!server.localContext || !('socketPath' in server.localContext)) throw new Error('Missing Session context');
                return { server, context: server.localContext };
            };
            const a = await open(sessionA);
            const b = await open(sessionB);
            // One host endpoint; each Session is reached only through its own bearer.
            expect(b.context.socketPath).toBe(a.context.socketPath);
            expect(a.context.bearerToken).not.toBe(b.context.bearerToken);
            const catalogReads = daemonCatalogBoundary.read.mock.calls.length;
            for (const method of ['POST', 'GET', 'DELETE']) {
                expect((await sendLocalSessionRequest(a.context.socketPath, 'Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '{', method)).status).toBe(401);
            }
            expect(daemonCatalogBoundary.read.mock.calls).toHaveLength(catalogReads);
            expect((await sendLocalSessionRequest(a.context.socketPath, `Bearer ${a.context.bearerToken}`)).status).toBe(400);
            // A connection the endpoint dispatched to Session A closes when A stops; B stays served.
            const acceptedSocket = createConnection(a.context.socketPath);
            onTestFinished(() => { acceptedSocket.destroy(); });
            await once(acceptedSocket, 'connect');
            const acceptedClosed = once(acceptedSocket, 'close');
            acceptedSocket.write(`POST /mcp HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${a.context.bearerToken}\r\n`
                + 'Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: 1\r\n\r\n{');
            await once(acceptedSocket, 'data');
            await a.server.stop();
            await acceptedClosed;
            expect((await sendLocalSessionRequest(a.context.socketPath, `Bearer ${a.context.bearerToken}`)).status).toBe(401);
            expect((await sendLocalSessionRequest(b.context.socketPath, `Bearer ${b.context.bearerToken}`)).status).toBe(400);
            const replacement = await open(sessionA);
            expect(replacement.context.bearerToken).not.toBe(a.context.bearerToken);
            expect((await sendLocalSessionRequest(replacement.context.socketPath, `Bearer ${a.context.bearerToken}`)).status).toBe(401);
            expect((await sendLocalSessionRequest(replacement.context.socketPath, `Bearer ${replacement.context.bearerToken}`)).status).toBe(400);
        } finally {
            await Promise.all(servers.map(server => server.stop()));
            await sessionA.close();
            await sessionB.close();
        }
    });

    it.skipIf(process.platform !== 'linux')('owns a private Session Unix socket and removes its directory on stop', async () => {
        daemonCatalogBoundary.read.mockReset();
        daemonCatalogBoundary.read.mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
        const session = createMutableApiSessionClientFixture({ sessionId: 'socket-lifetime' });
        const server = await startHappyServer(session, { localTransport: { agentUid: process.getuid!() } });
        try {
            const connection: unknown = Reflect.get(server, 'localContext');
            expect(connection).toMatchObject({ socketPath: expect.any(String) });
            const { socketPath } = z.parse(z.object({ socketPath: z.string() }), connection);
            expect((await stat(socketPath)).isSocket()).toBe(true);
            expect((await stat(dirname(socketPath))).mode & 0o777).toBe(0o700);
            expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
            await server.stop();
            expect(existsSync(dirname(socketPath))).toBe(false);
        } finally {
            await server.stop();
            await session.close();
        }
    });

    it.skipIf(process.platform !== 'linux')('rejects unauthenticated malformed requests and authenticates isolated Unix requests before parsing or catalog work', async () => {
        daemonCatalogBoundary.read.mockReset();
        daemonCatalogBoundary.read.mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
        // Native ACL commands are the OS boundary. The real Unix HTTP socket,
        // request admission, SDK, tool inventory and Action executor remain real.
        const acl = vi.mocked(childProcess.execFile).mockImplementation((...args: unknown[]) => {
            if (args[0] !== 'setfacl') throw new Error('Unexpected native ACL command');
            const callback = args.at(-1);
            if (typeof callback !== 'function') throw new Error('Missing ACL command callback');
            callback(null, '', '');
            return {} as childProcess.ChildProcess;
        });
        const session = createMutableApiSessionClientFixture({ sessionId: 'isolated-session' });
        let server: Awaited<ReturnType<typeof startHappyServer>> | undefined;
        try {
            server = await startHappyServer(session, { localTransport: { agentUid: 12345 } });
            const context = server.localContext;
            expect(context).toBeDefined();
            if (!context || !('socketPath' in context)) throw new Error('Missing isolated Session context');
            const catalogReads = daemonCatalogBoundary.read.mock.calls.length;
            const aclCommands = acl.mock.calls.length;
            for (const method of ['POST', 'GET', 'DELETE']) {
                const missing = await sendLocalSessionRequest(context.socketPath, undefined, '{', method);
                expect(missing.status).toBe(401);
                expect(missing.body).not.toContain('isolated-session');
                expect((await sendLocalSessionRequest(context.socketPath, 'Bearer wrong', '{', method)).status).toBe(401);
            }
            expect(daemonCatalogBoundary.read.mock.calls).toHaveLength(catalogReads);
            expect(acl.mock.calls).toHaveLength(aclCommands);
            expect((await sendLocalSessionRequest(context.socketPath, `Bearer ${context.bearerToken}`)).status).toBe(400);
            await server.stop();
            await expect(sendLocalSessionRequest(context.socketPath, `Bearer ${context.bearerToken}`)).rejects.toThrow();
        } finally {
            await server?.stop();
            acl.mockRestore();
            await session.close();
        }
    });

    it('offers manager answers and pass-up through the actual Codex MCP tool surface', async () => {
        daemonCatalogBoundary.read.mockReset();
        daemonCatalogBoundary.read.mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
        const session = Object.assign(createMutableApiSessionClientFixture({ sessionId: 'manager', metadata: createTestMetadata() }), {
            getWorkDepth: () => 0,
            getActiveTurnPermissionWitness: () => ({ turnId: 'manager-turn', workDepth: 0,
                causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } } as const),
        });
        const server = await startHappyServer(session, {
            sessionCredentials: { token: 'manager-question-fixture', encryption: null }, accountSettings: accountSettingsParse({}),
        });
        const client = new Client({ name: 'codex-manager-surface', version: '1' });
        try {
            const config = buildCodexAppServerConfigOverrides({ happier: { command: 'fixture-mcp-transport', args: [server.url] } });
            expect(config).toContain('mcp_servers.happier.enabled=true');
            const transportArgs: unknown = JSON.parse(config.find(entry => entry.startsWith('mcp_servers.happier.args='))!.split('=').slice(1).join('='));
            const [url] = z.parse(z.array(z.string()), transportArgs);
            await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { ...sessionMcpAuthorizationHeaders(server) } } }));
            const tools = (await client.listTools()).tools;
            // The native default is discoverable-only. Neither a dotted Action id
            // nor its absent dedicated Tool is a callable Codex tool name.
            expect(tools.map(tool => tool.name)).not.toContain('session_user_action_answer');
            const form = normalizeInteractionTransientQuestionsV1({ kind: 'questions', questions: [
                { id: 'sum', type: 'text', prompt: 'What is 17 + 25?', required: true },
            ] });
            const update = SessionFollowUpdateEnvelopeV1Schema.parse({
                v: 1, kind: 'session_follow_update', edge: { sourceSessionId: 'worker', destinationSessionId: 'manager' },
                reason: 'source_changed', deliveryIntent: 'context_only',
                observed: { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 1, turn: null },
                awareness: { v: 1, sessionId: 'worker', lifecycle: 'ready', runtime: 'idle', freshness: 'live',
                    operational: { primary: 'ready', reasons: ['ready'] }, encryption: 'ready', availability: 'complete' },
                recentMessages: [], truncated: false, questionOffers: [{ requestId: 'worker-question',
                    currentHandler: { kind: 'session', sessionId: 'manager' }, questions: form.questions }],
            });
            const prompt = renderSessionInputContextPromptV1({ sessionFollowUpdates: [update], transformedUserText: '' });
            const candidates = prompt.split('\n').flatMap(line => {
                try { const value: unknown = JSON.parse(line); return value && typeof value === 'object' && 'tool' in value ? [value] : []; }
                catch { return []; }
            });
            expect(candidates, 'the offer must name a callable transport with its actual routing arguments').toHaveLength(1);
            const invocation = z.parse(z.strictObject({ tool: z.string(), arguments: z.strictObject({
                actionId: z.literal('session.user_action.answer'), input: z.strictObject({ sessionId: z.string(), requestId: z.string() }),
            }) }), candidates[0]);
            const key = assignInjectedServerKeys(['happier']).get('happier');
            const nativeNames = tools.map(tool => `mcp__${key}__${tool.name}`);
            expect(nativeNames).toContain(`mcp__${key}__${invocation.tool}`);
            const tool = tools.find(tool => tool.name === invocation.tool)!;
            const validate = new Ajv({ strict: false }).compile(tool.inputSchema);
            expect(validate(invocation.arguments)).toBe(true);
            expect(invocation.arguments.input).toEqual({ sessionId: 'worker', requestId: 'worker-question' });
            const discovery = await client.callTool({ name: 'action_spec_get', arguments: { id: invocation.arguments.actionId } });
            expect(discovery).toMatchObject({ isError: false, structuredContent: { actionSpec: { id: invocation.arguments.actionId } } });
            for (const response of [{ answers: [{ question: form.questions[0].id, values: ['42'] }] }, { disposition: 'pass_up' }]) {
                const args = { ...invocation.arguments, input: { ...invocation.arguments.input, ...response } };
                expect(validate(args)).toBe(true);
                expect(getActionSpec(args.actionId).inputSchema.safeParse(args.input).success).toBe(true);
            }
        } finally {
            await client.close();
            await server.stop();
        }
    });

    it('advertises the canonical Discussion reply through Session MCP without bypassing exposure policy', async () => {
        daemonCatalogBoundary.read.mockReset();
        daemonCatalogBoundary.read.mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
        let settings = accountSettingsParse({});
        let features: CliServerFeaturesSnapshot = { status: 'ready', features: FeaturesResponseSchema.parse({
            features: { sessions: { enabled: true, conversations: { enabled: true } },
                sharing: { session: { enabled: true } } }, capabilities: {},
        }) };
        expect(resolveCliFeatureDecision({ featureId: 'sessions.conversations', env: process.env,
            serverSnapshot: features }).state).toBe('enabled');
        const session = Object.assign(createMutableApiSessionClientFixture({ sessionId: 'discussion-reply-mcp-session', metadata: createTestMetadata(), overrides: {
            getServerFeaturesSnapshot: () => features,
        } }), {
            getWorkDepth: () => 0,
            getActiveTurnPermissionWitness: () => ({ turnId: 'discussion-reply-turn', workDepth: 0,
                causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } } as const),
        });
        const server = await startHappyServer(session, {
            sessionCredentials: { token: 'discussion-reply-fixture', encryption: null },
            getAccountSettings: () => settings,
        });
        const client = new Client({ name: 'discussion-receiver', version: '1' });
        const failures: unknown[] = [];
        let phase = 'connect';
        try {
            // Inventory changes are observed across separate HTTP requests.
            // Do not let the global fetch pool's idle socket lifetime decide
            // this catalog test while rebuilding its large tool schemas.
            await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
                requestInit: { headers: { connection: 'close', ...sessionMcpAuthorizationHeaders(server) } },
            }));
            const names = async (nextPhase: string) => {
                phase = nextPhase;
                return (await client.listTools()).tools.map(tool => tool.name);
            };
            expect(await names('default inventory')).toContain('discussion_reply');
            settings = { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
                'discussion.reply': { toolExposureModes: { agent: 'discoverable_only' } },
            } }) };
            expect(await names('discoverable-only inventory')).not.toContain('discussion_reply');
            expect(await names('Action executor inventory')).toContain('action_execute');
            phase = 'discover Action spec';
            const discovered = await client.callTool({ name: 'action_spec_get', arguments: { id: 'discussion.reply' } });
            expect(discovered).toMatchObject({ isError: false, structuredContent: { actionSpec: { id: 'discussion.reply' } } });
            settings = { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
                'discussion.reply': { enabled: false },
            } }) };
            expect(await names('disabled Action inventory')).not.toContain('discussion_reply');
            settings = accountSettingsParse({});
            features = { status: 'ready', features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) };
            expect(await names('disabled feature inventory')).not.toContain('discussion_reply');
        } catch (cause) {
            failures.push(new Error(`MCP Discussion test request phase: ${phase}`, { cause }));
        } finally {
            await settleMcpTest(failures, [
                { phase: 'client close', run: () => client.close() },
                { phase: 'server stop', run: () => server.stop() },
                { phase: 'Session close', run: () => session.close() },
            ]);
        }
    });

    it.each(['turn', 'native runtime'] as const)('keeps MCP discovery available across %s retirement while tool calls keep their cancellation scope', async (retirement) => {
        daemonCatalogBoundary.read.mockReset();
        daemonCatalogBoundary.read.mockImplementation(async (options?: Readonly<{ signal?: AbortSignal }>) => {
            options?.signal?.throwIfAborted();
            return { kind: 'available', plugins: [], tools: [] };
        });
        let lifetime = new AbortController();
        let nativeOpened = false;
        let turn = new AbortController();
        const session = Object.assign(createMutableApiSessionClientFixture({ sessionId: 'reconnecting-mcp-session', metadata: createTestMetadata() }), {
            getRuntimeLifetimeSignal: () => nativeOpened ? lifetime.signal : null,
            getHostTurnAbortSignal: () => turn.signal,
            getWorkDepth: () => 0,
            getActiveTurnPermissionWitness: () => turn.signal.aborted || lifetime.signal.aborted ? null : ({ turnId: 'reconnecting-mcp-turn', workDepth: 0,
                causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const } }),
        });
        const server = await startHappyServer(session, {
            sessionCredentials: { token: 'reconnecting-mcp-fixture', encryption: null }, accountSettings: accountSettingsParse({}),
        });
        nativeOpened = true;
        const original = new Client({ name: 'original-native-session', version: '1' });
        const resumed = new Client({ name: 'resumed-native-session', version: '1' });
        const failures: unknown[] = [];
        let phase = 'original connect';
        try {
            await original.connect(sessionMcpTestTransport(server));
            phase = 'original inventory';
            expect((await original.listTools()).tools.map(tool => tool.name)).toContain('action_execute');
            phase = 'original close';
            await original.close();
            (retirement === 'turn' ? turn : lifetime).abort();

            // Native session resume discovers tools before the next host turn is admitted.
            phase = 'resumed connect';
            await resumed.connect(sessionMcpTestTransport(server));
            phase = 'resumed inventory';
            expect((await resumed.listTools()).tools.map(tool => tool.name)).toContain('action_execute');
            expect(await server.readToolNames()).toContain('action_execute');
            phase = 'cancelled tool call';
            await expect(resumed.callTool({ name: 'action_spec_get', arguments: { id: 'browser.view.open' } })).rejects.toThrow();

            turn = new AbortController();
            lifetime = new AbortController();
            phase = 'replacement tool call';
            const result = await resumed.callTool({ name: 'action_spec_get', arguments: { id: 'browser.view.open' } });
            expect(result).toMatchObject({ isError: false, structuredContent: { actionSpec: { id: 'browser.view.open' } } });
            phase = 'resumed close';
            await resumed.close();
            phase = 'server stop';
            await server.stop();
            phase = 'retired inventory refusal';
            await expect(server.readToolNames()).rejects.toThrow();
        } catch (cause) {
            failures.push(new Error(`MCP ${retirement} retirement test request phase: ${phase}`, { cause }));
        } finally {
            await settleMcpTest(failures, [
                { phase: 'original client close', run: () => original.close() },
                { phase: 'resumed client close', run: () => resumed.close() },
                { phase: 'server stop', run: () => server.stop() },
                { phase: 'Session close', run: () => session.close() },
            ]);
        }
    });

    it('keeps a shared catalog read available to a surviving native tool when another caller cancels', async () => {
        daemonCatalogBoundary.read.mockReset();
        const host = new AbortController();
        const lifetime = new AbortController();
        const cancelledCaller = new AbortController();
        const survivingCaller = new AbortController();
        let enter: () => void = () => undefined;
        let release: () => void = () => undefined;
        const entered = new Promise<void>(resolve => { enter = resolve; });
        let catalogReads = 0;
        let producerSignal: AbortSignal | undefined;
        daemonCatalogBoundary.read.mockImplementation(async (options?: Readonly<{ signal?: AbortSignal }>) => {
            catalogReads += 1;
            producerSignal = options?.signal;
            enter();
            return await new Promise((resolve, reject) => {
                release = () => resolve({ kind: 'available', plugins: [], tools: [] });
                options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
            });
        });
        const session = Object.assign(createMutableApiSessionClientFixture({ sessionId: 'shared-catalog-session', metadata: createTestMetadata() }), {
            getRuntimeLifetimeSignal: () => lifetime.signal,
            getHostTurnAbortSignal: () => host.signal,
            getWorkDepth: () => 0,
            getActiveTurnPermissionWitness: () => ({ turnId: 'shared-catalog-turn', workDepth: 0,
                causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const } }),
        });
        registerHappierSessionAgentToolRpc(session, {
            sessionCredentials: { token: 'shared-catalog-fixture', encryption: null }, accountSettings: accountSettingsParse({}),
        });
        const execute = (signal: AbortSignal) => session.rpcHandlerManager.invokeLocal(
            SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1,
            { toolName: 'action_spec_get', args: { id: 'browser.view.open' } }, { signal },
        );
        const cancelled = execute(cancelledCaller.signal);
        const surviving = execute(survivingCaller.signal);
        try {
            await entered;
            cancelledCaller.abort();
            await expect(cancelled).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
            expect(host.signal.aborted).toBe(false);
            expect(survivingCaller.signal.aborted).toBe(false);
            expect(producerSignal).toBeDefined();
            expect(producerSignal?.aborted).toBe(false);
            release();
            await expect(surviving).resolves.toMatchObject({ ok: true, result: { actionSpec: { id: 'browser.view.open' } } });
            expect(catalogReads).toBe(1);
        } finally {
            release(); await Promise.allSettled([cancelled, surviving]);
        }
    });

    it('settles a tool cancelled by host Stop while its daemon catalog admission is pending', async () => {
        daemonCatalogBoundary.read.mockReset();
        daemonCatalogBoundary.read.mockResolvedValueOnce({ kind: 'available', plugins: [], tools: [] });
        const turn = new AbortController();
        const lifetime = new AbortController();
        let enter: (signal: AbortSignal | undefined) => void = () => undefined;
        let release: () => void = () => undefined;
        const entered = new Promise<AbortSignal | undefined>(resolve => { enter = resolve; });
        daemonCatalogBoundary.read.mockImplementation(async (options?: Readonly<{ signal?: AbortSignal }>) => {
            enter(options?.signal);
            return await new Promise((resolve, reject) => {
                release = () => resolve({ kind: 'available', plugins: [], tools: [] });
                options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
            });
        });
        const session = Object.assign(createMutableApiSessionClientFixture({ sessionId: 'catalog-stop-session' }), {
            getRuntimeLifetimeSignal: () => lifetime.signal,
            getHostTurnAbortSignal: () => turn.signal,
        });
        const server = await startHappyServer(session);
        const pending = fetch(server.url, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
                ...sessionMcpAuthorizationHeaders(server) },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'action_execute', arguments: {
                actionId: 'browser.view.open', input: { kind: 'openView', commandId: 'catalog-stop',
                    browserSessionId: session.sessionId, viewId: 'view', platform: 'web',
                    target: { kind: 'externalUrl', targetId: 'target', url: 'https://example.test' } },
            } } }),
        });
        try {
            const signal = await Promise.race([entered, pending.then(async response => {
                throw new Error(`MCP request settled before catalog admission: ${await response.clone().text()}`);
            })]);
            expect(signal).toBeDefined();
            turn.abort();
            const response = await pending;
            expect(response.status).toBe(503);
            expect(await response.json()).toMatchObject({ ok: false, errorCode: 'cancelled' });
        } finally {
            release(); await pending; await server.stop();
        }
    });

    it('refreshes the admitted inventory on policy, feature and contributor occurrence changes', async () => {
        vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
        // Board reads also serve transcript visuals. Layout is the Action
        // whose canonical availability actually depends on sessions.board.
        const boardLayoutAction = 'session.board.layout.update' as const;
        const boardLayoutTool = getActionSpec(boardLayoutAction).bindings?.mcpToolName;
        let settings = accountSettingsParse({});
        let features: CliServerFeaturesSnapshot = { status: 'ready', features: FeaturesResponseSchema.parse({
            features: { sessions: { enabled: true, board: { enabled: true } } }, capabilities: {},
        }) };
        let tools: readonly ProjectedPluginToolCatalogEntry[] = [];
        daemonCatalogBoundary.read.mockReset();
        daemonCatalogBoundary.read.mockImplementation(async () => ({ kind: 'available', plugins: [], tools: structuredClone(tools) }));
        const session = createMutableApiSessionClientFixture({
            sessionId: 'inventory-refresh-session', overrides: {
                getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
                getServerFeaturesSnapshot: () => features,
            },
        });
        const server = await startHappyServer(session, {
            sessionCredentials: { token: 'offline-fixture', encryption: null },
            getAccountSettings: () => settings,
            requiredDirectActionIds: [boardLayoutAction],
        });
        const client = new Client({ name: 'inventory-refresh-test', version: '1.0.0' });
        const failures: unknown[] = [];
        let phase = 'connect';
        try {
            await client.connect(sessionMcpTestTransport(server));
            let inventoryRead = 0;
            const names = async () => {
                phase = `inventory read ${++inventoryRead}`;
                return (await client.listTools()).tools.map(tool => tool.name);
            };
            expect(await names()).toContain('change_title');
            expect(await names()).toContain(boardLayoutTool);
            vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', 'sessions.board');
            expect(await names()).not.toContain(boardLayoutTool);
            vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', '');
            expect(await names()).toContain(boardLayoutTool);
            // Supply the reader's effective policy rather than exercise a
            // persisted Settings migration in this inventory regression.
            settings = { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
                v: 1, actions: { 'session.title.set': { enabled: false } },
            }) };
            expect(await names()).not.toContain('change_title');
            features = { status: 'ready', features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) };
            expect(await names()).not.toContain(boardLayoutTool);
            settings = accountSettingsParse({});
            expect(await names()).toContain('change_title');
            tools = [{ toolId: 'acme.plugin/read', actionId: formatQualifiedPluginActionId({ pluginId: 'acme.plugin', localId: 'read-action' }), name: 'plugin_read',
                title: 'Plugin read', description: 'Read', inputSchema: { type: 'object', properties: {} },
                surfaces: ['agent'], expectedContributorOccurrenceId: 'occurrence-one' }];
            expect(await names()).toContain('plugin_read');
            tools = tools.map(tool => ({ ...tool, name: 'replacement_read', expectedContributorOccurrenceId: 'occurrence-two' }));
            expect(await names()).not.toContain('plugin_read');
            expect(await names()).toContain('replacement_read');
            tools = [];
            expect(await names()).not.toContain('replacement_read');
        } catch (cause) {
            failures.push(new Error(`MCP inventory refresh test request phase: ${phase}`, { cause }));
        } finally {
            vi.unstubAllEnvs();
            await settleMcpTest(failures, [
                { phase: 'client close', run: () => client.close() },
                { phase: 'server stop', run: () => server.stop() },
                { phase: 'Session close', run: () => session.close() },
            ]);
        }
    });
    it('keeps notifications available during catalog loss while tool requests fail closed', async () => {
        daemonCatalogBoundary.read.mockReset();
        daemonCatalogBoundary.read.mockResolvedValueOnce({ kind: 'available', plugins: [], tools: [] });
        daemonCatalogBoundary.read.mockResolvedValue({ kind: 'unavailable', code: 'daemon_unavailable' });

        const client = createMutableApiSessionClientFixture({
            sessionId: 'notification-stream-session',
            overrides: {
                getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
            },
        });
        const server = await startHappyServer(client);
        const notificationStream = new AbortController();
        try {
            const response = await fetch(server.url, {
                headers: { Accept: 'text/event-stream', ...sessionMcpAuthorizationHeaders(server) },
                signal: notificationStream.signal,
            });
            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('text/event-stream');
            notificationStream.abort();

            const toolResponse = await fetch(server.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
                    ...sessionMcpAuthorizationHeaders(server) },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
            });
            expect(toolResponse.status).toBe(503);
            await expect(toolResponse.json()).resolves.toMatchObject({
                ok: false, errorCode: 'daemon_plugin_catalog_unavailable',
            });
        } finally {
            notificationStream.abort();
            await server.stop();
        }
    });
});
