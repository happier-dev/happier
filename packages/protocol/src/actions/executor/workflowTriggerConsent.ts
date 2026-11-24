import type { WorkflowApprovedOperationV1 } from '../approvedOperationV1.js';
import type { WorkflowDefinitionV1 } from '../../workflows/workflowV1.js';
import type { WorkflowTriggerContextV1 } from '../../automations/automationWorkflowRecipeV2.js';
import { WorkflowProjectTargetV1Schema, type WorkflowProjectTargetV1 } from '../../workflows/workflowWorkspaceV1.js';
import { materializeWorkflowDefinitionAuthorityV1, type MaterializeWorkflowAcceptedSnapshotV1Input } from '../../workflows/materializeWorkflowAcceptedSnapshotV1.js';
import { resolveWorkflowRunStartInputsV1 } from '../../workflows/workflowStartPreparationV1.js';
import type { WorkflowMaterializedLeafV1, WorkflowResolvedInputsV1, WorkflowRunExecutionTargetV1 } from '../../workflows/workflowDefinitionV1.js';
import { formatWorkflowDefinitionRefV1, parseWorkflowDefinitionRefV1 } from '../../workflows/workflowDefinitionRefV1.js';
import { WorkflowApprovedOperationStepV1Schema } from '../approvedOperationV1.js';
import { readDeploymentBackupOccurrenceV1 } from '../../workflows/builtins/backupExamples.js';
import { walkWorkflowBlocks } from '../../workflows/workflowDefinitionEditV1.js';
import { DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1 } from '../../deployments/deploymentActionIdsV1.js';
import { listWorkflowActionFieldReferencesV1 } from '../../workflows/workflowActionTextV1.js';
import { WORKFLOW_TRIGGER_ADD_ACTION_ID } from '../workflowTriggerActionIds.js';

type WorkflowTriggerConsentDefinition = Readonly<{
  definition: WorkflowDefinitionV1;
  context: WorkflowTriggerContextV1;
  project: WorkflowProjectTargetV1;
  triggerId: string;
  workflowRef?: string;
  resolveWorkflow(ref: string): Promise<WorkflowDefinitionV1>;
  materializer?: Pick<MaterializeWorkflowAcceptedSnapshotV1Input, 'effects' | 'roleSelection'>;
}>;

async function readNativeActionContract(id: string) {
  const { ActionIdSchema } = await import('../actionIds.js');
  const actionId = ActionIdSchema.safeParse(id);
  if (!actionId.success) return null;
  const { getActionSpec } = await import('../actionSpecs.js');
  const { freezeWorkflowActionContractV1, actionSpecToActionDefinitionV1 } = await import('../actionCatalog.js');
  return freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(actionId.data)));
}

/** Shared consent pins Agent instructions and resolved launch choices, including child Workflows. */
export function projectWorkflowTriggerConsentAgentSteps(input: Readonly<{
  definition: WorkflowDefinitionV1;
  children: Readonly<Record<string, WorkflowDefinitionV1>>;
  materializedLeaves: readonly WorkflowMaterializedLeafV1[];
}>): NonNullable<WorkflowTriggerContextV1['actorConsent']>['agentSteps'] {
  const sources = new Map(([['$root', input.definition] as const, ...Object.entries(input.children)])
    .map(([key, definition]) => [key, new Map(walkWorkflowBlocks(definition.blocks).map(block => [block.id, block]))] as const));
  return input.materializedLeaves.flatMap(leaf => {
    if (leaf.kind !== 'step') return [];
    const authored = sources.get(leaf.sourceKey)?.get(leaf.blockId);
    if (authored?.kind !== 'step') throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
    return [{ sourceKey: leaf.sourceKey, blockId: leaf.blockId, document: authored.document, input: authored.input,
      ...(authored.inputMode === undefined ? {} : { inputMode: authored.inputMode }),
      selection: leaf.selection, executionTarget: leaf.executionTarget,
      ...(leaf.participant === undefined ? {} : { participant: leaf.participant }),
      ...(leaf.role === undefined ? {} : { role: leaf.role }) }];
  });
}

/** One materialization supplies both projections for a shared-trigger consent decision. */
export async function readWorkflowTriggerActorConsentSteps(input: Omit<WorkflowTriggerConsentDefinition, 'resolveWorkflow'> & Readonly<{
  resolveWorkflow(ref: string): Promise<Readonly<{ definition: WorkflowDefinitionV1; revision?: Readonly<{ bodyVersion: number }> }>>;
}>) {
  const childRevisions: { sourceKey: string; bodyVersion: number }[] = [];
  let completeChildRevisions = true;
  const { materialized, program } = await materializeWorkflowTriggerActionDefinition({ definition: input.definition,
    inputs: resolveWorkflowRunStartInputsV1(input.definition, input.context.inputs), project: input.project,
    resolveWorkflow: async ref => {
      const child = await input.resolveWorkflow(ref);
      if (child.revision === undefined) completeChildRevisions = false;
      else childRevisions.push({ sourceKey: ref, bodyVersion: child.revision.bodyVersion });
      return child.definition;
    }, materializer: input.materializer, deferTargetAvailability: true });
  if (!materialized.ok) throw Object.assign(new Error(materialized.error.code), { code: materialized.error.code });
  const projection = { definition: input.definition, children: program.children,
    materializedLeaves: materialized.materializedLeaves };
  const actionSteps = projectWorkflowTriggerConsentActionSteps({ ...projection, deployment: false });
  return { steps: actionSteps.map(row => row.step), actionStepRefs: actionSteps.map(row => row.ref),
    agentSteps: projectWorkflowTriggerConsentAgentSteps(projection), materializedLeaves: materialized.materializedLeaves,
    childRevisions: completeChildRevisions ? childRevisions : undefined };
}

/** The fixed-input rule and deployment SHA extension share one declaration/value binder. */
export async function materializeWorkflowTriggerActionDefinition(input: Readonly<{
  definition: WorkflowDefinitionV1; inputs: WorkflowResolvedInputsV1; project: WorkflowProjectTargetV1;
  executionTarget?: WorkflowRunExecutionTargetV1;
  workflowRef?: string;
  resolveWorkflow(ref: string): Promise<WorkflowDefinitionV1>;
  materializer?: Pick<MaterializeWorkflowAcceptedSnapshotV1Input, 'effects' | 'roleSelection'>;
  /** A pre-guest review freezes effects; the enrolled Run decides actual target availability. */
  deferTargetAvailability?: boolean;
}>) {
  const children: Record<string, WorkflowDefinitionV1> = {};
  const effects = input.materializer?.effects;
  const materialized = await materializeWorkflowDefinitionAuthorityV1({ definition: input.definition,
    ...(input.materializer?.roleSelection ? { roleSelection: input.materializer.roleSelection } : {}),
    context: { source: { kind: 'inline' }, inputs: input.inputs, machineId: input.project.machineId,
      ...(input.workflowRef === undefined ? {} : { triggerWorkflowRef: input.workflowRef }),
      executionTarget: input.executionTarget ?? { kind: 'detached_run' },
      workspaceTarget: { project: { ...input.project, checkoutRootPath: input.project.directory } },
      authorization: { principal: { kind: 'host' } } },
    effects: {
      ...effects,
      resolveTargetAvailability: input.deferTargetAvailability === true ? async () => true
        : effects?.resolveTargetAvailability ?? (async leaf => leaf.kind === 'action' || leaf.kind === 'workflow'),
      // Before Run admission, review uses native declarations and the exact contributed schema.
      readActionContract: input.deferTargetAvailability === true
        ? async id => await readNativeActionContract(id) ?? await effects?.readActionContract?.(id) ?? null
        : effects?.readActionContract ?? readNativeActionContract,
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
export async function readWorkflowTriggerActionConsent(input: WorkflowTriggerConsentDefinition) {
  const deployment = input.context.deploymentTriggers?.some(row => row.triggerId === input.triggerId) === true;
  const definition = deployment ? { ...input.definition,
    inputs: input.definition.inputs.map(field => field.name === 'sha' || field.name === 'requestKey'
      ? { ...field, required: false } : field) } : input.definition;
  const materializer = input.materializer;
  const { materialized, program } = await materializeWorkflowTriggerActionDefinition({ definition,
    inputs: resolveWorkflowRunStartInputsV1(definition, input.context.inputs), project: input.project,
    workflowRef: input.workflowRef, resolveWorkflow: input.resolveWorkflow, deferTargetAvailability: materializer !== undefined, materializer });
  if (!materialized.ok) throw Object.assign(new Error(materialized.error.code), { code: materialized.error.code });
  const materializedLeaves = materialized.materializedLeaves;
  return { steps: projectWorkflowTriggerConsentSteps({ definition, children: program.children, materializedLeaves, deployment,
    ...(input.workflowRef === undefined ? {} : { workflowRef: input.workflowRef }) }),
    materializedLeaves };
}

/** Authoring and Run admission consume the same already materialized effect scope. */
export function projectWorkflowTriggerConsentSteps(input: Readonly<{
  definition: WorkflowDefinitionV1;
  children: Readonly<Record<string, WorkflowDefinitionV1>>;
  materializedLeaves: readonly WorkflowMaterializedLeafV1[];
  deployment: boolean;
  workflowRef?: string;
}>): WorkflowApprovedOperationV1['steps'] {
  return projectWorkflowTriggerConsentActionSteps(input).map(row => row.step);
}

/** The same binding/filter supplies consent and the authored step's review identity. */
function projectWorkflowTriggerConsentActionSteps(input: Parameters<typeof projectWorkflowTriggerConsentSteps>[0]):
ReadonlyArray<Readonly<{ ref: Readonly<{ sourceKey: string; blockId: string }>; step: WorkflowApprovedOperationV1['steps'][number] }>> {
  const sources = new Map(([['$root', input.definition] as const, ...Object.entries(input.children)])
    .map(([key, definition]) => [key, { definition,
      blocks: new Map(walkWorkflowBlocks(definition.blocks).map(block => [block.id, block])) }] as const));
  return input.materializedLeaves.flatMap(leaf => {
    if (leaf.kind !== 'action' || !leaf.actionId || !leaf.actionInput) return [];
    const source = sources.get(leaf.sourceKey);
    const authored = source?.blocks.get(leaf.blockId);
    const occurrence = source && authored?.kind === 'action' ? readDeploymentBackupOccurrenceV1(source.definition, authored) : null;
    const ref = { sourceKey: leaf.sourceKey, blockId: leaf.blockId };
    if (authored?.kind === 'action') {
      if (input.workflowRef !== undefined && leaf.actionId === WORKFLOW_TRIGGER_ADD_ACTION_ID
        && authored.input.trigger?.kind === 'result') {
        // Automatic can bind only the instant supplied by this Run. The
        // concrete schedule shape is checked when that producer settles.
        const { trigger: _trigger, ...fixed } = leaf.actionInput;
        const producer = source?.blocks.get(authored.input.trigger.producer.blockId);
        if (leaf.sourceKey !== '$root' || authored.actionId !== leaf.actionId || producer?.kind !== 'action'
          || parseWorkflowDefinitionRefV1(input.workflowRef)?.kind !== 'artifact' || fixed.workflow !== input.workflowRef
          || !WorkflowProjectTargetV1Schema.safeParse(fixed.project).success || Object.keys(fixed).length !== 2) return [];
        return [{ ref, step: { actionId: leaf.actionId, input: fixed,
          binding: { kind: 'producer_result' as const, references: { trigger: authored.input.trigger }, scheduleStep: authored } } }];
      }
      const references = Object.fromEntries(Object.entries(authored.input).filter(([, binding]) =>
        listWorkflowActionFieldReferencesV1(binding).some(reference => reference.kind === 'trigger_event')));
      if (Object.keys(references).length > 0) {
        const step = WorkflowApprovedOperationStepV1Schema.safeParse({ actionId: leaf.actionId,
          input: Object.fromEntries(Object.entries(leaf.actionInput).filter(([field]) => !Object.hasOwn(references, field))),
          binding: { kind: 'trigger_event', references } });
        if (step.success) return [{ ref, step: step.data }];
      }
    }
    if (occurrence) return [{ ref, step: { actionId: leaf.actionId,
      input: Object.fromEntries(Object.entries(leaf.actionInput).filter(([field]) => !Object.hasOwn(occurrence.references, field))),
      binding: { kind: 'producer_result' as const, references: occurrence.references } } }];
    // Verify is a read-only check of this run's returned manifests, with no
    // standing mutation consent to carry through its per-snapshot item binding.
    if (leaf.actionId === DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1 && authored?.kind === 'action'
      && authored.input.snapshotId?.kind === 'item') return [];
    if (!input.deployment || leaf.actionId !== 'deployments.deploy') return [{ ref, step: { actionId: leaf.actionId, input: leaf.actionInput } }];
    const { sha: _sha, requestKey: _requestKey, ...fixed } = leaf.actionInput;
    return [{ ref, step: WorkflowApprovedOperationStepV1Schema.parse({ actionId: leaf.actionId,
      input: fixed, binding: { kind: 'deployment_sha' } }) }];
  });
}
