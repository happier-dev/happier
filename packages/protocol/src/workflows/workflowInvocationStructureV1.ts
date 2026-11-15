import type { WorkflowLexicalScope } from './workflowReferenceV1.js';
import type { WorkflowBlock, WorkflowDefinitionV1, WorkflowLeafV1 } from './workflowV1.js';
import type { WorkflowProgressEnvelopeV1, WorkflowRunInvocationIndexV1 } from './workflowProgressV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import type { JsonValue } from '../json/strictJsonValue.js';
import { readWorkflowValuePathV1 } from './workflowReferenceV1.js';
import type { WorkflowResolvedInputsV1 } from './workflowDefinitionV1.js';

/** Reconstructed interpreter context; never persisted as a second scope stack. */
export type WorkflowScopeFrameV1 = {
  parent?: WorkflowScopeFrameV1;
  structuralKey?: string;
  blocks: readonly WorkflowBlock[];
  scope: WorkflowProgressEnvelopeV1['invocationPath']['scope'];
  loop?: NonNullable<WorkflowLexicalScope['loop']> & Readonly<{ ownerKey: string; index: number }>;
  item?: Readonly<{ value: JsonValue; index: number; position: number; count: number }>;
};

export type WorkflowInvocationBindingRowV1 = Readonly<{
  index: WorkflowRunInvocationIndexV1;
  progress: WorkflowProgressEnvelopeV1;
}>;
export type WorkflowInvocationBindingParamsV1 = Readonly<{
  definition: WorkflowDefinitionV1;
  frozenChildren?: Readonly<Record<string, WorkflowDefinitionV1>>;
  invocation: WorkflowInvocationBindingRowV1;
  readInvocation: (recordId: string) => Promise<WorkflowInvocationBindingRowV1 | undefined>;
  inputs?: WorkflowResolvedInputsV1;
}>;

/** The retained correspondence belongs to this exact slot's same-conversation attempt lineage. */
export async function resolveWorkflowRetainedConversationAttemptV1(params: Readonly<{
  invocation: WorkflowInvocationBindingRowV1;
  readInvocation: WorkflowInvocationBindingParamsV1['readInvocation'];
}>): Promise<WorkflowInvocationBindingRowV1 | undefined> {
  let row = params.invocation;
  const seen = new Set([row.index.id]);
  while (true) {
    if (row.progress.blockKind !== 'step' || row.index.attempt !== row.progress.attempt) return undefined;
    if (row.progress.execution?.kind === 'session' || row.progress.execution?.kind === 'session_ready'
      || row.progress.execution?.kind === 'detached_run') return row;
    const previousId = row.progress.previousAttemptRecordId;
    if (row.progress.recovery?.conversation !== 'same_conversation' || !previousId || seen.has(previousId)) return undefined;
    const previous = await params.readInvocation(previousId);
    if (!previous || previous.index.id !== previousId || previous.index.lifecycle !== 'superseded'
      // Causal recovery replaces enclosing frames too. Their physical ids
      // change; this leaf's logical slot and exact attempt lineage do not.
      || previous.index.runId !== row.index.runId
      || previous.index.memberOrdinal !== row.index.memberOrdinal
      || BigInt(previous.index.attempt) + 1n !== BigInt(row.index.attempt)
      || previous.progress.logicalInvocationRecordId !== row.progress.logicalInvocationRecordId
      || previous.progress.blockKind !== row.progress.blockKind
      || !sameStrictJsonValue(previous.progress.invocationPath, row.progress.invocationPath)) return undefined;
    seen.add(previousId);
    row = previous;
  }
}

/** Live frames and frozen-row reconstruction share this ownership table. */
export function workflowBodyOwnsConversation(owner: Extract<WorkflowBlock, { kind: 'parallel' | 'loop' }>): boolean {
  return owner.kind === 'parallel'
    || (owner.repetition.kind === 'items' && owner.repetition.execution === 'parallel');
}

/** One frozen ancestry walk for result contracts, lexical frames and admission ownership. */
export async function resolveWorkflowInvocationStructureV1(params: WorkflowInvocationBindingParamsV1 & Readonly<{
  keyOfInvocation: (row: WorkflowInvocationBindingRowV1) => string;
  /** Admission may narrow ancestry lifetime; completed result sources are not ancestors. */
  isAncestryCurrent?: (row: WorkflowInvocationBindingRowV1) => boolean;
}>): Promise<Readonly<{
  leaf: WorkflowLeafV1;
  definition: WorkflowDefinitionV1;
  sourceKey: string;
  frame: WorkflowScopeFrameV1;
  inheritedConversationOwnerRecordId: string;
  rootConversationOwnerRecordId: string;
  inputs: WorkflowResolvedInputsV1;
}> | undefined> {
  if (params.isAncestryCurrent?.(params.invocation) === false) return undefined;
  const ancestry: WorkflowInvocationBindingRowV1[] = [params.invocation];
  const seen = new Set([params.invocation.index.id]);
  while (ancestry[0]!.index.parentRecordId !== null) {
    const parentId = ancestry[0]!.index.parentRecordId!;
    if (seen.has(parentId)) return undefined;
    const parent = await params.readInvocation(parentId);
    if (!parent || parent.index.id !== parentId || parent.index.runId !== params.invocation.index.runId
      || params.isAncestryCurrent?.(parent) === false) return undefined;
    seen.add(parentId);
    ancestry.unshift(parent);
  }
  const root = ancestry.shift();
  if (root?.progress.blockKind !== 'root' || root.progress.invocationPath.blockId !== '$root') return undefined;
  if (!root) return undefined;
  let frame: WorkflowScopeFrameV1 = { blocks: params.definition.blocks, scope: root.progress.invocationPath.scope };
  let definition = params.definition;
  let sourceKey = '$root';
  let inheritedConversationOwnerRecordId = root.index.id;
  let rootConversationOwnerRecordId = root.index.id;
  let bodyOwner: Extract<WorkflowBlock, { kind: 'loop' | 'parallel' }> | undefined;
  let bodyOwnerKey: string | undefined;
  let itemValues: readonly JsonValue[] | undefined;
  let inputs = params.inputs ?? {};
  for (let position = 0; position < ancestry.length; position += 1) {
    const { index, progress } = ancestry[position]!;
    if (progress.frame) {
      if (!bodyOwner || progress.blockKind !== bodyOwner.kind || progress.frame.ownerBlockId !== bodyOwner.id || progress.invocationPath.blockId !== bodyOwner.id) return undefined;
      const source = progress.frame.source;
      let blocks: readonly WorkflowBlock[];
      if (bodyOwner.kind === 'parallel') {
        if (source.kind !== 'branch') return undefined;
        const branch = bodyOwner.branches[Number(index.memberOrdinal)];
        if (!branch || branch.id !== source.branchId) return undefined;
        blocks = branch.blocks;
      } else {
        if (source.kind !== (bodyOwner.repetition.kind === 'items' ? 'item' : 'iteration')
          || source.index !== index.memberOrdinal) return undefined;
        blocks = bodyOwner.repetition.kind === 'evaluate'
          ? [...bodyOwner.body, bodyOwner.repetition.evaluator] : bodyOwner.body;
      }
      const loop = bodyOwner.kind === 'loop' && source.kind !== 'branch' && bodyOwnerKey
        ? { blockId: bodyOwner.id, kind: bodyOwner.repetition.kind,
            ...(bodyOwner.repetition.kind === 'items' ? { execution: bodyOwner.repetition.execution } : {}),
            ownerKey: bodyOwnerKey, index: Number(source.index) } : undefined;
      frame = { parent: frame, structuralKey: params.keyOfInvocation(ancestry[position]!),
        blocks, scope: progress.invocationPath.scope, ...(loop ? { loop } : {}),
        ...(source.kind === 'item' && itemValues?.[Number(source.index)] !== undefined
          ? { item: { value: itemValues[Number(source.index)]!, index: Number(source.index),
            position: Number(source.index) + 1, count: itemValues.length } }
          : source.kind !== 'item' && frame.item ? { item: frame.item } : {}) };
      if (workflowBodyOwnsConversation(bodyOwner)) inheritedConversationOwnerRecordId = index.id;
      bodyOwner = undefined;
      bodyOwnerKey = undefined;
      itemValues = undefined;
      continue;
    }
    if (bodyOwner) return undefined;
    const block = frame.blocks[Number(index.memberOrdinal)];
    if (!block || block.kind !== progress.blockKind || block.id !== progress.invocationPath.blockId) return undefined;
    if (position === ancestry.length - 1) return block.kind === 'step' || block.kind === 'action' || block.kind === 'wait' || block.kind === 'workflow'
      ? { leaf: block, definition, sourceKey, frame, inheritedConversationOwnerRecordId, rootConversationOwnerRecordId, inputs } : undefined;
    if (block.kind === 'if') {
      if (progress.container?.kind !== 'if') return undefined;
      frame = { parent: frame, structuralKey: params.keyOfInvocation(ancestry[position]!),
        blocks: progress.container.selected === 'then' ? block.then : block.otherwise,
        scope: progress.invocationPath.scope, ...(frame.item ? { item: frame.item } : {}) };
    } else if (block.kind === 'parallel' || block.kind === 'loop') {
      bodyOwner = block;
      bodyOwnerKey = params.keyOfInvocation(ancestry[position]!);
      if (params.inputs !== undefined && progress.container?.kind === 'loop' && progress.container.mode === 'items') {
        const source = progress.container.source;
        const reference = source.kind === 'definition' ? source.reference : undefined;
        const result = source.kind === 'result' ? await params.readInvocation(source.recordId) : undefined;
        const inputValue = reference?.kind === 'input' ? inputs[reference.name] : undefined;
        const value = reference?.kind === 'literal' ? reference.value : reference?.kind === 'input' && inputValue !== undefined
          ? readWorkflowValuePathV1(inputValue, reference.path ?? [])
          : source.kind === 'result' && result?.progress.result !== undefined
            ? readWorkflowValuePathV1(result.progress.result, source.path) : undefined;
        itemValues = Array.isArray(value) ? value : undefined;
      }
    } else if (block.kind === 'workflow') {
      const child = params.frozenChildren?.[block.workflowRef];
      if (!child) return undefined;
      definition = child;
      sourceKey = block.workflowRef;
      inputs = progress.container?.kind === 'body' ? progress.container.frameInputs ?? {} : {};
      // A called definition has its own lexical root and conversation owner.
      frame = { structuralKey: params.keyOfInvocation(ancestry[position]!), blocks: child.blocks,
        scope: [...progress.invocationPath.scope, { kind: 'workflow', blockId: block.id }] };
      inheritedConversationOwnerRecordId = index.id;
      rootConversationOwnerRecordId = index.id;
    } else return undefined;
  }
  return undefined;
}
