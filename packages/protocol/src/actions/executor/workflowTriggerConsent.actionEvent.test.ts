import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionV1Schema } from '../../workflows/workflowV1.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import * as consent from './workflowTriggerConsent.js';
import { prepareWorkflowApprovedOperation } from './workflowRunActions.js';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '../../deployments/deploymentActionIdsV1.js';
import { WorkflowApprovedOperationStepV1Schema, type WorkflowApprovedOperationStepV1 } from '../approvedOperationV1.js';
import type { WorkflowMaterializedLeafV1 } from '../../workflows/workflowDefinitionV1.js';

describe('Automatic Action-event consent', () => {
  it('saves fixed shell effects with structured trigger-event stdin and environment bindings', async () => {
    const event = { kind: 'action', phase: 'before' } as const;
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], blocks: [{
      kind: 'action', id: 'check', actionId: 'machines.command.run', input: {
        command: { kind: 'literal', value: 'cat; exit 7' },
        stdin: { kind: 'object', fields: {
          actionId: { kind: 'trigger_event', event, path: ['actionId'] },
          literal: { kind: 'literal', value: '$(touch injected); "quoted" & literal\nnext line' },
        } },
        env: { kind: 'object', fields: { HAPPIER_PHASE: { kind: 'trigger_event', event, path: ['phase'] } } },
      },
    }] });
    const project = { machineId: 'machine', directory: '/repo' };
    const { steps } = await consent.readWorkflowTriggerActionConsent({ definition, project, triggerId: 'check-trigger',
      context: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' } },
      resolveWorkflow: async () => { throw new Error('No child Workflow'); } });
    const operation = await prepareWorkflowApprovedOperation({ parent: { actionId: 'workflow.trigger.add', input: {
      target: { kind: 'inline', definition: StrictJsonValueSchema.parse(definition) }, project, actionApproval: 'automatic',
      trigger: { kind: 'action', enabled: true, phase: 'before', mode: 'wait', onFailure: 'refuse',
        actionIds: [DEPLOYMENT_DEPLOY_ACTION_ID_V1] },
    } }, steps, context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
      runtimeAccountId: 'owner', serverId: 'home', actionRequestId: 'save-event-check' },
      nativeAccount: { accountId: 'owner', serverId: 'home', isCurrent: async () => true } });
    expect(operation.steps).toEqual([{ actionId: 'machines.command.run', input: { command: 'cat; exit 7' },
      binding: { kind: 'trigger_event', references: {
        stdin: definition.blocks[0]!.kind === 'action' ? definition.blocks[0]!.input.stdin : undefined,
        env: definition.blocks[0]!.kind === 'action' ? definition.blocks[0]!.input.env : undefined,
      } } }]);
  });

  it('keeps confidential literal carriers out of saved structured Event consent', async () => {
    const event = { kind: 'action', phase: 'before' } as const;
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'action', id: 'check', actionId: 'machines.command.run',
      input: { command: { kind: 'literal', value: 'cat' }, stdin: { kind: 'object', fields: {
        actionId: { kind: 'trigger_event', event, path: ['actionId'] },
        secret: { kind: 'literal', value: { _isSecretValue: true, value: 'private' } },
      } } } }] });
    const { steps } = await consent.readWorkflowTriggerActionConsent({ definition,
      project: { machineId: 'machine', directory: '/repo' }, triggerId: 'check-trigger',
      context: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' } },
      resolveWorkflow: async () => { throw new Error('No child Workflow'); } });
    await expect(prepareWorkflowApprovedOperation({ parent: { actionId: 'workflow.trigger.update', input: {
      automationId: 'automation', triggerId: 'check-trigger', expectedRevision: 0, patch: { actionApproval: 'automatic' },
    } }, steps, context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
      runtimeAccountId: 'owner', serverId: 'home', actionRequestId: 'save-event-check' },
      nativeAccount: { accountId: 'owner', serverId: 'home', isCurrent: async () => true } }))
      .rejects.toMatchObject({ code: 'approval_required' });
  });

  it('retains declared confidential effect paths for structured Event literals', async () => {
    const actionId = 'example.fixture/actions/write';
    const input = { stdin: { secret: 'private', actionId: 'deployments.deploy' } };
    const bound = WorkflowApprovedOperationStepV1Schema.parse({ actionId, input: {}, binding: {
      kind: 'trigger_event', references: { stdin: { kind: 'object', fields: {
        secret: { kind: 'literal', value: 'private' },
        actionId: { kind: 'trigger_event', event: { kind: 'action', phase: 'before' }, path: ['actionId'] },
      } } },
    } });
    const cases: readonly WorkflowApprovedOperationStepV1[] = [{ actionId, input }, bound];
    for (const step of cases) {
      // The frozen contributed declaration is retained storage-boundary data.
      const leaf: WorkflowMaterializedLeafV1 = { kind: 'action', sourceKey: '$root', blockId: 'check', selection: {},
        authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'detached_run' }, actionId,
        actionInput: step.binding ? { stdin: { secret: 'private', actionId: { kind: 'unresolved' } } } : input,
        actionContract: { inputSchema: { type: 'object' }, outputSchema: {}, secretInputPaths: ['stdin.secret'] } };
      await expect(prepareWorkflowApprovedOperation({ parent: { actionId: 'workflow.trigger.update', input: {
        automationId: 'automation', triggerId: 'check-trigger', expectedRevision: 0, patch: { actionApproval: 'automatic' },
      } }, steps: [step], materializedLeaves: [leaf], context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
        runtimeAccountId: 'owner', serverId: 'home', actionRequestId: 'save-event-check' },
        nativeAccount: { accountId: 'owner', serverId: 'home', isCurrent: async () => true } }))
        .rejects.toMatchObject({ code: 'approval_required' });
    }
  });
});
