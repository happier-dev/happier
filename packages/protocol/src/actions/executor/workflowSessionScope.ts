import { z } from '../../zodRuntimePolicy.js';
import { WorkflowRunGetResultV1Schema, WorkflowInvocationListResultV1Schema, type WorkflowInvocationListRequestV1 } from '../../workflows/actionsV1.js';
import { resolveWorkflowInvocationStructureV1, type WorkflowInvocationBindingRowV1 } from '../../workflows/workflowInvocationStructureV1.js';
import { readWorkflowActionInvocationV1, type WorkflowSessionScopeV1 } from '../../workflows/workflowSessionScopeV1.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { areServerProfileIdentifiersEquivalent } from '../../features/payload/capabilities/serverIdentityCapabilities.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import type { ActionId } from '../actionIds.js';
import type { WorkflowMaterializedLeafV1 } from '../../workflows/workflowDefinitionV1.js';
import { readWorkflowCurrentInvocationAncestryV1 } from '../../workflows/workflowInvocationMembersV1.js';
import { createActionExecuteFailureError } from '../actionExecutionResult.js';

type WorkflowActionInvocationContextV1 = Readonly<{
  opened: ReturnType<typeof WorkflowRunGetResultV1Schema.parse>;
  readInvocation: (id: string) => Promise<WorkflowInvocationBindingRowV1 | undefined>;
  readMembers: (parentRecordId: string, memberOrdinal?: string) => Promise<WorkflowInvocationBindingRowV1[]>;
  readChildHistory: (parentRecordIds: string[]) => Promise<WorkflowInvocationBindingRowV1[]>;
  invocation: WorkflowInvocationBindingRowV1;
  structure: NonNullable<Awaited<ReturnType<typeof resolveWorkflowInvocationStructureV1>>>;
  leaf: WorkflowMaterializedLeafV1;
}>;

const invalidScope = createActionExecuteFailureError({ ok: false, errorCode: 'content_unavailable',
  error: 'workflow_scope_content_unavailable' });

/** Opens the exact accepted frame; neither Action operands nor sibling targets supply authority.
 * Missing/misbound facts return null; read failures propagate to the Action failure owner.
 */
export async function readActionWorkflowInvocationContextV1(
  actionId: ActionId, context: ActionExecutorContext,
  deps: Pick<ActionExecutorDeps, 'workflowAction' | 'resolveSessionReference' | 'resolveServerProfileScopeId'>,
): Promise<WorkflowActionInvocationContextV1 | null> {
  const caller = context.actionCaller;
  if (caller?.kind !== 'workflowRun' || !deps.workflowAction) return null;
  const identity = readWorkflowActionInvocationV1(caller.runId, context.actionRequestId ?? undefined);
  if (!identity) return null;
  const workflowAction = deps.workflowAction;
  const invoke = async (request: Parameters<NonNullable<ActionExecutorDeps['workflowAction']>>[0]) => workflowAction(request);
  const common = { context, ...(context.signal ? { signal: context.signal } : {}) };
  try {
    const opened = WorkflowRunGetResultV1Schema.parse(await invoke({ ...common,
      actionId: 'workflow.run.get', input: { runId: caller.runId, includeUsage: false } }));
    if (opened.run.id !== caller.runId) return null;
    // This opened ancestry lives only for this Action. It neither retains
    // authority across Actions nor replaces each effect's current Session check.
    const rows = new Map<string, WorkflowInvocationBindingRowV1>();
    const readSelected = async (selection: Pick<WorkflowInvocationListRequestV1, 'invocationId' | 'parentRecordId' | 'memberOrdinal' | 'parentRecordIds'>) => {
      const parents = selection.parentRecordIds ? new Set(selection.parentRecordIds) : undefined;
      const selected: WorkflowInvocationBindingRowV1[] = [];
      const ids = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        context.signal?.throwIfAborted();
        const page = WorkflowInvocationListResultV1Schema.parse(await invoke({ ...common,
          actionId: 'workflow.run.invocations.list', input: { runId: caller.runId, includeContent: true,
            ...selection, ...(cursor ? { cursor } : {}) } }));
        const details = page.invocationDetails;
        if (!details || details.length !== page.invocations.length) throw invalidScope;
        const indices = new Map(page.invocations.map(index => [index.id, index]));
        if (indices.size !== page.invocations.length) throw invalidScope;
        for (const detail of details) {
          const index = indices.get(detail.index.id);
          if (!index || index.runId !== caller.runId || !sameStrictJsonValue(index, detail.index)
            || detail.parentRevision !== page.parentRevision || detail.progress.attempt !== index.attempt
            || ids.has(index.id)
            || (selection.invocationId !== undefined && index.id !== selection.invocationId)
            || (selection.parentRecordId !== undefined && index.parentRecordId !== selection.parentRecordId)
            || (parents !== undefined && (index.parentRecordId === null || !parents.has(index.parentRecordId)))
            || (selection.memberOrdinal !== undefined && index.memberOrdinal !== selection.memberOrdinal)) {
            throw invalidScope;
          }
          ids.add(index.id);
          rows.set(index.id, detail);
          selected.push(detail);
        }
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw invalidScope;
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return selected;
    };
    const read = async (invocationId: string) => {
      const existing = rows.get(invocationId);
      if (existing) return existing;
      const selected = await readSelected({ invocationId });
      return selected.length === 1 ? selected[0] : undefined;
    };
    const readMembers = (parentRecordId: string, memberOrdinal?: string) => readSelected({ parentRecordId,
      ...(memberOrdinal === undefined ? {} : { memberOrdinal }) });
    const readChildHistory = (parentRecordIds: string[]) => parentRecordIds.length ? readSelected({ parentRecordIds }) : Promise.resolve([]);
    const logical = await read(identity.logicalInvocationId);
    if (!logical) return null;
    const ancestryParents = new Map<string, string>();
    const ancestry = await readWorkflowCurrentInvocationAncestryV1({ invocation: logical,
      currentRootRecordId: opened.checkpoint?.rootRecordId, readInvocation: read, readCurrentRoot: async () => {
        const roots = await readSelected({ parentRecordId: null, memberOrdinal: '0' });
        return roots.length === 1 ? roots[0] : undefined;
      }, readChildren: (parents, ordinal) => Promise.all(parents.map(id => readMembers(id, ordinal))).then(pages => pages.flat()) });
    const invocation = ancestry?.at(-1);
    for (let index = 1; ancestry && index < ancestry.length; index += 1) {
      ancestryParents.set(ancestry[index]!.index.id, ancestry[index - 1]!.index.id);
    }
    if (!invocation || invocation.index.lifecycle === 'superseded' || invocation.progress.blockKind !== 'action'
      || invocation.progress.attempt !== identity.attempt || invocation.progress.logicalInvocationRecordId !== identity.logicalInvocationId
      || (invocation.progress.execution && (invocation.progress.execution.kind !== 'action'
        || invocation.progress.execution.actionId !== actionId || invocation.progress.execution.actionRequestId !== context.actionRequestId))) return null;
    // Inherited rows retain their authenticated physical parent. Only the
    // reconstructed interpreter ancestry uses the selected current parent.
    const structureRow = (row: WorkflowInvocationBindingRowV1): WorkflowInvocationBindingRowV1 => {
      const parentRecordId = ancestryParents.get(row.index.id);
      return parentRecordId === undefined ? row : { ...row, index: { ...row.index, parentRecordId } };
    };
    const structure = await resolveWorkflowInvocationStructureV1({ definition: opened.definition,
      frozenChildren: opened.acceptedContext.frozenChildren, inputs: opened.acceptedContext.inputs,
      invocation: structureRow(invocation), readInvocation: async id => {
        const row = await read(id);
        return row ? structureRow(row) : undefined;
      }, keyOfInvocation: row => row.index.id });
    if (structure?.leaf.kind !== 'action' || structure.leaf.actionId !== actionId) return null;
    const leaf = opened.acceptedContext.materializedLeaves.find(leaf => leaf.sourceKey === structure.sourceKey
      && leaf.blockId === structure.leaf.id && leaf.kind === 'action' && leaf.actionId === actionId);
    if (!leaf) return null;
    return { opened, readInvocation: read, readMembers, readChildHistory, invocation, structure, leaf };
  } catch (error) {
    if (error === invalidScope || error instanceof z.core.$ZodError) return null;
    throw error;
  }
}

export async function resolveActionWorkflowSessionScopeV1(
  actionId: ActionId, context: ActionExecutorContext,
  deps: Pick<ActionExecutorDeps, 'workflowAction' | 'resolveSessionReference' | 'resolveServerProfileScopeId'>,
): Promise<WorkflowSessionScopeV1 | null> {
  if (actionId !== 'review.start' && actionId !== 'review.apply' && !actionId.startsWith('reviews.comments.')) return null;
  const binding = await readActionWorkflowInvocationContextV1(actionId, context, deps);
  if (!binding) return null;
  const { opened, invocation, structure, leaf } = binding;
  const sessions: WorkflowSessionScopeV1['sessions'] = [];
  const sameHome = (left: string, right: string | null | undefined) => areServerProfileIdentifiersEquivalent(left, right,
    identifier => identifier === context.serverId && context.serverIdentityId ? context.serverIdentityId
      : identifier === context.serverIdentityId ? context.serverIdentityId : deps.resolveServerProfileScopeId?.(identifier));
  for (const binding of leaf.sessionAuthorityBindings ?? []) {
    const value = structure.inputs[binding.inputName];
    if (value === undefined && structure.definition.inputs.some(field => field.name === binding.inputName && !field.required)) continue;
    const admitted = binding.targets.find(target => sameStrictJsonValue(target.address, value));
    if (!admitted || !sameHome(admitted.address.serverId, context.serverId) || !deps.resolveSessionReference) return null;
    const current = await deps.resolveSessionReference({ context, actionId, sessionId: admitted.address.sessionId,
      ...(context.signal ? { signal: context.signal } : {}) });
    context.signal?.throwIfAborted();
    if (current.kind !== 'unique' || current.address.sessionId !== admitted.address.sessionId
      || !sameHome(current.address.serverId, admitted.address.serverId)) return null;
    if (!sessions.some(address => sameStrictJsonValue(address, admitted.address))) sessions.push(admitted.address);
  }
  return { actionRequestId: context.actionRequestId!, invocationId: invocation.index.id, sessions };
}
