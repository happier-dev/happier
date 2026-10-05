import type { WorkflowStep } from './workflowV1.js';

/** Content-derived label shared by private authoring, Run detail and Session creation. */
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

/** The accepted sibling ordinal is zero-based; unnamed steps use Session defaults. */
export function formatWorkflowStepSessionTitle(params: Readonly<{
  step: WorkflowStep;
  memberOrdinal: string;
}>): string | null {
  const label = workflowStepPromptLabel(params.step);
  return label === null ? null : `${BigInt(params.memberOrdinal) + 1n} · ${label}`;
}
