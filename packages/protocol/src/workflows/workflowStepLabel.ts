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

/** The authored sibling position is zero-based; all visible block ordinals count from one. */
export function workflowBlockOrdinalV1(memberOrdinal: number | string): string {
  return (BigInt(memberOrdinal) + 1n).toString();
}

/** Only independently authored names become creation titles; Session defaults own unnamed steps. */
export function formatWorkflowStepSessionTitle(params: Readonly<{
  step: WorkflowStep;
  memberOrdinal: string;
  item?: Readonly<{ value: JsonValue; position: number }>;
}>): string | null {
  const name = params.step.name?.trim();
  if (!name) return null;
  const title = `${workflowBlockOrdinalV1(params.memberOrdinal)} · ${name}`;
  if (!params.item) return title;
  const value = params.item.value;
  const itemLabel = typeof value === 'string' && value.trim()
    ? value.trim()
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : String(params.item.position);
  return `${title} · ${itemLabel}`;
}
