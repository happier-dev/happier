import { describe, expect, it } from 'vitest';

import { createSplitCanvasPersistenceSnapshot } from '@/components/appShell/splitCanvas/model/splitCanvasPersistence';
import { createSplitCanvasState, splitCanvasReduce } from '@/components/appShell/splitCanvas/model/splitCanvasReducer';
import type { SplitCanvasLeafNode } from '@/components/appShell/splitCanvas/model/splitCanvasTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import {
    areSessionSplitCanvasSnapshotsEqual,
    createInitialSessionSplitCanvasSnapshot,
    readPersistedSessionSplitCanvasSnapshot,
    shouldPersistSessionSplitCanvasSnapshot,
    writePersistedSessionSplitCanvasSnapshot,
} from './sessionSplitCanvasPersistence';

function createLeaf(id: string, sessionId: string): SplitCanvasLeafNode<{ sessionId: string }> {
    return {
        id,
        kind: 'leaf',
        leafKind: 'session',
        payload: { sessionId },
    };
}

function createTwoSessionSplitState(input: Readonly<{
    firstSessionId: string;
    secondSessionId: string;
}>) {
    const firstLeaf = createLeaf(`session-leaf:${input.firstSessionId}`, input.firstSessionId);
    const secondLeaf = createLeaf(`session-leaf:${input.secondSessionId}`, input.secondSessionId);
    return splitCanvasReduce(createSplitCanvasState({
        root: firstLeaf,
        maxLeaves: 8,
    }), {
        type: 'splitLeaf',
        targetLeafId: firstLeaf.id,
        axis: 'row',
        placement: 'after',
        newLeaf: secondLeaf,
    });
}

function createSettings(overrides?: Partial<Settings>): Settings {
    return {
        schemaVersion: 6,
        recentMachinePaths: [],
        favoriteDirectories: [],
        favoriteMachines: [],
        favoriteProfiles: [],
        pinnedSessionKeysV1: [],
        workspaceRefsV1: [],
        pinnedWorkspaceRefIdsV1: [],
        workspaceLabelsV1: {},
        collapsedGroupKeysV1: {},
        sessionTagsV1: {},
        sessionListGroupOrderV1: {},
        dismissedCLIWarnings: { perMachine: {}, global: {} },
        ...(overrides ?? {}),
    } as Settings;
}

describe('sessionSplitCanvasPersistence', () => {
    it('creates a single-leaf snapshot for the anchor session', () => {
        expect(createInitialSessionSplitCanvasSnapshot({
            sessionId: 'sess_1',
            maxLeaves: 8,
        })).toEqual({
            version: 1,
            focusedLeafId: 'session-leaf:sess_1',
            maximizedLeafId: null,
            maxLeaves: 8,
            root: {
                id: 'session-leaf:sess_1',
                kind: 'leaf',
                leafKind: 'session',
                payload: {
                    sessionId: 'sess_1',
                },
            },
        });
    });

    it('writes a workspace-keyed patch for the synced account settings blob', () => {
        const snapshot = createSplitCanvasPersistenceSnapshot(createSplitCanvasState({
            root: createLeaf('session-leaf:sess_1', 'sess_1'),
            maxLeaves: 4,
        }));

        expect(writePersistedSessionSplitCanvasSnapshot({
            settings: createSettings(),
            scopeKey: 'server-a:machine-1:/repo',
            snapshot,
        })).toEqual({
            sessionSplitCanvasLayoutsV1: {
                'server-a:machine-1:/repo': snapshot,
            },
        });
    });

    it('reads the persisted snapshot back from synced account settings', () => {
        const snapshot = createSplitCanvasPersistenceSnapshot(createSplitCanvasState({
            root: createLeaf('session-leaf:sess_2', 'sess_2'),
            maxLeaves: 4,
        }));

        const settings = createSettings({
            sessionSplitCanvasLayoutsV1: {
                'server-a:machine-1:/repo': snapshot,
            },
        } as Partial<Settings>);

        expect(readPersistedSessionSplitCanvasSnapshot({
            settings,
            scopeKey: 'server-a:machine-1:/repo',
        })).toEqual(snapshot);
    });

    it('treats server-normalized snapshots with reordered JSON keys as equal', () => {
        const snapshot = createSplitCanvasPersistenceSnapshot(createSplitCanvasState({
            root: createLeaf('session-leaf:sess_1', 'sess_1'),
            maxLeaves: 8,
        }));
        const serverOrderedSnapshot = {
            focusedLeafId: snapshot.focusedLeafId,
            maxLeaves: snapshot.maxLeaves,
            maximizedLeafId: snapshot.maximizedLeafId,
            root: snapshot.root,
            version: snapshot.version,
        };

        expect(JSON.stringify(serverOrderedSnapshot)).not.toBe(JSON.stringify(snapshot));
        expect(areSessionSplitCanvasSnapshotsEqual(serverOrderedSnapshot, snapshot)).toBe(true);
    });

    it('does not persist route-only single-leaf snapshots over another route-only single-leaf snapshot', () => {
        const persisted = createInitialSessionSplitCanvasSnapshot({
            sessionId: 'sess_other_tab',
            maxLeaves: 8,
        });
        const snapshot = createInitialSessionSplitCanvasSnapshot({
            sessionId: 'sess_this_route',
            maxLeaves: 8,
        });

        expect(shouldPersistSessionSplitCanvasSnapshot({
            persisted,
            snapshot,
            routeSessionId: 'sess_this_route',
        })).toBe(false);
    });

    it('persists real split layout changes even when the route leaf is present', () => {
        const state = createSplitCanvasState({
            root: createLeaf('session-leaf:sess_this_route', 'sess_this_route'),
            maxLeaves: 8,
        });
        const splitState = createTwoSessionSplitState({
            firstSessionId: 'sess_this_route',
            secondSessionId: 'sess_b',
        });

        expect(shouldPersistSessionSplitCanvasSnapshot({
            persisted: createSplitCanvasPersistenceSnapshot(state),
            snapshot: createSplitCanvasPersistenceSnapshot(splitState),
            routeSessionId: 'sess_this_route',
        })).toBe(true);
    });

    it('persists collapsing an existing split layout back to one leaf', () => {
        const splitState = createTwoSessionSplitState({
            firstSessionId: 'sess_this_route',
            secondSessionId: 'sess_b',
        });
        const snapshot = createInitialSessionSplitCanvasSnapshot({
            sessionId: 'sess_this_route',
            maxLeaves: 8,
        });

        expect(shouldPersistSessionSplitCanvasSnapshot({
            persisted: createSplitCanvasPersistenceSnapshot(splitState),
            snapshot,
            routeSessionId: 'sess_this_route',
        })).toBe(true);
    });

    it('fails closed for missing scope keys and malformed snapshots', () => {
        const settings = createSettings({
            sessionSplitCanvasLayoutsV1: {
                'server-a:machine-1:/repo': {
                    version: 2,
                },
            },
        } as unknown as Partial<Settings>);

        expect(readPersistedSessionSplitCanvasSnapshot({
            settings,
            scopeKey: '',
        })).toBeNull();
        expect(readPersistedSessionSplitCanvasSnapshot({
            settings,
            scopeKey: 'server-a:machine-1:/repo',
        })).toBeNull();
    });
});
