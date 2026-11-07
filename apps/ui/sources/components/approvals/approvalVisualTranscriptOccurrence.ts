import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ApprovalStaleFailureDetailsSchema } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import { SESSION_BOARD_ACTION_MCP_TOOL_NAMES_V1 } from '@happier-dev/protocol/sessions/board/actionIds';

import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import {
    resolveTranscriptSessionBoardItemReference,
    type TranscriptSessionBoardItemReference,
} from '@/components/sessions/transcript/references/transcriptSessionBoardItemReference';

export type ApprovalVisualTranscriptOccurrence = Readonly<
    | { kind: 'pending' }
    | { kind: 'approved'; reference: TranscriptSessionBoardItemReference }
    | { kind: 'denied' }
    | { kind: 'expired' }
    | { kind: 'stale'; reason: string | null }
    | { kind: 'failed'; errorCode: string }
    | { kind: 'uncertain'; errorCode: string }
>;

/** Whether this Artifact belongs at the originating transcript visual call after settlement. */
export function presentsApprovalVisualTranscriptOccurrence(approval: ApprovalRequest): boolean {
    return approval.actionId === 'session.board.item.upsert'
        && approval.origin?.kind === 'transcript_tool_call';
}

/**
 * Projects the live approval Artifact into the one transcript occurrence at its
 * original tool-call position. Successful replay delegates to the same exact
 * acknowledgement recognizer as an Allowed call; this selector owns no result
 * parsing, persistence, polling, replay authority, or approval lifecycle.
 */
export function resolveApprovalVisualTranscriptOccurrence(input: Readonly<{
    approval: ApprovalRequest;
    address: SessionAddress;
}>): ApprovalVisualTranscriptOccurrence | null {
    const { approval } = input;
    if (!presentsApprovalVisualTranscriptOccurrence(approval)) return null;

    if (approval.status === 'open' || approval.status === 'approved' || approval.status === 'executing') {
        return { kind: 'pending' };
    }
    if (approval.status === 'rejected') return { kind: 'denied' };
    if (approval.status === 'canceled') return { kind: 'expired' };
    if (approval.status === 'outcome_unknown') return { kind: 'uncertain', errorCode: approval.execution?.errorCode ?? 'approval_execution_outcome_unknown' };
    if (approval.status === 'failed') {
        if (approval.execution?.errorCode === 'approval_stale') {
            const details = ApprovalStaleFailureDetailsSchema.safeParse(approval.execution.details);
            return { kind: 'stale', reason: details.success ? details.data.reason : null };
        }
        return { kind: 'failed', errorCode: approval.execution?.errorCode ?? 'action_failed' };
    }

    const reference = resolveTranscriptSessionBoardItemReference({
        toolName: SESSION_BOARD_ACTION_MCP_TOOL_NAMES_V1['session.board.item.upsert'],
        state: 'completed',
        input: approval.actionArgs,
        result: approval.execution?.result,
        address: input.address,
    });
    return reference ? { kind: 'approved', reference } : { kind: 'failed', errorCode: 'invalid_action_output' };
}
