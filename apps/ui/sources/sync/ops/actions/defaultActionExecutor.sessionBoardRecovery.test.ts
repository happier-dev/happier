import { describe, expect, it } from 'vitest';

import { SessionBoardActionFailureV1Schema, createSessionBoardOutcomeUnknownFailureV1 } from '@happier-dev/protocol/sessions/board';

import { projectRetiredSessionBoardActionFailure } from './defaultActionExecutor';

const intent = {
    sessionId: 'session-one',
    itemId: 'release-checklist',
    expectedItemRevision: null,
    item: {
        v: 1,
        title: 'Release checklist',
        frame: 'card',
        height: { mode: 'auto', fallback: 'regular' },
        source: {
            kind: 'declarative',
            document: { version: 1, root: { kind: 'markdown', text: 'Ready' } },
        },
    },
    placement: { tabId: 'overview', tabTitle: 'Overview' },
} as const;

const requestBody = JSON.stringify({
    operation: 'upsert_item',
    itemId: intent.itemId,
    expectedItemRevision: null,
    itemContent: { t: 'plain', v: intent.item },
    placement: {
        expectedLayoutRevision: null,
        layoutContent: {
            t: 'plain',
            v: {
                v: 1,
                tabs: [{
                    id: 'overview',
                    title: 'Overview',
                    items: [{ itemId: intent.itemId, width: 'medium' }],
                }],
            },
        },
    },
});

describe('retired Session Board Action result projection', () => {
    const issued = createSessionBoardOutcomeUnknownFailureV1({
        actionId: 'session.board.item.upsert',
        serverId: 'home-a',
        sessionId: 'session-one',
        requestBody,
        mutationRequest: JSON.parse(requestBody),
        intent,
    });

    it('keeps a pre-dispatch retirement definite and carries no recovery packet', () => {
        expect(projectRetiredSessionBoardActionFailure({
            actionId: 'session.board.item.upsert',
            mutationDispatched: false,
            retirementStatus: 'forbidden',
            recoveryDetails: issued.details,
        })).toEqual({ ok: false, errorCode: 'forbidden', error: 'forbidden' });
        expect(projectRetiredSessionBoardActionFailure({
            actionId: 'session.board.item.upsert',
            mutationDispatched: false,
            retirementStatus: 'feature_disabled',
            recoveryDetails: null,
        })).toEqual({ ok: false, errorCode: 'feature_disabled', error: 'feature_disabled',
            details: { operation: 'session.board.item.upsert' } });
        expect(projectRetiredSessionBoardActionFailure({
            actionId: 'session.board.item.upsert',
            mutationDispatched: false,
            retirementStatus: 'session_board_storage_mode_mismatch',
            recoveryDetails: null,
        })).toEqual({ ok: false, errorCode: 'session_board_storage_mode_mismatch', error: 'session_board_storage_mode_mismatch' });
    });

    it('returns only the strict originating recovery packet when scope retires after dispatch', () => {
        expect(projectRetiredSessionBoardActionFailure({
            actionId: 'session.board.item.upsert',
            mutationDispatched: true,
            retirementStatus: 'forbidden',
            recoveryDetails: issued.details,
        })).toEqual(issued);
    });

    it('stays definite when a dispatch was observed without the frozen request', () => {
        expect(projectRetiredSessionBoardActionFailure({
            actionId: 'session.board.item.upsert',
            mutationDispatched: true,
            retirementStatus: 'forbidden',
            recoveryDetails: null,
        })).toEqual({ ok: false, errorCode: 'forbidden', error: 'forbidden' });
    });

    it('never answers a retirement with a failure the strict Board union cannot parse', () => {
        for (const projected of [
            projectRetiredSessionBoardActionFailure({ actionId: 'session.board.item.upsert', mutationDispatched: false, retirementStatus: 'offline', recoveryDetails: null }),
            projectRetiredSessionBoardActionFailure({ actionId: 'session.board.item.upsert', mutationDispatched: true, retirementStatus: 'offline', recoveryDetails: null }),
            projectRetiredSessionBoardActionFailure({ actionId: 'session.board.item.upsert', mutationDispatched: true, retirementStatus: 'offline', recoveryDetails: issued.details }),
        ]) {
            expect(SessionBoardActionFailureV1Schema.safeParse(projected).success).toBe(true);
        }
    });
});
