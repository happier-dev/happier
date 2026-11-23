import { afterEach, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { ActionIdSchema, WorkflowActionInputSchemasV1, WorkflowActionOutputSchemasV1, WorkflowDefinitionV1Schema, type ActionId,
  accountSettingsParse, createRoleSourceReaderV1 } from '@happier-dev/protocol';
import { createWorkflowDefinitionActions } from '@happier-dev/protocol/actions/executor/workflowDefinitions';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { ActionPolicyOutputSchemas } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionResolverV1';
import { formatWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionRefV1';
import { projectWorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows/workflowPluginSourceContractV1';
import { configuration } from '@/configuration';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { WORKFLOW_RUN_STORAGE_HTTP_PATH } from '@/daemon/workflows/workflowRunStorageClient';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { resolveCliAgentStartContextV1 } from '@/session/actions/resolveCliAgentStartContextV1';
import { registerAccountHomeHttp, registerPlainArtifactRoutes } from '@/session/actions/widgetApproval.testkit';
import { createExternalMcpServer } from './createExternalMcpServer';

afterEach(() => vi.restoreAllMocks());

const accountId = 'workflow-mcp-owner';

async function withActionHome(
  test: (home: Readonly<{
    cli: ReturnType<typeof createCliActionExecutorFromCredentials>;
    invokeCli: (actionId: ActionId, input: unknown) => Promise<{ isError: boolean; result: unknown }>;
    invokeMcp: (actionId: ActionId, input: unknown) => Promise<{ isError: boolean; result: unknown }>;
    artifacts: ReturnType<typeof registerPlainArtifactRoutes>;
  }>) => Promise<void>,
  options?: Readonly<{ bound?: boolean; configureHome?: (app: FastifyInstance) => void }>,
) {
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`,
    encryption: null, credentialProvenance: 'stored_session' as const };
  const app = Fastify();
  const features = registerAccountHomeHttp(app, { accountId, serverId: 'srv_workflow_mcp' });
  const artifacts = registerPlainArtifactRoutes(app, accountId);
  options?.configureHome?.(app);
  const sessionId = 'c123456789012345678901234';
  app.get('/v1/features/authenticated', async () => ({ ...features,
    features: { ...features.features, workflows: { enabled: true } } }));
  const serverHttpBaseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const snapshot = { status: 'ready' as const, provenance: 'authenticated' as const,
    features: { ...features, features: { ...features.features, workflows: { enabled: true } } } };
  const resolveServerFeaturesSnapshot = async () => snapshot;
  const cli = createCliActionExecutorFromCredentials({ credentials, serverId: configuration.activeServerId,
    serverApiUrl: serverHttpBaseUrl, serverIdentityId: 'srv_workflow_mcp', resolveServerFeaturesSnapshot });
  const runtime = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createExternalMcpServer({ credentials,
    ...(options?.bound === false ? {} : { defaultSessionId: sessionId, machineId: 'workflow-machine' }),
    daemonControlTarget: null, serverFeaturesSnapshot: snapshot }));
  const client = new Client({ name: 'workflow-action-parity', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const invokeCli = async (actionId: ActionId, input: unknown) => {
    const action = await cli.execute(actionId, input, { surface: 'cli', authority: 'present_user',
      ...(actionId === 'actions.policy.set' ? { presentUserConfirmation: { actionId } } : {}) });
    return { isError: !action.ok, result: action.ok ? action.result : action };
  };
  const invokeMcp = async (actionId: ActionId, input: unknown) => {
    const reply = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: { actionId, input } }));
    const text = reply.content.find(row => row.type === 'text');
    if (text?.type !== 'text') throw new Error('Missing MCP Action result');
    return { isError: reply.isError === true, result: JSON.parse(text.text) as unknown };
  };
  try {
    await runtime.mcp.connect(serverTransport);
    await client.connect(clientTransport);
    await test({ cli, invokeCli, invokeMcp, artifacts });
  } finally {
    await client.close();
    await runtime.mcp.close();
    await app.close();
  }
}

it('creates and updates the same read Workflow through CLI and MCP while retaining Ask and validation', async () => {
  await withActionHome(async ({ cli, invokeMcp, artifacts }) => {
    const definition = { version: 1, blocks: [{ kind: 'action', id: 'read-policy', actionId: 'actions.policy.get',
      input: { profiles: { kind: 'literal', value: true } } }] };
    const definitionId = '12222222-2222-4222-8222-222222222222';
    const mcpDefinitionId = '13333333-3333-4333-8333-333333333333';
    const metadata = { title: 'Read policy' };
    // Home HTTP/persistence are the only replacement boundary. Both real
    // executors, compiler, authority, Account mode and Ask policy stay intact.
    const created = await cli.execute('workflow.definition.create', { definitionId, definition, metadata },
      { surface: 'cli', authority: 'present_user' });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) return;
    const saved = WorkflowActionOutputSchemasV1['workflow.definition.create'].parse(created.result);
    const mcpCreated = await invokeMcp('workflow.definition.create', { definitionId: mcpDefinitionId, definition, metadata });
    const mcpUpdated = await invokeMcp('workflow.definition.update', { definitionId, expectedRevision: saved.revision,
      definition, metadata: { title: 'Updated policy read' } });
    const deletion = await invokeMcp('workflow.definition.delete', { definitionId });
    const invalidDefinitionId = '15555555-5555-4555-8555-555555555555';
    const malformed = await invokeMcp('workflow.definition.create', { definitionId: invalidDefinitionId, metadata,
      definition: { version: 1, blocks: [{ kind: 'action', id: 'invalid-policy-read', actionId: 'actions.policy.get',
        input: { profiles: { kind: 'literal', value: false } } }] } });
    expect.soft(mcpCreated, 'MCP CREATE must persist the same admitted read definition').toMatchObject({
      isError: false, result: { definitionId: mcpDefinitionId },
    });
    expect.soft(mcpUpdated, 'MCP UPDATE must commit the requested revision').toMatchObject({
      isError: false, result: { definitionId },
    });
    expect.soft(artifacts.read(mcpDefinitionId)).toBeDefined();
    expect.soft(artifacts.read(definitionId)?.bodyVersion).toBe(2);
    expect.soft(deletion, 'Consequential MCP deletion retains its default Ask without erasing the Workflow').toMatchObject({
      isError: false, result: { kind: 'approval_request_created' },
    });
    expect.soft(artifacts.read(definitionId)).toBeDefined();
    expect.soft(malformed).toMatchObject({ isError: true, result: { errorCode: 'invalid_input' } });
    expect.soft(artifacts.read(invalidDefinitionId)).toBeUndefined();
  });
});

it.each(['cli', 'mcp', 'bound MCP'] as const)(
  'reads Home Run membership and summary, returns a missing Run, and retains cancellation through %s', async surface => {
    const runId = '18888888-8888-4888-8888-888888888888';
    const missingRunId = '19999999-9999-4999-8999-999999999999';
    const automationId = '1aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const machineId = 'retained-workflow-machine';
    const store = createWorkflowRunStorageTestkit({ runId, machineId, accountId, origin: { kind: 'automation', automationId } });
    await withActionHome(async ({ invokeCli, invokeMcp }) => {
      const invoke = surface === 'cli' ? invokeCli : invokeMcp;
      const list = () => invoke('workflow.run.list', { projection: 'membership' });
      expect(await list()).toMatchObject({ isError: false, result: { projection: 'membership',
        runs: [{ id: runId, machineId, state: 'queued', revision: 0, origin: { kind: 'automation', automationId } }],
        metadataByRunId: {} } });
      expect(await invoke('workflow.run.get', { runId: missingRunId })).toMatchObject({
        isError: true, result: { errorCode: 'run_not_found' },
      });
      expect(await invoke('workflow.run.cancel', { runId, expectedRevision: 0 })).toMatchObject({
        isError: false, result: { intent: 'cancelled', run: { id: runId, machineId, state: 'cancelled', revision: 1 } },
      });
      expect(await list()).toMatchObject({ isError: false, result: {
        runs: [{ id: runId, machineId, state: 'cancelled', revision: 1 }],
      } });
      expect(await invoke('workflow.run.summaries', { automationIds: [automationId] })).toMatchObject({
        isError: false, result: {
          automationSummaries: [{ automationId, lastRun: { id: runId, state: 'cancelled' } }],
          remainingAutomationIds: [],
        },
      });
    }, {
      bound: surface === 'bound MCP',
      configureHome(app) {
        app.post<{ Body: { operation: string; request?: unknown; runId?: unknown; expectedRevision?: unknown } }>(
          WORKFLOW_RUN_STORAGE_HTTP_PATH, async (request, reply) => {
            const { operation, request: readRequest, runId: requestedRunId, expectedRevision } = request.body;
            if (operation === 'list') {
              const { projection } = WorkflowActionInputSchemasV1['workflow.run.list'].parse(readRequest);
              if (projection === 'membership') return { projection, runs: [store.run()] };
            }
            if (operation === 'summaries') {
              const summaryRequest = WorkflowActionInputSchemasV1['workflow.run.summaries'].parse(readRequest);
              if ('automationIds' in summaryRequest && summaryRequest.automationIds.includes(automationId)) {
                const { id, state, workflowCustodyState, attentionRequired, failureUnseen, invocationAttentionRequired, createdAt } = store.run();
                return { automationSummaries: [{ automationId, lastRun: { id, state, workflowCustodyState, attentionRequired,
                  failureUnseen, invocationAttentionRequired, createdAt, startedAt: createdAt } }], remainingAutomationIds: [] };
              }
            }
            if (operation === 'get' && requestedRunId === missingRunId) {
              return reply.code(404).send({ error: 'run_not_found' });
            }
            if (operation === 'cancel' && requestedRunId === runId) {
              return await store.execute({ operation, ...WorkflowActionInputSchemasV1['workflow.run.cancel']
                .parse({ runId: requestedRunId, expectedRevision }) });
            }
            throw new Error(`Unexpected Workflow Run storage operation: ${operation}`);
          });
      },
    });
  },
);

it.each(['cli', 'mcp', 'bound MCP'] as const)(
  'reads saved approval profiles and requires a person to change them through %s', async surface => {
    await withActionHome(async ({ invokeCli, invokeMcp, artifacts }) => {
      const invoke = surface === 'cli' ? invokeCli : invokeMcp;
      const profileChange = { kind: 'create', profile: { name: 'Shared release profile', actions: {} } };
      const create = () => invoke('actions.policy.set', { profileChange });
      const read = () => invoke('actions.policy.get', { profiles: true });
      expect(await read()).toEqual({ isError: false, result: { profiles: [] } });
      if (surface !== 'cli') {
        expect(await create()).toMatchObject({ isError: false,
          result: { kind: 'approval_request_created', actionId: 'actions.policy.set' } });
        expect(await read()).toEqual({ isError: false, result: { profiles: [] } });
      }
      const created = await invokeCli('actions.policy.set', { profileChange });
      expect(created).toMatchObject({ isError: false });
      const result = ActionPolicyOutputSchemas['actions.policy.set'].parse(created.result);
      if (!('profileChange' in result) || result.profileChange.kind !== 'create') throw new Error('Missing created profile');
      expect(artifacts.read(result.profileChange.id)).toBeDefined();
      expect(await read()).toMatchObject({ isError: false, result: {
        profiles: [{ id: result.profileChange.id, profile: { id: result.profileChange.id, name: profileChange.profile.name } }],
      } });
    }, { bound: surface === 'bound MCP' });
  },
);

it.each(['session', 'workflowRun'] as const)(
  'retains materialized fieldless and nested ceilings for a host-stamped %s caller labeled MCP', async kind => {
  const sessionId = 'c123456789012345678901234';
  const runId = '16666666-6666-4666-8666-666666666666';
  const authority = resolveCliAgentStartContextV1({ sessionId, machineId: 'workflow-machine', directory: '/repo',
    backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }, metadata: {},
    appliedChildSelection: { status: 'applied',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }, modelId: null, connectedServices: null },
    starterDepth: 0, turnDepth: 0, callerPermissionMode: 'read-only', settings: accountSettingsParse({}),
    accountRoleOverrides: { status: 'ready', overrides: {} }, roleSourceInventory: await createRoleSourceReaderV1({})(),
    ...(kind === 'workflowRun' ? { runCaller: { runId, runDepth: 0 } } : {}),
  });
  if ('ok' in authority) throw new Error('Missing canonical caller authority fixture');
  const elevated = WorkflowDefinitionV1Schema.parse({ version: 1, defaults: { permissionMode: 'yolo' },
    blocks: [{ kind: 'action', id: 'read-policy', actionId: 'actions.policy.get',
      input: { profiles: { kind: 'literal', value: true } } }] });
  const pluginSource = projectWorkflowPluginSourceV1({ pluginId: 'external.recipes', pluginVersion: '1.0.0',
    definition: { id: 'elevated', title: 'Elevated nested recipe', definition: elevated } });
  const readPluginWorkflows = () => [pluginSource];
  const create = vi.fn(async () => { throw new Error('A denied definition must not reach storage'); });
  // Artifact persistence and remote Machine availability are boundaries. The
  // caller adapter, catalog, nested resolver, compiler and admission stay real.
  const owner = createWorkflowDefinitionActions({ encodeListCursor: () => '', readPluginWorkflows,
    artifactStore: { create, read: async () => null, list: async () => ({ items: [] }),
      update: async () => { throw new Error('Unexpected update'); },
      delete: async () => { throw new Error('Unexpected delete'); } },
    resolveMaterializer: async () => ({ effects: { resolveTargetAvailability: async () => true,
      readActionContract: async id => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(id)))),
      readWorkflowDefinition: ref => resolveWorkflowDefinitionRefV1(formatWorkflowDefinitionRefV1(ref), { readPluginWorkflows }),
    } }),
  });
  const caller = { surface: 'mcp' as const, authority: 'account_automation' as const,
    actionCaller: kind === 'session' ? { kind: 'session' as const, sessionId, starterDepth: 0, turnDepth: 0 }
      : { kind: 'workflowRun' as const, runId },
    agentStartContext: authority, sessionAgentSpawnPolicyV1: { v: 1 as const } };
  const nested = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [
    { kind: 'workflow', id: 'nested', workflowRef: pluginSource.workflow, input: {} },
  ] });
  for (const definition of [elevated, nested]) {
    await expect(owner.create({ definitionId: '17777777-7777-4777-8777-777777777777',
      metadata: { title: 'Refused escalation' }, definition }, undefined, caller)).rejects.toMatchObject({
      code: 'definition_exceeds_authority', details: { cause: { code: 'permission_exceeds_ceiling' } },
    });
  }
  expect(create).not.toHaveBeenCalled();
});
