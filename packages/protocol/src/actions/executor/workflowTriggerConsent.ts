import type { WorkflowApprovedOperationV1 } from '../approvedOperationV1.js';
import type { WorkflowDefinitionV1 } from '../../workflows/workflowV1.js';
import type { WorkflowTriggerContextV1 } from '../../automations/automationWorkflowRecipeV2.js';
import type { WorkflowProjectTargetV1 } from '../../workflows/workflowWorkspaceV1.js';
import { materializeWorkflowDefinitionAuthorityV1 } from '../../workflows/materializeWorkflowAcceptedSnapshotV1.js';
import { resolveWorkflowRunStartInputsV1 } from '../../workflows/workflowStartPreparationV1.js';
import type { WorkflowMaterializedLeafV1, WorkflowResolvedInputsV1 } from '../../workflows/workflowDefinitionV1.js';
import { formatWorkflowDefinitionRefV1 } from '../../workflows/workflowDefinitionRefV1.js';
import { WorkflowApprovedOperationStepV1Schema } from '../approvedOperationV1.js';
import { AutomationStoredWorkflowDefinitionV2Schema, type AutomationStoredWorkflowDefinitionV2ReadSchema } from '../../automations/automationWorkflowRecipeV2.js';
import type { z } from '../../zodRuntimePolicy.js';
import { readDeploymentBackupOccurrenceV1 } from '../../workflows/builtins/backupExamples.js';
import { walkWorkflowBlocks } from '../../workflows/workflowDefinitionEditV1.js';
import { DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1 } from '../../deployments/deploymentActionIdsV1.js';

type WorkflowTriggerConsentDefinition = Readonly<{
  definition: WorkflowDefinitionV1;
  context: WorkflowTriggerContextV1;
  project: WorkflowProjectTargetV1;
  triggerId: string;
  resolveWorkflow(ref: string): Promise<WorkflowDefinitionV1>;
}>;

/** The fixed-input rule and deployment SHA extension share one declaration/value binder. */
export async function materializeWorkflowTriggerActionDefinition(input: Readonly<{
  definition: WorkflowDefinitionV1; inputs: WorkflowResolvedInputsV1; project: WorkflowProjectTargetV1;
  resolveWorkflow(ref: string): Promise<WorkflowDefinitionV1>;
  /** A pre-guest review freezes effects; the enrolled Run decides actual target availability. */
  deferTargetAvailability?: boolean;
}>) {
  const children: Record<string, WorkflowDefinitionV1> = {};
  const { ActionIdSchema } = await import('../actionIds.js');
  const { getActionSpec } = await import('../actionSpecs.js');
  const { freezeWorkflowActionContractV1, actionSpecToActionDefinitionV1 } = await import('../actionCatalog.js');
  const materialized = await materializeWorkflowDefinitionAuthorityV1({ definition: input.definition,
    context: { source: { kind: 'inline' }, inputs: input.inputs, machineId: input.project.machineId,
      executionTarget: { kind: 'detached_run' },
      workspaceTarget: { project: { ...input.project, checkoutRootPath: input.project.directory } },
      authorization: { principal: { kind: 'host' } } },
    effects: {
      resolveTargetAvailability: async leaf => input.deferTargetAvailability === true || leaf.kind === 'action' || leaf.kind === 'workflow',
      readActionContract: async id => {
        const actionId = ActionIdSchema.safeParse(id);
        return actionId.success ? freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(actionId.data))) : null;
      },
      readWorkflowDefinition: async ref => {
        const key = formatWorkflowDefinitionRefV1(ref);
        const definition = await input.resolveWorkflow(key);
        children[key] = definition;
        return { definition, sourceKey: key };
      },
    },
  });
  return { materialized, program: { definition: input.definition, children } };
}

/** Save and selected-trigger reads derive the same exact authored effects. */
export async function readWorkflowTriggerConsentSteps(input: WorkflowTriggerConsentDefinition): Promise<WorkflowApprovedOperationV1['steps']> {
  const deployment = input.context.deploymentTriggers?.some(row => row.triggerId === input.triggerId) === true;
  const definition = deployment ? { ...input.definition,
    inputs: input.definition.inputs.map(field => field.name === 'sha' || field.name === 'requestKey'
      ? { ...field, required: false } : field) } : input.definition;
  const { materialized, program } = await materializeWorkflowTriggerActionDefinition({ definition,
    inputs: resolveWorkflowRunStartInputsV1(definition, input.context.inputs), project: input.project,
    resolveWorkflow: input.resolveWorkflow });
  if (!materialized.ok) throw Object.assign(new Error(materialized.error.code), { code: materialized.error.code });
  return projectWorkflowTriggerConsentSteps({ definition, children: program.children,
    materializedLeaves: materialized.materializedLeaves, deployment });
}

/** Authoring and Run admission consume the same already materialized effect scope. */
export function projectWorkflowTriggerConsentSteps(input: Readonly<{
  definition: WorkflowDefinitionV1;
  children: Readonly<Record<string, WorkflowDefinitionV1>>;
  materializedLeaves: readonly WorkflowMaterializedLeafV1[];
  deployment: boolean;
}>): WorkflowApprovedOperationV1['steps'] {
  const sources = new Map(([['$root', input.definition] as const, ...Object.entries(input.children)])
    .map(([key, definition]) => [key, { definition,
      blocks: new Map(walkWorkflowBlocks(definition.blocks).map(block => [block.id, block])) }] as const));
  return input.materializedLeaves.flatMap(leaf => {
    if (leaf.kind !== 'action' || !leaf.actionId || !leaf.actionInput) return [];
    const source = sources.get(leaf.sourceKey);
    const authored = source?.blocks.get(leaf.blockId);
    const occurrence = source && authored?.kind === 'action' ? readDeploymentBackupOccurrenceV1(source.definition, authored) : null;
    if (occurrence) return [{ actionId: leaf.actionId,
      input: Object.fromEntries(Object.entries(leaf.actionInput).filter(([field]) => !Object.hasOwn(occurrence.references, field))),
      binding: { kind: 'producer_result' as const, references: occurrence.references } }];
    // Verify is a read-only check of this run's returned manifests, with no
    // standing mutation consent to carry through its per-snapshot item binding.
    if (leaf.actionId === DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1 && authored?.kind === 'action'
      && authored.input.snapshotId?.kind === 'item') return [];
    if (!input.deployment || leaf.actionId !== 'deployments.deploy') return [{ actionId: leaf.actionId, input: leaf.actionInput }];
    const { sha: _sha, requestKey: _requestKey, ...fixed } = leaf.actionInput;
    return [WorkflowApprovedOperationStepV1Schema.parse({ actionId: leaf.actionId,
      input: fixed, binding: { kind: 'deployment_sha' } })];
  });
}

/** Translate the actually emitted current-dev proof, without renewing consent or reading an Environment. */
export async function normalizeStoredWorkflowTriggerConsent(input: Readonly<{
  automationId: string;
  context: z.infer<typeof AutomationStoredWorkflowDefinitionV2ReadSchema>;
  project: WorkflowProjectTargetV1;
}>): Promise<Readonly<{ context: WorkflowTriggerContextV1 }>> {
  const context = AutomationStoredWorkflowDefinitionV2Schema.parse({ ...input.context,
    ...(input.context.deploymentTriggers ? { deploymentTriggers: input.context.deploymentTriggers.map(({ approval: _approval, ...routing }) => routing) } : {}) });
  for (const trigger of input.context.deploymentTriggers ?? []) {
    const legacy = trigger.approval;
    if (!legacy || context.actionApprovals?.some(row => row.triggerId === trigger.triggerId)) continue;
    if (legacy.savedBy.kind !== 'person' || legacy.savedBy.accountId !== legacy.operation.approvedBy.accountId
      || legacy.savedFor.automationId !== input.automationId || legacy.savedFor.triggerId !== trigger.triggerId
      || legacy.operation.steps.length !== 0
      || !['workflow.trigger.add', 'workflow.trigger.update'].includes(legacy.operation.parent.actionId)) continue;
    if (legacy.operation.parent.actionId === 'workflow.trigger.update'
      && (legacy.operation.parent.input.automationId !== input.automationId
        || legacy.operation.parent.input.triggerId !== trigger.triggerId)) continue;
    const steps = await readWorkflowTriggerConsentSteps({ definition: legacy.program.definition,
      context, project: input.project, triggerId: trigger.triggerId,
      resolveWorkflow: async ref => {
        const child = legacy.program.children[ref];
        if (!child) throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
        return child;
      } });
    // The predecessor writer admitted exactly one repository deployment.
    if (steps.length !== 1 || steps[0]?.actionId !== 'deployments.deploy' || steps[0].binding?.kind !== 'deployment_sha') continue;
    context.actionApprovals = [...(context.actionApprovals ?? []), { triggerId: trigger.triggerId,
      operation: { ...legacy.operation, steps } }];
  }
  return { context };
}
