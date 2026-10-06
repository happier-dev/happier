import { describe, expect, it } from 'vitest';

import {
  AutomationStoredWorkflowDefinitionRecipeV2Schema,
  parseAutomationStoredWorkflowDefinitionRecipeV2,
  serializeAutomationStoredWorkflowDefinitionRecipeV2,
} from './automationWorkflowRecipeV2.js';
import {
  AutomationDefinitionCreateRequestSchema,
  AutomationV3WorkerClaimedRunSchema,
} from './automationApiV3.js';

const definition = {
  version: 1 as const,
  inputs: [],
  defaults: {
    agentTarget: {
      kind: 'agent' as const,
      identity: { pluginId: 'happier.agent.test', localId: 'test' },
    },
  },
  blocks: [{
    kind: 'step' as const,
    id: 'review',
    document: { text: 'Review the repository', references: [], attachments: [] },
    input: [],
    result: { kind: 'text' as const },
  }],
};

describe('AutomationStoredWorkflowDefinitionRecipeV2', () => {
  const recipe = {
    v: 2 as const,
    templateVersion: 4,
    workflow: {
      t: 'plain' as const,
      v: {
        inlineDefinition: definition,
        workspace: { directory: '/workspace/project' },
        executionTarget: { kind: 'session' as const },
      },
    },
    triggerEvidence: null,
  };

  it('stores the canonical definition inside the incumbent private Automation envelope', () => {
    expect(AutomationStoredWorkflowDefinitionRecipeV2Schema.parse(recipe)).toEqual(recipe);
    const serialized = serializeAutomationStoredWorkflowDefinitionRecipeV2(recipe);
    expect(serialized.kind).toBe('available');
    if (serialized.kind !== 'available') throw new Error('expected available recipe');
    expect(parseAutomationStoredWorkflowDefinitionRecipeV2(serialized.serialized)).toEqual(serialized);
  });

  it('is accepted by the existing Automation definition writer contract', () => {
    expect(AutomationDefinitionCreateRequestSchema.safeParse({
      automationId: 'automation-1',
      name: 'Daily review',
      enabled: true,
      executionRecipe: recipe,
      assignments: [{ machineId: 'machine-1' }],
      triggers: [],
    }).success).toBe(true);
  });

  it('reads unknown recipe and inline-definition fields while canonical inputs stay strict', () => {
    const stored = { ...recipe, extra: true, workflow: { ...recipe.workflow, extra: true,
      v: { ...recipe.workflow.v, extra: true, workspace: { directory: '/workspace/project', extra: true },
        inlineDefinition: { ...definition, extra: true, blocks: [{ ...definition.blocks[0], extra: true }] } } } };
    const opened = parseAutomationStoredWorkflowDefinitionRecipeV2(JSON.stringify(stored));
    expect(opened.kind).toBe('available');
    if (opened.kind !== 'available') throw new Error('expected readable stored recipe');
    expect(opened.recipe).toEqual(recipe);
    expect(AutomationStoredWorkflowDefinitionRecipeV2Schema.safeParse(stored).success).toBe(false);
    expect(serializeAutomationStoredWorkflowDefinitionRecipeV2(stored).kind).toBe('contentInvalid');
  });

  it('rejects legacy prompt content, occurrence evidence, and authored authority', () => {
    expect(AutomationStoredWorkflowDefinitionRecipeV2Schema.safeParse({
      ...recipe,
      workflow: { t: 'plain', v: { prompt: 'legacy' } },
    }).success).toBe(false);
    expect(AutomationStoredWorkflowDefinitionRecipeV2Schema.safeParse({
      ...recipe,
      triggerEvidence: { t: 'encrypted', c: 'opaque' },
    }).success).toBe(false);
    expect(AutomationDefinitionCreateRequestSchema.safeParse({
      automationId: 'automation-1',
      name: 'Untrusted workflow',
      enabled: true,
      executionRecipe: {
        ...recipe,
        authorization: { admittedPermissionCeiling: 'yolo' },
      },
      assignments: [{ machineId: 'machine-1' }],
      triggers: [],
    }).success).toBe(false);
  });

  it('keeps Automation occurrence evidence separate on the private workflow claim', () => {
    expect(AutomationV3WorkerClaimedRunSchema.parse({
      id: 'run-1',
      automationId: 'automation-1',
      attempt: 1,
      revision: 2,
      recipeKind: 'workflow-v2',
      executionInputEnvelope: JSON.stringify(recipe.workflow),
      automationEvidenceEnvelope: JSON.stringify({ t: 'plain', v: { event: 'created' } }),
      triggerId: null,
      triggerRetired: false,
      cause: { kind: 'manual', invokedAt: 1 },
    }).automationEvidenceEnvelope).toBe(JSON.stringify({ t: 'plain', v: { event: 'created' } }));
  });

  it('requires an explicit claim recipe discriminator', () => {
    const workflowClaim = {
      id: 'run-1',
      automationId: 'automation-1',
      attempt: 1,
      revision: 2,
      executionInputEnvelope: JSON.stringify(recipe.workflow),
      automationEvidenceEnvelope: null,
      triggerId: null,
      triggerRetired: false,
      cause: { kind: 'manual' as const, invokedAt: 1 },
    };

    expect(AutomationV3WorkerClaimedRunSchema.safeParse(workflowClaim).success).toBe(false);
    expect(AutomationV3WorkerClaimedRunSchema.safeParse({
      ...workflowClaim,
      recipeKind: 'workflow-v2',
    }).success).toBe(true);
    expect(AutomationV3WorkerClaimedRunSchema.safeParse({
      id: workflowClaim.id,
      automationId: workflowClaim.automationId,
      attempt: workflowClaim.attempt,
      revision: workflowClaim.revision,
      recipeKind: 'legacy',
      executionInputEnvelope: workflowClaim.executionInputEnvelope,
      triggerId: workflowClaim.triggerId,
      triggerRetired: workflowClaim.triggerRetired,
      cause: workflowClaim.cause,
    }).success).toBe(true);
  });
});
