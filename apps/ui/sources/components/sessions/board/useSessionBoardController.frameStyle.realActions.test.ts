import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { SessionBoardLayoutV1Schema, SessionBoardMutationV1Schema, type SessionBoardLayoutV1 } from '@happier-dev/protocol/sessions/board';

import { renderHook } from '@/dev/testkit';
import { createSessionBoardActionAdapter } from '@/sync/api/session/sessionBoardActions';
import { createSessionBoardActionsPort, projectSessionBoard } from '@/sync/domains/session/board';
import { createSessionSystemRecordRepository } from '@/sync/domains/sessionSystemRecords/repository';
import { useSessionBoardController } from './useSessionBoardController';

const session = { serverId: 'home-a', sessionId: 'session-one' };
const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const nextRevision = 'ssr1.AAAACHN5c3JlY18xAAAAAg';

describe('Board frame styles through the real Board Actions', () => {
    it.each(['plain', 'card', null] as const)('persists the selected placement override (%s) through shared editor admission', async (frameStyle) => {
        const original: SessionBoardLayoutV1 = { v: 1, tabs: [
            { id: 'first', title: 'First', items: [{ itemId: 'note', width: 'wide', frameStyle: 'plain' }] },
            { id: 'selected', title: 'Selected', items: [{ itemId: 'note', width: 'medium', frameStyle: 'card' }] },
        ] };
        let stored = original;
        let storedRevision = revision;
        let writes = 0;
        const scope = { serverId: session.serverId, accountId: 'alice' };
        // Only the Home HTTP boundary is substituted; all Board logic beneath it is real.
        const request: Parameters<typeof createSessionBoardActionAdapter>[0]['request'] = async (_path, init) => {
            if (init?.method !== 'PUT') return new Response(JSON.stringify({ record: {
                id: 'layout-row', address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' },
                content: { t: 'plain', v: stored }, revision: storedRevision,
                createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
            } }));
            const mutation = SessionBoardMutationV1Schema.parse(JSON.parse(String(init.body)));
            writes += 1;
            if (mutation.operation !== 'update_layout' || mutation.layoutContent.t !== 'plain') throw new Error('unexpected mutation');
            expect(mutation.expectedLayoutRevision).toBe(storedRevision);
            stored = SessionBoardLayoutV1Schema.parse(mutation.layoutContent.v);
            storedRevision = nextRevision;
            if (frameStyle === 'plain' && writes === 1) return new Response('{}');
            return new Response(JSON.stringify({ operation: 'update_layout', outcome: 'updated', layoutRevision: nextRevision }));
        };
        const adapter = createSessionBoardActionAdapter({ scope, session, request,
            repository: createSessionSystemRecordRepository({ scope, request }), contentContext: { mode: 'plain' },
            boardEnabled: true,
            capabilities: { readTranscript: true, editSessionRecords: true },
        });
        // Unrelated host delivery ports are genuine boundaries; fail if this Board journey reaches one.
        const unexpectedHostPort = async (): Promise<never> => { throw new Error('Unexpected host port in Board journey'); };
        const deps: ActionExecutorDeps = {
            sessionBoardAction: adapter,
            executionRunStart: unexpectedHostPort, executionRunList: unexpectedHostPort,
            executionRunGet: unexpectedHostPort, detachedExecutionRunSend: unexpectedHostPort,
            executionRunStop: unexpectedHostPort, executionRunAction: unexpectedHostPort, executionRunWait: unexpectedHostPort,
            sessionOpen: unexpectedHostPort, sessionFork: unexpectedHostPort, sessionRollback: unexpectedHostPort,
            sessionSpawnNew: unexpectedHostPort, pathsListRecent: unexpectedHostPort, machinesList: unexpectedHostPort,
            serversList: unexpectedHostPort, reviewEnginesList: unexpectedHostPort, agentsBackendsList: unexpectedHostPort,
            agentsModelsList: unexpectedHostPort, sessionSendMessage: unexpectedHostPort,
            sessionPermissionRespond: unexpectedHostPort, sessionUserActionAnswer: unexpectedHostPort,
            sessionModeSet: unexpectedHostPort, sessionModesList: unexpectedHostPort,
            sessionTargetPrimarySet: unexpectedHostPort, sessionTargetTrackedSet: unexpectedHostPort,
            sessionList: unexpectedHostPort, sessionActivityGet: unexpectedHostPort,
            sessionRecentMessagesGet: unexpectedHostPort, resetGlobalVoiceAgent: unexpectedHostPort,
            daemonMemorySearch: unexpectedHostPort, daemonMemoryGetWindow: unexpectedHostPort,
            daemonMemoryEnsureUpToDate: unexpectedHostPort,
        };
        const executor = createActionExecutor(deps);
        const actions = createSessionBoardActionsPort({ ...session,
            execute: (actionId, input, context) => executor.execute(actionId, input, { ...context, authority: 'present_user' }),
        });
        let snapshot = projectSessionBoard({ layout: { revision, outcome: { status: 'ready', value: original } },
            items: new Map(), capabilities: { readTranscript: true, editSessionRecords: true },
            freshness: 'fresh', reachability: 'reachable', loading: 'idle', incomplete: false,
        });
        const hook = await renderHook(() => useSessionBoardController({ ...session, binding: { status: 'ready', snapshot }, actions }));
        await act(async () => { await hook.getCurrent().run({ kind: 'view.select', viewId: 'selected' }); });
        await hook.rerender();
        expect(hook.getCurrent().supports('item.frameStyle')).toBe(true);
        await act(async () => { await hook.getCurrent().run({ kind: 'item.frameStyle', itemId: 'note', frameStyle }); });
        await hook.rerender();
        expect(stored.tabs[0]).toEqual(original.tabs[0]);
        expect(stored.tabs[1]?.items[0]).toEqual({ itemId: 'note', width: 'medium',
            ...(frameStyle === null ? {} : { frameStyle }),
        });
        if (frameStyle === 'plain') {
            expect(hook.getCurrent().lastOutcome?.kind).toBe('outcomeUnknown');
            snapshot = { ...snapshot, freshness: 'stale', loading: 'refreshing' };
            await hook.rerender();
            snapshot = projectSessionBoard({ layout: { revision: nextRevision, outcome: { status: 'ready', value: stored } },
                items: new Map(), capabilities: snapshot.capabilities, freshness: 'fresh', reachability: 'reachable',
                loading: 'idle', incomplete: false,
            });
            await hook.rerender();
        }
        expect(hook.getCurrent().lastOutcome?.kind).toBe('applied');

        const agentResult = await executor.execute('session.board.layout.update', {
            sessionId: session.sessionId, expectedLayoutRevision: nextRevision,
            operation: { op: 'item.frameStyle', tabId: 'selected', itemId: 'note', frameStyle: 'plain' },
        }, { surface: 'agent', authority: 'account_automation', serverId: session.serverId, defaultSessionId: session.sessionId });
        expect(agentResult).toMatchObject({ ok: true });

        const readOnlySnapshot = { ...snapshot, capabilities: { readTranscript: true, editSessionRecords: false }, canEdit: false };
        const readOnlyHook = await renderHook(() => useSessionBoardController({ ...session,
            binding: { status: 'ready', snapshot: readOnlySnapshot }, actions,
        }));
        expect(readOnlyHook.getCurrent().supports('item.frameStyle')).toBe(false);
        await act(async () => { await readOnlyHook.getCurrent().run({ kind: 'item.frameStyle', itemId: 'note', frameStyle }); });
        expect(writes).toBe(2);

        const readOnlyAdapter = createSessionBoardActionAdapter({ scope, session, request,
            repository: createSessionSystemRecordRepository({ scope, request }), contentContext: { mode: 'plain' },
            capabilities: { readTranscript: true, editSessionRecords: false },
        });
        await expect(readOnlyAdapter({ actionId: 'session.board.layout.update', context: {}, input: {
            sessionId: session.sessionId, expectedLayoutRevision: revision,
            operation: { op: 'item.frameStyle', tabId: 'selected', itemId: 'note', frameStyle },
        } })).resolves.toMatchObject({ errorCode: 'session_board_forbidden' });
    });
});
