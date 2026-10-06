import { selectWorkflowLexicalScope } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import { resolveWorkflowInvocationStructureV1 } from '@happier-dev/protocol/workflows/workflowInvocationStructureV1';
import type { WorkflowAuthoredProducerRef, WorkflowScopeFrameV1, WorkflowInvocationBindingRowV1, WorkflowInvocationBindingParamsV1, WorkflowStep, WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows';
import type { WorkflowCoordinatorInvocation, WorkflowCoordinatorStore } from './coordinator';
import { WorkflowInputResolutionError } from './input';
export type WorkflowScopeFrame = WorkflowScopeFrameV1;

export type WorkflowProducerBinding = Readonly<{
  resolve: (producer: WorkflowAuthoredProducerRef) => Promise<WorkflowCoordinatorInvocation | undefined>;
}>;

export type WorkflowInvocationBindingRow = WorkflowInvocationBindingRowV1;
type WorkflowInvocationBindingParams = WorkflowInvocationBindingParamsV1;

/** One frozen ancestry walk for result contracts, lexical frames and admission ownership. */
export async function resolveWorkflowInvocationStructure(params: WorkflowInvocationBindingParams & Readonly<{
  keyOfInvocation: (row: WorkflowInvocationBindingRow) => string;
}>): Promise<Readonly<{
  step: WorkflowStep;
  definition: WorkflowDefinitionV1;
  sourceKey: string;
  frame: WorkflowScopeFrame;
  inheritedConversationOwnerRecordId: string;
  rootConversationOwnerRecordId: string;
}> | undefined> {
  const resolved = await resolveWorkflowInvocationStructureV1(params);
  return resolved?.leaf.kind === 'step' ? { step: resolved.leaf, definition: resolved.definition, sourceKey: resolved.sourceKey, frame: resolved.frame,
    inheritedConversationOwnerRecordId: resolved.inheritedConversationOwnerRecordId,
    rootConversationOwnerRecordId: resolved.rootConversationOwnerRecordId } : undefined;
}

/** CODEC's step-only projection consumes the same exact ancestry owner. */
export async function resolveWorkflowInvocationStep(params: WorkflowInvocationBindingParams): Promise<WorkflowStep | undefined> {
  return (await resolveWorkflowInvocationStructure({ ...params, keyOfInvocation: (row) => row.index.id }))?.step;
}

/** Read one named structural slot, including a branch's exported body frame. */
export async function resolveWorkflowProducerInFrame(params: Readonly<{
  runId: string;
  store: WorkflowCoordinatorStore;
  frame: WorkflowScopeFrame;
  blockId: string;
}>): Promise<WorkflowCoordinatorInvocation | undefined> {
  const { frame, store, runId, blockId } = params;
  const ordinal = frame.blocks.findIndex((block) => block.id === blockId);
  if (ordinal >= 0) {
    return await store.readCurrent({ runId, blockId, scope: frame.scope,
      ...(frame.structuralKey ? { parentKey: frame.structuralKey } : {}), memberOrdinal: String(ordinal) });
  }
  for (let index = 0; index < frame.blocks.length; index += 1) {
    const block = frame.blocks[index]!;
    if (block.kind !== 'parallel') continue;
    const branchOrdinal = block.branches.findIndex((branch) => branch.id === blockId);
    if (branchOrdinal < 0) continue;
    const owner = await store.readCurrent({ runId, blockId: block.id, scope: frame.scope,
      ...(frame.structuralKey ? { parentKey: frame.structuralKey } : {}), memberOrdinal: String(index) });
    if (!owner) return undefined;
    return await store.readCurrent({ runId, blockId: block.id, scope: frame.scope,
      parentKey: owner.key, memberOrdinal: String(branchOrdinal) });
  }
  return undefined;
}

/** Load only the immediately named body slot of the same exact loop occurrence. */
export async function readWorkflowLoopBodyFrame(params: Readonly<{
  runId: string;
  store: WorkflowCoordinatorStore;
  frame: WorkflowScopeFrame;
  index: number;
}>): Promise<WorkflowScopeFrame | undefined> {
  const { frame, index, runId, store } = params;
  if (!frame.loop || index < 0) return undefined;
  const body = await store.readCurrent({ runId, blockId: frame.loop.blockId,
    scope: frame.scope, parentKey: frame.loop.ownerKey, memberOrdinal: String(index) });
  return body ? { ...frame, structuralKey: body.key, scope: body.path.scope,
    loop: { ...frame.loop, index } } : undefined;
}

export function createWorkflowProducerBinding(params: Readonly<{
  runId: string;
  store: WorkflowCoordinatorStore;
  frame: WorkflowScopeFrame;
}>): WorkflowProducerBinding {
  return { resolve: async (producer) => {
    const levels: WorkflowScopeFrame[] = [];
    for (let frame: WorkflowScopeFrame | undefined = params.frame; frame; frame = frame.parent) levels.unshift(frame);
    const selection = selectWorkflowLexicalScope(levels, producer.scope);
    if (selection.kind === 'invalid') throw new WorkflowInputResolutionError(selection.code);
    let frame: WorkflowScopeFrame | undefined = levels[selection.levelIndex]!;
    if (selection.kind === 'previous_iteration') {
      frame = await readWorkflowLoopBodyFrame({ ...params, frame, index: frame.loop!.index - 1 });
    }
    return frame ? await resolveWorkflowProducerInFrame({ ...params, frame, blockId: producer.blockId }) : undefined;
  } };
}
