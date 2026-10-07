import type { WorkflowBlock, WorkflowStep } from '@happier-dev/protocol';

/** Walk authored blocks in declaration order without limiting nesting. */
export function* walkWorkflowBlocks(
  blocks: readonly WorkflowBlock[],
): Generator<WorkflowBlock> {
  const pending: WorkflowBlock[] = [...blocks].reverse();
  while (pending.length > 0) {
    const block = pending.pop()!;
    yield block;
    const nested = block.kind === 'parallel'
      ? block.branches.flatMap((branch) => branch.blocks)
      : block.kind === 'if'
        ? [...block.then, ...block.otherwise]
        : block.kind === 'loop'
          ? [...block.body, ...(block.repetition.kind === 'evaluate' ? [block.repetition.evaluator] : [])]
          : [];
    for (let index = nested.length - 1; index >= 0; index -= 1) {
      pending.push(nested[index]!);
    }
  }
}

export function findWorkflowStepById(
  blocks: readonly WorkflowBlock[],
  blockId: string,
): WorkflowStep | undefined {
  for (const block of walkWorkflowBlocks(blocks)) {
    if (block.kind === 'step' && block.id === blockId) return block;
  }
  return undefined;
}
