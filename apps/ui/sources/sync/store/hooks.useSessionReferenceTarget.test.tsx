import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import { useSessionReferenceTarget } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import { projectComposerSessionSuggestionItems } from '@/sync/domains/input/suggestionSession';

afterEach(() => {
    standardCleanup();
});

const SERVER_ID = 'server-a';

function renderable(
    id: string,
    overrides: Partial<SessionListRenderableSession> = {},
): SessionListRenderableSession {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1_000,
        active: false,
        activeAt: 1,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: { name: `Session ${id}`, path: '/Users/dev/projects/app' },
        thinking: false,
        thinkingAt: 0,
        presence: 1,
        ...overrides,
    };
}

/**
 * The store shape the running app produces: the session-list snapshot writes a renderable for
 * EVERY row it fetched, while `sessions` holds only the handful of full records the hydration
 * planner admitted (`syncTuning.ts` ships `sessionListEagerHydrationCount: 4` and
 * `sessionListBackgroundHydrationMaxRows: 0`, so every remaining row is `skippedBackground` and
 * is never hydrated at all).
 *
 * `sessionListViewDataByServerId` is derived from the renderables, exactly as
 * `buildSessionListViewDataWithServerScope` derives it in production — which is why the picker
 * and the transcript chip must not be allowed to disagree.
 */
function installSessionListState(renderables: readonly SessionListRenderableSession[]): void {
    storage.setState((state) => ({
        ...state,
        sessions: {},
        sessionListRenderables: Object.fromEntries(renderables.map((entry) => [entry.id, entry])),
        sessionListViewDataByServerId: {
            [SERVER_ID]: renderables.map((session) => (
                { type: 'session', session } as unknown as SessionListViewItem
            )),
        },
    }));
}

describe('useSessionReferenceTarget', () => {
    it('reports a session the @session picker offers as present, even though it was never hydrated', async () => {
        const previousState = storage.getState();
        try {
            const current = renderable('current');
            const referenced = renderable('referenced', {
                metadata: { name: 'L16b QA target session', path: '/Users/dev/projects/app' },
            });
            installSessionListState([current, referenced]);

            // Owner A — the composer picker — offers it.
            const offered = projectComposerSessionSuggestionItems(
                storage.getState(),
                { serverId: null, currentSessionId: current.id },
            );
            expect(offered.map((item) => item.id)).toEqual([referenced.id]);

            // Owner B — the transcript reference chip — must agree at the same instant.
            const hook = await renderHook(() => useSessionReferenceTarget(referenced.id), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(storage.getState().sessions[referenced.id]).toBeUndefined();
            expect(hook.getCurrent().present).toBe(true);
            expect(hook.getCurrent().metadata).toBe(referenced.metadata);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('reports a session this viewer no longer has as absent', async () => {
        const previousState = storage.getState();
        try {
            installSessionListState([renderable('current')]);

            const hook = await renderHook(() => useSessionReferenceTarget('deleted-session'), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toEqual({ present: false, metadata: null });

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not re-render when session-list churn leaves the reference projection unchanged', async () => {
        const previousState = storage.getState();
        try {
            const referenced = renderable('referenced');
            installSessionListState([referenced]);

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSessionReferenceTarget(referenced.id);
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const initialRenderCount = renderCount;
            expect(hook.getCurrent().present).toBe(true);

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessionListRenderables: {
                        ...state.sessionListRenderables,
                        [referenced.id]: {
                            ...state.sessionListRenderables[referenced.id]!,
                            seq: 99,
                            thinking: true,
                            hasUnreadMessages: true,
                            updatedAt: 2_000,
                        },
                    },
                }));
                await flushHookEffects({ cycles: 1, turns: 4 });
            });

            expect(hook.getCurrent().metadata).toBe(referenced.metadata);
            expect(renderCount).toBe(initialRenderCount);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
