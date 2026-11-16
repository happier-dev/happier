import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { ActionsSettingsV1Schema} from '@happier-dev/protocol/actions/actionSettings';

import { SessionBoardLayoutV1Schema, SessionBoardMutationV1Schema, type SessionBoardLayoutV1 } from '@happier-dev/protocol/sessions/board';
import { SessionSystemRecordStoredReadResponseSchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';

import { createActionExecutorBoundaryFixture, renderHook } from '@/dev/testkit';
import { createSessionBoardActionAdapter, prepareSessionBoardItemForUi } from '@/sync/api/session/sessionBoardActions';
import { createSessionBoardActionsPort, projectSessionBoard } from '@/sync/domains/session/board';
import { createSessionSystemRecordRepository } from '@/sync/domains/sessionSystemRecords/repository';
import { useSessionBoardController } from './useSessionBoardController';

const session = { serverId: 'home-a', sessionId: 'session-one' };
const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const nextRevision = 'ssr1.AAAACHN5c3JlY18xAAAAAg';
const originalLayout: SessionBoardLayoutV1 = {
    v: 1,
    tabs: [
        { id: 'first', title: 'First', items: [{ itemId: 'missing', width: 'medium' }, { itemId: 'sibling-a', width: 'wide' }] },
        { id: 'selected', title: 'Selected', items: [{ itemId: 'sibling-b', width: 'compact' }, { itemId: 'missing', width: 'full' }] },
    ],
};

describe('missing-reference recovery through the real Board Actions', () => {
    it('pins a recovered transcript item onto an empty Board with a layout-only mutation', async () => {
        let storedLayout: SessionBoardLayoutV1 = { v: 1, tabs: [] };
        const item = { v: 1 as const, destination: 'transcript' as const, title: 'Recovered note', frame: 'card' as const,
            height: { mode: 'auto' as const, fallback: 'regular' as const },
            source: { kind: 'declarative' as const, document: { version: 1 as const, root: { kind: 'markdown' as const, text: 'Original content' } } } };
        const mutations: unknown[] = [];
        const requests: string[] = [];
        let actionResult: Awaited<ReturnType<ReturnType<typeof createActionExecutor>['execute']>> | undefined;
        const itemRecord = SessionSystemRecordStoredReadResponseSchema.parse({ record: {
            id: 'item-row', address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'visual' },
            content: { t: 'plain', v: item }, revision,
            createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
        } });
        const request: Parameters<typeof createSessionBoardActionAdapter>[0]['request'] = async (path, init) => {
            requests.push(path);
            if (init?.method !== 'PUT') {
                const isItem = path.includes('item.v1');
                if (isItem) return new Response(JSON.stringify(itemRecord));
                return new Response(JSON.stringify({ record: {
                    id: 'layout-row',
                    address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' },
                    content: { t: 'plain', v: storedLayout }, revision,
                    createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
                } }));
            }
            const mutation = SessionBoardMutationV1Schema.parse(JSON.parse(String(init.body)));
            mutations.push(mutation);
            expect(mutation.operation).toBe('update_layout');
            if (mutation.operation !== 'update_layout' || mutation.layoutContent.t !== 'plain') throw new Error('unexpected mutation');
            storedLayout = SessionBoardLayoutV1Schema.parse(mutation.layoutContent.v);
            return new Response(JSON.stringify({ operation: 'update_layout', outcome: 'updated', layoutRevision: nextRevision }));
        };
        const scope = { serverId: session.serverId, accountId: 'alice' };
        const adapter = createSessionBoardActionAdapter({ scope, session, request,
            repository: createSessionSystemRecordRepository({ scope, request }), contentContext: { mode: 'plain' },
            capabilities: { readTranscript: true, editSessionRecords: true }, boardEnabled: true,
        });
        // HTTP is the only substituted system boundary; the mounted controller,
        // approval/executor, semantic layout owner and sealing adapter are real.
        const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
            'session.board.layout.update': ['ui'], 'session.board.item.upsert': ['ui'],
        } });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ sessionBoardAction: adapter, sessionBoardPrepareItem: prepareSessionBoardItemForUi,
            readActionsSettings: () => settings,
        }));
        const actions = createSessionBoardActionsPort({ ...session,
            execute: async (actionId, input, context) => {
                actionResult = await executor.execute(actionId, input, { ...context, authority: 'present_user' });
                return actionResult;
            },
        });
        const snapshot = projectSessionBoard({
            layout: { revision, outcome: { status: 'ready', value: storedLayout } },
            items: new Map([['visual', { revision, outcome: { status: 'ready', value: item } }]]),
            capabilities: { readTranscript: true, editSessionRecords: true }, freshness: 'fresh',
            reachability: 'reachable', loading: 'idle', incomplete: false,
        });
        const hook = await renderHook(() => useSessionBoardController({ ...session, binding: { status: 'ready', snapshot }, actions }));
        await act(async () => { await hook.getCurrent().run({ kind: 'item.pin', itemId: 'visual' }); });
        expect(mutations, JSON.stringify({ actionResult, requests })).toEqual([expect.objectContaining({ operation: 'update_layout', expectedLayoutRevision: revision,
            itemPlacementParticipant: { itemId: 'visual', expectedItemRevision: revision } })]);
        expect(storedLayout.tabs).toEqual([{ id: 'overview', title: expect.any(String), items: [{ itemId: 'visual', width: 'medium' }] }]);
        expect(hook.getCurrent().lastOutcome?.kind).toBe('applied');
    });

    it.each([false, true])('removes all placements atomically or retains all on CAS conflict (conflict=%s)', async (conflict) => {
        let storedLayout = originalLayout;
        let storedRevision = revision;
        let writes = 0;
        const request: Parameters<typeof createSessionBoardActionAdapter>[0]['request'] = async (_path, init) => {
            if (init?.method !== 'PUT') return new Response(JSON.stringify({ record: {
                id: 'layout-row', address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' },
                content: { t: 'plain', v: storedLayout }, revision: storedRevision,
                createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z',
            } }));
            writes += 1;
            const mutation = SessionBoardMutationV1Schema.parse(JSON.parse(String(init.body)));
            if (mutation.operation !== 'update_layout') throw new Error('unexpected mutation');
            expect(mutation.expectedLayoutRevision).toBe(revision);
            if (conflict) return new Response(JSON.stringify({
                error: 'session_board_revision_conflict', currentLayoutRevision: nextRevision,
            }), { status: 409 });
            if (mutation.layoutContent.t !== 'plain') throw new Error('unexpected mutation');
            storedLayout = SessionBoardLayoutV1Schema.parse(mutation.layoutContent.v);
            storedRevision = nextRevision;
            return new Response(JSON.stringify({ operation: 'update_layout', outcome: 'updated', layoutRevision: nextRevision }));
        };
        const scope = { serverId: session.serverId, accountId: 'alice' };
        const adapter = createSessionBoardActionAdapter({
            scope, session, request, repository: createSessionSystemRecordRepository({ scope, request }),
            contentContext: { mode: 'plain' }, capabilities: { readTranscript: true, editSessionRecords: true }, boardEnabled: true,
        });
        // Only the Home HTTP boundary is substituted; controller, executor, reducer and codec are real.
        // Direct recovery uses the user's explicit waiver; shared Board writes
        // otherwise require approval even on the UI surface.
        const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
            'session.board.layout.update': ['ui'],
        } });
        const executorDeps = {
            sessionBoardAction: adapter,
            readActionsSettings: () => settings,
        } satisfies Pick<ActionExecutorDeps, 'sessionBoardAction' | 'readActionsSettings'>;
        const executor = createActionExecutor(createActionExecutorBoundaryFixture(executorDeps));
        let actionResult: Awaited<ReturnType<typeof executor.execute>> | undefined;
        const actions = createSessionBoardActionsPort({ ...session,
            execute: async (actionId, input, context) => {
                const result = await executor.execute(actionId, input, { ...context, authority: 'present_user' });
                actionResult = result;
                return result;
            },
        });
        const snapshot = projectSessionBoard({
            layout: { revision, outcome: { status: 'ready', value: originalLayout } }, items: new Map(),
            capabilities: { readTranscript: true, editSessionRecords: true }, freshness: 'fresh',
            reachability: 'reachable', loading: 'idle', incomplete: false,
        });
        const hook = await renderHook(() => useSessionBoardController({
            ...session, binding: { status: 'ready', snapshot }, actions,
        }));
        await act(async () => { await hook.getCurrent().run({ kind: 'view.select', viewId: 'selected' }); });
        await hook.rerender();
        expect(hook.getCurrent().activeViewId).toBe('selected');
        await act(async () => { await hook.getCurrent().run({ kind: 'item.remove', itemId: 'missing' }); });
        await hook.rerender();

        expect(actionResult, JSON.stringify(actionResult)).toMatchObject(conflict
            ? { ok: false, errorCode: 'session_board_revision_conflict' }
            : { ok: true });
        expect(writes).toBe(1);
        expect(storedLayout).toEqual(conflict ? originalLayout : {
            v: 1,
            tabs: [
                { id: 'first', title: 'First', items: [{ itemId: 'sibling-a', width: 'wide' }] },
                { id: 'selected', title: 'Selected', items: [{ itemId: 'sibling-b', width: 'compact' }] },
            ],
        });
        expect(hook.getCurrent().lastOutcome?.kind).toBe(conflict ? 'conflict' : 'applied');
    });
});
