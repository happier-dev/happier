import type { WorkflowOperationErrorCodeV1, WorkflowRunStateV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowRunPrivateMetadataV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { readWorkflowRunDisplayMetadataV1 } from '@happier-dev/protocol/workflows/workflowRunDisplayMetadataV1';
import { describeWorkflowOperationProblem } from './workflowProblemPresentation';

import { t } from '@/text';

/**
 * How a managed Run may name itself, from the Account-private metadata a
 * surface has for it.
 *
 * The public summary deliberately carries no title, so every Run surface —
 * the Workflows collection, the Session work-state entry and the exact Run
 * detail — answers the same three-way question from the same owner. Collapsing
 * the cases is what made every unread row read "Content unavailable":
 * `unavailable` retains the private-read owner's reason instead of treating
 * unreadable history, missing keys and a storage failure as the same state;
 * `unknown` means nothing Account-private names this Run yet, so the row
 * keeps its identity and lifecycle instead of claiming a failure.
 */
export type WorkflowRunDisplayName =
    | Readonly<{ kind: 'name'; value: string }>
    | Readonly<{ kind: 'unavailable'; reason: WorkflowOperationErrorCodeV1 }>
    | Readonly<{ kind: 'unknown' }>;

export function resolveWorkflowRunDisplayName(
    metadata: WorkflowRunPrivateMetadataV1 | null | undefined,
    acceptedContext?: Parameters<typeof readWorkflowRunDisplayMetadataV1>[0],
    /** The opened source Workflow's title, for a Run whose own content is not admitted yet (a queued Run). */
    sourceWorkflowTitle?: string | null,
): WorkflowRunDisplayName {
    if (metadata?.kind === 'available') return { kind: 'name', value: metadata.value.title };
    if (metadata?.kind === 'unavailable') return { kind: 'unavailable', reason: metadata.reason };
    const displayMetadata = acceptedContext ? readWorkflowRunDisplayMetadataV1(acceptedContext) : null;
    if (displayMetadata) return { kind: 'name', value: displayMetadata.title };
    return sourceWorkflowTitle ? { kind: 'name', value: sourceWorkflowTitle } : { kind: 'unknown' };
}

/** Failed list rows lead with the Run name while exact detail can still show its typed read problem. */
export function formatWorkflowRunDisplayName(name: WorkflowRunDisplayName, listState?: WorkflowRunStateV1): string {
    if (listState === 'failed' && name.kind === 'unavailable') return t('workflows.run.untitled');
    switch (name.kind) {
        case 'name': return name.value;
        case 'unavailable': return name.reason === 'content_unavailable'
            ? t('workflows.contentUnavailable') : describeWorkflowOperationProblem(name.reason).title;
        case 'unknown': return t('workflows.run.untitled');
    }
}

export function presentWorkflowRunTitle(
    name: WorkflowRunDisplayName,
    facts: Readonly<{ pending: boolean; state?: WorkflowRunStateV1 }>,
): Readonly<{ kind: 'pending' | 'name' | 'fallback'; title: string }> {
    if (name.kind === 'unknown' && facts.pending) return { kind: 'pending', title: t('common.loading') };
    return { kind: name.kind === 'name' ? 'name' : 'fallback', title: formatWorkflowRunDisplayName(name, facts.state) };
}
