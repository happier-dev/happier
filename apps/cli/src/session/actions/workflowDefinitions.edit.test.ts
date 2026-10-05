import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent,
  createActionExecutor, WorkflowDefinitionV1Schema, type ActionExecutorDeps,
  type WorkflowDefinitionEditOpV1,
  accountSettingsParse,
} from '@happier-dev/protocol';
import { applyWorkflowDefinitionEditsV1 } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';

import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createWorkflowDefinitionActions } from './workflowDefinitions';
import { createWorkflowActionExecutor } from './workflowActionExecutor';
import { resolveCliAgentStartContextV1 } from './resolveCliAgentStartContextV1';

// HTTP is the system boundary; codecs, Artifact CAS, policy and both executors stay real.
const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
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

function currentAuthority(permissionMode: 'default' | 'yolo') {
  const context = resolveCliAgentStartContextV1({ sessionId: 'origin', machineId: 'machine', directory: '/repo',
    backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }, metadata: {},
    starterDepth: 0, turnDepth: 0, callerPermissionMode: permissionMode, settings: accountSettingsParse({}) });
  if (!context) throw new Error('expected current host authority fixture');
  return context;
}

function harness(options: { authorityAvailable?: boolean; currentPermissionMode?: 'default' | 'yolo' } = {}) {
  let saved = {
    id: definitionId, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
    headerVersion: 2, bodyVersion: 3, seq: 1, createdAt: 1, updatedAt: 1,
    header: encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1', definitionId, revision: expectedRevision, metadata }),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify({ kind: 'workflow-definition.v1', definition }) }),
  };
  http.get.mockImplementation(async () => ({ status: 200, data: saved }));
  http.post.mockImplementation(async (_url: string, payload: Record<string, unknown>) => {
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
      // Remote machine availability is a boundary; selection and admission stay real.
      resolveMaterializer: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
    });
  const workflowAction = createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true,
    definitions,
    resolveIngressContext: async () => ({ agentTarget }),
    runs: { execute: async () => ({ ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' }) },
  });
  // This workflow-only harness never reaches the other Action transport dependencies.
  const executor = createActionExecutor({ workflowAction, isActionApprovalRequired: () => false,
    resolveAgentStartContext: async () => options.authorityAvailable === false ? null : currentAuthority(options.currentPermissionMode ?? 'default'),
  } as unknown as ActionExecutorDeps);
  return { executor, definitions, saved: () => saved };
}

const human = { surface: 'cli' as const };
describe('workflow.definition.edit through the real Action and Artifact owners', () => {
  beforeEach(() => { http.get.mockReset(); http.post.mockReset(); http.delete.mockReset(); });

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
