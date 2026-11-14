import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { accountSettingsParse } from '@happier-dev/protocol';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge';
import { HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI } from '@/mcp/resources/registerHappierMcpResources';
import { createSessionHolderSocketPath, requireSessionHolderExecutablePath, spawnSessionHolderChild, type SessionHolderTarget } from '@/subprocess/supervision/sessionHolder';
import { SESSION_TARGET_PLACEMENT_ENV_KEY } from '@/subprocess/supervision/sessionTargetRelay';
import { sessionMcpAgentTransport } from './sessionMcpClient.testkit';
import { SESSION_MCP_CONTEXT_FILE_ENV } from './sessionMcpLocalContext';

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

async function startSessionMcp(sessionId: string) {
    return await createHappierMcpBridge({ sessionId,
        getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
        rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
        updateMetadata() {}, getMetadataSnapshot: () => ({}),
    }, { accountSettings: accountSettingsParse({}) });
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
function shellTarget(directory: string, agentEnv: Readonly<Record<string, string>>): SessionHolderTarget {
    return {
        id: 'local-test-target', holderPath: requireSessionHolderExecutablePath(), socketDirectory: directory,
        exec: command => new Promise((resolve, reject) => {
            const child = spawn('sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
            child.once('error', reject);
            child.once('close', status => resolve({ status: status ?? 1, stdout, stderr: '' }));
        }),
        openChannel: argv => {
            const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
            const channel = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
            child.once('close', () => channel.destroy());
            return channel;
        },
        prepareLaunch: launch => ({ command: launch.command, args: launch.args, env: agentEnv }),
    };
}

describe('Session MCP through the native holder relay', () => {
    it.runIf(process.platform === 'linux')('serves an Agent held in a target through its holder channel, never this Machine\'s socket', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'mcp-target-'));
        const primarySocketPath = join(directory, 'primary.sock');
        process.env[SESSION_TARGET_PLACEMENT_ENV_KEY] = JSON.stringify({ id: 'local-test-target', holderPath: requireSessionHolderExecutablePath(),
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
            const target = shellTarget(directory, { ...config.env });
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
        process.env[SESSION_TARGET_PLACEMENT_ENV_KEY] = JSON.stringify({ id: 'local-test-target', holderPath: requireSessionHolderExecutablePath(),
            socketDirectory: directory, relaySocketPath: join(directory, 'relay.sock'), primarySocketPath });
        let bridge: Awaited<ReturnType<typeof startSessionMcp>> | undefined;
        const agents = [new Client({ name: 'target-primary', version: '1' }), new Client({ name: 'target-auxiliary', version: '1' })];
        try {
            bridge = await startSessionMcp('session-mcp-target-aux');
            const config = bridge.mcpServers.happier!;
            const target = shellTarget(directory, { ...config.env });
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

    it.runIf(process.platform !== 'win32')('gives the Agent tree no bearer and admits its shell clients by kernel peer proof', async () => {
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
            expect(JSON.stringify(bridge.mcpServers).includes(context.bearerToken)).toBe(false);

            // A bearer-less HTTP client in the Agent tree (the `happier` CLI's shell use) is admitted by peer proof.
            const script = `const r=require('node:http').request({socketPath:${JSON.stringify(context.socketPath)},path:'/mcp',method:'POST',`
                + `headers:{'content-type':'application/json',accept:'application/json, text/event-stream'}},`
                + `res=>{res.resume();process.stdout.write(String(res.statusCode));});r.end(${JSON.stringify(INITIALIZE)});`;
            expect(await runInAgentTree(process.execPath, ['-e', script], agentEnvironment)).toBe('200');

            // The same bearer-less request outside the Agent tree is refused; an out-of-tree consumer
            // holding the in-memory bearer (plugin services) is still admitted.
            expect(await initializeOverSocket(context.socketPath)).toBe(401);
            expect(await initializeOverSocket(context.socketPath, `Bearer ${context.bearerToken}`)).toBe(200);

            // The native relay reaches the Session from the bearer-less context.
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

            // Same uid, valid copied bearer, but not inside this Session's Agent tree: refused.
            const outsider = new Client({ name: 'relay-outsider', version: '1' });
            await expect(outsider.connect(new StdioClientTransport({ command: config.command, args: [...config.args!],
                env: { ...config.env }, stderr: 'ignore' }))).rejects.toThrow();
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
