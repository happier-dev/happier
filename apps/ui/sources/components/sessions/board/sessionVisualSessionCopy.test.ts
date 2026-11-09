import { describe, expect, it, vi } from 'vitest';

import { copySessionVisualToSession } from './sessionVisualSessionCopy';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createSessionBoardActionAdapter } from '@/sync/api/session/sessionBoardActions';
import { createSessionSystemRecordRepository } from '@/sync/domains/sessionSystemRecords/repository';

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
    it('copies through native confirmation and creates the first Board view in an empty destination', async () => {
        const sourceItem = { v: 1, destination: 'board', title: 'QA visual', frame: 'frameless',
            height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'declarative',
                document: { version: 1, root: { kind: 'markdown', text: '# REVISION ONE' } } } } as const;
        const writes: unknown[] = [];
        const scope = { serverId: 'home-a', accountId: 'alice' };
        // HTTP records and the native confirmation are the only substituted boundaries.
        const request = async (path: string, init?: RequestInit) => {
            if (init?.method === 'PUT') {
                const mutation = JSON.parse(String(init.body));
                writes.push(mutation);
                return new Response(JSON.stringify({ operation: 'upsert_item', itemId: 'copy-1',
                    outcome: 'created', itemRevision: sourceRevision, layoutRevision: sourceRevision }));
            }
            const sourceRead = path.includes('/session-a/') && path.includes('item.v1');
            return new Response(JSON.stringify({ record: sourceRead ? { id: 'source-row', address: {
                owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'chart' }, revision: sourceRevision,
                content: { t: 'plain', v: sourceItem }, createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
            } : null }));
        };
        const repository = createSessionSystemRecordRepository({ scope, request });
        const executor = createActionExecutor({
            presentUserActionConfirmation: async () => true,
            sessionBoardAction: args => createSessionBoardActionAdapter({ scope, request, repository,
                session: { serverId: scope.serverId, sessionId: args.input.sessionId! }, contentContext: { mode: 'plain' },
                boardEnabled: true, capabilities: { readTranscript: true, editSessionRecords: args.input.sessionId === 'session-b' },
            })(args),
        });
        const outcome = await copySessionVisualToSession({ serverId: scope.serverId,
            source: { sessionId: 'session-a', itemId: 'chart', revision: sourceRevision },
            destinationSessionId: 'session-b', createItemId: () => 'copy-1',
            execute: (actionId, input, context) => executor.execute(actionId, input, { ...context, authority: 'present_user' }),
        });
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'ok', value: { sessionId: 'session-b', result: { itemId: 'copy-1' } } });
        expect(writes).toEqual([expect.objectContaining({ itemContent: { t: 'plain', v: sourceItem },
            placement: { expectedLayoutRevision: null, layoutContent: { t: 'plain', v: { v: 1,
                tabs: [{ id: 'overview', title: expect.any(String), items: [{ itemId: 'copy-1', width: 'medium' }] }] } } },
        })]);
    });
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
            placement: { tabId: 'overview', tabTitle: expect.any(String) },
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
