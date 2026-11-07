import { describe, expect, it } from 'vitest';

import { ApprovalRequestV2Schema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createSessionSurfaceNoteDocumentV1 } from '@happier-dev/protocol/sessions/board';
import { SESSION_BOARD_ACTION_MCP_TOOL_NAMES_V1 } from '@happier-dev/protocol/sessions/board/actionIds';

import { resolveTranscriptSessionBoardItemReference } from '@/components/sessions/transcript/references/transcriptSessionBoardItemReference';

import {
    presentsApprovalVisualTranscriptOccurrence,
    resolveApprovalVisualTranscriptOccurrence,
} from './approvalVisualTranscriptOccurrence';

const ADDRESS = { serverId: 'home-a', sessionId: 'session-1' } as const;
const REVISION = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const ACTION_ID = 'session.board.item.upsert' as const;
const TOOL_NAME = SESSION_BOARD_ACTION_MCP_TOOL_NAMES_V1[ACTION_ID];

const actionArgs = {
    sessionId: ADDRESS.sessionId,
    itemId: 'visual-1',
    expectedItemRevision: null,
    destination: 'transcript' as const,
    item: {
        v: 1 as const,
        title: 'Release checklist',
        frame: 'frameless' as const,
        height: { mode: 'auto' as const, fallback: 'regular' as const },
        source: {
            kind: 'declarative' as const,
            document: createSessionSurfaceNoteDocumentV1('- ship it'),
        },
    },
};

const appliedResult = {
    v: 1 as const,
    serverId: ADDRESS.serverId,
    sessionId: ADDRESS.sessionId,
    itemDestination: 'transcript' as const,
    destination: null,
    result: {
        operation: 'upsert_item' as const,
        itemId: actionArgs.itemId,
        outcome: 'created' as const,
        itemRevision: REVISION,
    },
};

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
    return ApprovalRequestV2Schema.parse({
        v: 2,
        status: 'open',
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'agent', sessionId: ADDRESS.sessionId },
        requestedSurface: 'agent',
        origin: {
            kind: 'transcript_tool_call',
            sessionId: ADDRESS.sessionId,
            messageId: 'message-1',
            toolCallId: 'tool-1',
            toolName: 'session_board_item_upsert',
            toolInput: actionArgs,
        },
        executionOriginV1: {
            v: 1,
            authority: 'account_automation',
            surface: 'agent',
            caller: { kind: 'session', sessionId: ADDRESS.sessionId, starterDepth: 0, turnDepth: 0 },
            serverId: ADDRESS.serverId,
            sessionId: ADDRESS.sessionId,
            machineId: 'machine-1',
            actionId: ACTION_ID,
            requestId: 'request-1',
        },
        actionId: ACTION_ID,
        actionArgs,
        summary: 'Show Release checklist?',
        ...overrides,
    });
}

describe('resolveApprovalVisualTranscriptOccurrence', () => {
    it('keeps the request pending through approval and replay admission', () => {
        expect(resolveApprovalVisualTranscriptOccurrence({ approval: approval(), address: ADDRESS })).toEqual({ kind: 'pending' });
        expect(resolveApprovalVisualTranscriptOccurrence({
            approval: approval({
                status: 'approved',
                updatedAtMs: 2,
                decision: { kind: 'approve', decidedAtMs: 2 },
            }),
            address: ADDRESS,
        })).toEqual({ kind: 'pending' });
    });

    it('returns the exact same applied reference as the Allowed tool-call occurrence', () => {
        const allowed = resolveTranscriptSessionBoardItemReference({
            toolName: TOOL_NAME,
            state: 'completed',
            input: actionArgs,
            result: appliedResult,
            address: ADDRESS,
        });
        const request = approval({
            status: 'executed',
            updatedAtMs: 3,
            decision: { kind: 'approve', decidedAtMs: 2 },
            execution: { executedAtMs: 3, effectAttempted: true, ok: true, result: appliedResult },
        });

        expect(resolveApprovalVisualTranscriptOccurrence({ approval: request, address: ADDRESS }))
            .toEqual({ kind: 'approved', reference: allowed });
        expect(presentsApprovalVisualTranscriptOccurrence(request)).toBe(true);
    });

    it('distinguishes denied, expired and stale outcomes without a visual reference', () => {
        const denied = approval({
            status: 'rejected',
            updatedAtMs: 2,
            decision: { kind: 'reject', decidedAtMs: 2 },
        });
        const expired = approval({ status: 'canceled', updatedAtMs: 2 });
        const stale = approval({
            status: 'failed',
            updatedAtMs: 3,
            decision: { kind: 'approve', decidedAtMs: 2 },
            execution: {
                executedAtMs: 3,
                effectAttempted: false,
                ok: false,
                errorCode: 'approval_stale',
                error: 'approval_stale',
                details: { reason: 'origin_not_current' },
            },
        });

        expect(resolveApprovalVisualTranscriptOccurrence({ approval: denied, address: ADDRESS })).toEqual({ kind: 'denied' });
        expect(resolveApprovalVisualTranscriptOccurrence({ approval: expired, address: ADDRESS })).toEqual({ kind: 'expired' });
        expect(resolveApprovalVisualTranscriptOccurrence({ approval: stale, address: ADDRESS })).toEqual({
            kind: 'stale',
            reason: 'origin_not_current',
        });
    });
});
