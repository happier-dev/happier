import { describe, expect, it, vi } from 'vitest';

vi.mock('./buildSessionListViewDataWithServerScope', () => ({
    buildSessionListViewDataWithServerScope: vi.fn(() => [{ type: 'session', session: { id: 'rebuilt' } }]),
}));

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import type { ActiveServerSessionListStateLike } from './resolveActiveServerSessionListState';
import { buildSessionListViewDataWithServerScope } from './buildSessionListViewDataWithServerScope';
import { resolveActiveServerSessionListState } from './resolveActiveServerSessionListState';

function createBaseState(): ActiveServerSessionListStateLike {
    const activeRenderable = {
        id: 'existing-active',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        archivedAt: null,
        pendingVersion: 0,
        pendingCount: 0,
        metadataVersion: 1,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
        thinkingGraceUntil: null,
    } satisfies SessionListRenderableSession;

    return {
        sessions: {},
        sessionListRenderables: {},
        sessionListViewData: [{ type: 'session', session: { id: 'existing' } }] as SessionListViewItem[],
        machines: {},
        machineDisplayById: {},
        settings: {
            groupInactiveSessionsByProject: false,
            sessionListActiveGroupingV1: 'project',
            sessionListInactiveGroupingV1: 'date',
        },
        getProjectForSession: undefined,
    };
}

describe('resolveActiveServerSessionListState', () => {
    it('preserves the current view data and leaves the server-scoped cache untouched when no rebuild is needed', () => {
        const state = createBaseState();

        const next = resolveActiveServerSessionListState({
            state,
            shouldRebuild: false,
        });

        expect(next.sessionListViewData).toBe(state.sessionListViewData);
    });

    it('rebuilds the active session list view data without rewriting the server-scoped cache', () => {
        const state = createBaseState();

        const next = resolveActiveServerSessionListState({
            state,
            shouldRebuild: true,
        });

        expect(next.sessionListViewData).toEqual([{ type: 'session', session: { id: 'rebuilt' } }]);
    });

    it('preserves the existing view data reference when a rebuild is semantically unchanged', () => {
        const state = createBaseState();
        const rebuiltViewData = [{ type: 'session', session: { id: 'existing' } }] as SessionListViewItem[];

        vi.mocked(buildSessionListViewDataWithServerScope).mockReturnValueOnce(rebuiltViewData);

        const next = resolveActiveServerSessionListState({
            state,
            shouldRebuild: true,
        });

        expect(next.sessionListViewData).toBe(state.sessionListViewData);
    });
});
