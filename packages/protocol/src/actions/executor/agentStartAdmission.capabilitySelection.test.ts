import { describe, expect, it } from 'vitest';
import { projectActionWorkflowSelectionInputV1, resolveActionAgentStartRequestsV1 } from './agentStartAdmission.js';
import { WorkflowSessionAuthoringSelectionSchema, WorkflowStepSelectionV1Schema } from '../../workflows/workflowV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { buildWorkflowSelectionFromServerStartSpawnDraftV1 } from '../../workflows/workflowSessionAuthoringV1.js';
import { SessionServerStartSpawnDraftV1Schema } from '../../sessions/creation/sessionSpawnNewInputV2.js';
import { buildBackendTargetKeyV2 } from '../../backends/targets/backendTargetRefV2.js';
import { sessionModelSelectionV2TeamBindingIntent } from '../../providers/selection/v2.js';

const capabilitySelection = {
  mcp: { v: 1 as const, managedServersEnabled: true, forceIncludeServerIds: ['tools'], forceExcludeServerIds: [] },
  skills: { v: 1 as const, forceIncludeSkillIds: ['lint'], forceExcludeSkillIds: ['review'], excludeNativeSkillNames: ['native'] },
};

describe('Workflow capability selection inheritance', () => {
  it('retains a qualified Team model when converting a scheduled Session into a Workflow', () => {
    const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
    const model = { v: 2 as const, updatedAt: 0, ref: {
      source: 'team_resource' as const, agentTargetKey: buildBackendTargetKeyV2(agentTarget), modelId: 'team-model',
      teamId: 'team', resourceId: 'resource', expectedResourceRevision: 1, deliveryMode: 'brokered' as const,
    } };
    const teamCredentialBindings = [sessionModelSelectionV2TeamBindingIntent(model)];
    const spawn = SessionServerStartSpawnDraftV1Schema.parse({
      executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'path', path: '/repo' },
      agentTarget, teamCredentialBindings,
    });
    expect.soft(buildWorkflowSelectionFromServerStartSpawnDraftV1(spawn))
      .toMatchObject({ teamCredentialBindings });
    expect.soft(resolveActionAgentStartRequestsV1({ actionId: 'session.spawn_new', input: spawn,
      context: {}, baseline: { machineId: 'machine', directory: '/repo' } })).toMatchObject({
      ok: true, requests: [{ facts: { modelSelection: model } }],
      effectiveInput: { teamCredentialBindings },
    });
  });

  it('folds retained MCP-only workflow data at stored ingress and rejects legacy current writes', () => {
    const legacy = { mcpSelection: capabilitySelection.mcp, future: true };
    expect(createStoredReadSchema(WorkflowStepSelectionV1Schema).parse(legacy))
      .toEqual({ capabilitySelection: { mcp: capabilitySelection.mcp } });
    expect(WorkflowStepSelectionV1Schema.safeParse(legacy).success).toBe(false);
  });
  it('inherits both kinds from a portable Workflow selection and preserves explicit overrides', () => {
    const selected = WorkflowSessionAuthoringSelectionSchema.parse({ capabilitySelection });
    for (const actionId of ['session.spawn_new', 'execution.run.start', 'review.start']) {
      expect(projectActionWorkflowSelectionInputV1(actionId, {}, selected)).toMatchObject({ capabilitySelection });
      expect(projectActionWorkflowSelectionInputV1(actionId, { capabilitySelection: {} }, selected))
        .toMatchObject({ capabilitySelection: {} });
    }
  });
  it('retains both kinds when a Session creation becomes a Workflow selection', () => {
    const spawn = SessionServerStartSpawnDraftV1Schema.parse({
      executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'path', path: '/repo' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      capabilitySelection,
    });
    expect(buildWorkflowSelectionFromServerStartSpawnDraftV1(spawn)).toMatchObject({ capabilitySelection });
  });
});
