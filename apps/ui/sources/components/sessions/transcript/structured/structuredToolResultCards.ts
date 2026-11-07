import type { ToolCallMessage } from '@happier-dev/session-core/messages';
import type { core } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { ReviewCommentsV1Schema } from '@/sync/domains/input/reviewComments/reviewCommentMeta';
import { ReviewFindingsV1Schema } from '@happier-dev/protocol/messages/structured/reviewFindingsV1';
import { ReviewFindingsV2Schema } from '@happier-dev/protocol/messages/structured/reviewFindingsV2';
import { ReviewFollowUpV1Schema } from '@happier-dev/protocol/messages/structured/reviewFollowUpV1';
import { PlanOutputV1Schema } from '@happier-dev/protocol/messages/structured/planOutputV1';
import { DelegateOutputV1Schema } from '@happier-dev/protocol/messages/structured/delegateOutputV1';
import { ExecutionRunCompletionV1Schema } from '@happier-dev/protocol/execution/runs/completionInputV1';
import { ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { readScmDiffSummaryPublicationReceipt } from '@/sync/domains/scm/diffSummary/publicationReceipt';
import { parseHappierMetaEnvelope } from './happierMetaEnvelope';

/** The structured renderer consumes these same descriptors for every tool-carried result card. */
export const STRUCTURED_TOOL_RESULT_CARDS = {
    reviewComments: { kind: 'review_comments.v1', schema: ReviewCommentsV1Schema },
    reviewFindingsV1: { kind: 'review_findings.v1', schema: ReviewFindingsV1Schema },
    reviewFindingsV2: { kind: 'review_findings.v2', schema: ReviewFindingsV2Schema },
    reviewFollowUp: { kind: 'review_follow_up.v1', schema: ReviewFollowUpV1Schema },
    planOutput: { kind: 'plan_output.v1', schema: PlanOutputV1Schema },
    delegateOutput: { kind: 'delegate_output.v1', schema: DelegateOutputV1Schema },
    executionRunCompletion: { kind: 'execution_run_completion.v1', schema: ExecutionRunCompletionV1Schema },
    scmDiffSummary: { kind: 'scm_diff_summary.v1', schema: ScmDiffSummaryGenerateOutputSchema },
} as const satisfies Record<string, Readonly<{ kind: string; schema: core.$ZodType }>>;
const toolResultCardDescriptors = Object.values(STRUCTURED_TOOL_RESULT_CARDS);

/** Valid cards stand beside tool chrome; malformed or non-card metadata stays in ordinary details. */
export function hasToolCarriedStructuredResultCard(message: ToolCallMessage): boolean {
    const envelope = parseHappierMetaEnvelope(message.meta);
    if (!envelope) return false;
    const descriptor = toolResultCardDescriptors.find(({ kind }) => kind === envelope.kind);
    if (!descriptor) return false;
    if (descriptor.kind === STRUCTURED_TOOL_RESULT_CARDS.scmDiffSummary.kind) {
        const parsed = createStoredReadSchema(STRUCTURED_TOOL_RESULT_CARDS.scmDiffSummary.schema).safeParse(envelope.payload);
        return parsed.success && readScmDiffSummaryPublicationReceipt(parsed.data, message.meta?.scmResultUpdate) !== null;
    }
    return createStoredReadSchema(descriptor.schema).safeParse(envelope.payload).success;
}
