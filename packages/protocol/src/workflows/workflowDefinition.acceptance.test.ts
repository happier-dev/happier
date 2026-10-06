import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionArtifactBodyV1Schema, WorkflowDefinitionArtifactHeaderV1Schema, WorkflowAcceptedSnapshotV1Schema } from './workflowDefinitionV1.js';
import { AutomationStoredWorkflowDefinitionV2Schema } from '../automations/automationWorkflowRecipeV2.js';
import { createDeepWorkflowDefinition } from './workflowDefinition.testkit.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';

import {
  WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS,
  WorkflowDefinitionSchema,
  validateWorkflowDefinition,
} from './index.js';

const AGENT_TARGET = {
  kind: 'agent' as const,
  identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
};

describe('workflow definition acceptance contract', () => {
  it('rejects revision actors in the public Workflow header', () => {
    const header = { kind: 'workflow-definition.v1', definitionId: 'workflow-1',
      revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Review' } };
    expect(WorkflowDefinitionArtifactHeaderV1Schema.safeParse(header).success).toBe(true);
    expect(WorkflowDefinitionArtifactHeaderV1Schema.safeParse({ ...header,
      savedBy: { kind: 'person', accountId: 'owner' } }).success).toBe(false);
  });
  it('accepts deep canonical definitions at Artifact, Automation and accepted-snapshot boundaries', () => {
    const definition = createDeepWorkflowDefinition();
    const artifact = WorkflowDefinitionArtifactBodyV1Schema.parse({ kind: 'workflow-definition.v1', definition });
    const project = { machineId: 'machine-1', directory: '/repo' };
    const automation = AutomationStoredWorkflowDefinitionV2Schema.parse({ inlineDefinition: definition, workspace: { directory: project.directory }, executionTarget: { kind: 'session' } });
    const snapshot = WorkflowAcceptedSnapshotV1Schema.parse({
      startedBy: 'user',
      authoredDefinition: definition, materializedLeaves: [], frozenChildren: {}, workDepth: 0, metadata: null,
      definition, inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
      workspaceTarget: { project: { ...project, checkoutRootPath: '/repo' } }, source: { kind: 'inline' }, origin: { kind: 'direct' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
    });
    for (const value of [artifact, snapshot]) expect(sameStrictJsonValue(value.definition, definition)).toBe(true);
    expect(sameStrictJsonValue(automation.inlineDefinition, definition)).toBe(true);
  });
  it('round-trips a two-step result pipeline and its explicit final output through JSON storage', () => {
    const accepted = validateWorkflowDefinition({
      version: 1,
      inputs: [{ name: 'request', valueType: 'string', required: true }],
      defaults: {
        agentTarget: AGENT_TARGET,
        modelSelection: null,
        permissionMode: 'default',
        mcpSelection: {
          v: 1,
          managedServersEnabled: false,
          forceIncludeServerIds: ['review-tools'],
          forceExcludeServerIds: [],
        },
        connectedServices: { v: 1, bindingsByServiceId: {} },
        transcriptStorage: 'direct',
        terminal: null,
        windowsRemoteSessionLaunchMode: null,
        windowsRemoteSessionConsole: null,
        windowsTerminalWindowName: null,
        runtimeDescriptorV1: null,
      },
      blocks: [
        {
          kind: 'step',
          id: 'analyze',
          document: { text: 'Analyze the request.', references: [], attachments: [] },
          input: [{ kind: 'input', name: 'request' }],
          result: { kind: 'json', schema: { type: 'object' } },
        },
        {
          kind: 'step',
          id: 'implement',
          document: { text: 'Implement from the analysis.', references: [], attachments: [] },
          execution: {
            conversation: { kind: 'shared_run' },
            workspace: { kind: 'inherit' },
            modelSelection: null,
            permissionMode: 'default',
          },
          input: [{
            kind: 'result',
            producer: { blockId: 'analyze', scope: { kind: 'current' } },
            path: ['summary'],
          }],
          result: { kind: 'text' },
        },
      ],
      finalOutput: {
        kind: 'result',
        producer: { blockId: 'implement', scope: { kind: 'current' } },
        path: [],
      },
    });

    expect(accepted.issues).toEqual([]);
    expect(accepted.valid).toBe(true);
    const serialized = JSON.stringify(accepted.normalizedDefinition);
    const restored = WorkflowDefinitionSchema.parse(JSON.parse(serialized));

    expect(restored).toEqual(accepted.normalizedDefinition);
    expect(restored.finalOutput?.producer.blockId).toBe('implement');
    expect(restored.blocks[1]).toMatchObject({
      execution: {
        conversation: { kind: 'shared_run' },
        workspace: { kind: 'inherit' },
        modelSelection: null,
        permissionMode: 'default',
      },
      input: [{
        kind: 'result',
        producer: { blockId: 'analyze', scope: { kind: 'current' } },
        path: ['summary'],
      }],
    });
    expect(WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS).toContain('connectedServices');
    expect(WORKFLOW_SESSION_AUTHORING_SELECTION_FIELD_IDS).toContain('runtimeDescriptorV1');
  });

  it('accepts a representative 500-step program without inventing a workflow size or concurrency quota', () => {
    const accepted = validateWorkflowDefinition({
      defaults: { agentTarget: AGENT_TARGET },
      blocks: Array.from({ length: 500 }, (_, index) => `Inspect file ${index + 1}`),
    });

    expect(accepted.issues).toEqual([]);
    expect(accepted.normalizedDefinition?.blocks).toHaveLength(500);
    expect(accepted.normalizedDefinition?.blocks[499]?.id).toBe('wf--step-499');

    const parallel = validateWorkflowDefinition({
      defaults: { agentTarget: AGENT_TARGET },
      blocks: [{
        kind: 'parallel',
        id: 'checks',
        failurePolicy: 'collect_outcomes',
        branches: Array.from({ length: 32 }, (_, index) => ({
          id: `branch_${index}`,
          blocks: [`Check ${index}`],
        })),
      }],
    });

    expect(parallel.issues).toEqual([]);
    expect(parallel.normalizedDefinition?.blocks[0]).not.toHaveProperty('maxConcurrent');
  });
});
