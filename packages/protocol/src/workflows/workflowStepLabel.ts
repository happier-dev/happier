import type { WorkflowBlock, WorkflowStep } from './workflowV1.js';
import type { JsonValue } from '../json/strictJsonValue.js';
import { walkWorkflowBlocks } from './workflowDefinitionEditV1.js';

/** Authored labels for a static Artifact preview; containers and runtime occurrences are omitted. */
export function workflowDefinitionPreviewStepsV1(blocks: readonly WorkflowBlock[]): readonly string[] {
  return walkWorkflowBlocks(blocks).flatMap((block) => {
    if (block.kind === 'step' || block.kind === 'wait' || block.kind === 'action' || block.kind === 'workflow') return [workflowBlockReferenceLabel(block)];
    return [];
  });
}

/** Exact ids remain the fallback for reference pickers, where identity matters. */
export function workflowBlockReferenceLabel(block: WorkflowBlock): string {
  if (block.name?.trim()) return block.name.trim();
  if (block.kind === 'step' || block.kind === 'wait') return workflowStepPromptLabel(block) ?? block.id;
  return block.id;
}

/** Prompt-derived fallback for private authoring and Run detail when no name is authored. */
export function workflowStepPromptLabel(step: Pick<WorkflowStep, 'document'>): string | null {
  const firstNonemptyLine = step.document.text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstNonemptyLine === undefined) return null;
  // Preserve the existing visual bound without changing the authored prompt.
  return firstNonemptyLine.length > 60
    ? `${firstNonemptyLine.slice(0, 60)}…`
    : firstNonemptyLine;
}

/**
 * The one visible numbering of a workflow's blocks (lab `editor-E1`): every leaf — an Agent step, a
 * Wait for you, an Action, a Run a workflow, a loop's deciding step — is numbered 1, 2, 3 … in authored
 * execution order across lanes and bodies; containers (Side by side, Repeat, If) are unnumbered and show
 * their kind mark instead. The editor heading, the Flow/Run map, Activity rows and a step Session's title
 * all read this owner, so one step has one number everywhere. A nested workflow numbers its own blocks.
 *
 * Presentation only: the persisted invocation index (`memberOrdinal`, a sibling position) is unchanged.
 */
export function listWorkflowBlockOrdinalsV1(blocks: readonly WorkflowBlock[]): ReadonlyMap<string, string> {
  const ordinals = new Map<string, string>();
  const pending = [...blocks].reverse();
  while (pending.length > 0) {
    const block = pending.pop()!;
    switch (block.kind) {
      case 'step':
      case 'wait':
      case 'action':
      case 'workflow':
        ordinals.set(block.id, String(ordinals.size + 1));
        break;
      case 'parallel':
        for (let branchIndex = block.branches.length - 1; branchIndex >= 0; branchIndex -= 1) {
          const list = block.branches[branchIndex]!.blocks;
          for (let index = list.length - 1; index >= 0; index -= 1) pending.push(list[index]!);
        }
        break;
      case 'loop':
        // LIFO: the body precedes its deciding step in visible execution order.
        if (block.repetition.kind === 'evaluate') pending.push(block.repetition.evaluator);
        for (let index = block.body.length - 1; index >= 0; index -= 1) pending.push(block.body[index]!);
        break;
      case 'if':
        for (let index = block.otherwise.length - 1; index >= 0; index -= 1) pending.push(block.otherwise[index]!);
        for (let index = block.then.length - 1; index >= 0; index -= 1) pending.push(block.then[index]!);
        break;
    }
  }
  return ordinals;
}

/** One block's visible ordinal (see {@link listWorkflowBlockOrdinalsV1}); `null` for a container. */
export function workflowBlockOrdinalV1(blocks: readonly WorkflowBlock[], blockId: string): string | null {
  return listWorkflowBlockOrdinalsV1(blocks).get(blockId) ?? null;
}

/** Only independently authored names become creation titles; Session defaults own unnamed steps. */
export function formatWorkflowStepSessionTitle(params: Readonly<{
  step: WorkflowStep;
  /** The step's visible ordinal from `workflowBlockOrdinalV1`, exactly as its heading and map node show it. */
  stepOrdinal: string;
  item?: Readonly<{ value: JsonValue; position: number }>;
}>): string | null {
  const name = params.step.name?.trim();
  if (!name) return null;
  const title = `${params.stepOrdinal} · ${name}`;
  if (!params.item) return title;
  const value = params.item.value;
  const itemLabel = typeof value === 'string' && value.trim()
    ? value.trim()
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : String(params.item.position);
  return `${title} · ${itemLabel}`;
}
