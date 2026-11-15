import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type { RpcHandlerManagerLike } from '@/api/rpc/types';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { startHappyServer, type HappyMcpSessionClient } from '@/mcp/startHappyServer';
import { sessionMcpTestTransport } from './sessionMcpClient.testkit';
import { supportsSessionMcpLocalTransport } from './sessionMcpLocalTransport';

const daemonCatalogBoundary = vi.hoisted(() => ({
    read: vi.fn(async () => ({ kind: 'available' as const, plugins: [], tools: [] })),
}));

// The daemon control transport is outside the Session process. The host endpoint, its listener
// transport, Session bearers, request dispatch and each Session's MCP server below it are real.
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/daemon/controlClient')>(),
    readDaemonPluginCatalog: daemonCatalogBoundary.read,
    requestDaemonPluginActionExecution: async () => ({ matched: false }),
}));

type Started = Awaited<ReturnType<typeof startHappyServer>>;

function createSessionClient(sessionId: string) {
    const stop = vi.fn(async () => ({ ok: true as const, data: { v: 1, ok: true } }));
    const unexpected = async () => { throw new Error('unexpected execution-run call'); };
    const client: HappyMcpSessionClient = {
        sessionId,
        getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
        rpcHandlerManager: { invokeLocal: vi.fn(async () => ({ ok: true })) } as unknown as RpcHandlerManagerLike,
        updateMetadata: () => {},
        getMetadataSnapshot: () => ({}) as never,
        getWorkDepth: () => 0,
        getPermissionMode: () => 'default',
        getActiveTurnPermissionWitness: () => ({ turnId: `turn-${sessionId}`, workDepth: 0,
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } }) as never,
        executionRuns: { start: unexpected, list: unexpected, get: unexpected, send: unexpected, action: unexpected, stop },
    };
    return { client, stop };
}

/** Each Session starts its MCP inside its own hosted Session scope, as the session host runs it. */
function startInOwnSession(sessionId: string, localTransport: boolean): Promise<Started> {
    const { client } = sessions.get(sessionId) ?? (() => {
        const created = createSessionClient(sessionId);
        sessions.set(sessionId, created);
        return created;
    })();
    return runAddedHostedSession({ environment: { ...process.env }, workingDirectory: process.cwd(), end: () => {} },
        () => startHappyServer(client, localTransport ? { localTransport: { agentUid: process.getuid!() } } : {}));
}

const sessions = new Map<string, ReturnType<typeof createSessionClient>>();
const started: Started[] = [];
afterEach(async () => {
    await Promise.allSettled(started.splice(0).map(server => server.stop()));
    sessions.clear();
});

function endpointOf(server: Started): string {
    const context = server.localContext;
    if (!context) throw new Error('missing Session MCP context');
    return 'socketPath' in context ? context.socketPath : context.url;
}

/** One Streamable HTTP POST with only `authorization` chosen by the caller. */
function post(server: Started, endpoint: string, authorization: string | undefined, body: unknown): Promise<number> {
    return new Promise((resolve, reject) => {
        const target = endpoint.startsWith('http') ? { host: '127.0.0.1', port: Number(new URL(endpoint).port) } : { socketPath: endpoint };
        const call = httpRequest({ ...target, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json',
            accept: 'application/json, text/event-stream', ...(authorization ? { authorization } : {}) } }, response => {
            response.resume();
            response.once('end', () => resolve(response.statusCode ?? 0));
        });
        call.once('error', reject);
        call.end(JSON.stringify(body));
    });
}

async function stopRun(server: Started, sessionId: string): Promise<string> {
    const client = new Client({ name: 'endpoint-test', version: '1' });
    await client.connect(sessionMcpTestTransport(server));
    try {
        const result = await client.callTool({ name: 'action_execute',
            arguments: { actionId: 'execution.run.stop', input: { sessionId, runId: 'run-1' } } });
        return JSON.stringify(result);
    } finally {
        await client.close().catch(() => undefined);
    }
}

describe('one Session MCP endpoint per host', () => {
    it.each([
        ...(supportsSessionMcpLocalTransport() ? [{ transport: 'Unix socket', localTransport: true }] : []),
        { transport: 'loopback', localTransport: false },
    ])('serves every Session of the host from one $transport listener, each only through its own bearer', async ({ localTransport }) => {
        for (const id of ['endpoint-a', 'endpoint-b', 'endpoint-c']) started.push(await startInOwnSession(id, localTransport));
        const [a, b, c] = started as [Started, Started, Started];

        // 3 Sessions → 1 listener; every Session keeps its own bearer.
        expect(new Set(started.map(endpointOf)).size).toBe(1);
        expect(new Set(started.map(server => server.localContext!.bearerToken)).size).toBe(3);

        // Session B's bearer reaches Session B only: a request naming A is refused and A is never called.
        const namingA = JSON.parse(await stopRun(b, 'endpoint-a'));
        expect(namingA.isError, JSON.stringify(namingA)).toBe(true);
        const namingB = JSON.parse(await stopRun(b, 'endpoint-b'));
        expect(namingB.isError, JSON.stringify(namingB)).not.toBe(true);
        expect(sessions.get('endpoint-a')!.stop).toHaveBeenCalledTimes(0);
        expect(sessions.get('endpoint-b')!.stop).toHaveBeenCalledTimes(1);
        expect(sessions.get('endpoint-c')!.stop).toHaveBeenCalledTimes(0);

        // No bearer, or one that is no live Session's, is refused (the loopback has no peer proof; the
        // test process is in no Session's Agent tree).
        const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'outsider', version: '1' } } };
        const endpoint = endpointOf(a);
        expect(await post(a, endpoint, undefined, initialize)).toBe(401);
        expect(await post(a, endpoint, 'Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', initialize)).toBe(401);

        // A stopped Session's bearer is refused while the others stay served on the same listener.
        const bearerA = `Bearer ${a.localContext!.bearerToken}`;
        await a.stop();
        expect(a.localContext).toBeUndefined();
        expect(await post(b, endpoint, bearerA, initialize)).toBe(401);
        expect(await post(b, endpoint, `Bearer ${c.localContext!.bearerToken}`, initialize)).toBe(200);

        // The last Session closes the listener.
        await b.stop();
        await c.stop();
        if (localTransport) expect(existsSync(endpoint)).toBe(false);
        else await expect(post(b, endpoint, undefined, initialize)).rejects.toBeDefined();
    }, 60_000);
});
