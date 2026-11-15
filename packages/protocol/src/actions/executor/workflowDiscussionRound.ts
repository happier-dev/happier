import { readActionWorkflowInvocationContextV1 } from './workflowSessionScope.js';
import { WorkflowDiscussionRoundProjectInputV1Schema, WorkflowDiscussionRoundProjectResultV1Schema } from '../../workflows/workflowDiscussionRoundV1.js';
import { resolveWorkflowInvocationStructureV1 } from '../../workflows/workflowInvocationStructureV1.js';
import { resolveWorkflowAcceptedStepSelectionV1 } from '../../workflows/workflowStepSelectionV1.js';
import { sameStrictJsonValue, StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import type { ActionExecuteResult } from '../actionExecutionResult.js';
import { normalizeExecutableParticipantSelectionV1, type ExecutableParticipantSelectionV1 } from '../../discussions/executableParticipants.js';
import type { DiscussionOpenedMessageV1 } from '../../discussions/actions.js';
import { readWorkflowDiscussionContextV1 } from '../../workflows/workflowDiscussionContextV1.js';
import type { WorkflowBlock } from '../../workflows/workflowV1.js';
import type { WorkflowInvocationBindingRowV1 } from '../../workflows/workflowInvocationStructureV1.js';
import { readWorkflowInvocationMembersV1 } from '../../workflows/workflowInvocationMembersV1.js';

/** No round store: derive only from authorized, committed invocation and reply facts.
 * Read exceptions retain their cause through the enclosing Action failure owner.
 */
export async function executeWorkflowDiscussionRoundProjectV1(input: unknown, context: ActionExecutorContext,
  deps: ActionExecutorDeps): Promise<ActionExecuteResult> {
  const request = WorkflowDiscussionRoundProjectInputV1Schema.parse(input);
  const binding = await readActionWorkflowInvocationContextV1('workflow.discussion.round.project', context, deps);
  const unavailable = (): ActionExecuteResult => ({ ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' });
  if (!binding) return unavailable();
  const { opened, invocation, readInvocation, readMembers, readChildHistory } = binding;
  const readInheritedMembers = async (parentRecordIds: string[], memberOrdinal?: string) => readWorkflowInvocationMembersV1({
    parentRecordIds, ...(memberOrdinal === undefined ? {} : { memberOrdinal }), readParent: readInvocation,
    readChildren: parents => memberOrdinal === undefined ? readChildHistory(parents)
      : Promise.all(parents.map(parent => readMembers(parent, memberOrdinal))).then(pages => pages.flat()),
    indexOf: (row: WorkflowInvocationBindingRowV1) => row.index,
  });
  const readSlot = async (parent: string, ordinal: string) => (await readInheritedMembers([parent], ordinal)).get(parent)!;
  if (invocation.index.parentRecordId === null) return unavailable();
  // Conditionals retain their enclosing invocation scope. Follow only the
  // selected paths containing the requested block, including enclosing peers.
  let scopeFrame = binding.structure.frame;
  while (scopeFrame.parent && sameStrictJsonValue(scopeFrame.parent.scope, scopeFrame.scope)) scopeFrame = scopeFrame.parent;
  const scopeParentId = scopeFrame.structuralKey ?? binding.structure.rootConversationOwnerRecordId;
  const readBlock = async (parentRecordId: string, blockId: string | undefined) => {
    if (blockId === undefined) return [];
    const contains = (blocks: readonly WorkflowBlock[]) => {
      const pending = [...blocks];
      while (pending.length) {
        const block = pending.pop()!;
        if (block.id === blockId) return true;
        if (block.kind === 'if') pending.push(...block.then, ...block.otherwise);
      }
      return false;
    };
    const readIn = async (blocks: readonly WorkflowBlock[], parent: string): Promise<WorkflowInvocationBindingRowV1[]> => {
      const candidates = await Promise.all(blocks.flatMap((block, ordinal) => {
        if (block.id === blockId) return [readSlot(parent, String(ordinal))];
        if (block.kind !== 'if' || !contains([...block.then, ...block.otherwise])) return [];
        return [(async () => {
          const conditional = (await readSlot(parent, String(ordinal))).find(row => row.progress.blockKind === 'if'
            && row.progress.invocationPath.blockId === block.id && row.index.lifecycle !== 'superseded' && row.index.lifecycle !== 'skipped');
          const progress = conditional?.progress.container;
          return conditional && progress?.kind === 'if'
            ? await readIn(progress.selected === 'then' ? block.then : block.otherwise, conditional.index.id) : [];
        })()];
      }));
      return candidates.flat();
    };
    return await readIn(scopeFrame.blocks, parentRecordId);
  };
  const origin = 'origin' in opened.acceptedContext ? opened.acceptedContext.origin?.discussion : undefined;
  if (request.phase === 'prepare') {
    const declaration = binding.structure.definition.inputs.find(field => field.name === request.rosterInput);
    const raw = request.rosterInput ? binding.structure.inputs[request.rosterInput] : undefined;
    if (!declaration?.multiple || !declaration.inputType || !('hostType' in declaration.inputType)
      || declaration.inputType.hostType !== 'agentParticipant' || !Array.isArray(raw)) return unavailable();
    const roster: ExecutableParticipantSelectionV1[] = [];
    for (const value of raw) {
      const participant = normalizeExecutableParticipantSelectionV1(value);
      if (!participant) return unavailable();
      roster.push(participant);
    }
    const loop = binding.structure.frame.loop;
    if (!loop) return unavailable();
    let prior: ReturnType<typeof WorkflowDiscussionRoundProjectResultV1Schema.parse> | undefined;
    if (loop.index > 0) {
      const scope = invocation.progress.invocationPath.scope.map(part => part.kind === 'iteration' && part.blockId === loop.blockId
        ? { ...part, index: loop.index - 1 } : part);
      const previousFrame = (await readSlot(loop.ownerKey, String(loop.index - 1))).find(row =>
        row.index.lifecycle !== 'superseded' && row.index.lifecycle !== 'skipped'
        && row.progress.frame?.ownerBlockId === loop.blockId
        && row.progress.frame.source.kind === 'iteration' && row.progress.frame.source.index === String(loop.index - 1));
      if (!previousFrame) return unavailable();
      const previous = (await readBlock(previousFrame.index.id, request.previousProjectionBlockId)).find(row => row.index.lifecycle === 'completed' && row.progress.blockKind === 'action'
        && row.progress.invocationPath.blockId === request.previousProjectionBlockId
        && sameStrictJsonValue(row.progress.invocationPath.scope, scope));
      const parsed = WorkflowDiscussionRoundProjectResultV1Schema.safeParse(previous?.progress.result);
      if (!parsed.success) return unavailable();
      prior = parsed.data;
    }
    const nextParticipants = prior ? [...prior.nextParticipants] : [...roster];
    if (nextParticipants.some(participant => !roster.some(admitted => sameStrictJsonValue(participant, admitted)))) return unavailable();
    let throughSeq = prior?.throughSeq ?? origin?.throughSeq;
    const sinceSeq = throughSeq;
    const messages: DiscussionOpenedMessageV1[] = [];
    if (origin) {
      if (!deps.discussionAction || !context.serverId) return unavailable();
      const read = await readWorkflowDiscussionContextV1({ origin, scope: 'so_far', ...(sinceSeq === undefined ? {} : { afterSeq: sinceSeq }),
        context, discussionAction: deps.discussionAction, resolveServerProfileScopeId: deps.resolveServerProfileScopeId });
      if (!read.ok) return { ok: false, errorCode: read.code, error: read.code };
      throughSeq = read.context.throughSeq;
      messages.push(...read.context.messages.filter(message => !message.producerV1));
      const addressed = new Set(messages.flatMap(message => message.addressingV1?.participantSessionIds
        .filter(id => !message.addressingV1?.watcherSessionIds?.includes(id)) ?? []));
      for (const participant of roster) {
        const sessionId = participant.kind === 'session' ? participant.session.sessionId
          : prior?.outcomeReferences.find(outcome => sameStrictJsonValue(outcome.participant, participant))?.executionSessionId;
        if (sessionId && addressed.has(sessionId) && !nextParticipants.some(selected => sameStrictJsonValue(selected, participant))) nextParticipants.push(participant);
      }
    }
    return { ok: true, result: WorkflowDiscussionRoundProjectResultV1Schema.parse({ allPassed: false, hasNext: nextParticipants.length > 0,
      nextParticipants, outcomeReferences: prior?.outcomeReferences ?? [], ...(throughSeq === undefined ? {} : { throughSeq }),
      ...(origin ? { context: StrictJsonValueSchema.parse({ discussion: origin.discussion, throughSeq,
        messages: messages.sort((left, right) => left.seq - right.seq) }) } : {}) }) };
  }
  const collectionPages = await Promise.all([...new Set(request.collections)].map(blockId => readBlock(scopeParentId, blockId)));
  const collections = collectionPages.flat().filter(row => row.progress.blockKind === 'loop' && !row.progress.frame
    && request.collections.includes(row.progress.invocationPath.blockId)
    && sameStrictJsonValue(row.progress.invocationPath.scope, invocation.progress.invocationPath.scope)
    && row.index.lifecycle === 'completed');
  if (collections.length !== 1) return unavailable();
  const collection = collections[0]!;
  const prepared = (await readBlock(scopeParentId, request.preparationBlockId)).find(row =>
    row.progress.blockKind === 'action' && row.index.lifecycle === 'completed'
    && sameStrictJsonValue(row.progress.invocationPath.scope, invocation.progress.invocationPath.scope));
  const descendants: typeof collections = [];
  const visited = new Set([collection.index.id]);
  let parents = [collection.index.id];
  while (parents.length) {
    const members = await readInheritedMembers(parents);
    // Completed item collections declare their exact membership. A missing
    // page/slot cannot become an empty, all-passed round.
    for (const parentId of parents) {
      const parent = await readInvocation(parentId);
      if (!parent) return unavailable();
      const container = parent.progress.container;
      if (!parent.progress.frame && container?.kind === 'loop' && container.mode === 'items'
        && BigInt(members.get(parentId)!.length) !== BigInt(container.itemCount)) return unavailable();
    }
    const children = [...members.values()].flat();
    parents = [];
    for (const row of children) {
      if (row.index.lifecycle === 'superseded') return unavailable();
      if (row.index.lifecycle === 'skipped') continue;
      if (visited.has(row.index.id)) return unavailable();
      visited.add(row.index.id);
      if (row.progress.blockKind === 'step') descendants.push(row);
      else if (row.progress.blockKind === 'loop' || row.progress.blockKind === 'parallel'
        || row.progress.blockKind === 'if' || row.progress.blockKind === 'workflow') parents.push(row.index.id);
    }
  }
  descendants.sort((left, right) => BigInt(left.index.sequence) < BigInt(right.index.sequence) ? -1
    : BigInt(left.index.sequence) > BigInt(right.index.sequence) ? 1 : 0);
  const outcomeReferences: ReturnType<typeof WorkflowDiscussionRoundProjectResultV1Schema.parse>['outcomeReferences'] = [];
  for (const row of descendants) {
    const structure = await resolveWorkflowInvocationStructureV1({ definition: opened.definition,
      inputs: opened.acceptedContext.inputs, frozenChildren: opened.acceptedContext.frozenChildren, invocation: row,
      readInvocation, keyOfInvocation: row => row.index.id });
    if (!structure || structure.leaf.kind !== 'step') return unavailable();
    const leaf = opened.acceptedContext.materializedLeaves.find(leaf => leaf.sourceKey === structure.sourceKey && leaf.blockId === structure.leaf.id);
    if (!leaf?.participantBindings) return unavailable();
    const selected = resolveWorkflowAcceptedStepSelectionV1(leaf, structure.frame.item?.value, structure.inputs);
    const participant = leaf.participantBindings.selections.find(choice => sameStrictJsonValue(choice.participant, selected.participant))?.value;
    if (!participant) return unavailable();
    const reply = row.progress.replyOutcome;
    const kind = row.index.lifecycle === 'failed' ? 'failed' : row.index.lifecycle === 'cancelled' ? 'cancelled'
      : row.index.lifecycle !== 'completed' ? null : reply?.kind ?? null;
    // Missing reply custody is not an answer or pass, even when prose exists.
    if (!kind) return unavailable();
    outcomeReferences.push({ runId: opened.run.id, invocationRecordId: row.index.id, participant, kind,
      ...(row.progress.execution?.kind === 'session' ? { executionSessionId: row.progress.execution.sessionId } : {}),
      ...(row.progress.result === undefined ? {} : { result: row.progress.result }),
      ...(reply ? { reply: StrictJsonValueSchema.parse(reply) } : {}) });
  }
  const preparation = WorkflowDiscussionRoundProjectResultV1Schema.safeParse(prepared?.progress.result);
  const nextParticipants = outcomeReferences.filter(outcome => outcome.kind === 'answer').map(outcome => outcome.participant);
  return { ok: true, result: WorkflowDiscussionRoundProjectResultV1Schema.parse({
    allPassed: outcomeReferences.length === 0 || outcomeReferences.every(outcome => outcome.kind === 'pass'),
    hasNext: nextParticipants.length > 0,
    ...(preparation.success && preparation.data.throughSeq !== undefined ? { throughSeq: preparation.data.throughSeq } : {}),
    nextParticipants,
    outcomeReferences,
  }) };
}
