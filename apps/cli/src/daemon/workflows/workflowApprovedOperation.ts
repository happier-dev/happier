import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { invokeHostReviewedChildV1, resolveApprovalSurface,
  type ActionApprovedOperationAdmissionV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { formatQualifiedPluginActionId, parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { z } from 'zod/mini';
export { prepareWorkflowApprovedOperationSnapshot } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { bindWorkflowApprovedOperationSteps, matchesApprovedOperationStepV1 } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { sameStrictJsonValue, StrictJsonValueSchema, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowApprovedOperationV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { WorkflowRunSummaryV1Schema, WorkflowRunInvocationIndexV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { resolveWorkflowInvocationStructureV1, type WorkflowInvocationBindingRowV1 } from '@happier-dev/protocol/workflows/workflowInvocationStructureV1';
import { readWorkflowInvocationMembersV1 } from '@happier-dev/protocol/workflows';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { resolveWorkflowRunDataKeyV1, type WorkflowRunReadEncryptionV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import { openWorkflowAcceptedSnapshotStoredEnvelopeV1, openWorkflowProgressStoredEnvelopeV1,
  parseWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import type { createWorkflowRunStorageClient } from './workflowRunStorageClient';
import { createWorkflowProducerBinding } from './workflowScopeBinding';
import { resolveWorkflowValueReference, WorkflowInputResolutionError } from './input';

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
      const requestId = context.actionRequestId;
      const externalOrigin = context.externalActionExecutionAuthorization?.binding.workflowActionOrigin;
      const localCaller = context.actionCaller;
      if (!requestId || !(externalOrigin?.runId === runId && externalOrigin.requestId === requestId
        || !context.externalActionExecutionAuthorization && localCaller?.kind === 'workflowRun'
          && localCaller.runId === runId && context.executionRunWorkflowRunId === runId)) return null;
      if (!requestId.startsWith(`${runId}/`)) return null;
      const identity = requestId.slice(runId.length + 1);
      const separator = identity.lastIndexOf('/');
      const logicalInvocationId = identity.slice(0, separator);
      const attempt = identity.slice(separator + 1);
      if (separator <= 0 || !/^(0|[1-9][0-9]*)$/.test(attempt)) return null;
      context.signal?.throwIfAborted();
      const options = context.signal ? { signal: context.signal } : {};
      const stored = record(await params.storage.execute({ operation: 'get', runId }, options));
      const run = WorkflowRunSummaryV1Schema.safeParse(stored.run);
      const census = WorkflowRunRecipientCensusResponseV1Schema.safeParse(stored.keyCensus);
      if (!run.success || run.data.id !== runId || !['claimed', 'running'].includes(run.data.state)
        || run.data.workflowCustodyState !== 'pending' || !census.success || census.data.runId !== runId
        || census.data.ownerAccountId !== run.data.ownerAccountId || typeof stored.acceptedEnvelope !== 'string') return null;
      const material = await params.resolveEncryption(context);
      if (!material) return null;
      const key = resolveWorkflowRunDataKeyV1({ encryption: material, census: census.data });
      if (key.kind !== 'available') return null;
      const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...key.encryption.runCrypto,
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: census.data.ownerAccountId, runId },
        envelope: parseWorkflowStoredContentEnvelopeV1(stored.acceptedEnvelope) });
      if (opened.kind !== 'available' || !opened.content.approvedOperation) return null;
      let operation = opened.content.approvedOperation;
      const savedTrigger = operation.parent.actionId === 'workflow.trigger.add' || operation.parent.actionId === 'workflow.trigger.update';
      if (savedTrigger) {
        const origin = run.data.origin;
        if (origin.kind !== 'automation' || origin.cause?.kind !== 'trigger' || !params.readSavedTriggerConsent) return null;
        const selected = await params.readSavedTriggerConsent({ automationId: origin.automationId,
          triggerId: origin.cause.triggerId, ownerAccountId: run.data.ownerAccountId, operation, context });
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
      let detail = record(record(await params.storage.execute({ operation: 'invocations.get', runId,
        invocationId: logicalInvocationId }, options)).invocation);
      let index = WorkflowRunInvocationIndexV1Schema.safeParse(detail.index);
      // Recovery retains the logical request identity while the ordinary slot
      // owner selects its newest physical attempt. No inventory scan is needed.
      if (index.success && index.data.attempt !== attempt && index.data.parentRecordId) {
        detail = record(record(await params.storage.execute({ operation: 'invocations.current', runId,
          parentRecordId: index.data.parentRecordId, memberOrdinal: index.data.memberOrdinal }, options)).invocation);
        index = WorkflowRunInvocationIndexV1Schema.safeParse(detail.index);
      }
      if (!index.success || index.data.runId !== runId || index.data.attempt !== attempt
        || typeof detail.contentEnvelope !== 'string'
        || !(index.data.lifecycle === 'admitting' || phase === 'prepare' && index.data.lifecycle === 'pending')) return null;
      const progress = openWorkflowProgressStoredEnvelopeV1({ ...key.encryption.runCrypto,
        binding: { v: 1, purpose: 'invocation_progress', accountId: census.data.ownerAccountId, runId,
          recordId: index.data.id, sequence: index.data.sequence, parentRecordId: index.data.parentRecordId,
          memberOrdinal: index.data.memberOrdinal, attempt: index.data.attempt },
        envelope: parseWorkflowStoredContentEnvelopeV1(detail.contentEnvelope) });
      if (progress.kind !== 'available') return null;
      const invocation = progress.content;
      if (invocation.logicalInvocationRecordId !== logicalInvocationId || invocation.blockKind !== 'action') return null;
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
          parent, child, context, ...(!savedTrigger ? {
            admittedReview: { action: child.action, role: logicalInvocationId, surface: surface.surface },
          } : {}),
          execute: (_input, issuedContext) => execute(issuedContext),
        }) };
      };
      if (actionId && operation.parent.actionId !== 'workflow.trigger.add' && operation.parent.actionId !== 'workflow.trigger.update'
        && operation.steps.some(step => step.actionId === actionId && step.binding?.kind === 'producer_result')) {
        // Reuse the interpreter's ancestry, slot and value-reference owners.
        // Only exact selected rows are opened; repeated operands share one read
        // during this admission, with no retained cache or Run inventory scan.
        type Row = WorkflowInvocationBindingRowV1 & Readonly<{ key: string; path: typeof invocation.invocationPath }>;
        const rows = new Map<string, Promise<Row | undefined>>();
        const openRow = (value: unknown): Row | undefined => {
          const detail = record(value);
          const parsed = WorkflowRunInvocationIndexV1Schema.safeParse(detail.index);
          if (!parsed.success || parsed.data.runId !== runId || typeof detail.contentEnvelope !== 'string') return undefined;
          const index = parsed.data;
          const content = openWorkflowProgressStoredEnvelopeV1({ ...key.encryption.runCrypto,
            binding: { v: 1, purpose: 'invocation_progress', accountId: census.data.ownerAccountId, runId,
              recordId: index.id, sequence: index.sequence, parentRecordId: index.parentRecordId,
              memberOrdinal: index.memberOrdinal, attempt: index.attempt },
            envelope: parseWorkflowStoredContentEnvelopeV1(detail.contentEnvelope) });
          if (content.kind !== 'available' || content.content.attempt !== index.attempt) return undefined;
          return { index, progress: content.content, key: index.id, path: content.content.invocationPath };
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
        const current: Row = { index: index.data, progress: invocation, key: index.data.id, path: invocation.invocationPath };
        rows.set(current.index.id, Promise.resolve(current));
        const structure = await resolveWorkflowInvocationStructureV1({ definition: opened.content.definition,
          frozenChildren: opened.content.frozenChildren, inputs: opened.content.inputs,
          invocation: current, readInvocation, keyOfInvocation: row => row.index.id });
        if (structure?.leaf.kind !== 'action' || structure.leaf.actionId !== actionId) return null;
        const actionLeaf = structure.leaf;
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
        if (!actual.success || !prepared.success || index.data.lifecycle === 'admitting'
          && (execution?.kind !== 'action' || execution.actionId !== actionId || execution.actionRequestId !== requestId
            || !sameStrictJsonValue(execution.input, actual.data))
          || index.data.lifecycle === 'pending' && execution !== undefined) return null;
        for (const step of operation.steps) {
          if (step.actionId !== actionId || step.binding?.kind !== 'producer_result') continue;
          if (!Object.entries(step.binding.references).every(([field, reference]) =>
            sameStrictJsonValue(actionLeaf.input[field], reference))) continue;
          const operands: [string, JsonValue][] = [];
          for (const [field, reference] of Object.entries(step.binding.references)) {
            const value = await resolveWorkflowValueReference(reference, { inputs: structure.inputs,
              resolveResult: async reference => {
                const row = await producer.resolve(reference);
                if (row?.index.lifecycle !== 'completed' || row.progress.result === undefined)
                  throw new WorkflowInputResolutionError('missing_reference');
                return row.progress.result;
              },
              resolveWorkspace: async () => { throw new WorkflowInputResolutionError('invalid_reference_scope'); },
            });
            operands.push([field, value]);
          }
          const resolved = Object.fromEntries([...Object.entries(step.input), ...operands]);
          if (sameStrictJsonValue(resolved, actual.data)) {
            // Preparation already validated these concrete effects. Only this
            // exact semantic match may carry consent onto its prepared input.
            context.signal?.throwIfAborted();
            return admitReviewedChild(bindWorkflowApprovedOperationSteps({ operation, materializedLeaves: opened.content.materializedLeaves,
              steps: [{ actionId, input: prepared.data }] }), actionId, prepared.data);
          }
        }
      }
      let matchingSteps: WorkflowApprovedOperationV1['steps'];
      let originalActionId: string;
      let originalInput: Readonly<Record<string, JsonValue>>;
      if (index.data.lifecycle === 'admitting') {
        if (execution?.kind !== 'action' || execution.actionRequestId !== requestId) return null;
        originalActionId = execution.actionId;
        originalInput = z.record(z.string(), StrictJsonValueSchema).parse(execution.input);
        matchingSteps = operation.steps.filter(step => matchesApprovedOperationStepV1(step, execution.actionId, execution.input));
      } else {
        if (execution !== undefined) return null;
        const leaves = opened.content.materializedLeaves.filter(leaf => leaf.kind === 'action'
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
      const admittedActionId = actionId;
      const prepared = z.record(z.string(), StrictJsonValueSchema).safeParse(input);
      if (actionId !== originalActionId || !prepared.success
        || matchingSteps.some(step => step.binding) && semanticInput === undefined
        || !sameStrictJsonValue(semanticInput ?? input, originalInput)
        || !matchingSteps.some(step => matchesApprovedOperationStepV1(step, admittedActionId, semanticInput ?? input))) return null;
      return admitReviewedChild(bindWorkflowApprovedOperationSteps({ operation, materializedLeaves: opened.content.materializedLeaves,
        steps: [{ actionId, input: prepared.data }] }), actionId, prepared.data);
    } catch {
      // Absent/revoked/unreadable evidence restores ordinary approval policy.
      return null;
    }
  };
}
