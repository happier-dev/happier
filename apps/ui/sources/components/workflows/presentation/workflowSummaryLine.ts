import type { WorkflowBlock } from '@happier-dev/protocol/workflows/workflowV1';

import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';

const SEPARATOR = ' → ';

/**
 * The line under a workflow's title (owner 2026-11-15, lab round 1115 r16): when it runs, then each
 * top-level step in order — "Every weekday at 09:00 → find the cause → fix it → tell me". Generated
 * from the workflow on every read and never stored, so it can't disagree with the steps it names.
 */
export function formatWorkflowSummaryLine(draft: WorkflowEditorDraft, input: Readonly<{ trigger: string | null }>): string | null {
    const steps = draft.blocks.map(readSummaryPart).filter((part): part is string => part !== null);
    const parts = [...(input.trigger === null ? [] : [input.trigger]), ...steps];
    if (steps.length === 0 || parts.length === 0) return null;
    return parts.map((part, index) => (index === 0 ? part : lowerSentenceStart(part))).join(SEPARATOR);
}

/**
 * A top-level block as this line names it mid-sentence ("find the cause"): the Sentence view's step chips
 * (round 1116c Q4). A step with nothing written yet reads by its kind ("agent step").
 */
export function formatWorkflowSummaryStepName(block: WorkflowBlock): string {
    return lowerSentenceStart(readSummaryPart(block) ?? workflowBlockReferenceLabel(block));
}

/** A block by its name; an unnamed Agent step by its prompt's first sentence; an empty step says nothing. */
function readSummaryPart(block: WorkflowBlock): string | null {
    const name = block.name?.trim();
    if (name) return name;
    if (block.kind === 'step' || block.kind === 'wait') {
        const sentence = block.document.text.trim().split(/[.!?\n]/u)[0]?.trim() ?? '';
        return sentence.length === 0 ? null : sentence;
    }
    return workflowBlockReferenceLabel(block);
}

/** "Fix it" reads "fix it" mid-line; a word in capitals ("PR review") keeps them. */
function lowerSentenceStart(part: string): string {
    return /^\p{Lu}\p{Ll}/u.test(part) ? part.charAt(0).toLocaleLowerCase() + part.slice(1) : part;
}
