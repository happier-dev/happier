import { describe, expect, it } from 'vitest';
import { EntityDragScopeV1Schema } from '@happier-dev/protocol/plugins/ui/entityDragDrop';
import { collectSplitCanvasLeaves } from '@/components/appShell/splitCanvas/model/splitCanvasTree';
import { resolveSessionSplitCanvasState, runSessionSplitCanvasCommand } from '@/components/sessions/canvas/sessionSplitCanvasState';
import { areSessionSplitCanvasSnapshotsEqual, createInitialSessionSplitCanvasSnapshot, createSessionSplitCanvasPersistenceSnapshot, readPersistedSessionSplitCanvasSnapshot, SessionSplitCanvasPersistenceSnapshotSchema, shouldPersistSessionSplitCanvasSnapshot, writePersistedSessionSplitCanvasSnapshot } from './sessionSplitCanvasPersistence';

const scope = { serverId: 'home-a', accountId: 'account-a' };
describe('tabbed Session canvas persistence', () => {
    it('reads and writes canonical known fields at every stored level without loosening drag inputs', () => {
        const snapshot = createInitialSessionSplitCanvasSnapshot({ sessionId: 'a', scope });
        const root = snapshot.root;
        if (!root || root.kind !== 'leaf') throw new Error('Expected leaf');
        const tabId = root.payload.group.tabIds[0];
        const tab = root.payload.tabs[tabId];
        const stored = { ...snapshot, savedBy: 'other-client', scope: { ...scope, savedBy: 'other-client' }, root: { ...root, savedBy: 'other-client', payload: { ...root.payload, savedBy: 'other-client', group: { ...root.payload.group, savedBy: 'other-client' }, tabs: { [tabId]: { ...tab, savedBy: 'other-client', scope: { ...scope, savedBy: 'other-client' }, address: { ...tab.address, savedBy: 'other-client' } } } } } };
        const settings = { sessionSplitCanvasLayoutsV1: { 'workspace-a': stored } };
        expect(readPersistedSessionSplitCanvasSnapshot({ settings, scopeKey: 'workspace-a' })).toEqual(snapshot);
        expect(writePersistedSessionSplitCanvasSnapshot({ settings, scopeKey: 'workspace-a', snapshot: stored }).sessionSplitCanvasLayoutsV1['workspace-a']).toEqual(snapshot);
        const second = createInitialSessionSplitCanvasSnapshot({ sessionId: 'b', scope }).root;
        const split = { id: 'split', kind: 'split' as const, axis: 'row' as const, ratio: 0.5, first: root, second: second! };
        expect(SessionSplitCanvasPersistenceSnapshotSchema.parse({ ...stored, root: { ...split, savedBy: 'other-client', first: stored.root } })).toEqual({ ...snapshot, root: split });
        expect(SessionSplitCanvasPersistenceSnapshotSchema.safeParse({ ...stored, focusedLeafId: undefined }).success).toBe(false);
        expect(SessionSplitCanvasPersistenceSnapshotSchema.safeParse({ ...stored, root: { ...stored.root, payload: { ...stored.root.payload, group: { ...stored.root.payload.group, activeTabId: undefined } } } }).success).toBe(false);
        expect(EntityDragScopeV1Schema.safeParse(stored.scope).success).toBe(false);
    });
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
