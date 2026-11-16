import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent,
  createActionExecutor, WorkflowDefinitionV1Schema, type ActionExecutorDeps,
  type WorkflowDefinitionEditOpV1,
  accountSettingsParse,
  createRoleSourceReaderV1,
  type WorkflowDefinitionV1,
} from '@happier-dev/protocol';
import { freezeWorkflowActionContractV1, actionSpecToActionDefinitionV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { projectWorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows/workflowPluginSourceContractV1';
import { resolveWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionResolverV1';
import { formatWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionRefV1';
import { applyWorkflowDefinitionEditsV1 } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';

import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createWorkflowDefinitionActions } from './workflowDefinitions';
import { createWorkflowActionExecutor } from './workflowActionExecutor';
import { resolveCliAgentStartContextV1 } from './resolveCliAgentStartContextV1';
import { createCliActionDeps } from './createCliActionDeps';
import { createSessionRoleContext } from '../roles/sessionRoleContext';
import { createRoleSourceReader } from '../roles/roleSources';
import { createActionSettingsProvider } from '../../settings/actionsSettingsProvider';
import { resetActiveAccountSettingsSnapshotForTests } from '../../settings/accountSettings/activeAccountSettingsSnapshot';
import { createAccountEncryptionCurrentnessFixture } from '../../testkit/backends/sessionFixtures';
import type { ExecutionRunAppliedParentSelection } from '../../agent/runtime/bridges/executionRun/runtime/openInputs';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

// HTTP is the system boundary; codecs, Artifact CAS, policy and both executors stay real.
const http = vi.hoisted(() => ({ defaults: {}, get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('axios', () => ({ default: http }));

const definitionId = '11111111-1111-4111-8111-111111111111';
const expectedRevision = { headerVersion: 2, bodyVersion: 3 };
const metadata = { title: 'Review', description: 'Keep this description' };
const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
const definition = WorkflowDefinitionV1Schema.parse({ version: 1, defaults: { agentTarget }, blocks: [
  { kind: 'step', id: 'b1', document: { text: 'First', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
  { kind: 'step', id: 'b2', document: { text: 'Second', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
  { kind: 'step', id: 'b3', document: { text: 'Third', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
] });
const ops: WorkflowDefinitionEditOpV1[] = [
  { kind: 'set_step_prompt', blockId: 'b2', text: 'Changed' },
  { kind: 'move_block', blockId: 'b3', direction: 'up' },
];

const roleSourceInventory = await createRoleSourceReaderV1({})();

function currentAuthority(permissionMode: 'default' | 'yolo') {
  const context = resolveCliAgentStartContextV1({ sessionId: 'origin', machineId: 'machine', directory: '/repo',
    backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }, metadata: {},
    appliedChildSelection: { status: 'applied',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }, modelId: null, connectedServices: null },
    starterDepth: 0, turnDepth: 0, callerPermissionMode: permissionMode, settings: accountSettingsParse({}),
    accountRoleOverrides: { status: 'ready', overrides: {} }, roleSourceInventory });
  if (!context || 'ok' in context) throw new Error('expected current host authority fixture');
  return context;
}

function harness(options: { authorityAvailable?: boolean; currentPermissionMode?: 'default' | 'yolo'; definition?: WorkflowDefinitionV1; dropCallerContext?: boolean; pluginDefinition?: WorkflowDefinitionV1 } = {}) {
  const pluginSources = options.pluginDefinition ? [projectWorkflowPluginSourceV1({ pluginId: 'external.recipes', pluginVersion: '1.0.0',
    definition: { id: 'nested', title: 'External recipe', definition: options.pluginDefinition } })] : [];
  let saved = {
    id: definitionId, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
    headerVersion: 2, bodyVersion: 3, seq: 1, createdAt: 1, updatedAt: 1,
    header: encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1', definitionId, revision: expectedRevision, metadata }),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify({ kind: 'workflow-definition.v1', definition: options.definition ?? definition }) }),
  };
  http.get.mockImplementation(async () => ({ status: 200, data: saved }));
  http.post.mockImplementation(async (_url: string, payload: Record<string, unknown>) => {
    if (payload.id === definitionId) {
      saved = { ...saved, header: String(payload.header), body: String(payload.body), headerVersion: 1, bodyVersion: 1 };
      return { status: 200, data: saved };
    }
    if (payload.expectedHeaderVersion !== saved.headerVersion || payload.expectedBodyVersion !== saved.bodyVersion) {
      return { status: 200, data: { success: false, error: 'version-mismatch' } };
    }
    saved = { ...saved, header: String(payload.header), body: String(payload.body),
      headerVersion: saved.headerVersion + 1, bodyVersion: saved.bodyVersion + 1 };
    return { status: 200, data: { success: true, headerVersion: saved.headerVersion, bodyVersion: saved.bodyVersion } };
  });
  const artifactStore = createAccountArtifactStore({ credentials: { token: 'test-token', encryption: null },
    getAccountEncryptionMode: async () => 'plain' });
  const definitions = createWorkflowDefinitionActions({ artifactStore,
      readPluginWorkflows: () => pluginSources,
      // Remote machine availability is a boundary; selection and admission stay real.
      resolveMaterializer: async () => ({ effects: { resolveTargetAvailability: async () => true,
        readActionContract: async actionId => actionId === 'workflow.starters.list'
          ? freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(actionId))) : null,
        readWorkflowDefinition: ref => resolveWorkflowDefinitionRefV1(formatWorkflowDefinitionRefV1(ref), { readPluginWorkflows: () => pluginSources }),
      } }),
    });
  const workflowAction = createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true,
    definitions,
    resolveIngressContext: async () => ({ agentTarget }),
    runs: { execute: async () => ({ ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' }) },
  });
  // This workflow-only harness never reaches the other Action transport dependencies.
  const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"workflow.starters.list": Object.keys(ActionSurfaceSchema.shape), "workflow.definition.get": Object.keys(ActionSurfaceSchema.shape), "workflow.definition.edit": Object.keys(ActionSurfaceSchema.shape), "workflow.definition.create": Object.keys(ActionSurfaceSchema.shape), "workflow.definition.update": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), workflowAction: options.dropCallerContext
    ? (args: Parameters<typeof workflowAction>[0]) => workflowAction({ ...args, context: {} }) : workflowAction,
    resolveAgentStartContext: async () => options.authorityAvailable === false ? null : currentAuthority(options.currentPermissionMode ?? 'default'),
  } as unknown as ActionExecutorDeps);
  return { executor, workflowAction, definitions, saved: () => saved };
}

const human = { surface: 'cli' as const };
const agent = { surface: 'agent' as const, callerPermissionMode: 'default', sessionAgentSpawnPolicyV1: { v: 1 as const } };
const actionDefinition = WorkflowDefinitionV1Schema.parse({ version: 1, defaults: { permissionMode: 'default' },
  blocks: [{ kind: 'action', id: 'list', actionId: 'workflow.starters.list', input: {} }],
});
describe('workflow.definition.edit through the real Action and Artifact owners', () => {
  beforeEach(() => { http.get.mockReset(); http.post.mockReset(); http.delete.mockReset(); });
  afterEach(() => resetActiveAccountSettingsSnapshotForTests());

  it('uses native Session selection to admit an owner label edit while refusing an authority raise', async () => {
    const { workflowAction, definitions, saved } = harness({ definition: actionDefinition });
    const readArtifact = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (...args) => {
      const path = new URL(String(args[0])).pathname;
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === ACP_CATALOG_ROWS_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
      return readArtifact(...args);
    });
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const sessionMetadata = { machineId: 'machine', path: '/repo', flavor: 'claude' };
    let selectionAvailable = false;
    const readAppliedChildSelection = (): ExecutionRunAppliedParentSelection => selectionAvailable
      ? { status: 'applied', backendTarget: agentTarget, modelId: null, connectedServices: null }
      : { status: 'unavailable' };
    const roles = createSessionRoleContext({ readMetadata: () => sessionMetadata,
      readOrganization: async () => ({ manager: undefined, origin: { kind: 'none' } }),
      readRoleSources: createRoleSourceReader({}),
      readAccountRoleOverrides: () => ({ status: 'ready', overrides: {} }), readAppliedChildSelection,
    });
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: 'origin',
      mode: 'plain', ctx: null, serverId: 'definition-home', serverHttpBaseUrl: 'https://definition-owner.test',
      getCurrentSessionMetadata: () => sessionMetadata, getCurrentSessionBackendTarget: () => agentTarget,
      getCurrentSessionWorkDepth: () => 0, getSessionRoleContext: () => roles,
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
    });
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"workflow.definition.get": Object.keys(ActionSurfaceSchema.shape), "workflow.definition.edit": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), workflowAction, resolveAgentStartContext: deps.resolveAgentStartContext } as unknown as ActionExecutorDeps);
    const context = { ...agent, defaultSessionId: 'origin', actionCaller: {
      kind: 'session' as const, sessionId: 'origin', starterDepth: 0, turnDepth: 0,
    } };
    await expect(executor.execute('workflow.definition.get', { definitionId }, context)).resolves.toMatchObject({ ok: true });
    const rename = { definitionId, expectedRevision, ops: [{ kind: 'set_block_name', blockId: 'list', name: 'List starters' }] };
    const original = structuredClone(saved());
    await expect(executor.execute('workflow.definition.edit', rename, context)).resolves.toMatchObject({ ok: false,
      errorCode: 'target_unavailable', details: { code: 'target_unavailable', reason: 'caller_agent_unavailable' } });
    expect(saved()).toEqual(original);
    expect(http.post).not.toHaveBeenCalled();
    selectionAvailable = true;
    await expect(executor.execute('workflow.definition.edit', rename, context)).resolves.toMatchObject({ ok: true });
    expect((await definitions.get({ definitionId })).definition.blocks[0]).toMatchObject({ name: 'List starters' });
    const renamed = structuredClone(saved());
    http.post.mockClear();
    await expect(executor.execute('workflow.definition.edit', { definitionId,
      expectedRevision: { headerVersion: 3, bodyVersion: 4 },
      ops: [{ kind: 'set_default', field: 'permissionMode', value: 'yolo' }],
    }, context)).resolves.toMatchObject({ ok: false, errorCode: 'definition_exceeds_authority',
      details: { cause: { code: 'permission_exceeds_ceiling' } } });
    expect(saved()).toEqual(renamed);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('refuses a fieldless Action workflow permission escalation without changing the stored revision or body', async () => {
    const { executor, saved } = harness({ definition: actionDefinition });
    const before = structuredClone(saved());
    await expect(executor.execute('workflow.definition.edit', { definitionId, expectedRevision,
      ops: [{ kind: 'set_default', field: 'permissionMode', value: 'yolo' }],
    }, agent)).resolves.toMatchObject({ ok: false, errorCode: 'definition_exceeds_authority', details: {
      cause: { code: 'permission_exceeds_ceiling' },
    } });
    expect(saved()).toEqual(before);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('allows a within-ceiling Agent edit and a human permission raise on the same Action workflow', async () => {
    const { executor, definitions } = harness({ definition: actionDefinition });
    await expect(executor.execute('workflow.definition.edit', { definitionId, expectedRevision,
      ops: [{ kind: 'set_default', field: 'permissionMode', value: 'read-only' }],
    }, agent)).resolves.toMatchObject({ ok: true });
    await expect(executor.execute('workflow.definition.edit', { definitionId,
      expectedRevision: { headerVersion: 3, bodyVersion: 4 },
      ops: [{ kind: 'set_default', field: 'permissionMode', value: 'yolo' }],
    }, human)).resolves.toMatchObject({ ok: true });
    expect((await definitions.get({ definitionId })).definition.defaults.permissionMode).toBe('yolo');
  });

  it('refuses a write when caller context is dropped between the Action family and the definition owner', async () => {
    const { executor, saved } = harness({ definition: actionDefinition, dropCallerContext: true });
    const before = structuredClone(saved());
    await expect(executor.execute('workflow.definition.edit', { definitionId, expectedRevision,
      ops: [{ kind: 'set_default', field: 'permissionMode', value: 'yolo' }],
    }, agent)).resolves.toMatchObject({ ok: false, errorCode: 'definition_exceeds_authority' });
    expect(saved()).toEqual(before);
    expect(http.post).not.toHaveBeenCalled();
  });

  it.each(['workflow.definition.create', 'workflow.definition.update'] as const)('guards the same fieldless ceiling through %s', async actionId => {
    const { executor, saved } = harness({ definition: actionDefinition });
    const before = structuredClone(saved());
    await expect(executor.execute(actionId, { definitionId, metadata,
      ...(actionId === 'workflow.definition.update' ? { expectedRevision } : {}),
      definition: { ...actionDefinition, defaults: { permissionMode: 'yolo' } },
    }, agent)).resolves.toMatchObject({ ok: false, errorCode: 'definition_exceeds_authority', details: {
      cause: { code: 'permission_exceeds_ceiling' },
    } });
    expect(saved()).toEqual(before);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('checks the materialized ceiling of a nested external-plugin workflow with no Agent starts', async () => {
    const { executor, saved } = harness({ definition: WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {}, blocks: [
      { kind: 'workflow', id: 'nested', workflowRef: 'plugin:external.recipes/nested', input: {} },
    ] }), pluginDefinition: { ...actionDefinition, defaults: { permissionMode: 'yolo' } } });
    const before = structuredClone(saved());
    await expect(executor.execute('workflow.definition.edit', { definitionId, expectedRevision,
      ops: [{ kind: 'rename', name: 'Still checks the child' }],
    }, agent)).resolves.toMatchObject({ ok: false, errorCode: 'definition_exceeds_authority', details: {
      cause: { code: 'permission_exceeds_ceiling' },
    } });
    expect(saved()).toEqual(before);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('saves an authored block name through the edit Action and clears it without changing the prompt', async () => {
    const { executor, definitions, saved } = harness();
    http.get.mockResolvedValueOnce({ status: 404 });
    const initial = { ...definition, blocks: definition.blocks.map((block, index) => ({ ...block, name: index === 1 ? '  ' : '  From create  ' })) };
    await expect(executor.execute('workflow.definition.create', { definitionId, metadata, definition: initial }, human))
      .resolves.toMatchObject({ ok: true });
    expect((await definitions.get({ definitionId })).definition.blocks[0]).toMatchObject({ name: 'From create' });
    expect((await definitions.get({ definitionId })).definition.blocks[1]).not.toHaveProperty('name');
    await expect(executor.execute('workflow.definition.edit', { definitionId, expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      ops: [{ kind: 'set_block_name', blockId: 'b2', name: '  Implement  ' }],
    }, human)).resolves.toMatchObject({ ok: true, result: { changedBlockIds: ['b2'] } });
    expect((await definitions.get({ definitionId })).definition.blocks[1]).toMatchObject({ name: 'Implement', document: { text: 'Second' } });
    const updated = { ...definition, blocks: definition.blocks.map((block, index) => ({ ...block, name: index === 2 ? '  ' : '  From update  ' })) };
    await expect(executor.execute('workflow.definition.update', { definitionId,
      expectedRevision: { headerVersion: 2, bodyVersion: 2 }, metadata, definition: updated,
    }, human)).resolves.toMatchObject({ ok: true });
    expect((await definitions.get({ definitionId })).definition.blocks[0]).toMatchObject({ name: 'From update' });
    expect((await definitions.get({ definitionId })).definition.blocks[2]).not.toHaveProperty('name');
    await expect(executor.execute('workflow.definition.edit', { definitionId,
      expectedRevision: { headerVersion: 3, bodyVersion: 3 },
      ops: [{ kind: 'set_block_name', blockId: 'b2', name: '  ' }],
    }, human)).resolves.toMatchObject({ ok: true });
    expect((await definitions.get({ definitionId })).definition.blocks[1]).not.toHaveProperty('name');
    expect(saved().bodyVersion).toBe(4);
  });

  it('saves one atomic revision, preserves metadata and matches the local editor operations', async () => {
    const { executor, saved } = harness();
    const local = applyWorkflowDefinitionEditsV1({ ...definition, name: metadata.title }, ops);
    if (!local.ok) throw new Error('fixture operations invalid');
    const { name: _name, ...localDefinition } = local.draft;
    await expect(executor.execute('workflow.definition.edit', { definitionId, expectedRevision, ops }, human)).resolves.toEqual({
      ok: true, result: { definition: localDefinition, revision: { headerVersion: 3, bodyVersion: 4 }, metadata, changedBlockIds: ['b2', 'b3'] },
    });
    expect(http.post).toHaveBeenCalledOnce();
    expect(decodePlainArtifactStoredContent(saved().header)).toMatchObject({ metadata, revision: { headerVersion: 3, bodyVersion: 4 } });
  });

  it.each([{ headerVersion: 1, bodyVersion: 3 }, { headerVersion: 2, bodyVersion: 2 }])('refuses stale structured revision %j without writing', async (revision) => {
    const { executor } = harness();
    await expect(executor.execute('workflow.definition.edit', { definitionId, expectedRevision: revision, ops }, human))
      .resolves.toMatchObject({ ok: false, errorCode: 'currentness_conflict' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('refuses a lost CAS race without replay or retry', async () => {
    const { executor, saved } = harness();
    http.post.mockResolvedValue({ status: 200, data: { success: false, error: 'version-mismatch' } });
    await expect(executor.execute('workflow.definition.edit', { definitionId, expectedRevision, ops }, human))
      .resolves.toMatchObject({ ok: false, errorCode: 'currentness_conflict' });
    expect(http.post).toHaveBeenCalledOnce();
    expect(saved().bodyVersion).toBe(3);
  });

  it('refuses an unknown target in the middle of a batch without saving the first operation', async () => {
    const { executor, saved } = harness();
    await expect(executor.execute('workflow.definition.edit', { definitionId, expectedRevision,
      ops: [ops[0], { kind: 'remove_block', blockId: 'missing' }, ops[1]] }, human))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_input', details: { issues: [{ path: ['ops', 1] }] } });
    expect(http.post).not.toHaveBeenCalled();
    expect(saved().bodyVersion).toBe(3);
  });

  it('validates the resulting definition before writing', async () => {
    const { executor } = harness();
    await expect(executor.execute('workflow.definition.edit', { definitionId, expectedRevision,
      ops: [{ kind: 'set_final_output', finalOutput: { kind: 'result', producer: { blockId: 'missing', scope: { kind: 'current' } }, path: [] } }] }, human))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_input' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('uses update’s agent guard while allowing the same human edit', async () => {
    const { executor } = harness();
    const input = { definitionId, expectedRevision, ops: [{ kind: 'set_step_setting', blockId: 'b2', field: 'modelSelection',
      value: { v: 1, ref: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'denied-model' }, updatedAt: 1 } }] };
    const result = await executor.execute('workflow.definition.edit', input, { surface: 'agent',
      sessionAgentSpawnPolicyV1: { v: 1, allowModelOverride: false } });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'definition_exceeds_authority', details: {
        cause: { code: 'policy_denied_field', field: 'modelSelection' },
      } });
    expect(http.post).not.toHaveBeenCalled();
    await expect(executor.execute('workflow.definition.edit', input, human)).resolves.toMatchObject({ ok: true });
  });

  it('fails agent definition edits closed when current host authority is unavailable', async () => {
    const { executor } = harness({ authorityAvailable: false });
    await expect(executor.execute('workflow.definition.edit', { definitionId, expectedRevision, ops }, {
      surface: 'agent', sessionAgentSpawnPolicyV1: { v: 1 },
    })).resolves.toMatchObject({ ok: false, errorCode: 'definition_exceeds_authority', details: {
      cause: { code: 'target_unavailable' },
    } });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('does not release an Artifact read after nested definition materialization is cancelled', async () => {
    const { definitions } = harness();
    const controller = new AbortController();
    controller.abort(new Error('materialization_cancelled'));
    await expect(definitions.get({ definitionId, signal: controller.signal })).rejects.toThrow('materialization_cancelled');
    expect(http.get).not.toHaveBeenCalled();
  });

  it('refuses authored permissions above the active turn ceiling even when current Session mode is broader', async () => {
    const { executor } = harness({ currentPermissionMode: 'yolo' });
    await expect(executor.execute('workflow.definition.edit', { definitionId, expectedRevision,
      ops: [{ kind: 'set_step_setting', blockId: 'b2', field: 'permissionMode', value: 'yolo' }],
    }, { surface: 'agent', callerPermissionMode: 'yolo', sessionAgentSpawnPolicyV1: { v: 1 },
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'definition_exceeds_authority', details: {
      cause: { code: 'permission_exceeds_ceiling' },
    } });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('renames only the title and keeps the description, with no changed block ids', async () => {
    const { executor, saved } = harness();
    await expect(executor.execute('workflow.definition.edit', { definitionId, expectedRevision,
      ops: [{ kind: 'rename', name: 'New name' }] }, human)).resolves.toMatchObject({ ok: true,
        result: { metadata: { ...metadata, title: 'New name' }, changedBlockIds: [] } });
    expect(decodePlainArtifactStoredContent(saved().header)).toMatchObject({ metadata: { ...metadata, title: 'New name' } });
  });
});
