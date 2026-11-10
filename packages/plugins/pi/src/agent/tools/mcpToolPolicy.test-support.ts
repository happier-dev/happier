import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { strict as assert } from 'node:assert';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { AgentExecutionRunOpenRequest, AgentExecutionRunRuntime, AgentExecutionRunRuntimeContextV1, AgentSessionRuntimeContext, AgentSessionRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { PluginProtocolClientHandle, PluginProtocolClientSpec } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import type { AgentMcpToolPolicyContractInput, AgentMcpToolPolicyCallObservation,
  AgentMcpToolPolicyPermissionObservation } from '@happier-dev/plugin-sdk/testing';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { projectMcpServerMaterializationV1, resolveSessionCapabilitiesV1 } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { TranscriptRawAgentEventV1Schema, type TranscriptRawAgentEventV1 } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import { createMcpServerActionExecuteV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { commitMcpServerCatalogMutationV1, loadMcpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import type { McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/catalogSchemasV1';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { AgentState } from '@/api/types';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { ServerBoundPermissionRpcHandlerManager } from '@/agent/permissions/testkit/serverBoundPermissionRpcHandlerManager';
import { createNativeAgentSessionServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';
import { createNativeAgentSessionHostServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { materializeMcpServerConfigRecord, type MaterializeMcpServerConfigRecordResult } from '@/mcp/servers/materializeMcpServerConfigRecord';
import { resolveNodeBackedMcpServerCommand } from '@/mcp/runtime/resolveNodeBackedMcpServerCommand';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { PI_PLUGIN } from '../../manifest.js';
import { createPiAgentRuntime } from '../runtime/engine.js';
import { PI_MCP_APPROVAL_CALL_PREFIX } from './extensionSource.js';

class ApprovalSession {
  readonly sessionId = 'mcp-policy-contract';
  readonly rpcHandlerManager = new ServerBoundPermissionRpcHandlerManager(this.sessionId);
  state: AgentState = { requests: {}, completedRequests: {} };
  getAgentStateSnapshot() { return this.state; }
  getMetadataSnapshot() { return null; }
  updateAgentState(update: (state: AgentState) => AgentState) { this.state = update(this.state); return this.state; }
  async getAuthenticatedAccountId() { return 'fixture-account'; }
}

// Only OS transport and the remote model/MCP endpoints are fixture boundaries.
// The installed Pi CLI loads the production extension and emits its own native
// tool execution and confirm records; no test synthesizes permission requests.
const require = createRequire(import.meta.url);
// The installed package exports ESM only. Resolve its declared CLI through
// Node's package search roots, as the existing spawned real-owner fixture does.
const piCliPath = (require.resolve.paths('pi-coding-agent-0821') ?? [])
  .map(root => join(root, 'pi-coding-agent-0821', 'dist', 'cli.js')).find(existsSync);
if (!piCliPath) throw new Error('The installed Pi 0.82.1 CLI is unavailable');
const logger = { debug() {}, info() {}, warn() {}, error() {} };
let cwd = '';
let sequence = 0;
let catalog: McpServerCatalogV1;
let revision = 1;
let modelServer: Server;
let receiptServer: Server;
let providerExtensionPath = '';
let fixtureMcpServerPath = '';
let capabilityNotices: TranscriptRawAgentEventV1[] = [];
let privateConfigFiles: string[] = [];
let materialized: MaterializeMcpServerConfigRecordResult | undefined;
let calls: (AgentMcpToolPolicyCallObservation & Readonly<{ privateTokenDelivered: boolean }>)[] = [];
let permissions: AgentMcpToolPolicyPermissionObservation[] = [];
let advertisedTools = new Set<string>();
let corruptNativeApprovalCorrelation = false;
let approvalScope: 'once' | 'session' = 'once';
let handler: ProviderEnforcedPermissionHandler;
let session: ApprovalSession;
let controller: AbortController;
let launch = { argv: [] as string[], env: {} as Record<string, string>, acpSessionNew: null,
  appServerRequests: [], filesWritten: [] as string[], runtimeEvents: [] as AgentSessionRuntimeEvent[] };
const events = new WeakMap<AgentSessionRuntime, AgentSessionRuntimeEvent[]>();

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture has no TCP address');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function sse(model: string, name?: string, args: unknown = {}) {
  const content = name ? { type: 'tool_use', id: randomUUID(), name, input: {} } : { type: 'text', text: '' };
  const records = [
    { type: 'message_start', message: { id: randomUUID(), type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: content },
    { type: 'content_block_delta', index: 0, delta: name
      ? { type: 'input_json_delta', partial_json: JSON.stringify(args) }
      : { type: 'text_delta', text: 'Finished' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: name ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  return records.map(record => `event: ${record.type}\ndata: ${JSON.stringify(record)}\n\n`).join('');
}

async function spawnPi(spec: Extract<PluginProtocolClientSpec, { kind: 'jsonStream' }>): Promise<PluginProtocolClientHandle<'jsonStream'>> {
  const startedAtMs = Date.now();
  const argv = [piCliPath, ...(spec.launch.args ?? []), '--no-session', '--extension', providerExtensionPath,
    '--provider', 'fixture', '--model', 'fixture'];
  // Fixture isolation is deliberate: never collect or pass an Account's real
  // ambient environment. Observe only this complete synthetic native launch.
  const env: Record<string, string> = { HOME: cwd, USERPROFILE: cwd, TMPDIR: cwd, TEMP: cwd, TMP: cwd,
    PATH: process.platform === 'win32' ? dirname(process.execPath) : `${dirname(process.execPath)}:/usr/bin:/bin`,
    ...spec.launch.env };
  for (const key of spec.launch.unsetEnvKeys ?? []) delete env[key];
  launch = { ...launch, argv: [process.execPath, ...argv], env };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--happier-tools-config' || argv[index] === '--extension') launch.filesWritten.push(argv[index + 1]!);
  }
  const child = spawn(process.execPath, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const subscribers = new Set<(record: JsonValue) => void | Promise<void>>();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let record: JsonValue = JSON.parse(line);
    if (record && typeof record === 'object' && !Array.isArray(record) && record.type === 'response') {
      console.info('Real Pi RPC response', JSON.stringify({ command: record.command, elapsedMs: Date.now() - startedAtMs }));
    }
    if (record && typeof record === 'object' && !Array.isArray(record) && record.type === 'extension_error') console.info('Real Pi extension failure', JSON.stringify(record));
    // Sensitivity case at the genuine native RPC transport boundary: leave the
    // installed vendor's tool event and confirmation intact except its id link.
    if (corruptNativeApprovalCorrelation && record && typeof record === 'object' && !Array.isArray(record)
      && record.type === 'extension_ui_request' && record.method === 'confirm'
      && typeof record.title === 'string' && record.title.startsWith(PI_MCP_APPROVAL_CALL_PREFIX)) {
      record = { ...record, title: `${PI_MCP_APPROVAL_CALL_PREFIX}unmatched-${record.id}` };
    }
    for (const listener of subscribers) void listener(record);
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += String(data); });
  const terminal = new Promise<PluginProcessResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ termination: { observed: signal
      ? { kind: 'signal', signal } : { kind: 'exit', exitCode: code ?? 0 }, requestedBy: { kind: 'none' } },
      stdout: new Uint8Array(), stderr: new TextEncoder().encode(stderr), stdoutTruncated: false, stderrTruncated: false }));
  });
  const write = async (data: Uint8Array) => { await new Promise<void>((resolve, reject) => child.stdin.write(data, error => error ? reject(error) : resolve())); };
  const dispose = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await terminal;
    lines.close();
  };
  return { client: { write: async record => {
    console.info('Real Pi RPC command', JSON.stringify({ type: record && typeof record === 'object' && !Array.isArray(record) ? record.type : null,
      elapsedMs: Date.now() - startedAtMs }));
    await write(new TextEncoder().encode(`${JSON.stringify(record)}\n`));
  },
    subscribe(listener) { subscribers.add(listener); return { dispose() { subscribers.delete(listener); } }; }, dispose },
    process: { write, closeStdin: async () => { child.stdin.end(); }, async waitForExit() { return (await this.wait()).termination; },
    wait: () => terminal, onOutput: () => ({ dispose() {} }), dispose },
    wait: () => terminal, dispose };
}

const serverSource = `
import { createInterface } from 'node:readline';
const lines = createInterface({input:process.stdin});
lines.on('line', async line => {
  const message=JSON.parse(line); if (message.id===undefined) return;
  if (message.method === process.env.MCP_FIXTURE_FAIL) {
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:'private-failure-sentinel'}})+'\\n');
    return;
  }
  let result;
  if(message.method==='initialize') result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
  else if(message.method==='tools/list') result={tools:[{name:'echo',inputSchema:{type:'object',properties:{}}}]};
  else if(message.method==='tools/call') {
    const delivered=process.env.MCP_PRIVATE_FIXTURE_TOKEN==='pi-mcp-private-sentinel';
    await fetch(process.env.MCP_FIXTURE_RECEIPT,{method:'POST',body:JSON.stringify({server:process.env.MCP_FIXTURE_SERVER,tool:message.params.name,privateTokenDelivered:delivered})});
    result={isError:!delivered,content:[{type:'text',text:delivered?'received-private-token':'missing-private-token'}]};
  } else return;
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
});
`;

const executeToolsSet = createMcpServerActionExecuteV1({
  readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
    readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }) }),
  mutate: (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog, revision, change, scope: null,
    writeCatalog: async candidate => {
      if (expectedRevision !== revision || candidate.expectedRevision !== revision) return { status: 'conflict', revision };
      catalog = candidate.catalog;
      return { status: 'updated', revision: ++revision, cursor: revision };
    } }),
  machine: async () => { throw new Error('Account tool policy never starts a machine'); },
});

async function invoke(runtime: AgentSessionRuntime, name: string, args: Readonly<Record<string, unknown>>, scope: 'once' | 'session') {
  approvalScope = scope;
  const observed = events.get(runtime)!;
  const start = observed.length;
  const turnId = randomUUID();
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const completed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const subscription = runtime.watch(event => {
    if (event.kind === 'turn-complete' && event.turnId === turnId) finish();
    if (event.kind === 'runtime-ended') fail(new Error(`Pi ended during the tool call: ${JSON.stringify(event)}`));
  });
  try {
    const sent = await runtime.send({ inputIds: [randomUUID()], input: { text: `happier-fixture:${JSON.stringify({ name, args })}` },
      delivery: { kind: 'newTurn', turnId } });
    assert.equal(sent.status, 'admitted');
    await completed;
  } finally { subscription.dispose(); }
  const result = observed.slice(start).find(event => event.kind === 'tool-result');
  if (!result || result.kind !== 'tool-result') throw new Error('Installed Pi emitted no tool result');
  return result;
}

function createRuntimeServices() {
  const nativeServices = createNativeAgentSessionServices({ permissionHandler: {
    async handleToolCall(id, name, args, options) {
      const order = ++sequence;
      const pending = handler.handleToolCall(id, name, args, options);
      const prompted = session.state.requests?.[id] !== undefined;
      if (prompted) {
        const offered = session.state.requests?.[id]?.nativeChoices;
        const choice = offered?.choices.find(choice => choice.scope === approvalScope
          && (choice.decision === 'approved' || choice.decision === 'approved_for_session'));
        if (offered && !choice) throw new Error(`No offered ${approvalScope} Pi MCP approval`);
        const response = await session.rpcHandlerManager.handlers.get('session.permission.respond')?.(offered && choice
          ? { id, nativeChoice: { requirementId: offered.requirementId, choiceId: choice.id } }
          : { id, approved: true, ...(approvalScope === 'session' ? { decision: 'approved_for_session' } : {}) });
        if (response !== undefined) throw new Error(`Pi MCP approval failed: ${JSON.stringify(response)}`);
      }
      const result = await pending;
      if (name.startsWith('mcp__')) {
        const server = name.slice('mcp__'.length).split('__')[0]!;
        permissions.push({ server, serverId: `catalog-${server}`, tool: 'echo', order, prompted,
          decision: result.decision === 'approved' || result.decision === 'approved_for_session' ? 'approved' : 'denied' });
      }
      return result;
    },
  }, pluginId: 'happier.agent.pi', contributionId: 'pi', runtimeId: 'pi/runtime', sessionId: session.sessionId,
    occurrenceId: randomUUID(), immutableGenerationId: 'fixture-generation',
    sourceCustody: { kind: 'managed', immutableGenerationId: 'fixture-generation', installSource: 'npm' },
    isCurrent: () => true, signal: controller.signal });
  return { logger, interactions: nativeServices.interactions,
    connectedAccounts: { watch(_purpose: string, listener: () => void) { listener(); return { dispose() {} }; },
      getBinding: async () => null },
    exec: { systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'pi-cli' }, executablePath: piCliPath }) },
      clients: { spawn: spawnPi } },
  };
}

export type PiMcpToolPolicyContractFixture = AgentMcpToolPolicyContractInput & Readonly<{
  openRun(request: AgentExecutionRunOpenRequest): Promise<AgentExecutionRunRuntime>;
  observePermissions(): readonly AgentMcpToolPolicyPermissionObservation[];
  observeServerCalls(): readonly (AgentMcpToolPolicyCallObservation & Readonly<{ privateTokenDelivered: boolean }>)[];
  observeCapabilityNotices(): readonly TranscriptRawAgentEventV1[];
}>;

export function createPiMcpToolPolicyContractFixture(options: Readonly<{
  corruptNativeApprovalCorrelation?: boolean;
  brokenServer?: 'spawn' | 'initialize' | 'list';
}> = {}): PiMcpToolPolicyContractFixture {
  const addBrokenServer = (servers: AgentExecutionRunOpenRequest['mcpServers']) => ({
    ...servers,
    ...(options.brokenServer ? { broken: {
      command: options.brokenServer === 'spawn' ? join(cwd, 'missing-command') : process.execPath,
      args: [fixtureMcpServerPath], env: { MCP_FIXTURE_FAIL: options.brokenServer === 'initialize' ? 'initialize' : 'tools/list' },
    } } : {}),
  });
  return {
  agent: PI_PLUGIN.manifest.contributes.agents.find(agent => agent.id === 'pi')!,
  candidateControl: { off: 'hidden', approval: 'host' },
  observeLaunch: () => launch,
  async observeToolShell(runtime) {
    const result = await invoke(runtime, 'bash', { command: 'env' }, 'once');
    assert.equal(result.isError, false, 'The installed Pi tool shell environment must be observed');
    return { argv: launch.argv, env: { observedToolOutput: JSON.stringify(result.output) } };
  },
  fixtureServer: {
    async prepare(input) {
      cwd = input.cwd; sequence = 0; revision = 1; calls = []; permissions = []; privateConfigFiles = []; capabilityNotices = [];
      advertisedTools = new Set();
      corruptNativeApprovalCorrelation = options.corruptNativeApprovalCorrelation === true;
      launch = { argv: [], env: {}, acpSessionNew: null, appServerRequests: [], filesWritten: [], runtimeEvents: [] };
      controller = new AbortController(); session = new ApprovalSession();
      setActiveAccountSettingsSnapshot({ scopeKey: 'pi-mcp-fixture', source: 'network', settings: accountSettingsParse({}),
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], rawSettings: {},
        promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
      receiptServer = createServer(async (request, response) => {
        if (request.method !== 'POST') { response.writeHead(404); response.end(); return; }
        let body = ''; for await (const part of request) body += String(part);
        calls.push({ ...JSON.parse(body), order: ++sequence }); response.end('ok');
      });
      const receipt = await listen(receiptServer);
      modelServer = createServer(async (request, response) => {
        if (request.method !== 'POST') { response.writeHead(404); response.end(); return; }
        let body = ''; for await (const part of request) body += String(part);
        const payload = JSON.parse(body);
        const last = payload.messages.at(-1);
        const text = typeof last.content === 'string' ? last.content : last.content.find((part: { type: string }) => part.type === 'text')?.text;
        const call = typeof text === 'string' && text.startsWith('happier-fixture:') ? JSON.parse(text.slice('happier-fixture:'.length)) : null;
        if (call) {
          advertisedTools = new Set((payload.tools ?? []).map((tool: { name: string }) => tool.name));
          console.info('Real Pi tool request', JSON.stringify({ requested: call.name, offered: [...advertisedTools] }));
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(sse(payload.model, call?.name, call?.args));
      });
      const modelUrl = await listen(modelServer);
      providerExtensionPath = join(cwd, 'fixture-provider.mjs');
      await writeFile(providerExtensionPath, `export default function(pi){pi.registerProvider('fixture',{baseUrl:${JSON.stringify(modelUrl)},apiKey:'fixture-key',api:'anthropic-messages',models:[{id:'fixture',name:'fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:8192}]});}`);
      const serverPath = join(cwd, 'fixture-mcp.mjs'); fixtureMcpServerPath = serverPath; await writeFile(serverPath, serverSource);
      const identities = ['a', 'b'].map(key => ({ key, serverId: `catalog-${key}`, title: 'Duplicate fixture', tool: 'echo' }));
      catalog = { v: 1, bindings: identities.map(server => ({ id: `rule-${server.key}`, serverId: server.serverId, enabled: true,
        target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 })), servers: identities.map(server => ({ id: server.serverId, name: server.key, title: server.title,
        transport: 'stdio', stdio: { command: process.execPath, args: [serverPath] }, env: {
          MCP_FIXTURE_SERVER: { t: 'literal', v: server.key }, MCP_FIXTURE_RECEIPT: { t: 'literal', v: receipt },
          MCP_PRIVATE_FIXTURE_TOKEN: { t: 'literal', v: 'pi-mcp-private-sentinel' },
        }, createdAt: 1, updatedAt: 1,
        tools: { default: 'ask', overrides: {} } })) };
      materialized = await materializeMcpServerConfigRecord({ tmpDir: cwd, processEnv: {},
        resolved: projectMcpServerMaterializationV1(resolveSessionCapabilitiesV1({ context: { machineId: 'fixture', directory: cwd,
          machinePlatform: null, projectKey: null, agentId: 'pi' }, mcp: { ...catalog, strictMode: true }, skills: null,
          selection: {}, agentAcceptsUserMcp: true }), cwd),
        deps: { resolveStdioLauncherCommand: async () => {
          const command = await resolveNodeBackedMcpServerCommand({ distEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.mjs'],
            sourceEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.ts'], preferSourceEntrypoint: true });
          return { ...command, args: ['--conditions=happier-source', ...command.args] };
        } },
      });
      const servers = identities.map(identity => ({ ...identity, config: materialized!.mcpServers[identity.key]! }));
      privateConfigFiles.push(...servers.map(server => server.config.env!.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE!));
      handler = new ProviderEnforcedPermissionHandler(session as unknown as ApiSessionClient, { logPrefix: '[Pi MCP]',
        getWorkspaceWrites: () => 'allow', getMcpToolContext: () => ({ catalog: { status: 'ready', authority: 'active',
          revision, diagnostics: [], catalog }, mcpServerIdentities: Object.fromEntries(servers.map(server => [server.key, { serverId: server.serverId, serverTitle: server.title }])) }) });
      return { servers: [servers[0]!, servers[1]!], secrets: ['pi-mcp-private-sentinel'], privateConfigFiles };
    },
    observeCalls: () => calls,
    async setPolicy(input) {
      for (const [key, setting] of Object.entries(input.settings)) {
        const result = await executeToolsSet({ actionId: 'mcp.servers.tools.set', input: { serverId: `catalog-${key}`, tools: { echo: setting } },
          context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } });
        assert.equal(result.ok, true);
      }
      handler.setPermissionMode(input.permissionMode);
    },
    async dispose() {
      controller.abort();
      try { await Promise.all([close(modelServer), close(receiptServer)]); }
      finally { materialized?.cleanup(); materialized = undefined; resetActiveAccountSettingsSnapshotForTests(); }
    },
  },
  async openSession(request) {
    // The host context is the boundary; native preparation and launch stay real.
    const sessionServices = createNativeAgentSessionHostServices({
      owners: { features: { isEnabled: () => false }, sessionHooks: {}, transcripts: { fileFollow: {} },
        accountUsage: {}, mcp: {}, toolExecution: {} },
      agentId: 'pi', sessionId: request.sessionId, directory: cwd, signal: controller.signal, isCurrent: () => true,
      session: { sessionId: request.sessionId, updateMetadata() {},
        async enqueueAgentMessageCommitted(...args: Parameters<ApiSessionClient['enqueueAgentMessageCommitted']>) {
          const payload = args[1];
          if (payload.type === 'event') capabilityNotices.push(TranscriptRawAgentEventV1Schema.parse(payload.data));
          return { persisted: true, delivered: false };
        },
      },
      publications: { models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
        activeInput: { bind: () => ({ dispose() {} }), publishStatus() {} } },
      readToolExecutionCapability: () => null,
      // Unused host capabilities are inert fixture fields; the real transcript
      // publisher and strict event consumer above are never replaced.
    } as never);
    const runtime = await createPiAgentRuntime().sessions.open({ ...request, mcpServers: addBrokenServer(request.mcpServers),
      launchEnvironment: { values: { PI_CODING_AGENT_DIR: cwd }, unset: [] },
    }, { signal: controller.signal, services: createRuntimeServices(),
      session: { id: request.sessionId, services: { transcripts: sessionServices.transcripts } },
    } as unknown as AgentSessionRuntimeContext);
    const observed: AgentSessionRuntimeEvent[] = []; events.set(runtime, observed);
    runtime.watch(event => { observed.push(event); launch.runtimeEvents.push(event); });
    return runtime;
  },
  async openRun(request) {
    const open = createPiAgentRuntime().sessions.executionRunContextV1!.open;
    return await open({ ...request, mcpServers: addBrokenServer(request.mcpServers), launchEnvironment: { values: { PI_CODING_AGENT_DIR: cwd }, unset: [] } },
      { signal: controller.signal, services: createRuntimeServices(),
        scope: { kind: 'execution_run', executionRunId: request.runId },
        executionRun: { id: request.runId, services: {} },
      } as unknown as AgentExecutionRunRuntimeContextV1);
  },
  observePermissions: () => permissions,
  observeCapabilityNotices: () => capabilityNotices,
  observeServerCalls: () => calls,
  async invokeTool(runtime, request) {
    const before = permissions.length;
    const result = await invoke(runtime, `mcp__${request.server}__${request.tool}`, request.arguments, request.approvalScope);
    const name = `mcp__${request.server}__${request.tool}`;
    return { outcome: !advertisedTools.has(name) ? 'hidden' : result.isError ? 'denied' : 'completed', permissions: permissions.slice(before) };
  },
  };
}
