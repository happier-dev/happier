import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { json } from 'node:stream/consumers';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { handleToolsCommand } from './tools';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { runCompiledActionCliCommand } from '@/cli/actions/executeCommand';
import { findCompiledActionCliCommand, listCompiledActionCliCommands } from '@/cli/actions/compiledCommands';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { handleActionsCommand } from './actions';
import { executeSessionMcpAction } from './toolsSessionMcp';
import { createActionExecutor, type ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createHappierToolInventory } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { formatHappierMcpToolFailure, prepareHappierMcpToolInventory, registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { createNativeAgentSessionInteractionHostRuntime } from '@/agent/runtime/bridges/executionRun/nativeAgentExecutionRun';
import { createNativeSessionBoundary, createVoiceSessionContextLease } from '@/agent/runtime/bridges/executionRun/testkit/nativeSessionContext';
import { createLazyExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/hostRuntime/lazy';
import { withExecutionRunHostRuntimeCleanup } from '@/agent/runtime/bridges/executionRun/hostRuntime/cleanup';
import { withExecutionRunPermissionResponder } from '@/agent/runtime/bridges/executionRun/hostRuntime/permissionResponder';
import { withExecutionRunRuntimeIdentityPublication } from '@/agent/runtime/identity/executionRunRuntimeIdentityPublication';
import { borrowExecutionRunRuntimeTurn } from '@/agent/runtime/bridges/executionRun/hostRuntime/borrowedTurn';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';

afterEach(() => vi.unstubAllEnvs());

const skillResult = { skillId: 'selected-skill', name: 'review', skillMd: 'Review the owning Session.',
  revision: '1:1', provenance: { kind: 'written' }, modified: false, trust: 'text_only',
  cost: { descriptionTokens: 0, bodyTokens: 6 }, rules: [], files: [] };

const deploymentInput = { serverId: 'home', environmentId: 'staging', expectedRevision: 1, targetLinkId: 'target',
  expectedTargetLinkRevision: 1, contentArtifactId: 'content', contentHeaderVersion: 1,
  contentBodyVersion: 1, requestKey: 'agent-deploy' };
const deploymentSettings = normalizeActionsSettingsV1({ v: 1,
  approvalWaivedSurfaces: { 'deployments.deploy': ['agent', 'cli'] },
  approvalProfiles: [{ id: 'reviewed-deploys', name: 'Reviewed deploys',
    actions: { 'deployments.deploy': { approvalRequiredSurfaces: ['agent', 'mcp'] } } }] });
const actionSessionId = 'cmvbeu0ig0040m203zcysq5v8';
const diagnosticFailure = { ok: false, errorCode: 'action_failed', error: 'Action failed',
  requestId: 'diagnostic-action', effectAttempted: false, details: { expectedRevision: 3 },
  failureCause: { phase: 'execution_authorization', errorClass: 'Error', errorCode: 'machine_manage_required', httpStatus: null },
} as const;

async function createDeploymentAdmissionFixture() {
  const root = await mkdtemp(join(tmpdir(), 'happier-action-inbox-'));
  const inbox: ApprovalRequest[] = [];
  // Profile and Artifact persistence are storage boundaries; admission, profile
  // resolution, approval production and deployment dispatch remain real.
  const readActionApprovalProfileId = vi.fn(async (context: ActionExecutorContext) =>
    context.actionCaller?.kind === 'session' ? 'reviewed-deploys' : undefined);
  const deploymentAction = vi.fn(async () => ({ ok: true as const, environmentId: 'staging', revision: 2,
    deploymentId: 'deployment', deploymentRevision: 1, state: 'succeeded' as const }));
  const executor = createActionExecutor({
    readActionApprovalProfileId,
    resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: 'staging' } }),
    prepareDeploymentAction: async () => ({ input: deploymentInput, preview: { sourceMethod: 'gitIntegration' } }),
    approvalsCreate: async ({ request }) => {
      const stored = ApprovalRequestV2Schema.parse(request);
      const artifactId = `approval-${inbox.length + 1}`;
      await writeFile(join(root, `${artifactId}.json`), JSON.stringify(stored));
      inbox.push(stored);
      return { artifactId };
    },
    deploymentAction,
  });
  return { executor, inbox, readActionApprovalProfileId, deploymentAction,
    close: () => rm(root, { recursive: true, force: true }) };
}

// Real Unix HTTP + MCP SDK server is the CLI's network boundary. It deliberately
// binds one owner independently of the untrusted CLI --session-id argument.
async function openSessionMcpBoundary(useHappierOwner = false, actionExecutor?: ReturnType<typeof createActionExecutor>) {
  const root = await mkdtemp(join(tmpdir(), 'happier-agent-tools-'));
  const socketPath = join(root, 'mcp.sock');
  const bearer = 's'.repeat(43);
  const calls: unknown[] = [];
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${bearer}`) {
      response.writeHead(401).end();
      return;
    }
    const mcp = actionExecutor ? new McpServer({ name: 'owning-session', version: '1' })
      : useHappierOwner ? createHappierMcpServer({ sessionId: 'owning-session',
      getServerBinding: () => ({ serverId: 'home', serverUrl: 'https://home.example.test' }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'owning-session', encryptionMode: 'plain' }),
      updateMetadata: () => undefined,
    }, { authorityScope: 'session' }).mcp
      : new Server({ name: 'owning-session', version: '1' }, { capabilities: { tools: {} } });
    if (actionExecutor && mcp instanceof McpServer) {
      const bridge = createActionToolExecutorBridge({ surface: 'agent', actionsSettings: deploymentSettings, defaultSessionMachineId: 'runtime-machine',
        executor: { execute: (actionId, input, context) => actionExecutor.execute(actionId, input, {
          ...context, serverId: 'home', runtimeAccountId: 'owner',
          actionCaller: { kind: 'session', sessionId: actionSessionId, starterDepth: 0, turnDepth: 0 },
        }) } });
      const inventory = createHappierToolInventory({ surface: 'agent' });
      registerHappierMcpBuiltInTools(mcp, { sessionId: actionSessionId, surface: 'agent',
        toolInventory: prepareHappierMcpToolInventory({ sessionId: actionSessionId, inventory: {
          ...inventory, tools: inventory.tools.filter(tool => tool.name === 'action_execute'),
        } }), deps: { ...bridge, changeTitle: async () => ({ success: true }),
          resolveActionOptions: args => bridge.resolveActionOptions(args, actionSessionId) },
      });
    }
    if (mcp instanceof Server) {
    mcp.setRequestHandler(ListToolsRequestSchema, async request => ({ tools: [{ name: 'change_title',
      description: 'Rename the owning Session', inputSchema: { type: 'object' as const } },
      ...(request.params?._meta?.['happier/tool-sources'] === true ? [{ name: 'echo', inputSchema: { type: 'object' as const },
        _meta: { 'happier/tool-source': 'selected-custom' } }] : [])] }));
    mcp.setRequestHandler(CallToolRequestSchema, async request => {
      calls.push(request.params);
      if (request.params._meta?.['happier/tool-source'] === 'selected-custom') {
        const result = { content: [{ type: 'text' as const, text: JSON.stringify(request.params.arguments) }] };
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, result }) }], structuredContent: { ok: true, result } };
      }
      if (request.params.name === 'action_execute') {
        // The real registrar serializes ActionExecuteResult.result, not another
        // ActionExecuteResult wrapper. Keep this network fixture at that seam.
        const input = request.params.arguments?.input;
        if (input && typeof input === 'object' && 'skillId' in input && input.skillId === 'diagnostic') {
          return formatHappierMcpToolFailure(diagnosticFailure);
        }
        const refused = input && typeof input === 'object' && 'skillId' in input && input.skillId === 'refused';
        return { content: [{ type: 'text' as const, text: JSON.stringify(refused
          ? { errorCode: 'approval_required', error: 'Approval required', details: { scope: 'owning-session' } }
          : skillResult) }], isError: Boolean(refused) };
      }
      return request.params.arguments?.refuse === true
        ? { content: [{ type: 'text' as const, text: JSON.stringify({ errorCode: 'approval_required', error: 'Approval required' }) }], isError: true }
        : { content: [{ type: 'text' as const, text: JSON.stringify({ sessionId: 'owning-session', title: request.params.arguments?.title }) }], isError: false };
    });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.once('close', () => { void transport.close(); void mcp.close(); });
    try {
      const body = request.method === 'POST' ? await json(request) : undefined;
      if (actionExecutor && body && typeof body === 'object' && 'method' in body && body.method === 'tools/call') {
        calls.push('params' in body ? body.params : undefined);
      }
      await mcp.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  const contextPath = join(root, 'session-mcp.json');
  await writeFile(contextPath, JSON.stringify({ v: 1, socketPath, bearerToken: bearer }), { mode: 0o600 });
  vi.stubEnv('HAPPIER_SESSION_MCP_CONTEXT_FILE', contextPath);
  return { calls, bearer, socketPath, contextPath, async close() {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  } };
}

describe('Agent tools Session MCP authority', () => {
  it('retains canonical failure identity through the Action options bridge', async () => {
    const executor = createActionExecutor({});
    const bridge = createActionToolExecutorBridge({ executor: {
      execute: (id, input, context) => executor.execute(id, input, {
        ...context, actionRequestId: 'options-diagnostic',
      }),
    } });
    await expect(bridge.resolveActionOptions({ actionId: null, fieldPath: null,
      optionsSourceId: 'missing-source', sessionId: null, limit: null, query: null }, actionSessionId))
      .resolves.toMatchObject({ ok: false, requestId: 'options-diagnostic' });
  });
  it.runIf(process.platform === 'linux')('retains canonical failure diagnostics through the MCP producer and Session CLI reader', async () => {
    const boundary = await openSessionMcpBoundary();
    try {
      await expect(executeSessionMcpAction('skills.read', { skillId: 'diagnostic' })).resolves.toEqual(diagnosticFailure);
    } finally { await boundary.close(); }
  });
  it.runIf(process.platform === 'linux')('retains canonical executor diagnostics through the Action tool bridge and Session CLI reader', async () => {
    const executor = createActionExecutor({
      // Session-list transport is the system boundary; Action admission and projection remain real.
      sessionList: async () => { throw createActionExecuteFailureError(diagnosticFailure); },
    });
    const boundary = await openSessionMcpBoundary(false, executor);
    try {
      await expect(executeSessionMcpAction('session.list', {})).resolves.toMatchObject({
        ...diagnosticFailure, requestId: expect.any(String),
      });
    } finally { await boundary.close(); }
  });
  it.runIf(process.platform === 'linux')('returns the bound native Action result with provider identity through every host wrapper', async () => {
    const bound = await openSessionMcpBoundary();
    const ambient = await openSessionMcpBoundary();
    const native = createNativeSessionBoundary();
    const host = createNativeAgentSessionInteractionHostRuntime({
      runtime: { sessions: { open: native.open } },
      lease: { pluginId: 'acme.voice', pluginVersion: '1', agentId: 'acme.voice/agents/default',
        localAgentId: 'default', occurrenceId: 'bound-action', isCurrent: () => true },
      sessionCapabilities: { open: ['create'], delivery: ['newTurn'], cancel: true },
      createSessionContext: ({ services, signal }) => ({
        ...createVoiceSessionContextLease({ services, signal, async dispose() {} }),
        sessionMcpContext: { v: 1, socketPath: bound.socketPath, bearerToken: bound.bearer },
      }),
      options: { cwd: '/repo', runId: 'bound-action', backendId: 'acme.voice/agents/default', scope: 'session_owned', permissionMode: 'read_only' },
    });
    const runtime = createLazyExecutionRunHostRuntime({ resolveRuntime: async () =>
      withExecutionRunHostRuntimeCleanup(withExecutionRunRuntimeIdentityPublication({
        runtime: withExecutionRunPermissionResponder(borrowExecutionRunRuntimeTurn(host, 'bound-action', () => true, async () => {}), {}),
        identity: { runtimeDescriptor: null, runtimeCapabilities: {}, runtimeFacets: null },
      }), async () => {}),
    });
    try {
      expect(runtime.executeAction).toEqual(expect.any(Function));
      await expect(runtime.executeAction?.('skills.read', { skillId: 'selected' }, 'provider-call-1'))
        .resolves.toEqual({ ok: true, result: skillResult });
      await expect(runtime.executeAction?.('skills.read', { skillId: 'refused' }, 'provider-call-2'))
        .resolves.toEqual({ ok: false, errorCode: 'approval_required', error: 'Approval required', details: { scope: 'owning-session' } });
      expect(bound.calls).toMatchObject([
        { name: 'action_execute', arguments: { actionId: 'skills.read', input: { skillId: 'selected' } }, _meta: { 'happier/action-request-id': 'provider-call-1' } },
        { name: 'action_execute', _meta: { 'happier/action-request-id': 'provider-call-2' } },
      ]);
      expect(ambient.calls).toEqual([]);
      expect(process.env.HAPPIER_SESSION_MCP_CONTEXT_FILE).toBe(ambient.contextPath);
      expect(native.opens).toEqual([]);
    } finally { await runtime.dispose(); await host.dispose(); await ambient.close(); await bound.close(); }
  });

  it.runIf(process.platform === 'linux').each([false, true])(
    'auto-detects generic Session Action identity and creates an Inbox approval before any deployment (wait=%s)', async wait => {
      const fixture = await createDeploymentAdmissionFixture();
      const boundary = await openSessionMcpBoundary(false, fixture.executor);
      const readCredentialsFn = vi.fn(async (): Promise<never> => { throw new Error('Person credentials must not be read'); });
      const readCredentialsForServerIdFn = vi.fn(async (): Promise<never> => { throw new Error('Person credentials must not be read'); });
      const createExecutorFn = vi.fn(async (): Promise<never> => { throw new Error('Person executor must not be created'); });
      const output = captureStdoutJsonOutput();
      const previousExitCode = process.exitCode;
      process.exitCode = undefined;
      try {
        await handleActionsCommand(['invoke', 'deployments.deploy', '--input-json', JSON.stringify(deploymentInput),
          '--request-id', 'cli-deploy-correlation', ...(wait ? ['--wait'] : []), '--json'], { readCredentialsFn, readCredentialsForServerIdFn, createExecutorFn });
        expect(output.json(), output.chunks.join('')).toMatchObject({ ok: true, data: { kind: 'approval_request_created',
          actionId: 'deployments.deploy', artifactId: 'approval-1' } });
        expect(fixture.inbox).toMatchObject([{ status: 'open', actionId: 'deployments.deploy', actionArgs: deploymentInput,
          createdBy: { surface: 'agent', sessionId: actionSessionId },
          executionOriginV1: { requestId: 'cli-deploy-correlation', caller: { kind: 'session', sessionId: actionSessionId } } }]);
        expect(fixture.readActionApprovalProfileId).toHaveBeenCalledOnce();
        expect(fixture.deploymentAction).not.toHaveBeenCalled();
        expect(readCredentialsFn).not.toHaveBeenCalled();
        expect(readCredentialsForServerIdFn).not.toHaveBeenCalled();
        expect(createExecutorFn).not.toHaveBeenCalled();
        expect(boundary.calls).toMatchObject([{ name: 'action_execute', arguments: {
          actionId: 'deployments.deploy', input: deploymentInput,
        } }]);
      } finally { output.restore(); process.exitCode = previousExitCode; await boundary.close(); await fixture.close(); }
    });

  it('keeps a person invocation on its CLI admission path when Session context is absent', async () => {
    vi.stubEnv('HAPPIER_SESSION_MCP_CONTEXT_FILE', '');
    const fixture = await createDeploymentAdmissionFixture();
    const readCredentialsFn = vi.fn(async () => ({ token: 'person-test-token', encryption: null }));
    const output = captureStdoutJsonOutput();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await handleActionsCommand(['invoke', 'deployments.deploy', '--input-json', JSON.stringify(deploymentInput), '--json'], {
        readCredentialsFn,
        getServerProfileFn: async () => { throw new Error('No saved Home in this fixture'); },
        createExecutorFn: () => ({ execute: (actionId, input, context) => fixture.executor.execute(actionId, input,
          { ...context, actionsSettings: deploymentSettings }),
          resolveSessionTarget: async (): Promise<never> => { throw new Error('No Session target'); } }),
      });
      expect(output.json(), output.chunks.join('')).toMatchObject({ ok: true, data: { deploymentId: 'deployment', state: 'succeeded' } });
      expect(readCredentialsFn).toHaveBeenCalledOnce();
      expect(fixture.inbox).toEqual([]);
      expect(fixture.deploymentAction).toHaveBeenCalledOnce();
    } finally { output.restore(); process.exitCode = previousExitCode; await fixture.close(); }
  });

  it.runIf(process.platform === 'linux')('refuses malformed generic Session Action identity metadata before admission', async () => {
    const fixture = await createDeploymentAdmissionFixture();
    const boundary = await openSessionMcpBoundary(false, fixture.executor);
    try {
      expect(await executeSessionMcpAction('deployments.deploy', deploymentInput, { actionRequestId: ' invalid ' }))
        .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      expect(fixture.inbox).toEqual([]);
      expect(fixture.readActionApprovalProfileId).not.toHaveBeenCalled();
      expect(fixture.deploymentAction).not.toHaveBeenCalled();
    } finally { await boundary.close(); await fixture.close(); }
  });

  it.runIf(process.platform === 'linux')('fails a stale detected Session context without falling back to person credentials', async () => {
    const boundary = await openSessionMcpBoundary();
    await boundary.close();
    const readCredentialsFn = vi.fn(async (): Promise<never> => { throw new Error('Person credentials must not be read'); });
    const output = captureStdoutJsonOutput();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await handleActionsCommand(['invoke', 'deployments.deploy', '--input-json', JSON.stringify(deploymentInput), '--json'], { readCredentialsFn });
      expect(output.json()).toMatchObject({ ok: false });
      expect(readCredentialsFn).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally { output.restore(); process.exitCode = previousExitCode; }
  });

  it.runIf(process.platform === 'linux').each([
    ['--server-id', 'another-home'], ['--machine-id', 'another-machine'], ['--project-directory', '/another-project'],
  ] as const)('refuses Session retargeting with %s before opening person credentials', async (flag, target) => {
    const boundary = await openSessionMcpBoundary();
    const readCredentialsFn = vi.fn(async (): Promise<never> => { throw new Error('Person credentials must not be read'); });
    const getServerProfileFn = vi.fn(async (): Promise<never> => { throw new Error('Person Home must not be read'); });
    const output = captureStdoutJsonOutput();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await handleActionsCommand(['invoke', 'deployments.deploy', '--input-json', JSON.stringify(deploymentInput),
        flag, target, '--json'], { readCredentialsFn, getServerProfileFn });
      expect(output.json(), output.chunks.join('')).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
      expect(boundary.calls).toEqual([]);
      expect(readCredentialsFn).not.toHaveBeenCalled();
      expect(getServerProfileFn).not.toHaveBeenCalled();
    } finally { output.restore(); process.exitCode = previousExitCode; await boundary.close(); }
  });

  it.runIf(process.platform === 'linux').each([
    { actionId: 'deployments.deploy', flag: '--server-id', value: 'another-home', input: deploymentInput },
    { actionId: 'deployments.deploy', flag: '--machine-id', value: 'another-machine', input: deploymentInput },
    { actionId: 'workflow.run.start', flag: '--project-directory', value: '/another-project', input: {
      runId: '11111111-1111-4111-8111-111111111111',
      source: { kind: 'inline', definition: { version: 1, inputs: [], defaults: {}, blocks: ['work'] } },
    } },
  ])('refuses friendly Session retargeting with $flag before dispatching $actionId', async ({ actionId, flag, value, input }) => {
    const boundary = await openSessionMcpBoundary();
    const command = listCompiledActionCliCommands().find(candidate => candidate.actionId === actionId);
    if (!command) throw new Error(`Missing compiled ${actionId} command`);
    const readCredentialsFn = vi.fn(async (): Promise<never> => { throw new Error('Person credentials must not be read'); });
    const output = captureStdoutJsonOutput();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCompiledActionCliCommand({ command,
        argv: [...command.path, '--input-json', JSON.stringify(input), flag, value, '--json'], deps: { readCredentialsFn } });
      expect(output.json(), output.chunks.join('')).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
      expect(boundary.calls).toEqual([]);
      expect(readCredentialsFn).not.toHaveBeenCalled();
    } finally { output.restore(); process.exitCode = previousExitCode; await boundary.close(); }
  });
  it.runIf(process.platform === 'linux')('reports invalid root tool arguments without a socket failure or Account fallback', async () => {
    const boundary = await openSessionMcpBoundary(true);
    const readCredentials = vi.fn(async () => { throw new Error('stored Account credentials must not be read'); });
    const output = captureStdoutJsonOutput();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      for (const args of ['null', '[]', '17']) {
        output.chunks.length = 0;
        await handleToolsCommand(['call', '--agent-bridge', '--source', 'happier', '--tool', 'change_title',
          '--args-json', args, '--json'], { readCredentials });
        expect(output.json(), `root arguments: ${args}`).toMatchObject({ ok: false, error: { code: 'invalid_parameters' } });
      }
      expect(readCredentials).not.toHaveBeenCalled();
    } finally { output.restore(); process.exitCode = previousExitCode; await boundary.close(); }
  });

  it.runIf(process.platform === 'linux')('routes a friendly Agent Action command through the owning Session instead of a local Account executor', async () => {
    const boundary = await openSessionMcpBoundary();
    const readCredentialsFn = vi.fn(async () => { throw new Error('stored Account credentials must not be read'); });
    const createExecutorFn = vi.fn(async (): Promise<never> => { throw new Error('local Account executor must not be created'); });
    const command = findCompiledActionCliCommand(['skills', 'read'], listCompiledActionCliCommands());
    if (!command) throw new Error('Missing canonical skills.read command');
    const output = captureStdoutJsonOutput();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCompiledActionCliCommand({ command, argv: ['skills', 'read', '--input-json', '{"skillId":"selected-skill"}', '--json'],
        deps: { readCredentialsFn, createExecutorFn } });
      expect(output.json()).toMatchObject({ ok: true, data: skillResult });
      expect(boundary.calls).toEqual([{ name: 'action_execute', arguments: {
        actionId: 'skills.read', input: { skillId: 'selected-skill' },
      } }]);
      expect(readCredentialsFn).not.toHaveBeenCalled();
      expect(createExecutorFn).not.toHaveBeenCalled();
      output.chunks.length = 0;
      await runCompiledActionCliCommand({ command, argv: ['skills', 'read', '--input-json', '{"skillId":"refused"}', '--json'],
        agentBridgeSessionId: 'untrusted-target', deps: { readCredentialsFn, createExecutorFn } });
      expect(output.json()).toMatchObject({ ok: false, error: { code: 'approval_required',
        details: { scope: 'owning-session' } } });
    } finally { output.restore(); process.exitCode = previousExitCode; await boundary.close(); }
  });

  it.runIf(process.platform === 'linux')('lists and calls the owning authenticated Session with zero Account credential reads', async () => {
    const boundary = await openSessionMcpBoundary();
    const readCredentials = vi.fn(async () => { throw new Error('stored Account credentials must not be read'); });
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      for (const command of ['list', 'call'] as const) {
        const output = captureStdoutJsonOutput();
        try {
          await handleToolsCommand([command, '--agent-bridge', '--session-id', 'another-session',
            ...(command === 'call' ? ['--source', 'happier', '--tool', 'change_title', '--args-json', '{"title":"new"}', '--tool-call-id', 'pi-native-call'] : []),
            '--json'], { readCredentials });
          expect(output.json()).toMatchObject(command === 'list'
            ? { ok: true, data: { sources: { happier: [{ name: 'change_title' }] } } }
            : { ok: true, data: { source: 'happier', tool: 'change_title', output: { sessionId: 'owning-session', title: 'new' } } });
          expect(output.chunks.join('')).not.toContain(boundary.bearer);
          expect(output.chunks.join('')).not.toContain(boundary.socketPath);
        } finally { output.restore(); }
      }
      expect(boundary.calls).toEqual([{ name: 'change_title', arguments: { title: 'new' },
        _meta: { 'happier/tool-call-id': 'pi-native-call' } }]);
      expect(readCredentials).not.toHaveBeenCalled();
    } finally { process.exitCode = previousExitCode; await boundary.close(); }
  });

  it.runIf(process.platform === 'linux')('preserves the Session refusal code without a local Action execution', async () => {
    const boundary = await openSessionMcpBoundary();
    const readCredentials = vi.fn(async () => { throw new Error('stored Account credentials must not be read'); });
    const output = captureStdoutJsonOutput();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await handleToolsCommand(['call', '--agent-bridge', '--source', 'happier', '--tool', 'change_title',
        '--args-json', '{"refuse":true}', '--json'], { readCredentials });
      expect(output.json()).toMatchObject({ ok: false, error: { code: 'approval_required' } });
      expect(readCredentials).not.toHaveBeenCalled();
      expect(boundary.calls).toHaveLength(1);
    } finally { output.restore(); process.exitCode = previousExitCode; await boundary.close(); }
  });

  it.runIf(process.platform === 'linux')('uses the authenticated host profile for custom sources without Account credentials', async () => {
    const boundary = await openSessionMcpBoundary();
    const readCredentials = vi.fn(async () => { throw new Error('stored Account credentials must not be read'); });
    const output = captureStdoutJsonOutput();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await handleToolsCommand(['call', '--agent-bridge', '--source', 'selected-custom', '--tool', 'echo',
        '--args-json', '{"value":"custom input"}', '--json'], { readCredentials });
      expect(output.json()).toMatchObject({ ok: true, data: { source: 'selected-custom', tool: 'echo',
        output: { content: [{ type: 'text', text: '{"value":"custom input"}' }] } } });
      expect(readCredentials).not.toHaveBeenCalled();
      expect(boundary.calls).toEqual([{ name: 'echo', arguments: { value: 'custom input' },
        _meta: { 'happier/tool-source': 'selected-custom' } }]);
    } finally { output.restore(); process.exitCode = previousExitCode; await boundary.close(); }
  });

  it.each([
    { command: 'list', marker: '--agent-bridge' }, { command: 'call', marker: '--agent-bridge' },
    { command: 'list', marker: '--session-agent-bridge' }, { command: 'call', marker: '--session-agent-bridge' },
  ] as const)('refuses $command ($marker) without Session context before reading stored credentials', async ({ command, marker }) => {
    vi.stubEnv('HAPPIER_SESSION_MCP_CONTEXT_FILE', '');
    vi.stubEnv('HAPPIER_HOME_DIR', '/private/custodian-home');
    const readCredentials = vi.fn(async () => { throw new Error('stored Account credentials must not be read'); });
    const output = captureStdoutJsonOutput();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await handleToolsCommand([command, marker, '--session-id', 'untrusted-target',
        ...(command === 'call' ? ['--source', 'happier', '--tool', 'change_title', '--args-json', '{"title":"new"}'] : []),
        '--json'], { readCredentials });
      expect(output.json()).toMatchObject({ ok: false, error: { code: 'not_authenticated' } });
      expect(readCredentials).not.toHaveBeenCalled();
      expect(output.chunks.join('')).not.toContain('/private/custodian-home');
      expect(process.exitCode).toBe(1);
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });
});
