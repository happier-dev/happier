import type { WorkflowInvocationBindingRowV1 } from './workflowInvocationStructureV1.js';
import type { WorkflowRunInvocationIndexV1 } from './workflowProgressV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';

/** Resolve the root slot, including checkpoints retained before root replacement. */
export async function readWorkflowInvocationRootV1<T extends WorkflowInvocationBindingRowV1>(params: Readonly<{
  root: T;
  currentRootRecordId?: string;
  readInvocation: (id: string) => Promise<T | undefined>;
  readCurrentRoot: () => Promise<T | undefined>;
}>): Promise<T | undefined> {
  const original = params.root;
  let root = params.currentRootRecordId && params.currentRootRecordId !== original.index.id
    ? await params.readInvocation(params.currentRootRecordId) : original;
  if (root?.index.lifecycle === 'superseded') root = await params.readCurrentRoot();
  if (!root || root.index.lifecycle === 'superseded') return undefined;
  let ancestor = root;
  const seen = new Set<string>();
  let containsOriginal = false;
  for (;;) {
    if (seen.has(ancestor.index.id) || ancestor.index.runId !== original.index.runId
      || ancestor.index.parentRecordId !== null || ancestor.index.memberOrdinal !== '0'
      || ancestor.progress.blockKind !== 'root' || ancestor.progress.attempt !== ancestor.index.attempt
      || ancestor.progress.logicalInvocationRecordId !== original.progress.logicalInvocationRecordId
      || !sameStrictJsonValue(ancestor.progress.invocationPath, { blockId: '$root', scope: [] })) return undefined;
    if (ancestor.index.id === original.index.id) containsOriginal = true;
    if (ancestor.index.attempt === '0') return containsOriginal
      && ancestor.index.id === original.progress.logicalInvocationRecordId
      && ancestor.progress.previousAttemptRecordId === undefined ? root : undefined;
    seen.add(ancestor.index.id);
    const previousId = ancestor.progress.previousAttemptRecordId;
    const previous = previousId ? await params.readInvocation(previousId) : undefined;
    if (!previous || previous.index.id !== previousId || previous.index.lifecycle !== 'superseded'
      || BigInt(previous.index.attempt) + 1n !== BigInt(ancestor.index.attempt)) return undefined;
    ancestor = previous;
  }
}

/** Current root-to-member correspondence; physical envelope bindings stay unchanged. */
export async function readWorkflowCurrentInvocationAncestryV1<T extends WorkflowInvocationBindingRowV1>(params: Readonly<{
  invocation: T;
  currentRootRecordId?: string;
  readInvocation: (id: string) => Promise<T | undefined>;
  readCurrentRoot: () => Promise<T | undefined>;
  readChildren: (parentRecordIds: string[], memberOrdinal: string) => Promise<readonly T[]>;
}>): Promise<readonly T[] | undefined> {
  const seen = new Set<string>();
  const current = async (row: T): Promise<readonly T[] | undefined> => {
    if (seen.has(row.index.id)) return undefined;
    seen.add(row.index.id);
    if (row.index.parentRecordId === null) {
      const root = await readWorkflowInvocationRootV1({ ...params, root: row });
      return root ? [root] : undefined;
    }
    const originalParent = await params.readInvocation(row.index.parentRecordId);
    const ancestry = originalParent ? await current(originalParent) : undefined;
    const parent = ancestry?.at(-1);
    if (!ancestry || !parent) return undefined;
    if (parent.index.id === row.index.parentRecordId && row.index.lifecycle !== 'superseded') return [...ancestry, row];
    const members = await readWorkflowInvocationMembersV1({ parentRecordIds: [parent.index.id],
      memberOrdinal: row.index.memberOrdinal, readParent: params.readInvocation,
      readChildren: parents => params.readChildren(parents, row.index.memberOrdinal), indexOf: (member: T) => member.index });
    const selected = members.get(parent.index.id);
    const candidate = selected?.length === 1 ? selected[0] : undefined;
    if (!candidate || candidate.index.lifecycle === 'superseded'
      || candidate.index.runId !== row.index.runId
      || candidate.progress.logicalInvocationRecordId !== row.progress.logicalInvocationRecordId
      || candidate.progress.blockKind !== row.progress.blockKind
      || !sameStrictJsonValue(candidate.progress.invocationPath, row.progress.invocationPath)) return undefined;
    return [...ancestry, candidate];
  };
  return current(params.invocation);
}

/**
 * A recovered structural parent inherits its nearest unreplaced member slots.
 * Select the newest physical attempt before inheriting; skipped/superseded slots
 * still mask older slots. Consumers retain tombstones for scheduling or exclude
 * them from results. Read all requested parents together at each recovery depth.
 */
export async function readWorkflowInvocationMembersV1<T>(params: Readonly<{
  parentRecordIds: readonly string[];
  memberOrdinal?: string;
  readParent: (id: string) => Promise<WorkflowInvocationBindingRowV1 | undefined>;
  readChildren: (parentRecordIds: string[]) => Promise<readonly T[]>;
  indexOf: (row: T) => WorkflowRunInvocationIndexV1;
}>): Promise<ReadonlyMap<string, readonly T[]>> {
  const selections = new Map([...new Set(params.parentRecordIds)].map(id => [id, new Map<string, T>()]));
  let pending = [...selections].map(([id, members]) => ({ id, members, seen: new Set<string>() }));
  while (pending.length) {
    const parentIds = [...new Set(pending.map(parent => parent.id))];
    const slots = new Map(parentIds.map(id => [id, new Map<string, T>()]));
    for (const row of await params.readChildren(parentIds)) {
      const index = params.indexOf(row);
      const members = index.parentRecordId === null ? undefined : slots.get(index.parentRecordId);
      if (!members || (params.memberOrdinal !== undefined && index.memberOrdinal !== params.memberOrdinal)) {
        throw Object.assign(new Error('workflow_member_selection_invalid'), { code: 'content_unavailable' });
      }
      const previous = members.get(index.memberOrdinal);
      if (!previous || BigInt(index.attempt) > BigInt(params.indexOf(previous).attempt)) members.set(index.memberOrdinal, row);
    }
    const next = await Promise.all(pending.map(async state => {
      if (state.seen.has(state.id)) throw Object.assign(new Error('workflow_member_ancestry_invalid'), { code: 'content_unavailable' });
      state.seen.add(state.id);
      for (const [ordinal, row] of slots.get(state.id)!) if (!state.members.has(ordinal)) state.members.set(ordinal, row);
      // An exact selected slot needs no older history or parent content.
      if (params.memberOrdinal !== undefined && state.members.has(params.memberOrdinal)) return undefined;
      const parent = await params.readParent(state.id);
      if (!parent || parent.index.id !== state.id) throw Object.assign(new Error('workflow_parent_invocation_missing'), { code: 'content_unavailable' });
      return parent.progress.previousAttemptRecordId ? { ...state, id: parent.progress.previousAttemptRecordId } : undefined;
    }));
    pending = next.filter(state => state !== undefined);
  }
  return new Map([...selections].map(([id, members]) => [id, [...members.values()].sort((left, right) => {
    const a = BigInt(params.indexOf(left).memberOrdinal);
    const b = BigInt(params.indexOf(right).memberOrdinal);
    return a < b ? -1 : a > b ? 1 : 0;
  })]));
}
