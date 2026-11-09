import { describe, expect, it, vi } from 'vitest';

import { copySessionVisualToSession } from './sessionVisualSessionCopy';

const sourceRevision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const copied = {
    v: 1,
    serverId: 'home-a',
    sessionId: 'session-b',
    result: { operation: 'upsert_item', itemId: 'copy-1', itemRevision: sourceRevision, layoutRevision: sourceRevision, outcome: 'created' },
    destination: { tabId: 'overview', width: 'medium' },
} as const;

/**
 * Copy to another session (V-OP-02): the exact item at its exact revision becomes an independent item
 * in the chosen Session, through the same `session.board.item.upsert` copySource an agent uses.
 */
describe('copySessionVisualToSession', () => {
    it('asks the destination Session for an independent copy of the exact source revision, placed on its Board', async () => {
        const execute = vi.fn(async () => ({ ok: true as const, result: copied }));
        const outcome = await copySessionVisualToSession({
            serverId: 'home-a',
            source: { sessionId: 'session-a', itemId: 'chart', revision: sourceRevision },
            destinationSessionId: 'session-b',
            createItemId: () => 'copy-1',
            execute,
        });
        expect(outcome).toEqual({ status: 'ok', value: copied });
        expect(execute).toHaveBeenCalledWith('session.board.item.upsert', {
            sessionId: 'session-b',
            itemId: 'copy-1',
            expectedItemRevision: null,
            destination: 'board',
            placement: { tabId: 'overview' },
            copySource: { serverId: 'home-a', sessionId: 'session-a', itemId: 'chart', expectedItemRevision: sourceRevision },
        }, { serverId: 'home-a', defaultSessionId: 'session-b', surface: 'ui' });
    });

    it('reports a copy waiting for approval and a changed source without claiming it was copied', async () => {
        const approval = { kind: 'approval_request_created' as const, artifactId: 'approval-copy-1', actionId: 'session.board.item.upsert' };
        const pending = await copySessionVisualToSession({
            serverId: 'home-a', source: { sessionId: 'session-a', itemId: 'chart', revision: sourceRevision },
            destinationSessionId: 'session-b',
            execute: vi.fn(async () => ({ ok: true as const, result: approval })),
        });
        expect(pending).toEqual({ status: 'pending_approval', approval });
        const conflict = await copySessionVisualToSession({
            serverId: 'home-a', source: { sessionId: 'session-a', itemId: 'chart', revision: sourceRevision },
            destinationSessionId: 'session-b',
            execute: vi.fn(async () => ({ ok: false as const, errorCode: 'session_board_revision_conflict', error: 'session_board_revision_conflict',
                details: { currentItemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAg' } })),
        });
        expect(conflict).toMatchObject({ status: 'refused', error: { error: 'session_board_revision_conflict' } });
    });
});
