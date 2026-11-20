import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { invokeHostReviewedChildV1, resolveApprovalSurface,
  type ActionApprovedOperationAdmissionV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { formatQualifiedPluginActionId, parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { z } from 'zod/mini';
import { AutomationScheduleTriggerInputSchema } from '@happier-dev/protocol/automations/automationApiV3';
export { prepareWorkflowApprovedOperationSnapshot } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { bindWorkflowApprovedOperationSteps, matchesApprovedOperationStepV1,
  projectWorkflowTriggerConsentSteps } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { sameStrictJsonValue, StrictJsonValueSchema, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowApprovedOperationV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { resolveWorkflowInvocationStructureV1, type WorkflowInvocationBindingRowV1 } from '@happier-dev/protocol/workflows/workflowInvocationStructureV1';
import { readWorkflowInvocationMembersV1 } from '@happier-dev/protocol/workflows';
import type { WorkflowRunReadEncryptionV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import type { createWorkflowRunStorageClient } from './workflowRunStorageClient';
import { createWorkflowProducerBinding } from './workflowScopeBinding';
import { resolveWorkflowActionFieldBinding, resolveWorkflowValueReference, WorkflowInputResolutionError } from './input';
import { createWorkflowActionAdmissionReader } from './workflowActionAdmission';
import { readDeploymentBackupOccurrenceV1 } from '@happier-dev/protocol/workflows/builtins/backupExamples';
import { DeploymentBackupPolicyV1Schema, DeploymentBackupRunInputV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

function workflowActionOperand(actionId: string | undefined, input: unknown) {
  if (actionId !== 'action.invoke') return { actionId, input };
  const envelope = record(input);
  const target = PluginContributionIdentityV1Schema.safeParse(envelope.action);
  return target.success ? { actionId: formatQualifiedPluginActionId(target.data), input: envelope.input } : null;
}

/**
 * Fresh optional approval evidence, never a credential or a read grant.
 * Storage owns current access and Account mode; its existing key/envelope owner
 * opens only this Run. No result is cached between preparation and dispatch.
 */
export function createWorkflowApprovedOperationReader(params: Readonly<{
  storage: Pick<ReturnType<typeof createWorkflowRunStorageClient>, 'execute'>;
  resolveEncryption: (context: ActionExecutorContext) => Promise<WorkflowRunReadEncryptionV1 | null>;
  /** Fresh selected private record; the Account trigger owner retains its mode and lifecycle checks. */
  readSavedTriggerConsent?: (input: Readonly<{ automationId: string; triggerId: string; ownerAccountId: string;
    operation: WorkflowApprovedOperationV1; context: ActionExecutorContext;
  }>) => Promise<WorkflowApprovedOperationV1 | null>;
}>): (request: Readonly<{ runId: string; actionId?: string; input?: unknown; semanticInput?: unknown;
  context: ActionExecutorContext; phase: 'prepare' | 'dispatch' }>) => Promise<ActionApprovedOperationAdmissionV1 | null> {
  const readAdmission = createWorkflowActionAdmissionReader(params);
  return async ({ runId, actionId, input, semanticInput, context, phase }) => {
    try {
      // Coordinator correspondence names the contributed leaf; its ordinary
      // Action front door carries that same effect in the action.invoke envelope.
      if (actionId === 'action.invoke') {
        const operand = workflowActionOperand(actionId, input);
        if (!operand) return null;
        if (semanticInput !== undefined) {
          const semantic = workflowActionOperand(actionId, semanticInput);
          if (!semantic || semantic.actionId !== operand.actionId) return null;
          semanticInput = semantic.input;
        }
        actionId = operand.actionId;
        input = operand.input;
      }
      const admission = await readAdmission({ runId, context });
      if (!admission?.accepted.approvedOperation) return null;
      const { logicalInvocationId, accepted } = admission;
      const requestId = context.actionRequestId!;
      const options = context.signal ? { signal: context.signal } : {};
      let operation = admission.accepted.approvedOperation;
      const savedTrigger = operation.parent.actionId === 'workflow.trigger.add' || operation.parent.actionId === 'workflow.trigger.update';
      if (savedTrigger) {
        const origin = admission.run.origin;
        if (origin.kind !== 'automation' || origin.cause?.kind !== 'trigger' || !params.readSavedTriggerConsent) return null;
        const selected = await params.readSavedTriggerConsent({ automationId: origin.automationId,
          triggerId: origin.cause.triggerId, ownerAccountId: admission.run.ownerAccountId, operation, context });
        if (!selected) return null;
        operation = selected;
      }
      if (context.runtimeAccountId !== operation.approvedBy.accountId) return null;
      operation = { ...operation, steps: operation.steps.map(step => {
        if (step.actionId !== 'action.invoke' || step.binding) return step;
        const operand = workflowActionOperand(step.actionId, step.input);
        const input = z.record(z.string(), StrictJsonValueSchema).safeParse(operand?.input);
        return operand?.actionId && input.success ? { actionId: operand.actionId, input: input.data } : step;
      }) };
      const admitted = await admission.readActionInvocation(phase);
      if (!admitted) return null;
      const index = admitted.index;
      const invocation = admitted.progress;
      const execution = invocation.execution;
      const admitReviewedChild = (bound: WorkflowApprovedOperationV1, childAction: string,
        childInput: Readonly<Record<string, JsonValue>>): ActionApprovedOperationAdmissionV1 => {
        const surface = resolveApprovalSurface(context);
        if (surface.kind === 'ambiguous') return bound;
        // Only the live Run owner can supply this continuation after matching
        // the exact invocation. Stored operation data alone never folds Require.
        const parent = structuredClone(operation.parent);
        const child = { action: parseQualifiedPluginActionId(childAction) ?? ActionIdSchema.parse(childAction),
          role: logicalInvocationId, input: structuredClone(childInput) };
        return { ...bound, invokeReviewedChild: execute => invokeHostReviewedChildV1({
          parent, child, context, approvedBy: operation.approvedBy, ...(!savedTrigger ? {
            admittedReview: { action: child.action, role: logicalInvocationId, surface: surface.surface },
          } : {}),
          execute: (_input, issuedContext) => execute(issuedContext),
        }) };
      };
      if (actionId && operation.steps.some(step => step.actionId === actionId && step.binding && step.binding.kind !== 'deployment_sha')) {
        // Reuse the interpreter's ancestry, slot and value-reference owners.
        // Only exact selected rows are opened; repeated operands share one read
        // during this admission, with no retained cache or Run inventory scan.
        type Row = WorkflowInvocationBindingRowV1 & Readonly<{ key: string; path: typeof invocation.invocationPath }>;
        const rows = new Map<string, Promise<Row | undefined>>();
        const openRow = (value: unknown): Row | undefined => {
          const row = admission.openInvocation(value);
          return row ? { ...row, key: row.index.id, path: row.progress.invocationPath } : undefined;
        };
        const readInvocation = (id: string): Promise<Row | undefined> => {
          let pending = rows.get(id);
          if (!pending) {
            pending = params.storage.execute({ operation: 'invocations.get', runId, invocationId: id }, options)
              .then(response => {
                const row = openRow(record(response).invocation);
                return row?.index.id === id ? row : undefined;
              });
            rows.set(id, pending);
          }
          return pending;
        };
        const current: Row = { index, progress: invocation, key: index.id, path: invocation.invocationPath };
        rows.set(current.index.id, Promise.resolve(current));
        const structure = await resolveWorkflowInvocationStructureV1({ definition: accepted.definition,
          frozenChildren: accepted.frozenChildren, inputs: accepted.inputs,
          invocation: current, readInvocation, keyOfInvocation: row => row.index.id });
        if (structure?.leaf.kind !== 'action' || structure.leaf.actionId !== actionId) return null;
        const actionLeaf = structure.leaf;
        const producerResult = operation.steps.some(step => step.actionId === actionId && step.binding?.kind === 'producer_result');
        const occurrence = savedTrigger && producerResult ? readDeploymentBackupOccurrenceV1(structure.definition, actionLeaf) : null;
        // Saving projects authored blocks; acceptance freezes concrete
        // execution fields into `definition`, so compare the authored source.
        if (savedTrigger && !sameStrictJsonValue(operation.steps, projectWorkflowTriggerConsentSteps({
          definition: accepted.authoredDefinition, children: accepted.frozenChildren, materializedLeaves: accepted.materializedLeaves,
          deployment: operation.steps.some(step => step.binding?.kind === 'deployment_sha'),
          ...(accepted.source.kind === 'automation' && accepted.source.definitionId !== undefined
            ? { workflowRef: accepted.source.definitionId } : {}),
        }))) return null;
        const slots = new Map<string, Promise<Row | undefined>>();
        const producer = createWorkflowProducerBinding({ runId, frame: structure.frame, store: {
          readCurrent: async ({ blockId, scope, parentKey, memberOrdinal }) => {
            const parentRecordId = parentKey ?? structure.rootConversationOwnerRecordId;
            const slotKey = JSON.stringify([parentRecordId, memberOrdinal]);
            let selected = slots.get(slotKey);
            if (!selected) {
              selected = (async () => {
                const members = await readWorkflowInvocationMembersV1({ parentRecordIds: [parentRecordId], memberOrdinal,
                  readParent: readInvocation, indexOf: (row: Row) => row.index,
                  readChildren: async parents => (await Promise.all(parents.map(async parentRecordId => {
                    const response = await params.storage.execute({ operation: 'invocations.current', runId,
                      parentRecordId, memberOrdinal }, options);
                    return openRow(record(response).invocation);
                  }))).filter((row): row is Row => row !== undefined) });
                return members.get(parentRecordId)?.[0];
              })();
              slots.set(slotKey, selected);
            }
            const row = await selected;
            return row?.progress.invocationPath.blockId === blockId && sameStrictJsonValue(row.path.scope, scope) ? row : undefined;
          },
        } });
        const actual = z.record(z.string(), StrictJsonValueSchema).safeParse(semanticInput ?? input);
        const prepared = z.record(z.string(), StrictJsonValueSchema).safeParse(input);
        if (!actual.success || !prepared.success || index.lifecycle === 'admitting'
          && (execution?.kind !== 'action' || execution.actionId !== actionId || execution.actionRequestId !== requestId
            || !sameStrictJsonValue(execution.input, actual.data))
          || index.lifecycle === 'pending' && execution !== undefined) return null;
        if (occurrence) {
          const fixed = Object.fromEntries(await Promise.all(Object.entries(occurrence.producer.input).map(async ([field, reference]) =>
            [field, await resolveWorkflowActionFieldBinding(reference, { inputs: structure.inputs,
              resolveResult: async () => { throw new WorkflowInputResolutionError('invalid_reference_scope'); },
              resolveWorkspace: async () => { throw new WorkflowInputResolutionError('invalid_reference_scope'); } })])));
          const anchor = operation.steps.find(step => !step.binding && step.actionId === DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1
            && sameStrictJsonValue(step.input, fixed));
          if (!anchor) return null;
          const selected = await producer.resolve({ blockId: occurrence.producer.id, scope: { kind: 'current' } });
          if (selected?.index.lifecycle !== 'completed') return null;
          const output = record(selected.progress.result);
          const policy = DeploymentBackupPolicyV1Schema.safeParse(output.backupPolicy);
          const target = DeploymentBackupRunInputV1Schema.safeParse(output.backupTarget);
          if (!policy.success || !target.success || !sameStrictJsonValue(policy.data, anchor.input.backupPolicy)
            || target.data.serverId !== anchor.input.serverId || target.data.environmentId !== anchor.input.environmentId) return null;
        }
        for (const step of operation.steps) {
          if (step.actionId !== actionId || !step.binding || step.binding.kind === 'deployment_sha') continue;
          if (step.binding.kind === 'producer_result') {
            if (step.binding.scheduleStep) {
              const trigger = AutomationScheduleTriggerInputSchema.safeParse(actual.data.trigger);
              if (!savedTrigger || structure.sourceKey !== '$root' || step.binding.scheduleStep.id !== actionLeaf.id
                || !trigger.success || !trigger.data.enabled || trigger.data.schedule.kind !== 'once') continue;
            } else if (savedTrigger && !occurrence) continue;
          }
          if (!Object.entries(step.binding.references).every(([field, reference]) =>
            sameStrictJsonValue(actionLeaf.input[field], reference))) continue;
          const runtime = { inputs: structure.inputs, triggerEventValues: accepted.triggerEventValues,
            resolveResult: async reference => {
              const row = await producer.resolve(reference);
              if (row?.index.lifecycle !== 'completed' || row.progress.result === undefined)
                throw new WorkflowInputResolutionError('missing_reference');
              return row.progress.result;
            },
            resolveWorkspace: async () => { throw new WorkflowInputResolutionError('invalid_reference_scope'); },
          } satisfies Parameters<typeof resolveWorkflowValueReference>[1];
          const operands = step.binding.kind === 'trigger_event'
            ? await Promise.all(Object.entries(step.binding.references).map(async ([field, reference]) =>
              [field, await resolveWorkflowActionFieldBinding(reference, runtime)] as const))
            : await Promise.all(Object.entries(step.binding.references).map(async ([field, reference]) =>
              [field, await resolveWorkflowValueReference(reference, runtime)] as const));
          const resolved = Object.fromEntries([...Object.entries(step.input), ...operands]);
          if (sameStrictJsonValue(resolved, actual.data)) {
            // Preparation already validated these concrete effects. Only this
            // exact semantic match may carry consent onto its prepared input.
            context.signal?.throwIfAborted();
            return admitReviewedChild(bindWorkflowApprovedOperationSteps({ operation, materializedLeaves: accepted.materializedLeaves,
              steps: [{ actionId, input: prepared.data }] }), actionId, prepared.data);
          }
        }
      }
      let matchingSteps: WorkflowApprovedOperationV1['steps'];
      let originalActionId: string;
      let originalInput: Readonly<Record<string, JsonValue>>;
      if (index.lifecycle === 'admitting') {
        if (execution?.kind !== 'action' || execution.actionRequestId !== requestId) return null;
        originalActionId = execution.actionId;
        originalInput = z.record(z.string(), StrictJsonValueSchema).parse(execution.input);
        matchingSteps = operation.steps.filter(step => matchesApprovedOperationStepV1(step, execution.actionId, execution.input));
      } else {
        if (execution !== undefined) return null;
        const leaves = accepted.materializedLeaves.filter(leaf => leaf.kind === 'action'
          && leaf.blockId === invocation.invocationPath.blockId);
        // A pending row has no resolved correspondence yet. Only an unambiguous
        // exact frozen input can consent before the admitting write; deferred
        // bindings keep ordinary approval until that evidence exists.
        if (leaves.length !== 1 || leaves[0]!.actionInput === undefined || leaves[0]!.actionId === undefined) return null;
        const leaf = leaves[0]!;
        if (leaf.actionId === undefined || leaf.actionInput === undefined) return null;
        originalActionId = leaf.actionId;
        originalInput = leaf.actionInput;
        matchingSteps = operation.steps.filter(step => matchesApprovedOperationStepV1(step, originalActionId, originalInput));
      }
      if (matchingSteps.length === 0) return null;
      context.signal?.throwIfAborted();
      if (!actionId) return { ...operation, steps: matchingSteps };
      const preparedActionId = actionId;
      const prepared = z.record(z.string(), StrictJsonValueSchema).safeParse(input);
      if (preparedActionId !== originalActionId || !prepared.success
        || matchingSteps.some(step => step.binding) && semanticInput === undefined
        || !sameStrictJsonValue(semanticInput ?? input, originalInput)
        || !matchingSteps.some(step => matchesApprovedOperationStepV1(step, preparedActionId, semanticInput ?? input))) return null;
      return admitReviewedChild(bindWorkflowApprovedOperationSteps({ operation, materializedLeaves: accepted.materializedLeaves,
        steps: [{ actionId: preparedActionId, input: prepared.data }] }), preparedActionId, prepared.data);
    } catch {
      // Absent/revoked/unreadable evidence restores ordinary approval policy.
      return null;
    }
  };
}
