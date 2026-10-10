import { lazyZodSchema } from '../lazyZodSchema.js';
import type { WorkflowMaterializedLeafV1 } from './workflowDefinitionV1.js';
import type { WorkflowBlock, WorkflowDefinitionV1, WorkflowLeafV1, WorkflowStepExecutionSelection } from './workflowV1.js';
import { listWorkflowBlockOrdinalsV1, workflowBlockReferenceLabel } from './workflowStepLabel.js';
import { z } from 'zod';

/** Authored structure has one leaf traversal for admission and destination projections. */
export function collectWorkflowLeavesV1(definition: WorkflowDefinitionV1): WorkflowLeafV1[] {
  return collectWorkflowLeafPositionsV1(definition).map(entry => entry.leaf);
}

function collectWorkflowLeafPositionsV1(definition: WorkflowDefinitionV1): Array<{ leaf: WorkflowLeafV1; ordinal: number }> {
  const leaves: Array<{ leaf: WorkflowLeafV1; ordinal: number }> = [];
  const ordinals = listWorkflowBlockOrdinalsV1(definition.blocks);
  const siblings = (blocks: readonly WorkflowBlock[]) => [...blocks].reverse();
  const pending = siblings(definition.blocks);
  while (pending.length > 0) {
    const block = pending.pop()!;
    if (block.kind === 'parallel') pending.push(...block.branches.slice().reverse().flatMap(branch => siblings(branch.blocks)));
    else if (block.kind === 'if') pending.push(...siblings(block.otherwise), ...siblings(block.then));
    else if (block.kind === 'loop') {
      if (block.repetition.kind === 'evaluate') pending.push(block.repetition.evaluator);
      pending.push(...siblings(block.body));
    } else leaves.push({ leaf: block, ordinal: Number(ordinals.get(block.id)) });
  }
  return leaves;
}

/** The materializer's existing per-leaf Session availability relation. */
export function readWorkflowLeafTargetSessionIdsV1(selection: Pick<WorkflowStepExecutionSelection, 'conversation'>,
  originSessionId?: string): string[] {
  return [...new Set([
    ...(originSessionId ? [originSessionId] : []),
    ...(selection.conversation?.kind === 'existing_session' ? [selection.conversation.sessionId] : []),
  ])];
}

/**
 * `usesOriginSession`: an unbound definition can still describe its origin destination.
 * `unresolvedWorkflowRefs`: a reference cannot be projected until its current definition has been read.
 * The type is the wire schema's, so a projection result is assignable wherever the schema's shape is.
 */
export const WorkflowDestinationsV1Schema = lazyZodSchema(() => z.object({
  targetSessionIds: z.array(z.string().min(1)), usesOriginSession: z.boolean(),
  unresolvedWorkflowRefs: z.array(z.string().min(1)),
  leaves: z.array(z.object({ sourceKey: z.string().min(1), blockId: z.string().min(1),
    ordinal: z.number().int().positive().optional(), name: z.string().optional(),
    sessionIds: z.array(z.string().min(1)) }).strict()),
}).strict());

export type WorkflowDestinationsV1 = z.infer<typeof WorkflowDestinationsV1Schema>;

/** Loading uses the caller's authorized reader, not a second definition catalog. */
export async function resolveWorkflowDestinationsV1(input: Parameters<typeof deriveWorkflowDestinationsV1>[0],
  read: (ref: string) => Promise<WorkflowDefinitionV1 | null>): Promise<WorkflowDestinationsV1> {
  const children = { ...input.children };
  const attempted = new Set<string>();
  let destinations = deriveWorkflowDestinationsV1({ ...input, children });
  while (destinations.unresolvedWorkflowRefs.some(ref => !attempted.has(ref))) {
    for (const ref of destinations.unresolvedWorkflowRefs) {
      if (attempted.has(ref)) continue;
      attempted.add(ref);
      const child = await read(ref);
      if (child) children[ref] = child;
    }
    destinations = deriveWorkflowDestinationsV1({ ...input, children });
  }
  return destinations;
}

/** Pure projection of current definitions or the already-resolved accepted graph. */
export function deriveWorkflowDestinationsV1(input: Readonly<{
  definition: WorkflowDefinitionV1;
  children?: Readonly<Record<string, WorkflowDefinitionV1>>;
  materializedLeaves?: readonly WorkflowMaterializedLeafV1[];
  originSessionId?: string;
}>): WorkflowDestinationsV1 {
  const leaves: WorkflowDestinationsV1['leaves'] = [];
  const targetSessionIds = new Set<string>();
  const unresolved = new Set<string>();
  let usesOriginSession = false;
  const visit = (sourceKey: string, blockId: string, selection: Pick<WorkflowStepExecutionSelection, 'conversation'>,
    position?: { leaf: WorkflowLeafV1; ordinal: number }) => {
    usesOriginSession ||= selection.conversation?.kind === 'origin_session';
    const sessionIds = readWorkflowLeafTargetSessionIdsV1(selection,
      selection.conversation?.kind === 'origin_session' ? input.originSessionId : undefined);
    for (const sessionId of sessionIds) targetSessionIds.add(sessionId);
    leaves.push({ sourceKey, blockId, sessionIds, ...(position ? { ordinal: position.ordinal,
      name: workflowBlockReferenceLabel(position.leaf) } : {}) });
  };
  if (input.materializedLeaves) {
    const positions = new Map<string, ReturnType<typeof collectWorkflowLeafPositionsV1>>();
    positions.set('$root', collectWorkflowLeafPositionsV1(input.definition));
    for (const [key, definition] of Object.entries(input.children ?? {})) positions.set(key, collectWorkflowLeafPositionsV1(definition));
    for (const leaf of input.materializedLeaves) visit(leaf.sourceKey, leaf.blockId, leaf.selection,
      positions.get(leaf.sourceKey)?.find(position => position.leaf.id === leaf.blockId));
  } else {
    const pending = [{ sourceKey: '$root', definition: input.definition }];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const frame = pending.pop()!;
      if (visited.has(frame.sourceKey)) continue;
      visited.add(frame.sourceKey);
      for (const position of collectWorkflowLeafPositionsV1(frame.definition)) {
        const leaf = position.leaf;
        visit(frame.sourceKey, leaf.id, { conversation: leaf.execution?.conversation ?? frame.definition.defaults.conversation }, position);
        if (leaf.kind !== 'workflow') continue;
        const child = input.children?.[leaf.workflowRef];
        if (child) pending.push({ sourceKey: leaf.workflowRef, definition: child });
        else unresolved.add(leaf.workflowRef);
      }
    }
  }
  return { targetSessionIds: [...targetSessionIds], usesOriginSession, unresolvedWorkflowRefs: [...unresolved], leaves };
}
