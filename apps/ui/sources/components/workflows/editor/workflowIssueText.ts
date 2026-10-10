import type { WorkflowValidationIssue } from '@happier-dev/protocol/workflows/workflowV1';

import { findWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { resolveWorkflowIssueBlockId } from '@/sync/domains/workflows/workflowAuthoring';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

import { formatWorkflowFieldLabel } from './WorkflowStepDataEditor';

/**
 * One validation issue as a person reads it: the thing to fix, named (DESIGN-4 P3). An empty
 * prompt says to write it; a field that is missing or not valid says which field; every other
 * issue keeps its code's sentence. The document, the import review and the Flow pane all word an
 * issue here, so one issue is never worded two ways.
 */
export function formatWorkflowIssueText(
    issue: Pick<WorkflowValidationIssue, 'code' | 'path'> & Partial<Pick<WorkflowValidationIssue, 'blockId'>>,
    /** The draft the issue's path walks, so a Wait for you's empty prompt reads as its own question. */
    draft?: WorkflowEditorDraft,
): string {
    const segments = issue.path.split('/').filter((segment) => segment.length > 0);
    const last = segments.at(-1);
    if (issue.code === 'invalid_input' || issue.code === 'missing_required_input') {
        if (last === 'text' && segments.at(-2) === 'document') {
            const blockId = draft === undefined ? null : resolveWorkflowIssueBlockId(draft, issue);
            const block = blockId === null || draft === undefined ? null : findWorkflowBlock(draft, blockId);
            return t(block?.kind === 'wait' ? 'workflows.issue.emptyWaitPrompt' : 'workflows.issue.emptyPrompt');
        }
        // The field's own name: an input's key, else the nearest segment that names rather than places.
        const inputAt = segments.lastIndexOf('input');
        const inputKey = inputAt >= 0 ? segments[inputAt + 1] : undefined;
        // A workflow input's own default names the input ("Rounds needs a valid value").
        const workflowInput = segments[0] === 'inputs' ? draft?.inputs[Number(segments[1])]?.name : undefined;
        const field = workflowInput ?? (inputKey !== undefined && !/^\d+$/u.test(inputKey) ? inputKey
            : [...segments].reverse().find((segment) => !/^\d+$/u.test(segment) && !STRUCTURAL_SEGMENTS.has(segment)));
        if (field !== undefined) {
            const label = formatWorkflowFieldLabel(field);
            return issue.code === 'missing_required_input'
                ? t('workflows.issue.fieldMissing', { field: label })
                : t('workflows.issue.fieldInvalid', { field: label });
        }
    }
    return t(`workflows.issue.${issue.code}`);
}

/** Path segments that place a field rather than name it. */
const STRUCTURAL_SEGMENTS: ReadonlySet<string> = new Set([
    'blocks', 'branches', 'body', 'then', 'otherwise', 'input', 'inputs', 'repetition', 'evaluator', 'execution',
]);

/**
 * A typed card's issues by field ("message" → "Message is required."), so the offending row is
 * marked where it is, not only counted in the header (DESIGN-6 P3). The first issue per field wins.
 */
export function collectWorkflowFieldIssueTexts(
    issues: readonly Pick<WorkflowValidationIssue, 'code' | 'path'>[],
    draft?: WorkflowEditorDraft,
): Readonly<Record<string, string>> {
    const byField: Record<string, string> = {};
    for (const issue of issues) {
        const segments = issue.path.split('/').filter((segment) => segment.length > 0);
        const at = segments.lastIndexOf('input');
        const field = at >= 0 ? segments[at + 1] : undefined;
        if (field === undefined || /^\d+$/u.test(field) || byField[field] !== undefined) continue;
        byField[field] = formatWorkflowIssueText(issue, draft);
    }
    return byField;
}
