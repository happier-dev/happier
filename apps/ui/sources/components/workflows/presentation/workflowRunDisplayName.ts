import type { WorkflowOperationErrorCodeV1, WorkflowRunPrivateMetadataV1 } from '@happier-dev/protocol';
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
): WorkflowRunDisplayName {
    if (metadata?.kind === 'available') return { kind: 'name', value: metadata.value.title };
    return metadata?.kind === 'unavailable' ? { kind: 'unavailable', reason: metadata.reason } : { kind: 'unknown' };
}

/** The one localized label for each resolved name. */
export function formatWorkflowRunDisplayName(name: WorkflowRunDisplayName): string {
    switch (name.kind) {
        case 'name': return name.value;
        case 'unavailable': return name.reason === 'content_unavailable'
            ? t('workflows.contentUnavailable') : describeWorkflowOperationProblem(name.reason).title;
        case 'unknown': return t('workflows.run.untitled');
    }
}
