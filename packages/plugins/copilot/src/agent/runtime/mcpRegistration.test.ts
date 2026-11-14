import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import type { AgentAcpRuntimeOptions, AgentSessionOpenRequest, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { createPublicAcpSession, type PublicAcpComposerDependencies } from '@/agent/acp/runtime/publicSession/createPublicAcpSession';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { COPILOT_AUTH_ENV_VARS } from '../auth/services/copilotAuth.js';
import { COPILOT_PROVIDER_OWNED_ENV_KEYS } from '../providerBinding.js';
import { createCopilotAgentRuntime } from './factory.js';

const require = createRequire(import.meta.url);
const moduleUrl = (id: string) => JSON.stringify(pathToFileURL(require.resolve(id)).href);
const configuration = {
  mode: { value: null, updatedAtMs: 1 }, model: { value: null, updatedAtMs: 1 },
  permissionIntent: { value: 'default' as const, updatedAtMs: 1 }, options: {},
};

describe('Copilot Session MCP registration', () => {
  const nativeBinary = process.env.HAPPIER_COPILOT_NATIVE_PROBE_BINARY;
  const cases = ['create', 'resume', 'refused', 'no-tools', ...(nativeBinary ? ['native'] : [])];
  it.each(cases)('owns Session MCP registration and cleanup on %s', async kind => {
    const directory = await mkdtemp(join(tmpdir(), 'copilot-mcp-registration-'));
    const capture = join(directory, 'capture.json');
    const journal = join(directory, 'mcp-handshake.jsonl');
    const signal = new AbortController().signal;
    const environment = {
      PATH: process.env.PATH, HOME: directory, USERPROFILE: directory,
      COPILOT_HOME: join(directory, '.copilot'), XDG_CONFIG_HOME: join(directory, 'config'),
      COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:1',
      COPILOT_PROVIDER_API_KEY: 'dummy-qa-not-a-secret', COPILOT_MODEL: 'qa-fixture',
    };
    await runAddedHostedSession({ workingDirectory: directory, end() {}, environment }, async () => {
      // The vendor process is the boundary: like Copilot 1.0.111, this peer
      // ignores ACP mcpServers and discovers tools only from its startup file.
      const peer = writeAcpTestAgentScript({ dir: directory, fileName: 'copilot-peer.mjs', source: `
        import { createInterface } from 'node:readline';
        import { readFileSync, writeFileSync } from 'node:fs';
        import { Client } from ${moduleUrl('@modelcontextprotocol/sdk/client/index.js')};
        import { StdioClientTransport } from ${moduleUrl('@modelcontextprotocol/sdk/client/stdio.js')};
        const clients = [];
        const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
        const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
        async function close() { await Promise.all(clients.map(client => client.close())); process.exit(0); }
        process.on('SIGTERM', () => { void close(); });
        process.stdin.on('end', () => { void close(); });
        createInterface({ input: process.stdin }).on('line', async line => {
          const request = JSON.parse(line);
          try {
            if (request.method === 'initialize') respond(request.id, {
              protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [],
            });
            else if (request.method === 'session/new' || request.method === 'session/load') {
              const flag = process.argv.indexOf('--additional-mcp-config');
              const configPath = flag < 0 ? null : process.argv[flag + 1].slice(1);
              const config = configPath ? JSON.parse(readFileSync(configPath, 'utf8')) : { mcpServers: {} };
              const tools = [];
              for (const [name, server] of Object.entries(config.mcpServers)) {
                const client = new Client({ name: 'copilot-boundary', version: '1' });
                clients.push(client);
                await client.connect(new StdioClientTransport({
                  command: server.command, args: server.args, env: { PATH: process.env.PATH, ...server.env },
                }));
                tools.push(...(await client.listTools()).tools.map(tool => name + '/' + tool.name));
              }
              writeFileSync(process.env.CAPTURE, JSON.stringify({ configPath, tools,
                acpServers: request.params.mcpServers, config }));
              if (process.env.REFUSE === 'true') throw new Error('Fixture startup refused');
              respond(request.id, { sessionId: request.params.sessionId ?? 'copilot-native' });
            } else if (request.method === 'session/set_mode') respond(request.id, {});
          } catch (error) { send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: String(error) } }); }
        });
      ` });
      const mcp = writeAcpTestAgentScript({ dir: directory, fileName: 'mcp-peer.mjs', source: `
        import { appendFileSync } from 'node:fs';
        import { createInterface } from 'node:readline';
        createInterface({ input: process.stdin }).on('line', line => {
          const request = JSON.parse(line);
          if (!('id' in request)) return;
          const result = request.method === 'initialize'
            ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
            : request.method === 'tools/list'
            ? { tools: [{ name: 'qa_ping', description: 'Fixture ping', inputSchema: { type: 'object' } }] } : {};
          if (process.argv[2]) appendFileSync(process.argv[2], JSON.stringify({ method: request.method, result }) + '\\n');
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
        });
      ` });
      const dependencies: PublicAcpComposerDependencies = {
        pluginId: 'happier.agent.copilot', agentId: 'copilot', signal, isCurrent: () => true,
        systemTools: { resolve: async request => ({ toolId: request.toolId, launch: {
          kind: 'binary', executablePath: kind === 'native' ? nativeBinary! : process.execPath,
          args: kind === 'native' ? ['--model', 'qa-fixture'] : [peer], env: { CAPTURE: capture, REFUSE: String(kind === 'refused') },
        } }) },
        interactions: { async request() { throw new Error('Unexpected interaction'); } },
        media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
        models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
      };
      // Only unused host-service slots are omitted; the plugin and ACP composer stay real.
      let launchOptions: AgentAcpRuntimeOptions | undefined;
      const context = { signal, services: { connectedAccounts: { getBinding: async () => null } },
        protocols: { acp: { open: (request: AgentSessionOpenRequest, options: AgentAcpRuntimeOptions) => { launchOptions = options; return createPublicAcpSession(request, options, dependencies); } } },
      } as unknown as AgentSessionRuntimeContext;
      const runtime = await createCopilotAgentRuntime({
        plugin: { id: 'happier.agent.copilot', version: '0.0.0' }, agent: { id: 'copilot' }, signal,
      });
      const base = {
        sessionId: kind, cwd: directory,
        launchEnvironment: { values: { ...environment, PATH: environment.PATH ?? '' },
          unset: [...COPILOT_AUTH_ENV_VARS, ...COPILOT_PROVIDER_OWNED_ENV_KEYS]
            .filter(key => !Object.hasOwn(environment, key)),
        },
        configuration: kind === 'native'
          ? { ...configuration, model: { value: 'qa-fixture', updatedAtMs: 1 } } : configuration,
        mcpServers: kind === 'no-tools' ? {} : { happier: { command: process.execPath, args: kind === 'native' ? [mcp, journal] : [mcp], env: { QA_CONTEXT: kind } } },
      };
      const request: AgentSessionOpenRequest = kind === 'resume'
        ? { ...base, kind, providerSessionId: 'copilot-native' } : { ...base, kind: 'create' };
      let opened: Awaited<ReturnType<NonNullable<typeof runtime.sessions>['open']>> | undefined;
      let configPath: string | undefined;
      try {
        if (kind === 'refused') await expect(runtime.sessions!.open(request, context)).rejects.toThrow();
        else opened = await runtime.sessions!.open(request, context);
        if (kind === 'native') {
          const transport = launchOptions!.transport;
          if (transport.kind !== 'stdio') throw new Error('Expected stdio');
          configPath = transport.args![transport.args!.indexOf('--additional-mcp-config') + 1]!.slice(1);
          const native = opened!;
          let output = '';
          let watch!: ReturnType<typeof native.watch>;
          const completed = new Promise<void>((resolve, reject) => {
            watch = native.watch(event => {
              if (event.kind === 'message-delta') output += event.text;
              if (event.kind === 'turn-complete') resolve();
              if (event.kind === 'turn-failed') reject(new Error(JSON.stringify(event.diagnostic)));
            });
          });
          try {
            await native.send({ inputIds: ['mcp-show'], input: { text: '/mcp show happier' },
              delivery: { kind: 'newTurn', turnId: 'mcp-show' } });
            await completed;
            console.log('COPILOT_NATIVE_MCP_SHOW', output);
            expect(output).toContain('happier (connected)');
            const handshake = await readFile(journal, 'utf8');
            console.log('COPILOT_NATIVE_MCP_HANDSHAKE', handshake);
            expect(handshake).toContain('tools/list');
            expect(handshake).toContain('qa_ping');
          } finally { watch?.dispose(); }
          await opened!.dispose(); opened = undefined;
          await expect(access(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
          return;
        }
        const observed = JSON.parse(await readFile(capture, 'utf8'));
        configPath = observed.configPath;
        if (kind === 'no-tools') {
          expect(observed.tools).toEqual([]);
          expect(observed.configPath).toBeNull();
          return;
        }
        expect(observed.tools).toContain('happier/qa_ping');
        expect(observed.acpServers ?? []).toEqual([]);
        expect(observed.config.mcpServers.happier.env.QA_CONTEXT).toBe(kind);
        expect(configPath).not.toBe(join(directory, '.copilot', 'mcp-config.json'));
        await opened?.dispose();
        opened = undefined;
        await expect(access(configPath!)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await opened?.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
});
