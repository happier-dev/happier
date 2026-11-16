import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { accountSettingsParse } from '@happier-dev/protocol';
import { ensureManagedGuestSessionHolder } from '@happier-dev/cli-common/machines/managed';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge';
import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import { HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI } from '@/mcp/resources/registerHappierMcpResources';
import { createSessionHolderSocketPath, requireSessionHolderExecutablePath, spawnSessionHolderChild, type SessionHolderTarget } from '@/subprocess/supervision/sessionHolder';
import { SESSION_TARGET_PLACEMENT_ENV_KEY } from '@/subprocess/supervision/sessionTargetRelay';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { sessionMcpAgentTransport } from './sessionMcpClient.testkit';
import { SESSION_MCP_BEARER_ENV, SESSION_MCP_CONTEXT_FILE_ENV } from './sessionMcpLocalContext';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { TRANSCRIPT_SECRET_REDACTED } from '@/api/session/client/transport/transcriptSecretRedaction';
import { buildOutboundSessionMessagePayload } from '@/api/session/client/transport/outboundSessionMessagePayload';

const daemonCatalogBoundary = vi.hoisted(() => ({
    read: vi.fn(async () => ({ kind: 'available' as const, plugins: [], tools: [] })),
}));

// Daemon IPC is the external boundary; the Session MCP server, relay endpoint, holder,
// native relay and kernel peer check below it are real.
vi.mock('@/daemon/controlClient', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
    return { ...actual, readDaemonPluginCatalog: daemonCatalogBoundary.read,
        requestDaemonPluginActionExecution: async () => ({ matched: false }) };
});

async function startSessionMcp(sessionId: string, extra: Partial<HappyMcpSessionClient> = {}, accountSettings = accountSettingsParse({})) {
    return await createHappierMcpBridge({ ...extra, sessionId,
        getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
        rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
        updateMetadata() {}, getMetadataSnapshot: () => ({}),
    }, { accountSettings });
}

/** Run `command` the way an Agent's shell does: under a Session holder, with the Agent's environment. */
async function runInAgentTree(command: string, args: readonly string[], env: Readonly<Record<string, string>>): Promise<string> {
    const child = spawnSessionHolderChild({ executablePath: requireSessionHolderExecutablePath(), socketPath: createSessionHolderSocketPath(),
        command, args: [...args], env: { ...process.env, ...env } });
    const output: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    await once(child, 'exit');
    return Buffer.concat(output).toString('utf8');
}

const INITIALIZE = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'agent-shell', version: '1' } } });

/** One Streamable HTTP initialize over the Session socket; resolves the HTTP status. */
function initializeOverSocket(socketPath: string, authorization?: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const request = httpRequest({ socketPath, path: '/mcp', method: 'POST', headers: {
            'content-type': 'application/json', accept: 'application/json, text/event-stream',
            ...(authorization ? { authorization } : {}) } }, response => { response.resume(); resolve(response.statusCode ?? 0); });
        request.once('error', reject);
        request.end(INITIALIZE);
    });
}

/**
 * A target the way the runner reaches one (`sessionHolder.target.test.ts`): a finite `exec` and a live
 * byte channel running `argv` (here this host's shell and a real `holder attach` child, as
 * `docker exec -i` runs it). The Agent's environment comes only from the launch preparation.
 */
function shellTarget(directory: string, agentEnv: Readonly<Record<string, string>>, holderPath = requireSessionHolderExecutablePath()): SessionHolderTarget {
    return {
        id: 'local-test-target', holderPath, socketDirectory: directory,
        exec: command => new Promise((resolve, reject) => {
            const child = spawn('sh', ['-c', command], { env: { ...process.env, HOME: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
            child.once('error', reject);
            child.once('close', status => resolve({ status: status ?? 1, stdout, stderr: '' }));
        }),
        openChannel: argv => {
            const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
            const channel = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
            child.once('close', () => channel.destroy());
            return channel;
        },
        prepareLaunch: launch => ({ command: launch.command, args: launch.args, env: agentEnv }),
    };
}

async function placeHostHolder(directory: string) {
    const provider = shellTarget(directory, {});
    // This target is this host's shell: materialize its real native pair through
    // the production bootstrap, without requiring cross-compiled guest artifacts.
    const artifact = async (path: string) => {
        const bytes = await readFile(path);
        return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    };
    return await ensureManagedGuestSessionHolder({ version: 'mcp-composed-test',
        resolveArtifacts: async () => {
            const helperPath = resolveProcessCustodySupportExecutable();
            if (!helperPath) throw new Error('missing host process custody helper');
            return { holder: await artifact(requireSessionHolderExecutablePath()), helper: await artifact(helperPath) };
        },
        io: { exec: ({ command }) => provider.exec(command), putFile: ({ path, bytes }) => writeFile(path, bytes) },
    });
}

describe('Session MCP through the native holder relay', () => {
    it.runIf(process.platform === 'linux')('routes a placed Run to its own catalog when its Session registered first', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'mcp-run-'));
        const primarySocketPath = join(directory, 'p.sock');
        const placed = await placeHostHolder(directory);
        const environment = { ...process.env, [SESSION_TARGET_PLACEMENT_ENV_KEY]: JSON.stringify({
            id: 'local-test-target', holderPath: placed.holderPath, socketDirectory: directory,
            relaySocketPath: join(directory, 'r.sock'), primarySocketPath,
        }) };
        try {
            await runAddedHostedSession({ environment, workingDirectory: directory, end: () => {} }, async () => {
                const primary = await startSessionMcp('placed-own-run');
                let run: Awaited<ReturnType<typeof startSessionMcp>> | undefined;
                const primaryAgent = new Client({ name: 'placed-primary', version: '1' });
                const runAgent = new Client({ name: 'placed-run', version: '1' });
                try {
                    run = await startSessionMcp('placed-own-run', {}, accountSettingsParse({
                        actionsSettingsV1: { v: 1, actions: { 'session.title.set': { enabled: false } } },
                    }));
                    const connectAgent = (agent: Client, config: typeof primary.mcpServers.happier, socketPath: string) =>
                        agent.connect(sessionMcpAgentTransport(config!, { target: shellTarget(directory, { ...config!.env }, placed.holderPath),
                            socketPath, role: socketPath === primarySocketPath ? 'primary' : 'auxiliary' }));
                    await connectAgent(runAgent, run.mcpServers.happier, join(directory, 'a.sock'));
                    await connectAgent(primaryAgent, primary.mcpServers.happier, primarySocketPath);
                    expect((await runAgent.listTools()).tools.map(tool => tool.name)).not.toContain('change_title');
                    expect((await primaryAgent.listTools()).tools.map(tool => tool.name)).toContain('change_title');
                    expect(JSON.stringify(run.mcpServers)).not.toContain(run.happierMcpServer.localContext!.bearerToken);
                } finally {
                    await Promise.allSettled([primaryAgent.close(), runAgent.close()]);
                    await run?.happierMcpServer.stop();
                    await primary.happierMcpServer.stop();
                }
            });
        } finally { await rm(directory, { recursive: true, force: true }); }
    }, 120_000);

    it.runIf(process.platform !== 'win32')('keeps a Session relay reachable when its own Run opens a second bridge in the same holder scope', async () => {
        await runAddedHostedSession({ environment: { ...process.env }, workingDirectory: process.cwd(), end: () => {} }, async () => {
            const primary = await startSessionMcp('session-mcp-own-run');
            let run: Awaited<ReturnType<typeof startSessionMcp>> | undefined;
            const primaryAgent = new Client({ name: 'same-session-primary', version: '1' });
            const runAgent = new Client({ name: 'same-session-run', version: '1' });
            try {
                const context = primary.happierMcpServer.localContext;
                if (!context || !('socketPath' in context)) throw new Error('missing Session MCP socket context');
                const script = `const r=require('node:http').request({socketPath:${JSON.stringify(context.socketPath)},path:'/mcp',method:'POST',`
                    + `headers:{'content-type':'application/json',accept:'application/json, text/event-stream'}},`
                    + `res=>{res.resume();process.stdout.write(String(res.statusCode));});r.end(${JSON.stringify(INITIALIZE)});`;
                const initialStatus = await runInAgentTree(process.execPath, ['-e', script], {});
                expect(initialStatus).toBe('200');
                // Session-owned Runs rebind the Happier bridge without opening another hosted Session.
                run = await startSessionMcp('session-mcp-own-run', {}, accountSettingsParse({
                    actionsSettingsV1: { v: 1, actions: { 'session.title.set': { enabled: false } } },
                }));
                const statusAfterRebind = await runInAgentTree(process.execPath, ['-e', script], {});
                // A shared Agent tree cannot choose between the two registrations anonymously.
                expect(statusAfterRebind).toBe('401');
                const runInitialized = await runAgent.connect(sessionMcpAgentTransport(run.mcpServers.happier!))
                    .then(() => true, () => false);
                expect(runInitialized).toBe(true);
                await primaryAgent.connect(sessionMcpAgentTransport(primary.mcpServers.happier!));
                expect((await runAgent.listTools()).tools.map(tool => tool.name)).not.toContain('change_title');
                expect((await primaryAgent.listTools()).tools.map(tool => tool.name)).toContain('change_title');
                const runContext = run.happierMcpServer.localContext;
                if (!runContext) throw new Error('missing Run MCP context');
                // An Agent can echo its private MCP config: the real outbound writer redacts both live registrations.
                const transcriptEcho = (value: string) => JSON.stringify(buildOutboundSessionMessagePayload({ mode: 'plain', ctx: null }, value));
                const redactedEcho = JSON.stringify({ t: 'plain', v: TRANSCRIPT_SECRET_REDACTED });
                expect(transcriptEcho(runContext.bearerToken) === redactedEcho).toBe(true);
                expect(transcriptEcho(context.bearerToken) === redactedEcho).toBe(true);
                await run.happierMcpServer.stop();
                expect(await initializeOverSocket(context.socketPath, `Bearer ${runContext.bearerToken}`)).toBe(401);
                expect(transcriptEcho(runContext.bearerToken) === JSON.stringify({ t: 'plain', v: runContext.bearerToken })).toBe(true);
                expect(transcriptEcho(context.bearerToken) === redactedEcho).toBe(true);
                expect((await primaryAgent.listTools()).tools.map(tool => tool.name)).toContain('change_title');
            } finally {
                await Promise.allSettled([primaryAgent.close(), runAgent.close()]);
                await run?.happierMcpServer.stop();
                await primary.happierMcpServer.stop();
            }
        });
    }, 120_000);

    it.runIf(process.platform === 'linux')('serves an Agent held in a target through its holder channel, never this Machine\'s socket', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'mcp-target-'));
        const primarySocketPath = join(directory, 'primary.sock');
        const placed = await placeHostHolder(directory);
        process.env[SESSION_TARGET_PLACEMENT_ENV_KEY] = JSON.stringify({ id: 'local-test-target', holderPath: placed.holderPath,
            socketDirectory: directory, relaySocketPath: join(directory, 'relay.sock'), primarySocketPath });
        let bridge: Awaited<ReturnType<typeof startSessionMcp>> | undefined;
        const agent = new Client({ name: 'target-agent', version: '1' });
        try {
            bridge = await startSessionMcp('session-mcp-target');
            const config = bridge.mcpServers.happier!;
            const hostContext = bridge.happierMcpServer.localContext;
            if (!hostContext) throw new Error('missing Session MCP context');
            // No context is named: the relay uses its own holder's in the target; this Machine's socket and bearer never cross.
            expect(config.env?.[SESSION_MCP_CONTEXT_FILE_ENV]).toBeUndefined();
            const target = shellTarget(directory, { ...config.env }, placed.holderPath);
            await agent.connect(sessionMcpAgentTransport(config, { target, socketPath: primarySocketPath, role: 'primary' }));
            const names = (await agent.listTools()).tools.map(tool => tool.name);
            expect(names).toEqual(expect.arrayContaining(['action_spec_search', 'action_spec_get', 'action_execute']));
            const discovered = CallToolResultSchema.parse(await agent.callTool({ name: 'action_spec_get', arguments: { id: 'session.list' } }));
            expect(discovered.content.length).toBeGreaterThan(0);

            // Same user, same context, outside the holder's Agent tree: the holder refuses it.
            const outsider = new Client({ name: 'target-outsider', version: '1' });
            await expect(outsider.connect(new StdioClientTransport({ command: config.command, args: [...config.args!],
                env: { ...config.env }, stderr: 'ignore' }))).rejects.toThrow();
            await outsider.close().catch(() => undefined);
            expect((await agent.listTools()).tools.length).toBe(names.length);
        } finally {
            delete process.env[SESSION_TARGET_PLACEMENT_ENV_KEY];
            await agent.close().catch(() => undefined);
            await bridge?.happierMcpServer.stop();
            await rm(directory, { recursive: true, force: true });
        }
    }, 60_000);

    it.runIf(process.platform === 'linux')('every Agent held in a target reaches Session MCP through its own holder (primary and auxiliary)', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'mcp-target-aux-'));
        const primarySocketPath = join(directory, 'primary.sock');
        const placed = await placeHostHolder(directory);
        process.env[SESSION_TARGET_PLACEMENT_ENV_KEY] = JSON.stringify({ id: 'local-test-target', holderPath: placed.holderPath,
            socketDirectory: directory, relaySocketPath: join(directory, 'relay.sock'), primarySocketPath });
        let bridge: Awaited<ReturnType<typeof startSessionMcp>> | undefined;
        const agents = [new Client({ name: 'target-primary', version: '1' }), new Client({ name: 'target-auxiliary', version: '1' })];
        try {
            bridge = await startSessionMcp('session-mcp-target-aux');
            const config = bridge.mcpServers.happier!;
            const target = shellTarget(directory, { ...config.env }, placed.holderPath);
            await agents[0]!.connect(sessionMcpAgentTransport(config, { target, socketPath: primarySocketPath, role: 'primary' }));
            // An execution run's Agent in the same target: its own holder, its own Agent tree.
            // Keep the holder's appended `.mcp` socket within AF_UNIX's pathname limit under executor TMPDIRs.
            await agents[1]!.connect(sessionMcpAgentTransport(config, { target, socketPath: join(directory, 'aux.sock'), role: 'auxiliary' }));
            const listed = await Promise.all(agents.map(async agent => (await agent.listTools()).tools.length));
            expect(listed.filter(count => count > 0)).toHaveLength(2);
        } finally {
            delete process.env[SESSION_TARGET_PLACEMENT_ENV_KEY];
            await Promise.all(agents.map(agent => agent.close().catch(() => undefined)));
            await bridge?.happierMcpServer.stop();
            await rm(directory, { recursive: true, force: true });
        }
    }, 60_000);

    it.runIf(process.platform !== 'win32')('keeps the relay bearer out of the Agent environment and context file while admitting shell clients by peer proof', async () => {
        const bridge = await startSessionMcp('session-mcp-agent-shell');
        const context = bridge.happierMcpServer.localContext;
        const contextFile = bridge.happierMcpServer.contextFilePath;
        if (!context || !('socketPath' in context) || !contextFile) throw new Error('missing Session MCP socket context');
        const agentEnvironment = { [SESSION_MCP_CONTEXT_FILE_ENV]: contextFile };
        try {
            // What a shell `env; cat "$HAPPIER_SESSION_MCP_CONTEXT_FILE"` shows the Agent: the socket, never the bearer.
            const shown = await runInAgentTree('/bin/sh', ['-c', 'env; cat "$HAPPIER_SESSION_MCP_CONTEXT_FILE"'], agentEnvironment);
            expect(shown).toContain(context.socketPath);
            expect(shown.includes(context.bearerToken)).toBe(false);
            expect(JSON.stringify(bridge.mcpServers).includes(context.bearerToken)).toBe(true);

            // A bearer-less HTTP client in the Agent tree (the `happier` CLI's shell use) is admitted by peer proof.
            const script = `const r=require('node:http').request({socketPath:${JSON.stringify(context.socketPath)},path:'/mcp',method:'POST',`
                + `headers:{'content-type':'application/json',accept:'application/json, text/event-stream'}},`
                + `res=>{res.resume();process.stdout.write(String(res.statusCode));});r.end(${JSON.stringify(INITIALIZE)});`;
            expect(await runInAgentTree(process.execPath, ['-e', script], agentEnvironment)).toBe('200');

            // The same bearer-less request outside the Agent tree is refused; an out-of-tree consumer
            // holding the in-memory bearer (plugin services) is still admitted.
            expect(await initializeOverSocket(context.socketPath)).toBe(401);
            expect(await initializeOverSocket(context.socketPath, `Bearer ${context.bearerToken}`)).toBe(200);

            // The native relay selects its registration with the bearer in its own MCP config.
            const agent = new Client({ name: 'relay-agent-bearerless', version: '1' });
            try {
                await agent.connect(sessionMcpAgentTransport(bridge.mcpServers.happier!));
                expect((await agent.listTools()).tools.length).toBeGreaterThan(0);
            } finally {
                await agent.close().catch(() => undefined);
            }
        } finally {
            await bridge.happierMcpServer.stop();
        }
    }, 120_000);

    it.runIf(process.platform !== 'win32')('serves two Sessions of one host from one socket and resolves each Agent tree to its own Session', async () => {
        const inSession = <T>(run: () => T): T => runAddedHostedSession({ environment: { ...process.env }, workingDirectory: process.cwd(), end: () => {} }, run);
        // Each Session's own execution-run owner and admitted Turn: what a request reaching that Session can act on.
        const stops = { a: vi.fn(async () => ({ ok: true as const, data: { v: 1, ok: true } })),
            b: vi.fn(async () => ({ ok: true as const, data: { v: 1, ok: true } })) };
        const unexpected = async () => { throw new Error('unexpected execution-run call'); };
        const runOwner = (sessionId: string, stop: typeof stops.a): Partial<HappyMcpSessionClient> => ({
            getWorkDepth: () => 0, getPermissionMode: () => 'default',
            getActiveTurnPermissionWitness: () => ({ turnId: `turn-${sessionId}`, workDepth: 0,
                causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } }) as never,
            executionRuns: { start: unexpected, list: unexpected, get: unexpected, send: unexpected, action: unexpected, stop },
        });
        let bridgeA: Awaited<ReturnType<typeof startSessionMcp>> | undefined;
        let bridgeB: Awaited<ReturnType<typeof startSessionMcp>> | undefined;
        try {
            // Each Session starts in its own hosted scope, as the session host runs it; A's Agent tree is spawned in A's scope.
            await inSession(async () => {
                bridgeA = await startSessionMcp('session-mcp-host-a', runOwner('session-mcp-host-a', stops.a));
                const contextA = bridgeA.happierMcpServer.localContext;
                if (!contextA || !('socketPath' in contextA)) throw new Error('missing Session MCP socket context');
                bridgeB = await inSession(() => startSessionMcp('session-mcp-host-b', runOwner('session-mcp-host-b', stops.b)));
                const contextB = bridgeB.happierMcpServer.localContext;
                if (!contextB || !('socketPath' in contextB)) throw new Error('missing Session MCP socket context');
                // One listener for the host's Sessions; separate bearers.
                expect(contextB.socketPath).toBe(contextA.socketPath);
                expect(contextB.bearerToken).not.toBe(contextA.bearerToken);
                // A bearer-less client in A's Agent tree is A: a stop naming B is refused as another Session's,
                // one naming A is not (it reaches A's own execution-run owner).
                const call = (sessionId: string) => `const http=require('node:http');const send=(b)=>new Promise(r=>{const q=http.request({socketPath:${JSON.stringify(contextA.socketPath)},path:'/mcp',method:'POST',`
                    + `headers:{'content-type':'application/json',accept:'application/json, text/event-stream'}},res=>{let t='';res.on('data',c=>t+=c);res.on('end',()=>r(res.statusCode+' '+t));});q.end(JSON.stringify(b));});`
                    + `send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'action_execute',arguments:{actionId:'execution.run.stop',input:{sessionId:${JSON.stringify(sessionId)},runId:'run-1'}}}}).then(o=>process.stdout.write(o));`;
                const env = { [SESSION_MCP_CONTEXT_FILE_ENV]: bridgeA.happierMcpServer.contextFilePath ?? '' };
                const namingB = await runInAgentTree(process.execPath, ['-e', call('session-mcp-host-b')], env);
                const refusedAsAnotherSession = /current_session_only|execution_run_scope_mismatch/u;
                expect(namingB.startsWith('200'), namingB).toBe(true);
                expect(namingB, namingB).toMatch(refusedAsAnotherSession);
                const namingA = await runInAgentTree(process.execPath, ['-e', call('session-mcp-host-a')], env);
                expect(namingA.startsWith('200'), namingA).toBe(true);
                expect(namingA, namingA).not.toMatch(refusedAsAnotherSession);
                expect([stops.a.mock.calls.length, stops.b.mock.calls.length]).toEqual([1, 0]);
                // The same bearer-less request from outside every Session's Agent tree is refused.
                expect(await initializeOverSocket(contextA.socketPath)).toBe(401);
            });
        } finally {
            await bridgeA?.happierMcpServer.stop();
            await bridgeB?.happierMcpServer.stop();
        }
    }, 120_000);

    it.runIf(process.platform !== 'win32')('serves the Agent tree in-process and refuses callers outside it', async () => {
        const bridge = await startSessionMcp('session-mcp-relay');
        const config = bridge.mcpServers.happier!;
        const context = bridge.happierMcpServer.localContext;
        if (!context || !('socketPath' in context)) throw new Error('missing Session MCP socket context');
        // Agents launch the shipped holder's relay mode, never a Node bridge process.
        expect(config.command).toMatch(/happier-session-holder/u);
        expect(config.args).toEqual(['mcp-relay']);
        const agent = new Client({ name: 'relay-agent', version: '1' });
        const budgeted = new Client({ name: 'relay-agent-budget', version: '1' });
        try {
            await agent.connect(sessionMcpAgentTransport(config));
            const names = (await agent.listTools()).tools.map(tool => tool.name);
            expect(names).toEqual(expect.arrayContaining(['action_spec_search', 'action_spec_get', 'action_execute']));
            const discovered = CallToolResultSchema.parse(await agent.callTool({ name: 'action_spec_get', arguments: { id: 'session.list' } }));
            expect(discovered.content.length).toBeGreaterThan(0);
            expect((await agent.listResources()).resources.map(resource => resource.uri)).toContain(HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI);

            // The Agent's tool-name budget rides the relay preamble; aliases resolve in the host.
            await budgeted.connect(sessionMcpAgentTransport({ ...config, args: [...config.args!, '--tool-name-max-length', '12'] }));
            const projected = (await budgeted.listTools()).tools.map(tool => tool.name);
            expect(projected.every(name => name.length <= 12)).toBe(true);
            const alias = projected.find(name => name.startsWith('h__'));
            expect(alias).toBeDefined();
            expect(CallToolResultSchema.parse(await budgeted.callTool({ name: alias!, arguments: {} })).content.length).toBeGreaterThan(0);

            // An uncredentialed process outside this Session's Agent tree is refused.
            const outsider = new Client({ name: 'relay-outsider', version: '1' });
            await expect(outsider.connect(new StdioClientTransport({ command: config.command, args: [...config.args!],
                env: Object.fromEntries(Object.entries(config.env ?? {}).filter(([key]) => key !== SESSION_MCP_BEARER_ENV)), stderr: 'ignore' }))).rejects.toThrow();
            await outsider.close().catch(() => undefined);

            // A wrong bearer gets a 401 and never an MCP response.
            const raw = connect(context.socketPath);
            const received: Buffer[] = [];
            raw.on('data', chunk => received.push(chunk));
            raw.write('GET /mcp-relay HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: happier-mcp-relay\r\n'
                + 'Authorization: Bearer wrong\r\n\r\n'
                + `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`);
            await once(raw, 'close');
            const reply = Buffer.concat(received).toString('utf8');
            expect(reply.startsWith('HTTP/1.1 401')).toBe(true);
            expect(reply).not.toContain('jsonrpc');

            // The admitted Agent keeps working.
            expect((await agent.listTools()).tools.length).toBe(names.length);
        } finally {
            await agent.close().catch(() => undefined);
            await budgeted.close().catch(() => undefined);
            await bridge.happierMcpServer.stop();
        }
    }, 60_000);
});
