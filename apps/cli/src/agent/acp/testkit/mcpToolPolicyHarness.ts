import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import type {
  AgentLaunchObserverBoundaries, AgentMcpToolPolicyContractInput,
  AgentMcpToolPolicyPermissionObservation, AgentMcpToolPolicyCallObservation,
} from '@happier-dev/plugin-sdk/testing';
import { createAgentLaunchObserver } from '../../../../../../packages/plugin-sdk/src/testing/observeAgentLaunch';
import type { AgentAcpRuntimeOptions, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentContribution } from '@happier-dev/plugin-sdk/agents';
import { StrictJsonValueSchema, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { PluginAgentAcpNativeSessionMcpConfigV2 } from '@happier-dev/protocol';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import {
  commitMcpServerCatalogMutationV1, loadMcpServerCatalogV1,
} from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { createMcpServerActionExecuteV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import type { McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { parseMcpToolWireNameV1, ResolvedMcpToolIdentityV1Schema } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { PluginAgentContributionV2Schema, projectMcpServerMaterializationV1, resolveSessionCapabilitiesV1 } from '@happier-dev/protocol';
import { createGeminiAgentRuntime } from '../../../../../../packages/plugins/gemini/src/agent/runtime/factory';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/gemini/src/manifest';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { ServerBoundPermissionRpcHandlerManager } from '@/agent/permissions/testkit/serverBoundPermissionRpcHandlerManager';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createNativeAgentCurrentSessionUiServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { createAcpSessionRuntimeContextFixture } from '@/agent/acp/testkit/runtimeContextFixture';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { materializeMcpServerConfigRecord } from '@/mcp/servers/materializeMcpServerConfigRecord';
import { resolveNodeBackedMcpServerCommand } from '@/mcp/runtime/resolveNodeBackedMcpServerCommand';
import { createPublicAcpExecutionRun, createPublicAcpSession, type PublicAcpComposerDependencies } from '../runtime/publicSession/createPublicAcpSession';
import { isPrimaryAgentContributionDefinition, readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';

const require = createRequire(import.meta.url);
const moduleUrl = (id: string) => JSON.stringify(pathToFileURL(require.resolve(id)).href);

/** An installed executable remains the Agent boundary; no ACP replies are synthesized. */
export type AcpMcpPolicyVendorBoundary = Readonly<{
  executablePath: string;
  prepare(input: Readonly<{ cwd: string }>): Promise<Readonly<Record<string, string>>>;
  dispose(): Promise<void>;
}>;

function writeVendorObserver(dir: string, executablePath: string) {
  return writeAcpTestAgentScript({ dir, fileName: 'mcp-policy-vendor-observer.mjs', source: `
    import { spawn } from 'node:child_process';
    import { createInterface } from 'node:readline';
    import { writeFileSync, appendFileSync } from 'node:fs';
    const argv = [${JSON.stringify(executablePath)}, ...process.argv.slice(2)];
    const child = spawn(argv[0], argv.slice(1), { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const trace = value => appendFileSync(process.env.HAPPIER_MCP_VENDOR_TRACE_FILE || process.env.CAPTURE + '.acp.jsonl', JSON.stringify(value) + '\\n');
    createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line); trace({ direction: 'in', value: message });
      if (message.method === 'session/new') writeFileSync(process.env.CAPTURE,
        JSON.stringify({ argv, env: process.env, acpSessionNew: message.params }));
      child.stdin.write(line + '\\n');
    });
    createInterface({ input: child.stdout }).on('line', line => {
      try { trace({ direction: 'out', value: JSON.parse(line) }); } catch {}
      process.stdout.write(line + '\\n');
    });
    child.stderr.on('data', bytes => { trace({ direction: 'stderr', value: String(bytes) }); process.stderr.write(bytes); });
    child.on('error', error => { process.stderr.write(String(error)); process.exitCode = 1; });
    child.on('exit', code => process.exit(code ?? 1));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    process.stdin.on('end', () => child.stdin.end());
  ` });
}

/** The third-party Agent/process is the boundary. It discovers the actual MCP transport,
 * sends standard ACP permission requests, and dispatches only the selected allow_once.
 * This fixture characterizes the real leaf/composer; it is not a vendor admission probe. */
function writeAgent(dir: string, toolWireFormat: 'canonical' | 'underscore' | 'gemini', tool: string, nativeConfig?: PluginAgentAcpNativeSessionMcpConfigV2, authMethodIds: readonly string[] = [], models?: JsonValue) {
  return writeAcpTestAgentScript({ dir, fileName: 'mcp-policy-agent.mjs', source: `
    import { createInterface } from 'node:readline';
    import { spawnSync } from 'node:child_process';
    import { appendFileSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
    import { join } from 'node:path';
    import { Client } from ${moduleUrl('@modelcontextprotocol/sdk/client/index.js')};
    import { StdioClientTransport } from ${moduleUrl('@modelcontextprotocol/sdk/client/stdio.js')};
    import { zSessionNotification, zRequestPermissionRequest, zRequestPermissionResponse } from ${JSON.stringify(new URL('./schema/zod.gen.js', pathToFileURL(require.resolve('@agentclientprotocol/sdk'))).href)};
    const clients = new Map(); const pending = new Map(); const nativeGrants = new Set(); let nextId = 100; let activePrompt = null;
    const nativeConfig = ${JSON.stringify(nativeConfig ?? null)};
    const trace = value => appendFileSync(process.env.CAPTURE + '.acp.jsonl', JSON.stringify(value) + '\\n');
    const send = value => {
      const schema = value.method === 'session/update' ? zSessionNotification
        : value.method === 'session/request_permission' ? zRequestPermissionRequest : null;
      const validation = schema?.safeParse(value.params);
      trace({ direction: 'out', value, ...(validation ? { validation: validation.success ? 'accepted' : validation.error.issues } : {}) });
      if (validation && !validation.success) throw new Error('ACP fixture schema rejected: ' + JSON.stringify(validation.error.issues));
      process.stdout.write(JSON.stringify(value) + '\\n');
    };
    const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
    const request = (method, params) => new Promise(resolve => {
      const id = nextId++; pending.set(id, resolve); send({ jsonrpc: '2.0', id, method, params });
    });
    createInterface({ input: process.stdin }).on('line', async line => {
      const message = JSON.parse(line);
      trace({ direction: 'in', value: message });
      if (!message.method) {
        if (pending.has(message.id)) pending.get(message.id)(zRequestPermissionResponse.parse(message.result));
        pending.delete(message.id); return;
      }
      try {
        if (message.method === 'initialize') ok(message.id, { protocolVersion: 1, agentCapabilities: {},
          authMethods: ${JSON.stringify(authMethodIds.map(id => ({ id, name: 'Fixture authentication' })))} });
        else if (message.method === 'session/new') {
          writeFileSync(process.env.CAPTURE, JSON.stringify({ argv: process.argv.slice(1), env: process.env, acpSessionNew: message.params }));
          const delivered = nativeConfig
            ? Object.entries(JSON.parse(readFileSync(join(process.env[nativeConfig.configRootEnvKey[process.platform === 'win32' ? 'win32' : 'posix']],
              nativeConfig.directory, nativeConfig.fileName), 'utf8'))[nativeConfig.serversKey]).map(([name, value]) => ({
                name, ...value, env: Object.entries(value.env ?? {}).map(([name, value]) => ({ name, value })) }))
            : message.params.mcpServers;
          for (const server of delivered) {
            const client = new Client({ name: 'acp-boundary', version: '1' });
            await client.connect(new StdioClientTransport({ command: server.command, args: server.args,
              env: { PATH: process.env.PATH, ...Object.fromEntries(server.env.map(entry => [entry.name, entry.value])) } }));
            const listed = await client.listTools();
            if (!listed.tools.some(value => value.name === ${JSON.stringify(tool)})) throw new Error('Fixture tool was not delivered');
            clients.set(server.name, client);
          }
          ok(message.id, { sessionId: 'mcp-policy-provider', ...${JSON.stringify(models ? { models } : {})} });
        } else if (message.method === 'session/cancel') {
          if (activePrompt?.sessionId === message.params.sessionId) {
            activePrompt.cancelled = true;
          }
        } else if (message.method === 'session/prompt') {
          const prompt = { id: message.id, sessionId: message.params.sessionId, cancelled: false }; activePrompt = prompt;
          const promptText = message.params.prompt.find(block => block.type === 'text').text;
          // This peer reports actual accepted user input. The host's existing stale-
          // output fence uses this standard update as the successor prompt boundary.
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: message.params.sessionId,
            update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: promptText } } } });
          const input = JSON.parse(promptText);
          if (input.kind === 'shell') {
            const shell = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({argv:process.argv.slice(1),env:process.env}))'],
              { encoding: 'utf8', env: process.env });
            if (shell.status !== 0) throw new Error('Fixture tool shell failed: ' + shell.stderr);
            const child = JSON.parse(shell.stdout);
            writeFileSync(process.env.CAPTURE + '.shell', shell.stdout);
            send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: message.params.sessionId,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Shell observed for prompt ' + message.id } } } });
          } else {
            const subject = ${toolWireFormat === 'gemini'
              ? "('mcp_' + input.server + '_' + input.tool).replace(/[^a-zA-Z0-9_\\-.:]/g, '_')"
              : toolWireFormat === 'underscore'
              ? "input.server.replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + input.tool.replace(/[^a-zA-Z0-9_-]/g, '_')"
              : "'mcp__' + input.server + '__' + input.tool"};
            // Gemini 0.63.0 Turn.handlePendingFunctionCall carries the native
            // function name in its correlation id; ACP sends a human title only.
            const toolCallId = ${toolWireFormat === 'gemini' ? "subject + '__call-' + message.id" : "'call-' + message.id"};
            const updateTool = update => send({ jsonrpc: '2.0', method: 'session/update', params: {
              sessionId: message.params.sessionId, update: { toolCallId, ...update } } });
            const permission = nativeGrants.has(subject) ? { outcome: { optionId: 'allow' } } : await request('session/request_permission', { sessionId: message.params.sessionId,
              toolCall: { toolCallId, kind: 'other', title: ${toolWireFormat === 'gemini' ? "'Read the team documentation'" : 'subject'}, rawInput: input.arguments },
              options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] });
            // Settle a cancelled prompt after consuming its actual permission
            // response, so the boundary observation precedes the terminal fact.
            writeFileSync(process.env.CAPTURE + '.permission.tmp', JSON.stringify({ invocation: input.fixtureInvocation, server: input.server, tool: input.tool, response: permission }));
            renameSync(process.env.CAPTURE + '.permission.tmp', process.env.CAPTURE + '.permission');
            if (prompt.cancelled) {
              ok(message.id, { stopReason: 'cancelled' });
              if (activePrompt === prompt) activePrompt = null;
              return;
            }
            if (permission?.outcome?.optionId === 'always') nativeGrants.add(subject);
            const allowed = permission?.outcome?.optionId === 'allow' || permission?.outcome?.optionId === 'always';
            if (allowed) {
              const output = await clients.get(input.server).callTool({ name: input.tool, arguments: input.arguments });
              updateTool({ sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: output });
            } else updateTool({ sessionUpdate: 'tool_call_update', status: 'failed' });
            send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: message.params.sessionId,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: (allowed ? 'completed' : 'denied') + ' for prompt ' + message.id } } } });
          }
          ok(message.id, { stopReason: 'end_turn' });
          if (activePrompt === prompt) activePrompt = null;
        } else if (message.id !== undefined) ok(message.id, {});
      } catch (error) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } }); }
    });
    const close = async () => { for (const client of clients.values()) await client.close(); process.exit(0); };
    process.on('SIGTERM', close); process.stdin.on('end', close);
  ` });
}

export function createAcpMcpPolicyFixture(params: Readonly<{
  agent: AgentContribution;
  pluginId: string;
  factory: AgentRuntimeFactory;
  toolWireFormat?: 'canonical' | 'underscore' | 'gemini';
  nativeConfig?: PluginAgentAcpNativeSessionMcpConfigV2;
  /** Auth methods advertised by the third-party boundary, not an auth-selector mock. */
  authMethods?: readonly string[];
  /** Native model state advertised by the third-party process boundary. */
  models?: JsonValue;
  vendor?: AcpMcpPolicyVendorBoundary;
  serverKeys?: readonly [string, string];
  toolNames?: readonly [string, ...string[]];
  initialToolDefault?: 'ask' | 'allow_read_only' | 'allow_all';
}>): AgentMcpToolPolicyContractInput {
  const keys = params.serverKeys ?? ['team-docs', 'team-docs__archive'] as const;
  const tools = params.toolNames ?? ['read_file'] as const;
  const tool = tools[0];
  let cwd = ''; let catalog: McpServerCatalogV1; let revision = 1; let order = 0; let invocation = 0;
  let scope: 'once' | 'session' = 'once';
  const handlers = new WeakMap<Parameters<AgentMcpToolPolicyContractInput['invokeTool']>[0], ProviderEnforcedPermissionHandler>();
  let materialized: Awaited<ReturnType<typeof materializeMcpServerConfigRecord>> | undefined;
  let launchObserver: ReturnType<typeof createAgentLaunchObserver>;
  let permissions: AgentMcpToolPolicyPermissionObservation[] = [];
  let calls: AgentMcpToolPolicyCallObservation[] = [];
  let nativeConfigFiles: string[] = [];
  let vendorEnvironment: Readonly<Record<string, string>> = {};
  let permissionObservationAbort = new AbortController();
  const sessionDisposals: Array<() => Promise<void>> = [];
  const receipt = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/receipt') { response.statusCode = 404; response.end(); return; }
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || !('server' in value) || !('tool' in value)
      || typeof value.server !== 'string' || typeof value.tool !== 'string') throw new Error('Invalid fixture receipt');
    calls.push({ server: value.server, tool: value.tool, order: ++order }); response.end('{}');
  });
  const send = async (runtime: Parameters<AgentMcpToolPolicyContractInput['invokeTool']>[0], input: object) => {
    const events: AgentSessionRuntimeEvent[] = [];
    let settle!: () => void;
    const completed = new Promise<void>(resolve => { settle = resolve; });
    const turnId = `mcp-turn-${++invocation}`;
    const subscription = runtime.watch(event => {
      (launchObserver.boundaries as AgentLaunchObserverBoundaries).recordRuntimeEvent(event);
      if ((event.kind === 'input-rejected' || event.kind === 'input-custody-unknown')
        && event.inputIds.includes(`input-${invocation}`)) {
        events.push(event);
        settle();
        return;
      }
      if (event.kind !== 'runtime-ended' && (!('turnId' in event) || event.turnId !== turnId)) return;
      events.push(event);
      if (['turn-complete', 'turn-failed', 'turn-cancelled', 'runtime-ended'].includes(event.kind)) settle();
    });
    try {
      const admission = await runtime.send({ inputIds: [`input-${invocation}`], input: { text: JSON.stringify({ ...input, fixtureInvocation: invocation }) },
        delivery: { kind: 'newTurn', turnId }, causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' } });
      assert.equal(admission.status, 'admitted', JSON.stringify(admission));
      await completed;
      return { text: events.filter(event => event.kind === 'message-delta').map(event => event.text).join(''),
        terminal: events.find(event => ['turn-complete', 'turn-failed', 'turn-cancelled', 'runtime-ended', 'input-rejected', 'input-custody-unknown'].includes(event.kind))! };
    } finally { subscription.dispose(); }
  };
  const read = () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
    readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: StrictJsonValueSchema.parse(JSON.parse(JSON.stringify(catalog))) } }) });
  const execute = createMcpServerActionExecuteV1({ readCatalog: read,
    mutate: (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog, revision, change, scope: null,
      writeCatalog: async candidate => {
        if (candidate.expectedRevision !== revision || expectedRevision !== revision) return { status: 'conflict', revision };
        catalog = candidate.catalog; return { status: 'updated', revision: ++revision, cursor: revision };
      } }), machine: async () => { throw new Error('This fixture has no Machine mutation'); } });
  return {
    agent: params.agent,
    candidateControl: { off: 'blocked', approval: 'host' },
    fixtureServer: {
      async prepare(input) {
        cwd = input.cwd; revision = 1; order = 0; invocation = 0; permissions = []; calls = []; nativeConfigFiles = [];
        permissionObservationAbort = new AbortController();
        await mkdir(join(cwd, 'native-home'));
        vendorEnvironment = await params.vendor?.prepare({ cwd }) ?? {};
        launchObserver = createAgentLaunchObserver({ home: join(cwd, 'native-home') });
        await new Promise<void>(resolve => receipt.listen(0, '127.0.0.1', resolve));
        const address = receipt.address(); if (!address || typeof address === 'string') throw new Error('Missing receipt address');
        const script = writeAcpTestAgentScript({ dir: cwd, fileName: 'mcp-policy-server.mjs', source: `
          import { McpServer } from ${moduleUrl('@modelcontextprotocol/sdk/server/mcp.js')};
          import { StdioServerTransport } from ${moduleUrl('@modelcontextprotocol/sdk/server/stdio.js')};
          const server = new McpServer({ name: 'contract-mcp', version: '1' });
          for (const tool of ${JSON.stringify(tools)}) server.registerTool(tool, {}, async () => {
            if (process.env.PRIVATE_MARKER !== 'acp-contract-private-marker') throw new Error('Private env did not reach MCP process');
            await fetch(process.env.RECEIPT, { method: 'POST', body: JSON.stringify({ server: process.env.SERVER_KEY, tool }) });
            return { content: [{ type: 'text', text: 'ok' }] };
          });
          await server.connect(new StdioServerTransport());
        ` });
        catalog = { v: 1, servers: keys.map((key, index) => ({ id: `item-${index}`, name: key, title: 'Team docs',
          transport: 'stdio', stdio: { command: process.execPath, args: [script] }, env: {
            PRIVATE_MARKER: { t: 'literal', v: 'acp-contract-private-marker' }, SERVER_KEY: { t: 'literal', v: key },
            RECEIPT: { t: 'literal', v: `http://127.0.0.1:${address.port}/receipt` } }, createdAt: 1, updatedAt: 1 })),
          bindings: keys.map((_, index) => ({ id: `rule-${index}`, serverId: `item-${index}`, enabled: true,
            target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 })) };
        if (params.initialToolDefault) catalog = { ...catalog, servers: catalog.servers.map(server => ({ ...server,
          tools: { default: params.initialToolDefault!, overrides: {} } })) };
        const resolved = resolveSessionCapabilitiesV1({ context: { machineId: 'fixture', directory: cwd,
          machinePlatform: null, projectKey: null, agentId: params.agent.id }, mcp: { ...catalog, strictMode: true },
          skills: null, selection: {}, agentAcceptsUserMcp: true });
        materialized = await materializeMcpServerConfigRecord({ resolved: projectMcpServerMaterializationV1(resolved, cwd),
          tmpDir: cwd, processEnv: {}, deps: { resolveStdioLauncherCommand: async () => {
            const command = await resolveNodeBackedMcpServerCommand({ distEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.mjs'],
              sourceEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.ts'], preferSourceEntrypoint: true });
            return { ...command, args: ['--conditions=happier-source', ...command.args] };
          } } });
        const descriptors = keys.map((key, index) => ({ key, serverId: `item-${index}`, title: 'Team docs', tool,
          config: materialized!.mcpServers[key]! }));
        return { servers: [descriptors[0]!, descriptors[1]!], secrets: ['acp-contract-private-marker'],
          privateConfigFiles: Object.values(materialized.mcpServers).map(config => config.env!.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE!) };
      },
      observeCalls: () => calls,
      async setPolicy(input) {
        for (const [key, setting] of Object.entries(input.settings)) {
          const server = catalog.servers.find(value => value.name === key)!;
          const result = await execute({ actionId: 'mcp.servers.tools.set', input: { serverId: server.id, tools: { [tool]: setting } },
            context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } });
          if (!result.ok) throw new Error(JSON.stringify(result));
        }
        if (input.runtime) handlers.get(input.runtime)?.setPermissionMode(input.permissionMode);
        if (input.runtime) {
          if (!input.runtime.updateConfiguration) throw new Error('The MCP policy runtime cannot update configuration');
          await input.runtime.updateConfiguration(input.configuration);
        }
      },
      async dispose() { permissionObservationAbort.abort(); materialized?.cleanup(); materialized = undefined;
        try { if (receipt.listening) await new Promise<void>((resolve, reject) => receipt.close(error => error ? reject(error) : resolve())); }
        finally {
          try { for (const dispose of sessionDisposals.splice(0)) await dispose(); }
          finally { await params.vendor?.dispose(); }
        } },
    },
    async openSession(request) {
      const signal = new AbortController().signal;
      const session = createMutableApiSessionClientFixture({ sessionId: request.sessionId });
      const rpc = new ServerBoundPermissionRpcHandlerManager(request.sessionId);
      session.rpcHandlerManager.registerHandler = (name, callback) => rpc.registerHandler(name, callback);
      const prompted = new Set<string>();
      const updateAgentState = session.updateAgentState.bind(session);
      session.updateAgentState = async updater => {
        await updateAgentState(updater);
        for (const [id, pending] of Object.entries(session.__getAgentState().requests ?? {})) {
          if (prompted.has(id)) continue;
          const identity = parseMcpToolWireNameV1(pending.tool, new Set(keys));
          if (identity) {
            const resolved = ResolvedMcpToolIdentityV1Schema.parse(pending.mcpTool);
            assert.equal(resolved.server, identity.server);
            assert.equal(resolved.tool, identity.tool);
            assert.equal(resolved.item.serverId, catalog.servers.find(server => server.name === identity.server)!.id);
          }
          prompted.add(id);
          // The authenticated client responds to a published request, not to a guessed
          // synchronous handler return. Automatic policy decisions publish no request.
          queueMicrotask(() => { void Promise.resolve(rpc.handlers.get('permission')!({ id, approved: true,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            // A native offer takes the plain Session decision; tool rules exist only without one.
            ...(scope !== 'session' ? {} : pending.nativeChoices
              ? { decision: 'approved_for_session' } : { allowedTools: [pending.tool] }) })).then(result => {
              assert.equal(result, undefined, `Fixture response rejected: ${JSON.stringify(result)}`);
            }); });
        }
      };
      const handler = new ProviderEnforcedPermissionHandler(session, { logPrefix: '[ACP MCP contract]', getWorkspaceWrites: () => 'allow',
        getMcpToolContext: () => ({ catalog: { status: 'ready', authority: 'active', revision, diagnostics: [], catalog },
          mcpServerIdentities: Object.fromEntries(keys.map((key, index) => [key, { serverId: `item-${index}`, serverTitle: 'Team docs' }])) }) });
      const permissionMode = request.configuration?.permissionIntent.value;
      if (permissionMode !== null && permissionMode !== undefined) handler.setPermissionMode(permissionMode);
      const observedHandler = { async handleToolCall(...args: Parameters<ProviderEnforcedPermissionHandler['handleToolCall']>) {
        const identity = parseMcpToolWireNameV1(args[1], new Set(keys));
        // Genuine native shell calls use the ordinary host policy. A lost MCP
        // identity produces no MCP observation and therefore cannot pass K8c.
        if (!identity) return handler.handleToolCall(...args);
        const before = ++order;
        const result = handler.handleToolCall(...args);
        const settled = await result;
        permissions.push({ ...identity, serverId: catalog.servers.find(value => value.name === identity.server)!.id,
          decision: ['approved', 'approved_for_session', 'approved_execpolicy_amendment'].includes(settled.decision)
            ? 'approved' : 'denied', prompted: prompted.has(args[0]), order: before });
        return settled;
      } };
      const ui = createNativeAgentCurrentSessionUiServices({ permissionHandler: observedHandler, pluginId: params.pluginId,
        contributionId: params.agent.id, runtimeId: params.agent.id, sessionId: request.sessionId, occurrenceId: 'contract-occurrence', isCurrent: () => true, signal });
      const publications = createNativeAgentSessionPublications({ agentId: params.agent.id, session: null, signal,
        isCurrent: () => true, supportsInFlightSteer: false });
      const runtime = await params.factory({ plugin: { id: params.pluginId, version: '0.0.0' }, agent: { id: params.agent.id }, signal });
      const unavailableServices = createUnavailablePluginServices();
      const createComposerDependencies = (options: AgentAcpRuntimeOptions): PublicAcpComposerDependencies => {
        const auth = options.definition?.auth;
        const script = params.vendor ? writeVendorObserver(cwd, params.vendor.executablePath)
          : writeAgent(cwd, params.toolWireFormat ?? 'canonical', tool, params.nativeConfig,
            auth && 'methodId' in auth ? [auth.methodId] : params.authMethods, params.models);
        return { pluginId: params.pluginId, agentId: params.agent.id, signal,
          isCurrent: () => true, interactions: ui.interactions, modes: publications.services.modes, models: publications.services.models,
          media: { registerSourceRoot: async () => { throw new Error('No media in MCP fixture'); } },
          systemTools: { resolve: async request => ({ toolId: request.toolId, launch: { kind: 'binary', executablePath: process.execPath,
            args: [script], env: { CAPTURE: join(cwd, 'capture.json') } } }) },
          managedDependencies: { resolve: async request => {
            assert.equal(request.pluginId, params.pluginId);
            return { command: process.execPath, args: [script], env: { CAPTURE: join(cwd, 'capture.json') }, release() {} };
          } } };
      };
      // Only system executable/help and Session transport are boundary fixtures; the leaf, native
      // home shaping, public composer, transient owner, permission policy and catalog CAS are real.
      const contextFixture = createAcpSessionRuntimeContextFixture({ agent: params.agent, pluginId: params.pluginId,
        occurrenceId: 'contract-occurrence',
        sessionId: request.sessionId, signal, directory: cwd, session, permissionHandler: observedHandler, publications,
        readToolExecutionCapability: () => runtime.toolExecution?.capability ?? null,
        services: {
        ...unavailableServices,
        settings: { ...unavailableServices.settings, forScope: scope => ({
          ...unavailableServices.settings.forScope(scope), get: async () => null,
        }) },
        connectedAccounts: {
          ...unavailableServices.connectedAccounts,
          watch(_purpose, listener) {
            listener({ kind: 'resync', authorityChanged: false }); return { dispose() {} };
          },
          getBinding: async () => null,
        },
        exec: { ...unavailableServices.exec, run: async (request: Readonly<{ args?: readonly string[]; env?: Readonly<Record<string, string>> }>) => {
          if (params.vendor) {
            const output = await promisify(execFile)(params.vendor.executablePath, [...request.args ?? []], {
              env: { ...vendorEnvironment, ...request.env, ...(process.env.PATH ? { PATH: process.env.PATH } : {}) },
            });
            return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
              stdout: new TextEncoder().encode(output.stdout), stderr: new TextEncoder().encode(output.stderr),
              stdoutTruncated: false, stderrTruncated: false };
          }
          return {
        termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
        stdout: new TextEncoder().encode('--acp'), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
        } } },
        protocols: { acp: { open: async (openRequest, options) => {
          const composed = await createPublicAcpSession(openRequest, options, createComposerDependencies(options));
          const capture: { argv: string[]; env: Record<string, string>; acpSessionNew: unknown } = JSON.parse(await readFile(join(cwd, 'capture.json'), 'utf8'));
          const boundaries = launchObserver.boundaries as AgentLaunchObserverBoundaries;
          boundaries.recordLaunch(capture); boundaries.recordAcpSessionNew(capture.acpSessionNew);
          if (params.nativeConfig) {
            const rootKey = params.nativeConfig.configRootEnvKey[process.platform === 'win32' ? 'win32' : 'posix'];
            nativeConfigFiles.push(join(capture.env[rootKey]!, params.nativeConfig.directory, params.nativeConfig.fileName));
          }
          return composed;
        }, openExecutionRunV1: (openRequest, options) =>
          createPublicAcpExecutionRun(openRequest, options, createComposerDependencies(options)),
        } } });
      sessionDisposals.push(() => contextFixture.dispose());
      if (!runtime.sessions) throw new Error('The Agent has no Session factory');
      const sessionRuntime = await runtime.sessions.open({ ...request, launchEnvironment: {
        values: { HOME: join(cwd, 'native-home'), ...(params.vendor ? vendorEnvironment : {
          GOOGLE_GENAI_USE_VERTEXAI: '1', GOOGLE_CLOUD_PROJECT: 'fixture-project', GOOGLE_CLOUD_LOCATION: 'fixture-location',
        }),
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}) },
        unset: Object.keys(process.env).filter(key => key !== 'HOME' && key !== 'PATH'),
      } }, contextFixture.context);
      handlers.set(sessionRuntime, handler);
      return sessionRuntime;
    },
    observeLaunch: () => launchObserver.observeLaunch(),
    nativeConfigFiles: () => nativeConfigFiles,
    async invokeTool(runtime, request) {
      scope = request.approvalScope; const before = permissions.length; const beforeCalls = calls.length;
      const result = await send(runtime, request);
      const observed = permissions.slice(before);
      assert.notEqual(result.terminal.kind, 'runtime-ended', JSON.stringify(result.terminal));
      let identityRefused = false;
      if (!params.vendor && observed.length === 0 && result.terminal.kind !== 'turn-complete') {
        // The host can publish its failed turn before the child receives the
        // cancelled reply. Observe that actual reply with the fixture lifecycle,
        // without classifying an arbitrary failed turn as permission denial.
        let changed!: () => void;
        let failed!: (error: Error) => void;
        const changes = watch(cwd, () => changed?.());
        const abort = () => { changes.close(); failed?.(new Error('Permission observation disposed')); };
        permissionObservationAbort.signal.addEventListener('abort', abort, { once: true });
        changes.on('error', error => failed?.(error));
        let permission: unknown;
        try {
          while (true) {
            const change = new Promise<void>((resolve, reject) => { changed = resolve; failed = reject; });
            void change.catch(() => undefined);
            try { permission = JSON.parse(await readFile(join(cwd, 'capture.json.permission'), 'utf8')); }
            catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
            if (permission && typeof permission === 'object' && 'invocation' in permission && permission.invocation === invocation) break;
            await change;
          }
        } finally { changes.close(); permissionObservationAbort.signal.removeEventListener('abort', abort); }
        if (permission && typeof permission === 'object' && 'server' in permission && 'tool' in permission
          && permission.server === request.server && permission.tool === request.tool && 'response' in permission
          && permission.response && typeof permission.response === 'object' && 'outcome' in permission.response
          && permission.response.outcome && typeof permission.response.outcome === 'object'
          && 'outcome' in permission.response.outcome) {
          identityRefused = permission.response.outcome.outcome === 'cancelled';
        }
      }
      const denied = observed.some(value => value.decision === 'denied') || identityRefused;
      if (!denied) assert.equal(result.terminal.kind, 'turn-complete', JSON.stringify(result.terminal));
      // ACP text is presentation, not call evidence. The actual MCP receipt and
      // terminal outcome decide completion even if the host emits no message delta.
      assert.ok(denied || calls.slice(beforeCalls).some(call => call.server === request.server && call.tool === request.tool),
        `No actual MCP receipt: ${JSON.stringify({ result, observed })}`);
      return { outcome: denied ? 'denied' : 'completed', permissions: observed };
    },
    async observeToolShell(runtime) {
      const result = await send(runtime, { kind: 'shell' });
      assert.equal(result.terminal.kind, 'turn-complete', JSON.stringify(result.terminal));
      return JSON.parse(await readFile(join(cwd, 'capture.json.shell'), 'utf8'));
    },
  };
}

/** Declarative Agents share the real host factory; each case consumes its authored runtime.
 * A passing boundary fixture is source characterization, never installed-vendor evidence. */
export async function createDeclarativeAcpMcpPolicyFixtures(vendorForAgent?: (agent: AgentContribution) => AcpMcpPolicyVendorBoundary | undefined): Promise<AgentMcpToolPolicyContractInput[]> {
  const [{ readAgentCatalogSnapshot }, { normalizePluginDeclarativeAcpRuntime }, { createHostDeclarativeAcpAgentRuntimeFactory }] = await Promise.all([
    import('@/agent/catalog/snapshot'), import('@/agent/acp/runtime/definition/plugin'),
    import('@/plugins/runtime/runner/createHostDeclarativeAcpAgentRuntimeFactory'),
  ]);
  return [...readAgentCatalogSnapshot().agentDefinitionsById.values()].flatMap(entry => {
    const agent = entry.richDefinition?.definition;
    if (!agent || !isPrimaryAgentContributionDefinition(agent) || agent.runtime.kind !== 'acp' || !entry.pluginId) return [];
    const runtime = normalizePluginDeclarativeAcpRuntime(agent.runtime);
    const vendor = vendorForAgent?.(agent);
    return [createAcpMcpPolicyFixture({ agent, pluginId: entry.pluginId,
      ...(vendor ? { vendor } : {}),
      factory: createHostDeclarativeAcpAgentRuntimeFactory(runtime, {
        executionRunContextV1: readAgentSessionCapabilities(agent)?.executionRunContext?.versions.includes(1) === true,
      }), ...(agent.runtime.definition?.mcp?.nativeSessionConfig
        ? { nativeConfig: agent.runtime.definition.mcp.nativeSessionConfig } : {}) })];
  });
}

export function createGeminiMcpPolicyFixture(vendor?: AcpMcpPolicyVendorBoundary,
  factory: AgentRuntimeFactory = createGeminiAgentRuntime): AgentMcpToolPolicyContractInput {
  const parsed = parsePluginManifest(PLUGIN_MANIFEST);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  const agent = parsed.manifest.contributes.agents?.find(agent => agent.id === 'gemini');
  if (!agent) throw new Error('Missing authored Gemini Agent');
  return createAcpMcpPolicyFixture({ agent: PluginAgentContributionV2Schema.parse(agent), pluginId: parsed.manifest.id, factory,
    toolWireFormat: 'gemini', ...(vendor ? { vendor } : {}) });
}

/** The custom first-party leaves consume their own real factories, including native
 * settings/account preparation. Only process, account and settings storage are boundaries. */
export async function createPluginAcpMcpPolicyFixtures(): Promise<AgentMcpToolPolicyContractInput[]> {
  const [grok, grokManifest, auggie, auggieManifest, cursor, cursorManifest, copilot, copilotManifest,
    ohMyPi, ohMyPiManifest, custom, customManifest] = await Promise.all([
    import('../../../../../../packages/plugins/grok/src/agent/runtime/factory'), import('../../../../../../packages/plugins/grok/src/manifest'),
    import('../../../../../../packages/plugins/auggie/src/agent/runtime/factory'), import('../../../../../../packages/plugins/auggie/src/manifest'),
    import('../../../../../../packages/plugins/cursor/src/agent/runtime/engine'), import('../../../../../../packages/plugins/cursor/src/manifest'),
    import('../../../../../../packages/plugins/copilot/src/agent/runtime/factory'), import('../../../../../../packages/plugins/copilot/src/manifest'),
    import('../../../../../../packages/plugins/ohmypi/src/agent/runtime/engine'), import('../../../../../../packages/plugins/ohmypi/src/manifest'),
    import('../../../../../../packages/plugins/custom-acp/src/agent/runtime/factory'), import('../../../../../../packages/plugins/custom-acp/src/manifest'),
  ]);
  const cases = [
    { id: 'grok', manifest: grokManifest.PLUGIN_MANIFEST, factory: grok.createGrokAgentRuntime, authMethods: ['cached_token'] },
    { id: 'auggie', manifest: auggieManifest.PLUGIN_MANIFEST, factory: auggie.createAuggieAgentRuntime },
    { id: 'cursor', manifest: cursorManifest.PLUGIN_MANIFEST, factory: cursor.createCursorAgentRuntime },
    { id: 'copilot', manifest: copilotManifest.PLUGIN_MANIFEST, factory: copilot.createCopilotAgentRuntime },
    { id: 'ohmypi', manifest: ohMyPiManifest.PLUGIN_MANIFEST, factory: ohMyPi.createOhMyPiAgentRuntime },
    { id: 'custom-acp', manifest: customManifest.PLUGIN_MANIFEST, factory: custom.createCustomAcpAgentRuntime },
  ];
  return cases.map(entry => {
    const parsed = parsePluginManifest(entry.manifest);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    const agent = parsed.manifest.contributes.agents?.find(agent => agent.id === entry.id);
    if (!agent) throw new Error(`Missing authored Agent ${entry.id}`);
    return createAcpMcpPolicyFixture({ agent: PluginAgentContributionV2Schema.parse(agent), pluginId: parsed.manifest.id, factory: entry.factory,
      ...('authMethods' in entry ? { authMethods: entry.authMethods } : {}) });
  });
}

