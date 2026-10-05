import { describe, expect, it } from 'vitest';
import { collectSplitCanvasLeaves } from '@/components/appShell/splitCanvas/model/splitCanvasTree';
import { resolveSessionSplitCanvasState, runSessionSplitCanvasCommand } from '@/components/sessions/canvas/sessionSplitCanvasState';
import { areSessionSplitCanvasSnapshotsEqual, createInitialSessionSplitCanvasSnapshot, createSessionSplitCanvasPersistenceSnapshot, readPersistedSessionSplitCanvasSnapshot, SessionSplitCanvasPersistenceSnapshotSchema, shouldPersistSessionSplitCanvasSnapshot, writePersistedSessionSplitCanvasSnapshot } from './sessionSplitCanvasPersistence';

const scope = { serverId: 'home-a', accountId: 'account-a' };
describe('tabbed Session canvas persistence', () => {
    it('round trips ordered qualified members, active tab and focus without persisting a pane count cap', () => {
        let state = resolveSessionSplitCanvasState({ sessionId: 'a', scope });
        state = runSessionSplitCanvasCommand(state, { type: 'openSession', sessionId: 'b', leafId: state.focusedLeafId! });
        const snapshot = createSessionSplitCanvasPersistenceSnapshot(state);
        expect('maxLeaves' in snapshot).toBe(false);
        const settings = writePersistedSessionSplitCanvasSnapshot({ settings: { sessionSplitCanvasLayoutsV1: {} }, scopeKey: 'workspace-a', snapshot });
        const read = readPersistedSessionSplitCanvasSnapshot({ settings, scopeKey: 'workspace-a' });
        expect(read).toEqual(snapshot);
        expect(collectSplitCanvasLeaves(read!.root)[0].payload.group.tabIds).toHaveLength(2);
        expect(shouldPersistSessionSplitCanvasSnapshot({ persisted: snapshot, snapshot, routeSessionId: 'a' })).toBe(false);
        expect(shouldPersistSessionSplitCanvasSnapshot({ persisted: null, snapshot, routeSessionId: 'a' })).toBe(true);
        expect(areSessionSplitCanvasSnapshotsEqual({ ...snapshot }, snapshot)).toBe(true);
    });

    it('does not write a route-only initial mount and rejects the retired single-session shape and invalid membership', () => {
        const snapshot = createInitialSessionSplitCanvasSnapshot({ sessionId: 'a', scope });
        expect(shouldPersistSessionSplitCanvasSnapshot({ persisted: null, snapshot, routeSessionId: 'a' })).toBe(false);
        expect(SessionSplitCanvasPersistenceSnapshotSchema.safeParse({ version: 1, root: { id: 'old', kind: 'leaf', leafKind: 'session', payload: { sessionId: 'a' } }, focusedLeafId: 'old', maximizedLeafId: null, maxLeaves: 8 }).success).toBe(false);
        const root = snapshot.root!;
        if (root.kind !== 'leaf') throw new Error('Expected leaf');
        expect(SessionSplitCanvasPersistenceSnapshotSchema.safeParse({ ...snapshot, root: { ...root, payload: { ...root.payload, group: { ...root.payload.group, tabIds: ['missing'] } } } }).success).toBe(false);
        expect(SessionSplitCanvasPersistenceSnapshotSchema.safeParse({ ...snapshot, root: { id: 'split', kind: 'split', axis: 'row', ratio: 0.5, first: root, second: { ...root, id: 'other' } } }).success).toBe(false);
    });
});
