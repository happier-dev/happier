import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { WorkflowAuthoredResultReferenceSchema, WorkflowBlockIdSchema, type WorkflowAuthoredResultReference } from './workflowReferenceV1.js';
import { WorkflowArtifactRevisionV1Schema, WorkflowDefinitionMetadataV1Schema } from './workflowDefinitionV1.js';
import { WorkflowDefinitionIdV1Schema } from './workflowIdsV1.js';
import {
  WorkflowBlockSchema, WorkflowDefinitionV1Schema, WorkflowInputDefinitionSchema, WorkflowStepExecutionSelectionSchema,
  WorkflowStepSchema, WorkflowActionLeafV1Schema, WorkflowInsertBlockV1Schema, WorkflowBlockNameV1Schema,
} from './workflowV1.js';
import type { WorkflowCondition, WorkflowAuthoredProducerRef, WorkflowValueReference } from './workflowReferenceV1.js';
import type { WorkflowActionLeafV1 } from './workflowLeafV1.js';
import type {
  WorkflowBlock,
  WorkflowDefinitionV1,
  WorkflowInputDefinition,
  WorkflowLeafExecutionTargetV1,
  WorkflowParallelBranch,
  WorkflowStep,
  WorkflowStepExecutionSelection,
} from './workflowV1.js';

export { WorkflowInsertBlockV1Schema, type WorkflowInsertBlockV1 } from './workflowV1.js';

export type WorkflowDefinitionDraftV1 = Readonly<{
  name: string;
  inputs: readonly WorkflowInputDefinition[];
  defaults: WorkflowDefinitionV1['defaults'];
  blocks: readonly WorkflowBlock[];
  roles?: WorkflowDefinitionV1['roles'];
  finalOutput?: WorkflowAuthoredResultReference;
}>;

export type WorkflowBlockListRef =
  | Readonly<{ kind: 'root' }>
  | Readonly<{ kind: 'loopBody'; loopId: string }>
  | Readonly<{ kind: 'ifThen'; ifId: string }>
  | Readonly<{ kind: 'ifOtherwise'; ifId: string }>
  | Readonly<{ kind: 'parallelBranch'; parallelId: string; branchId: string }>;

/** Every block in authored order, depth-first, including evaluator steps. */
export function walkWorkflowBlocks(blocks: readonly WorkflowBlock[]): readonly WorkflowBlock[] {
  const collected: WorkflowBlock[] = [];
  const pending = [...blocks].reverse();
  while (pending.length > 0) {
    const block = pending.pop()!;
    collected.push(block);
    switch (block.kind) {
      case 'step':
      case 'action':
      case 'workflow':
      case 'wait':
        break;
      case 'parallel':
        for (let branchIndex = block.branches.length - 1; branchIndex >= 0; branchIndex -= 1) {
          const list = block.branches[branchIndex]!.blocks;
          for (let index = list.length - 1; index >= 0; index -= 1) pending.push(list[index]!);
        }
        break;
      case 'loop':
        for (let index = block.body.length - 1; index >= 0; index -= 1) pending.push(block.body[index]!);
        if (block.repetition.kind === 'evaluate') pending.push(block.repetition.evaluator);
        break;
      case 'if':
        for (let index = block.otherwise.length - 1; index >= 0; index -= 1) pending.push(block.otherwise[index]!);
        for (let index = block.then.length - 1; index >= 0; index -= 1) pending.push(block.then[index]!);
        break;
    }
  }
  return collected;
}

export function collectWorkflowBlockIds(draft: WorkflowDefinitionDraftV1): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const block of walkWorkflowBlocks(draft.blocks)) {
    ids.add(block.id);
    if (block.kind === 'parallel') {
      for (const branch of block.branches) ids.add(branch.id);
    }
  }
  return ids;
}

/** Authored executable leaves; containers and repeated runtime occurrences do not count. */
export function countWorkflowStepsV1(blocks: readonly WorkflowBlock[]): number {
  return walkWorkflowBlocks(blocks).filter((block) =>
    block.kind === 'step' || block.kind === 'action' || block.kind === 'workflow' || block.kind === 'wait').length;
}

export function findWorkflowBlock(draft: WorkflowDefinitionDraftV1, blockId: string): WorkflowBlock | null {
  for (const block of walkWorkflowBlocks(draft.blocks)) {
    if (block.id === blockId) return block;
  }
  return null;
}

/** The list a block belongs to, so Add and Move know their scope. */
export function findWorkflowBlockListRef(
  draft: WorkflowDefinitionDraftV1,
  blockId: string,
): WorkflowBlockListRef | null {
  const search = (list: readonly WorkflowBlock[], ref: WorkflowBlockListRef): WorkflowBlockListRef | null => {
    for (const block of list) {
      if (block.id === blockId) return ref;
      let found: WorkflowBlockListRef | null = null;
      switch (block.kind) {
        case 'parallel':
          for (const branch of block.branches) {
            found ??= search(branch.blocks, { kind: 'parallelBranch', parallelId: block.id, branchId: branch.id });
          }
          break;
        case 'loop':
          found = search(block.body, { kind: 'loopBody', loopId: block.id });
          break;
        case 'if':
          found = search(block.then, { kind: 'ifThen', ifId: block.id })
            ?? search(block.otherwise, { kind: 'ifOtherwise', ifId: block.id });
          break;
        case 'step':
        case 'action':
        case 'workflow':
        case 'wait':
          break;
      }
      if (found !== null) return found;
    }
    return null;
  };
  return search(draft.blocks, { kind: 'root' });
}

/** A list addressed by its owning block, or null when that target does not exist. */
export function getWorkflowBlockList(draft: WorkflowDefinitionDraftV1, ref: WorkflowBlockListRef): readonly WorkflowBlock[] | null {
  if (ref.kind === 'root') return draft.blocks;
  const ownerId = ref.kind === 'loopBody' ? ref.loopId : ref.kind === 'parallelBranch' ? ref.parallelId : ref.ifId;
  const owner = findWorkflowBlock(draft, ownerId);
  if (ref.kind === 'loopBody') return owner?.kind === 'loop' ? owner.body : null;
  if (ref.kind === 'parallelBranch') return owner?.kind === 'parallel' ? owner.branches.find((branch) => branch.id === ref.branchId)?.blocks ?? null : null;
  return owner?.kind === 'if' ? ref.kind === 'ifThen' ? owner.then : owner.otherwise : null;
}

// ---------------------------------------------------------------------------
// Structural editing
// ---------------------------------------------------------------------------

/**
 * Rewrites exactly one block list and returns the same draft object when
 * nothing changed, so an edit inside one branch cannot rerender unrelated
 * siblings.
 */
function mapBlockList(
  blocks: readonly WorkflowBlock[],
  target: WorkflowBlockListRef,
  rewrite: (list: readonly WorkflowBlock[]) => readonly WorkflowBlock[],
): readonly WorkflowBlock[] {
  if (target.kind === 'root') {
    const next = rewrite(blocks);
    return next === blocks ? blocks : next;
  }

  let changed = false;
  const nextBlocks = blocks.map((block): WorkflowBlock => {
    switch (block.kind) {
      case 'step':
      case 'action':
      case 'workflow':
      case 'wait':
        return block;
      case 'parallel': {
        let branchChanged = false;
        const branches = block.branches.map((branch): WorkflowParallelBranch => {
          const isTarget = target.kind === 'parallelBranch'
            && target.parallelId === block.id
            && target.branchId === branch.id;
          const nextInner = isTarget
            ? rewrite(branch.blocks)
            : mapBlockList(branch.blocks, target, rewrite);
          if (nextInner === branch.blocks) return branch;
          branchChanged = true;
          return { ...branch, blocks: nextInner };
        });
        if (!branchChanged) return block;
        changed = true;
        return { ...block, branches };
      }
      case 'loop': {
        const isTarget = target.kind === 'loopBody' && target.loopId === block.id;
        const body = isTarget ? rewrite(block.body) : mapBlockList(block.body, target, rewrite);
        if (body === block.body) return block;
        changed = true;
        return { ...block, body };
      }
      case 'if': {
        const thenTarget = target.kind === 'ifThen' && target.ifId === block.id;
        const otherwiseTarget = target.kind === 'ifOtherwise' && target.ifId === block.id;
        const thenBlocks = thenTarget ? rewrite(block.then) : mapBlockList(block.then, target, rewrite);
        const otherwiseBlocks = otherwiseTarget
          ? rewrite(block.otherwise)
          : mapBlockList(block.otherwise, target, rewrite);
        if (thenBlocks === block.then && otherwiseBlocks === block.otherwise) return block;
        changed = true;
        return { ...block, then: thenBlocks, otherwise: otherwiseBlocks };
      }
    }
  });
  return changed ? nextBlocks : blocks;
}

/** Replaces one block wherever it lives, preserving untouched subtree identity. */
export function updateWorkflowBlock<TDraft extends WorkflowDefinitionDraftV1>(
  draft: TDraft,
  blockId: string,
  update: (block: WorkflowBlock) => WorkflowBlock,
): TDraft {
  let changed = false;
  const rewriteList = (list: readonly WorkflowBlock[]): readonly WorkflowBlock[] => {
    let listChanged = false;
    const next = list.map((block): WorkflowBlock => {
      if (block.id === blockId) {
        const replacement = update(block);
        if (replacement === block) return block;
        listChanged = true;
        changed = true;
        return replacement;
      }
      switch (block.kind) {
        case 'step':
        case 'action':
        case 'workflow':
        case 'wait':
          return block;
        case 'parallel': {
          let branchChanged = false;
          const branches = block.branches.map((branch): WorkflowParallelBranch => {
            const inner = rewriteList(branch.blocks);
            if (inner === branch.blocks) return branch;
            branchChanged = true;
            return { ...branch, blocks: inner };
          });
          if (!branchChanged) return block;
          listChanged = true;
          return { ...block, branches };
        }
        case 'loop': {
          const body = rewriteList(block.body);
          let repetition = block.repetition;
          if (block.repetition.kind === 'evaluate' && block.repetition.evaluator.id === blockId) {
            const replacement = update(block.repetition.evaluator);
            if (replacement !== block.repetition.evaluator && (replacement.kind === 'step' || replacement.kind === 'action')) {
              repetition = { ...block.repetition, evaluator: replacement };
              changed = true;
            }
          }
          if (body === block.body && repetition === block.repetition) return block;
          listChanged = true;
          return { ...block, body, repetition };
        }
        case 'if': {
          const thenBlocks = rewriteList(block.then);
          const otherwiseBlocks = rewriteList(block.otherwise);
          if (thenBlocks === block.then && otherwiseBlocks === block.otherwise) return block;
          listChanged = true;
          return { ...block, then: thenBlocks, otherwise: otherwiseBlocks };
        }
      }
    });
    return listChanged ? next : list;
  };

  const blocks = rewriteList(draft.blocks);
  return changed || blocks !== draft.blocks ? { ...draft, blocks } : draft;
}

/** The editor and edit Action share the same authored-name mutation. */
export function setWorkflowBlockName<TDraft extends WorkflowDefinitionDraftV1>(
  draft: TDraft, blockId: string, name: string | undefined,
): TDraft {
  const normalized = WorkflowBlockNameV1Schema.parse(name);
  return updateWorkflowBlock(draft, blockId, (block) => {
    if (block.name === normalized) return block;
    const { name: _name, ...unnamed } = block;
    return normalized === undefined ? unnamed : { ...unnamed, name: normalized };
  });
}

/** Names one lane of a Side by side group; a blank name restores its "Lane {n}" caption. */
export function setWorkflowParallelBranchName<TDraft extends WorkflowDefinitionDraftV1>(
  draft: TDraft, parallelId: string, branchId: string, name: string | undefined,
): TDraft {
  const normalized = WorkflowBlockNameV1Schema.parse(name);
  return updateWorkflowBlock(draft, parallelId, (block) => {
    if (block.kind !== 'parallel') return block;
    let changed = false;
    const branches = block.branches.map((branch) => {
      if (branch.id !== branchId || branch.name === normalized) return branch;
      changed = true;
      const { name: _name, ...unnamed } = branch;
      return normalized === undefined ? unnamed : { ...unnamed, name: normalized };
    });
    return changed ? { ...block, branches } : block;
  });
}

/**
 * What a step added here reads by default: the result of the step immediately
 * before it in the same scope.
 *
 * The plan's "adding a second step defaults to the previous result" is a fact
 * about the insertion point, not about the block kind, so it is resolved here
 * rather than inside the context-free `createWorkflowBlock` factory. Only an
 * immediately preceding **step** produces one unambiguous result; a parallel
 * group, loop or condition needs the author to name which branch or iteration
 * they mean, so those insert with no input rather than a guessed one.
 */
export function resolvePreviousResultInputForInsertion(
  draft: WorkflowDefinitionDraftV1,
  params: Readonly<{ list: WorkflowBlockListRef; afterBlockId?: string | null }>,
): WorkflowAuthoredResultReference | null {
  let siblings: readonly WorkflowBlock[] = [];
  mapBlockList(draft.blocks, params.list, (list) => {
    siblings = list;
    return list;
  });
  const anchorIndex = params.afterBlockId == null
    ? siblings.length - 1
    : siblings.findIndex((block) => block.id === params.afterBlockId);
  const previous = anchorIndex < 0 ? undefined : siblings[anchorIndex];
  if (previous === undefined || previous.kind !== 'step') return null;
  return { kind: 'result', producer: { blockId: previous.id, scope: { kind: 'current' } }, path: [] };
}

/** Copies one authored subtree, remapping only typed references to copied identities. */
export function copyWorkflowBlocks(
  blocks: readonly WorkflowBlock[],
  takenIds: ReadonlySet<string>,
  inputs: ReadonlyMap<string, string> = new Map(),
): Readonly<{ blocks: readonly WorkflowBlock[]; remapResult: (ref: WorkflowAuthoredResultReference) => WorkflowAuthoredResultReference }> {
  const occupied = new Set(takenIds);
  const ids = new Map<string, string>();
  for (const block of walkWorkflowBlocks(blocks)) {
    for (const id of [block.id, ...(block.kind === 'parallel' ? block.branches.map((branch) => branch.id) : [])]) {
      let next = id;
      for (let suffix = 2; occupied.has(next); suffix += 1) next = `${id}-${suffix}`;
      occupied.add(next);
      ids.set(id, next);
    }
  }
  const sourceBlocks = new Map(walkWorkflowBlocks(blocks).map((block) => [block.id, block]));
  const producer = (ref: WorkflowAuthoredProducerRef): WorkflowAuthoredProducerRef => ({ ...ref,
    blockId: ids.get(ref.blockId) ?? ref.blockId,
    scope: ref.scope.kind === 'previous_iteration'
      ? { ...ref.scope, loopBlockId: ids.get(ref.scope.loopBlockId) ?? ref.scope.loopBlockId } : ref.scope,
  });
  const result = (ref: WorkflowAuthoredResultReference): WorkflowAuthoredResultReference => {
    // A loop's aggregate is keyed by its child block ids; named JSON result fields are not ids.
    const path = [...ref.path];
    if (sourceBlocks.get(ref.producer.blockId)?.kind === 'loop') {
      const childIndex = path[0] === 'last' ? 1 : path[0] === 'iterations' && typeof path[1] === 'number' ? 2 : -1;
      const child = path[childIndex];
      if (typeof child === 'string' && ids.has(child)) path[childIndex] = ids.get(child)!;
    }
    return { ...ref, producer: producer(ref.producer), path };
  };
  const reference = (ref: WorkflowValueReference): WorkflowValueReference => {
    switch (ref.kind) {
      case 'input': return { ...ref, name: inputs.get(ref.name) ?? ref.name };
      case 'result': return result(ref);
      case 'workspace':
      case 'loop_trailing_count': return { ...ref, producer: producer(ref.producer) };
      default: return ref;
    }
  };
  const condition = (value: WorkflowCondition): WorkflowCondition => {
    switch (value.kind) {
      case 'exists': return { ...value, value: reference(value.value) };
      case 'compare': return { ...value, left: reference(value.left), right: reference(value.right) };
      case 'all':
      case 'any': return { ...value, conditions: value.conditions.map(condition) };
      case 'not': return { ...value, condition: condition(value.condition) };
    }
  };
  const copyStep = (block: WorkflowStep): WorkflowStep => ({
    ...block, id: ids.get(block.id)!,
    ...(block.onlyWhen === undefined ? {} : { onlyWhen: condition(block.onlyWhen) }),
    input: block.input.map(reference),
    ...(block.execution === undefined ? {} : { execution: {
      ...block.execution,
      ...(block.execution.conversation?.kind === 'from_step' ? { conversation: {
        ...block.execution.conversation, producer: producer(block.execution.conversation.producer),
      } } : {}),
      ...(block.execution.workspace?.kind === 'from_step' ? { workspace: {
        ...block.execution.workspace, producer: producer(block.execution.workspace.producer),
      } } : {}),
    } }),
  });
  const copyAction = (block: WorkflowActionLeafV1): WorkflowActionLeafV1 => ({
    ...block, id: ids.get(block.id)!,
    ...(block.onlyWhen === undefined ? {} : { onlyWhen: condition(block.onlyWhen) }),
    input: Object.fromEntries(Object.entries(block.input).map(([key, value]) => [key,
      value.kind === 'list' ? { ...value, items: value.items.map((item) => item.kind === 'origin_session_id' ? item : reference(item)) }
        : value.kind === 'origin_session_id' ? value : reference(value)])),
  });
  const copy = (block: WorkflowBlock): WorkflowBlock => {
    const identity = { id: ids.get(block.id)! };
    const guarded = 'onlyWhen' in block && block.onlyWhen !== undefined ? { onlyWhen: condition(block.onlyWhen) } : {};
    switch (block.kind) {
      case 'step': return copyStep(block);
      case 'action': return copyAction(block);
      case 'workflow': return { ...block, ...identity, ...guarded, input: Object.fromEntries(Object.entries(block.input).map(([key, value]) => [key, reference(value)])) };
      case 'wait': return { ...block, ...identity, ...guarded };
      case 'parallel': return { ...block, ...identity, ...guarded, branches: block.branches.map((branch) => ({
        ...branch, id: ids.get(branch.id)!, blocks: branch.blocks.map(copy),
      })) };
      case 'if': return { ...block, ...identity, when: condition(block.when), then: block.then.map(copy), otherwise: block.otherwise.map(copy) };
      case 'loop': {
        const repetition = block.repetition;
        const maxIterations = 'maxIterations' in repetition && typeof repetition.maxIterations !== 'number'
          ? { ...repetition.maxIterations, name: inputs.get(repetition.maxIterations.name) ?? repetition.maxIterations.name }
          : 'maxIterations' in repetition ? repetition.maxIterations : undefined;
        const copiedRepetition = repetition.kind === 'count' ? { ...repetition, count: reference(repetition.count) }
          : repetition.kind === 'items' ? { ...repetition, items: reference(repetition.items) }
          : repetition.kind === 'until' ? { ...repetition, maxIterations: maxIterations!, stopWhen: condition(repetition.stopWhen) }
          : { ...repetition, maxIterations: maxIterations!, evaluator: repetition.evaluator.kind === 'step' ? copyStep(repetition.evaluator) : copyAction(repetition.evaluator) };
        return { ...block, ...identity, ...guarded, body: block.body.map(copy), repetition: copiedRepetition };
      }
    }
  };
  return { blocks: blocks.map(copy), remapResult: result };
}

export function duplicateWorkflowBlock<TDraft extends WorkflowDefinitionDraftV1>(
  draft: TDraft, blockId: string,
): Readonly<{ draft: TDraft; blockId: string | null }> {
  const source = findWorkflowBlock(draft, blockId);
  const list = findWorkflowBlockListRef(draft, blockId);
  if (source === null || list === null) return { draft, blockId: null };
  const copy = copyWorkflowBlocks([source], collectWorkflowBlockIds(draft)).blocks[0]!;
  return { draft: insertWorkflowBlock(draft, { list, block: copy, afterBlockId: blockId }), blockId: copy.id };
}


export function insertWorkflowBlock<TDraft extends WorkflowDefinitionDraftV1>(
  draft: TDraft,
  params: Readonly<{ list: WorkflowBlockListRef; block: WorkflowBlock; afterBlockId?: string | null }>,
): TDraft {
  const blocks = mapBlockList(draft.blocks, params.list, (list) => {
    const anchor = params.afterBlockId == null
      ? list.length
      : list.findIndex((block) => block.id === params.afterBlockId) + 1;
    const position = anchor <= 0 ? list.length : anchor;
    return [...list.slice(0, position), params.block, ...list.slice(position)];
  });
  return blocks === draft.blocks ? draft : { ...draft, blocks };
}

/**
 * Removes a block and reports the references that became invalid, so the editor
 * can show them for repair instead of silently retargeting them to a
 * neighbouring step.
 */
/**
 * Exactly where a removed block sat, so an Undo can put it back rather than
 * append it. It is a coordinate, not a snapshot of the whole draft: restoring
 * therefore composes with any edit made in between instead of reverting it.
 */
export type WorkflowBlockRemoval = Readonly<{
  list: WorkflowBlockListRef;
  index: number;
  block: WorkflowBlock;
}>;

export function removeWorkflowBlock<TDraft extends WorkflowDefinitionDraftV1>(
  draft: TDraft,
  blockId: string,
): Readonly<{
  draft: TDraft;
  removed: WorkflowBlock | null;
  removal: WorkflowBlockRemoval | null;
}> {
  const removed = findWorkflowBlock(draft, blockId);
  if (removed === null) return { draft, removed: null, removal: null };
  const listRef = findWorkflowBlockListRef(draft, blockId);
  if (listRef === null) return { draft, removed: null, removal: null };

  let removedIndex = -1;
  const blocks = mapBlockList(draft.blocks, listRef, (list) => {
    const index = list.findIndex((block) => block.id === blockId);
    if (index < 0) return list;
    removedIndex = index;
    return [...list.slice(0, index), ...list.slice(index + 1)];
  });
  const removal: WorkflowBlockRemoval | null = removedIndex < 0
    ? null
    : { list: listRef, index: removedIndex, block: removed };
  const finalOutput = draft.finalOutput?.producer.blockId === blockId ? undefined : draft.finalOutput;
  const next: TDraft = finalOutput === draft.finalOutput
    ? { ...draft, blocks }
    : { ...draft, blocks, ...(finalOutput === undefined ? {} : { finalOutput }) };
  if (finalOutput === undefined && draft.finalOutput !== undefined) {
    const { finalOutput: _dropped, ...rest } = next;
    return { draft: { ...rest, blocks } as TDraft, removed, removal };
  }
  return { draft: next, removed, removal };
}

/**
 * Puts a removed block back at its recorded position.
 *
 * The index is clamped to the list's current length, because the author may
 * have added or removed siblings before pressing Undo; restoring must not throw
 * away that work or fail. A `finalOutput` binding this removal cleared is not
 * resurrected: that selection is the author's, and re-deriving it here would be
 * a second decision-maker for it.
 */
export function restoreWorkflowBlock<TDraft extends WorkflowDefinitionDraftV1>(
  draft: TDraft,
  removal: WorkflowBlockRemoval,
): TDraft {
  if (findWorkflowBlock(draft, removal.block.id) !== null) return draft;
  const blocks = mapBlockList(draft.blocks, removal.list, (list) => {
    const position = Math.min(Math.max(removal.index, 0), list.length);
    return [...list.slice(0, position), removal.block, ...list.slice(position)];
  });
  return blocks === draft.blocks ? draft : { ...draft, blocks };
}

/**
 * Takes a block out of its list without touching anything else the author
 * chose.
 *
 * Relocation and deletion are different intents: deleting a producer must clear
 * a `finalOutput` that named it, while moving the same block elsewhere must
 * not. Reusing the deletion helper for a move silently erased that selection,
 * so the two now have separate primitives and `removeWorkflowBlock` stays the
 * only destructive one.
 */
function detachWorkflowBlock<TDraft extends WorkflowDefinitionDraftV1>(
  draft: TDraft,
  blockId: string,
): TDraft {
  const listRef = findWorkflowBlockListRef(draft, blockId);
  if (listRef === null) return draft;
  const blocks = mapBlockList(draft.blocks, listRef, (list) => {
    const index = list.findIndex((block) => block.id === blockId);
    return index < 0 ? list : [...list.slice(0, index), ...list.slice(index + 1)];
  });
  return blocks === draft.blocks ? draft : { ...draft, blocks };
}

export type WorkflowBlockMoveDirection = 'up' | 'down' | 'in' | 'out';

/**
 * Keyboard- and screen-reader-reachable reordering. `in` nests a block into the
 * container immediately above it; `out` lifts it to the enclosing list right
 * after that container. Ids never change, so references survive the move and an
 * invalid one stays visible for repair.
 */
export function moveWorkflowBlock<TDraft extends WorkflowDefinitionDraftV1>(
  draft: TDraft,
  blockId: string,
  direction: WorkflowBlockMoveDirection,
): TDraft {
  const listRef = findWorkflowBlockListRef(draft, blockId);
  if (listRef === null) return draft;
  const block = findWorkflowBlock(draft, blockId);
  if (block === null) return draft;

  if (direction === 'up' || direction === 'down') {
    const blocks = mapBlockList(draft.blocks, listRef, (list) => {
      const index = list.findIndex((entry) => entry.id === blockId);
      const target = direction === 'up' ? index - 1 : index + 1;
      if (index < 0 || target < 0 || target >= list.length) return list;
      const next = [...list];
      next[index] = list[target]!;
      next[target] = list[index]!;
      return next;
    });
    return blocks === draft.blocks ? draft : { ...draft, blocks };
  }

  if (direction === 'in') {
    let container: WorkflowBlock | null = null;
    mapBlockList(draft.blocks, listRef, (list) => {
      const index = list.findIndex((entry) => entry.id === blockId);
      container = index > 0 ? list[index - 1]! : null;
      return list;
    });
    const previous = container as WorkflowBlock | null;
    if (previous === null || previous.kind === 'step') return draft;
    const destination = resolveDefaultChildListRef(previous);
    if (destination === null) return draft;
    return insertWorkflowBlock(detachWorkflowBlock(draft, blockId), { list: destination, block });
  }

  if (listRef.kind === 'root') return draft;
  const containerId = listRef.kind === 'parallelBranch' ? listRef.parallelId
    : listRef.kind === 'loopBody' ? listRef.loopId
      : listRef.ifId;
  const outerList = findWorkflowBlockListRef(draft, containerId);
  if (outerList === null) return draft;
  return insertWorkflowBlock(detachWorkflowBlock(draft, blockId), {
    list: outerList,
    block,
    afterBlockId: containerId,
  });
}

function resolveDefaultChildListRef(container: WorkflowBlock): WorkflowBlockListRef | null {
  switch (container.kind) {
    case 'parallel': {
      const branch = container.branches[0];
      return branch === undefined
        ? null
        : { kind: 'parallelBranch', parallelId: container.id, branchId: branch.id };
    }
    case 'loop':
      return { kind: 'loopBody', loopId: container.id };
    case 'if':
      return { kind: 'ifThen', ifId: container.id };
    case 'step':
    case 'action':
    case 'workflow':
    case 'wait':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Block creation
// ---------------------------------------------------------------------------

/**
 * Stable ids are assigned at object creation, before validation or save, so a
 * structured block never enters the optional-id dialect the Protocol rejects.
 */
export function createWorkflowBlockId(prefix: string, takenIds: ReadonlySet<string>): string {
  let ordinal = 1;
  while (takenIds.has(`${prefix}-${ordinal}`)) ordinal += 1;
  return `${prefix}-${ordinal}`;
}

export type WorkflowBlockKind = 'step' | 'parallel' | 'loop' | 'if';

export function createWorkflowBlock(
  kind: WorkflowBlockKind,
  takenIds: ReadonlySet<string>,
): WorkflowBlock {
  const assigned = new Set(takenIds);
  const nextId = (prefix: string): string => {
    const id = createWorkflowBlockId(prefix, assigned);
    assigned.add(id);
    return id;
  };
  const emptyStep = (): WorkflowStep => ({
    kind: 'step',
    id: nextId('step'),
    document: { text: '', references: [], attachments: [] },
    input: [],
    result: { kind: 'text' },
  });

  switch (kind) {
    case 'step':
      return emptyStep();
    case 'parallel': {
      const id = nextId('parallel');
      return {
        kind: 'parallel',
        id,
        // Structured parallel blocks carry their failure policy explicitly.
        failurePolicy: 'fail_stop',
        branches: [
          { id: nextId('branch'), blocks: [emptyStep()] },
          { id: nextId('branch'), blocks: [emptyStep()] },
        ],
      };
    }
    case 'loop': {
      const id = nextId('loop');
      return {
        kind: 'loop',
        id,
        repetition: { kind: 'count', count: { kind: 'literal', value: 2 } },
        body: [emptyStep()],
      };
    }
    case 'if': {
      const id = nextId('if');
      return {
        kind: 'if',
        id,
        when: { kind: 'exists', value: { kind: 'literal', value: true } },
        then: [emptyStep()],
        otherwise: [],
      };
    }
  }
}

/** What a new step-kind block starts from: the Action or workflow it calls, or nothing (Wait). */
export type WorkflowLeafBlockSeed =
  | Readonly<{ kind: 'action'; actionId: string }>
  | Readonly<{ kind: 'workflow'; workflowRef: string }>
  | Readonly<{ kind: 'wait' }>;

/**
 * The step kinds beside the Agent step (U4): an Action call, a nested
 * workflow, or a Wait for you. Each is created complete enough to parse, with
 * its fields unbound; the author binds them next. An Action leaf never names a
 * `workflow.run.*` Action — composition is the Workflow leaf.
 */
export function createWorkflowLeafBlock(seed: WorkflowLeafBlockSeed, takenIds: ReadonlySet<string>): WorkflowBlock {
  switch (seed.kind) {
    case 'action':
      return WorkflowActionLeafV1Schema.parse({
        kind: 'action', id: createWorkflowBlockId('action', takenIds), actionId: seed.actionId, input: {},
      });
    case 'workflow':
      return {
        kind: 'workflow', id: createWorkflowBlockId('workflow', takenIds),
        workflowRef: WorkflowDefinitionIdV1Schema.parse(seed.workflowRef), input: {},
      };
    case 'wait':
      return {
        kind: 'wait', id: createWorkflowBlockId('wait', takenIds),
        document: { text: '', references: [], attachments: [] }, result: { kind: 'text' },
      };
  }
}

export function createWorkflowParallelBranch(takenIds: ReadonlySet<string>): WorkflowParallelBranch {
  const assigned = new Set(takenIds);
  const branchId = createWorkflowBlockId('branch', assigned);
  assigned.add(branchId);
  return {
    id: branchId,
    blocks: [{
      kind: 'step',
      id: createWorkflowBlockId('step', assigned),
      document: { text: '', references: [], attachments: [] },
      input: [],
      result: { kind: 'text' },
    }],
  };
}

// ---------------------------------------------------------------------------
// Draft lifecycle
// ---------------------------------------------------------------------------

export function setWorkflowStepText<TDraft extends WorkflowDefinitionDraftV1>(
  draft: TDraft,
  blockId: string,
  text: string,
): TDraft {
  return updateWorkflowBlock(draft, blockId, (block) => {
    if (block.kind !== 'step' || block.document.text === text) return block;
    return { ...block, document: { ...block.document, text } };
  });
}

/**
 * Applies a step override. Passing `undefined` for a field removes the
 * override so the step inherits again; passing `null` records an explicit
 * "automatic/none" choice, and a value equal to the current default stays an
 * explicit override.
 */
export function setWorkflowStepExecutionField<TDraft extends WorkflowDefinitionDraftV1, TField extends keyof WorkflowStepExecutionSelection>(
  draft: TDraft,
  blockId: string,
  field: TField,
  value: WorkflowStepExecutionSelection[TField] | undefined,
): TDraft {
  return updateWorkflowBlock(draft, blockId, (block) => {
    if (block.kind !== 'step') return block;
    const execution = block.execution ?? {};
    const hadField = Object.hasOwn(execution, field);
    if (value === undefined) {
      if (!hadField) return block;
      const { [field]: _removed, ...rest } = execution;
      if (Object.keys(rest).length === 0) {
        const { execution: _dropped, ...blockRest } = block;
        return blockRest as WorkflowStep;
      }
      return { ...block, execution: rest as WorkflowStepExecutionSelection };
    }
    if (hadField && execution[field] === value) return block;
    return { ...block, execution: { ...execution, [field]: value } };
  });
}

/**
 * Records the step's authored result-wait deadline exactly as chosen, or
 * removes the key so the saved definition carries no deadline at all. The
 * draft never supplies a default duration: omission means no workflow-authored
 * deadline. A value that is not yet a number is kept as the unresolved number
 * the canonical validator rejects, so the page states the repair instead of
 * silently dropping what was typed.
 */
export function setWorkflowStepTimeout<TDraft extends WorkflowDefinitionDraftV1>(
  draft: TDraft,
  blockId: string,
  timeoutMs: number | undefined,
): TDraft {
  return updateWorkflowBlock(draft, blockId, (block) => {
    if (block.kind !== 'step' && block.kind !== 'action') return block;
    if (timeoutMs === undefined) {
      if (!Object.hasOwn(block, 'timeoutMs')) return block;
      const { timeoutMs: _dropped, ...rest } = block;
      return rest as WorkflowBlock;
    }
    if (Object.is(block.timeoutMs, timeoutMs)) return block;
    return { ...block, timeoutMs };
  });
}

/**
 * A block's own "Only run when" condition, or removal so it always runs. An
 * If block's condition is its structure (`when`), not this guard.
 */
export function setWorkflowBlockOnlyWhen<TDraft extends WorkflowDefinitionDraftV1>(
  draft: TDraft,
  blockId: string,
  condition: WorkflowCondition | undefined,
): TDraft {
  return updateWorkflowBlock(draft, blockId, (block) => {
    if (block.kind === 'if') return block;
    if (condition === undefined) {
      if (!Object.hasOwn(block, 'onlyWhen')) return block;
      const { onlyWhen: _dropped, ...rest } = block;
      return rest as WorkflowBlock;
    }
    return block.onlyWhen === condition ? block : { ...block, onlyWhen: condition };
  });
}

/** "Review before continuing" on an Agent step or Action: on is `true`, off is omission. */
export function setWorkflowLeafPauseForReview<TDraft extends WorkflowDefinitionDraftV1>(
  draft: TDraft,
  blockId: string,
  pauseForReview: boolean,
): TDraft {
  return updateWorkflowBlock(draft, blockId, (block) => {
    if (block.kind !== 'step' && block.kind !== 'action') return block;
    if (!pauseForReview) {
      if (!Object.hasOwn(block, 'pauseForReview')) return block;
      const { pauseForReview: _dropped, ...rest } = block;
      return rest as WorkflowBlock;
    }
    return block.pauseForReview === true ? block : { ...block, pauseForReview: true };
  });
}

/**
 * An Agent step's own "Runs in" class, or removal so it follows the workflow
 * default again (U5 precedence: an explicit step choice first).
 */
export function setWorkflowStepExecutionTarget<TDraft extends WorkflowDefinitionDraftV1>(
  draft: TDraft,
  blockId: string,
  target: WorkflowLeafExecutionTargetV1['kind'] | undefined,
): TDraft {
  return updateWorkflowBlock(draft, blockId, (block) => {
    if (block.kind !== 'step') return block;
    const execution = block.execution ?? {};
    if (target === undefined) {
      if (!Object.hasOwn(execution, 'executionTarget')) return block;
      const { executionTarget: _dropped, ...rest } = execution;
      if (Object.keys(rest).length === 0) {
        const { execution: _emptied, ...blockRest } = block;
        return blockRest as WorkflowStep;
      }
      return { ...block, execution: rest };
    }
    if (execution.executionTarget?.kind === target) return block;
    return { ...block, execution: { ...execution, executionTarget: { kind: target } } };
  });
}

export function setWorkflowDefaultField<TDraft extends WorkflowDefinitionDraftV1, TField extends keyof WorkflowStepExecutionSelection>(
  draft: TDraft,
  field: TField,
  value: WorkflowStepExecutionSelection[TField] | undefined,
): TDraft {
  const hadField = Object.hasOwn(draft.defaults, field);
  if (value === undefined) {
    if (!hadField) return draft;
    const { [field]: _removed, ...rest } = draft.defaults;
    return { ...draft, defaults: rest as WorkflowStepExecutionSelection };
  }
  if (hadField && draft.defaults[field] === value) return draft;
  return { ...draft, defaults: { ...draft.defaults, [field]: value } };
}

export function setWorkflowFinalOutput<TDraft extends WorkflowDefinitionDraftV1>(
  draft: TDraft,
  finalOutput: WorkflowAuthoredResultReference | null,
): TDraft {
  if (finalOutput === null) {
    if (draft.finalOutput === undefined) return draft;
    const { finalOutput: _dropped, ...rest } = draft;
    return rest as TDraft;
  }
  return { ...draft, finalOutput };
}

export function setWorkflowInputs<TDraft extends WorkflowDefinitionDraftV1>(
  draft: TDraft,
  inputs: readonly WorkflowInputDefinition[],
): TDraft {
  return draft.inputs === inputs ? draft : { ...draft, inputs };
}

/** Assign only missing ids, then delegate every structural decision to the canonical schema. */
function materializeInsertedBlock(input: unknown, takenIds: ReadonlySet<string>) {
  const parsed = WorkflowInsertBlockV1Schema.safeParse(input);
  if (!parsed.success) return parsed;
  const assigned = new Set(takenIds);
  const identities: { value: Record<string, unknown>; prefix: string }[] = [];
  const pending: { raw: unknown; prefix: string }[] = [{ raw: parsed.data, prefix: parsed.data.kind }];
  while (pending.length > 0) {
    const { raw, prefix } = pending.pop()!;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const value = raw as Record<string, unknown>;
    identities.push({ value, prefix });
    const children: { raw: unknown; prefix: string }[] = [];
    const appendBlocks = (blocks: unknown): void => {
      if (!Array.isArray(blocks)) return;
      for (const block of blocks) {
        if (block && typeof block === 'object' && 'kind' in block && typeof block.kind === 'string') {
          children.push({ raw: block, prefix: block.kind });
        }
      }
    };
    if (value.kind === 'parallel' && Array.isArray(value.branches)) {
      for (const branch of value.branches) children.push({ raw: branch, prefix: 'branch' });
    } else if (prefix === 'branch') {
      appendBlocks(value.blocks);
    }
    if (value.kind === 'loop') {
      appendBlocks(value.body);
      if (value.repetition && typeof value.repetition === 'object' && 'evaluator' in value.repetition) {
        appendBlocks([value.repetition.evaluator]);
      }
    }
    if (value.kind === 'if') {
      appendBlocks(value.then);
      appendBlocks(value.otherwise);
    }
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]!);
  }
  // Reserve every explicit identity before allocating any omitted one.
  for (const { value } of identities) if (typeof value.id === 'string') assigned.add(value.id);
  for (const { value, prefix } of identities) {
    if (value.id !== undefined) continue;
    const id = createWorkflowBlockId(prefix, assigned);
    assigned.add(id);
    value.id = id;
  }
  return WorkflowBlockSchema.safeParse(parsed.data);
}
export const WorkflowBlockListRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('root') }).strict(),
  z.object({ kind: z.literal('loopBody'), loopId: WorkflowBlockIdSchema }).strict(),
  z.object({ kind: z.literal('ifThen'), ifId: WorkflowBlockIdSchema }).strict(),
  z.object({ kind: z.literal('ifOtherwise'), ifId: WorkflowBlockIdSchema }).strict(),
  z.object({ kind: z.literal('parallelBranch'), parallelId: WorkflowBlockIdSchema, branchId: WorkflowBlockIdSchema }).strict(),
]));

type WorkflowSelectionEdit<TKind extends string> = {
  [TField in keyof WorkflowStepExecutionSelection]-?: { kind: TKind; field: TField; value?: WorkflowStepExecutionSelection[TField] }
}[keyof WorkflowStepExecutionSelection];

function selectionEditSchema<TKind extends 'set_default' | 'set_step_setting'>(kind: TKind) {
  const variants = Object.entries(WorkflowStepExecutionSelectionSchema.shape).map(([field, value]) => z.object({
    kind: z.literal(kind), field: z.literal(field), value,
    ...(kind === 'set_step_setting' ? { blockId: WorkflowBlockIdSchema } : {}),
  }).strict());
  return z.union(variants) as z.ZodType<
    WorkflowSelectionEdit<TKind> & (TKind extends 'set_step_setting' ? { blockId: string } : object)
  >;
}

export const WorkflowDefinitionEditOpV1Schema = lazyZodSchema(() => z.union([
  z.object({ kind: z.literal('insert_block'), list: WorkflowBlockListRefV1Schema, block: WorkflowInsertBlockV1Schema, afterBlockId: WorkflowBlockIdSchema.optional() }).strict(),
  z.object({ kind: z.literal('replace_block'), blockId: WorkflowBlockIdSchema, block: WorkflowBlockSchema }).strict(),
  z.object({ kind: z.literal('remove_block'), blockId: WorkflowBlockIdSchema }).strict(),
  z.object({ kind: z.literal('move_block'), blockId: WorkflowBlockIdSchema, direction: z.enum(['up', 'down', 'in', 'out']) }).strict(),
  z.object({ kind: z.literal('set_step_prompt'), blockId: WorkflowBlockIdSchema, text: z.string() }).strict(),
  z.object({ kind: z.literal('set_block_name'), blockId: WorkflowBlockIdSchema, name: WorkflowBlockNameV1Schema }).strict(),
  selectionEditSchema('set_step_setting'),
  z.object({ kind: z.literal('set_step_setting'), blockId: WorkflowBlockIdSchema, field: z.literal('timeoutMs'), value: WorkflowStepSchema.shape.timeoutMs }).strict(),
  selectionEditSchema('set_default'),
  z.object({ kind: z.literal('set_inputs'), inputs: z.array(WorkflowInputDefinitionSchema) }).strict(),
  z.object({ kind: z.literal('set_final_output'), finalOutput: WorkflowAuthoredResultReferenceSchema.nullable() }).strict(),
  z.object({ kind: z.literal('rename'), name: z.string().trim().min(1) }).strict(),
]));
export type WorkflowDefinitionEditOpV1 = z.infer<typeof WorkflowDefinitionEditOpV1Schema>;

export const WorkflowDefinitionEditRequestV1Schema = lazyZodSchema(() => z.object({
  definitionId: WorkflowDefinitionIdV1Schema,
  expectedRevision: WorkflowArtifactRevisionV1Schema,
  ops: z.array(WorkflowDefinitionEditOpV1Schema).min(1),
}).strict());
export const WorkflowDefinitionEditResultV1Schema = lazyZodSchema(() => z.object({
  definition: WorkflowDefinitionV1Schema,
  revision: WorkflowArtifactRevisionV1Schema,
  metadata: WorkflowDefinitionMetadataV1Schema,
  changedBlockIds: z.array(WorkflowBlockIdSchema),
}).strict());
export type WorkflowDefinitionEditRequestV1 = z.infer<typeof WorkflowDefinitionEditRequestV1Schema>;
export type WorkflowDefinitionEditResultV1 = z.infer<typeof WorkflowDefinitionEditResultV1Schema>;

export type WorkflowDefinitionEditsResultV1<TDraft extends WorkflowDefinitionDraftV1> =
  | Readonly<{ ok: true; draft: TDraft; changedBlockIds: readonly string[] }>
  | Readonly<{ ok: false; issue: { opIndex: number; code: 'unknown_block_id' | 'invalid_target' } }>;

/** One atomic document edit owner for both the editor and the saved-definition Action. */
export function applyWorkflowDefinitionEditsV1<TDraft extends WorkflowDefinitionDraftV1>(
  draft: TDraft,
  ops: readonly WorkflowDefinitionEditOpV1[],
): WorkflowDefinitionEditsResultV1<TDraft> {
  let next = draft;
  const changed = new Set<string>();
  for (const [opIndex, op] of ops.entries()) {
    const fail = (code: 'unknown_block_id' | 'invalid_target'): WorkflowDefinitionEditsResultV1<TDraft> => ({ ok: false, issue: { opIndex, code } });
    const target = 'blockId' in op ? findWorkflowBlock(next, op.blockId) : null;
    if ('blockId' in op && !target) return fail('unknown_block_id');
    const before = next;
    switch (op.kind) {
      case 'insert_block': {
        const list = getWorkflowBlockList(next, op.list);
        if (!list || (op.afterBlockId !== undefined && !list.some((block) => block.id === op.afterBlockId))) return fail('invalid_target');
        const block = materializeInsertedBlock(op.block, collectWorkflowBlockIds(next));
        if (!block.success) return fail('invalid_target');
        next = insertWorkflowBlock(next, { list: op.list, block: block.data, afterBlockId: op.afterBlockId });
        for (const inserted of walkWorkflowBlocks([block.data])) changed.add(inserted.id);
        break;
      }
      case 'replace_block':
        if (target?.kind === 'step' && findWorkflowBlockListRef(next, op.blockId) === null && op.block.kind !== 'step') return fail('invalid_target');
        next = updateWorkflowBlock(next, op.blockId, () => op.block);
        for (const replaced of walkWorkflowBlocks([op.block])) changed.add(replaced.id);
        break;
      case 'remove_block': {
        const removal = removeWorkflowBlock(next, op.blockId);
        if (!removal.removed) return fail('invalid_target');
        next = removal.draft;
        break;
      }
      case 'move_block':
        next = moveWorkflowBlock(next, op.blockId, op.direction);
        if (next === before) return fail('invalid_target');
        changed.add(op.blockId);
        break;
      case 'set_step_prompt':
        if (target?.kind !== 'step') return fail('invalid_target');
        next = setWorkflowStepText(next, op.blockId, op.text);
        if (next !== before) changed.add(op.blockId);
        break;
      case 'set_block_name':
        next = setWorkflowBlockName(next, op.blockId, op.name);
        if (next !== before) changed.add(op.blockId);
        break;
      case 'set_step_setting':
        if (target?.kind !== 'step') return fail('invalid_target');
        next = op.field === 'timeoutMs'
          ? setWorkflowStepTimeout(next, op.blockId, op.value)
          : setWorkflowStepExecutionField(next, op.blockId, op.field, op.value);
        if (next !== before) changed.add(op.blockId);
        break;
      case 'set_default': next = setWorkflowDefaultField(next, op.field, op.value); break;
      case 'set_inputs': next = setWorkflowInputs(next, op.inputs); break;
      case 'set_final_output': next = setWorkflowFinalOutput(next, op.finalOutput); break;
      case 'rename': next = { ...next, name: op.name }; break;
    }
  }
  const surviving = new Set(walkWorkflowBlocks(next.blocks).map((block) => block.id));
  return { ok: true, draft: next, changedBlockIds: [...changed].filter((id) => surviving.has(id)) };
}
