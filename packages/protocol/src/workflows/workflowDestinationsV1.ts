import type { WorkflowMaterializedLeafV1 } from './workflowDefinitionV1.js';
import type { WorkflowBlock, WorkflowDefinitionV1, WorkflowLeafV1, WorkflowStepExecutionSelection } from './workflowV1.js';
import { z } from 'zod';

/** Authored structure has one leaf traversal for admission and destination projections. */
export function collectWorkflowLeavesV1(definition: WorkflowDefinitionV1): WorkflowLeafV1[] {
  const leaves: WorkflowLeafV1[] = [];
  const pending: WorkflowBlock[] = [...definition.blocks].reverse();
  while (pending.length > 0) {
    const block = pending.pop()!;
    if (block.kind === 'parallel') pending.push(...block.branches.flatMap(branch => branch.blocks).reverse());
    else if (block.kind === 'if') pending.push(...[...block.then, ...block.otherwise].reverse());
    else if (block.kind === 'loop') {
      if (block.repetition.kind === 'evaluate') pending.push(block.repetition.evaluator);
      pending.push(...block.body.slice().reverse());
    } else leaves.push(block);
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
export const WorkflowDestinationsV1Schema = z.object({
  targetSessionIds: z.array(z.string().min(1)), usesOriginSession: z.boolean(),
  unresolvedWorkflowRefs: z.array(z.string().min(1)),
  leaves: z.array(z.object({ sourceKey: z.string().min(1), blockId: z.string().min(1),
    sessionIds: z.array(z.string().min(1)) }).strict()),
}).strict();

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
  const leaves: Array<{ sourceKey: string; blockId: string; sessionIds: string[] }> = [];
  const targetSessionIds = new Set<string>();
  const unresolved = new Set<string>();
  let usesOriginSession = false;
  const visit = (sourceKey: string, blockId: string, selection: Pick<WorkflowStepExecutionSelection, 'conversation'>) => {
    usesOriginSession ||= selection.conversation?.kind === 'origin_session';
    const sessionIds = readWorkflowLeafTargetSessionIdsV1(selection,
      selection.conversation?.kind === 'origin_session' ? input.originSessionId : undefined);
    for (const sessionId of sessionIds) targetSessionIds.add(sessionId);
    leaves.push({ sourceKey, blockId, sessionIds });
  };
  if (input.materializedLeaves) {
    for (const leaf of input.materializedLeaves) visit(leaf.sourceKey, leaf.blockId, leaf.selection);
  } else {
    const pending = [{ sourceKey: '$root', definition: input.definition }];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const frame = pending.pop()!;
      if (visited.has(frame.sourceKey)) continue;
      visited.add(frame.sourceKey);
      for (const leaf of collectWorkflowLeavesV1(frame.definition)) {
        visit(frame.sourceKey, leaf.id, { conversation: leaf.execution?.conversation ?? frame.definition.defaults.conversation });
        if (leaf.kind !== 'workflow') continue;
        const child = input.children?.[leaf.workflowRef];
        if (child) pending.push({ sourceKey: leaf.workflowRef, definition: child });
        else unresolved.add(leaf.workflowRef);
      }
    }
  }
  return { targetSessionIds: [...targetSessionIds], usesOriginSession, unresolvedWorkflowRefs: [...unresolved], leaves };
}
