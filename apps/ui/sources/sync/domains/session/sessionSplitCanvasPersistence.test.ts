import { describe, expect, it } from 'vitest';

import { createSplitCanvasPersistenceSnapshot } from '@/components/appShell/splitCanvas/model/splitCanvasPersistence';
import { createSplitCanvasState } from '@/components/appShell/splitCanvas/model/splitCanvasReducer';
import type { SplitCanvasLeafNode } from '@/components/appShell/splitCanvas/model/splitCanvasTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import {
    createInitialSessionSplitCanvasSnapshot,
    readPersistedSessionSplitCanvasSnapshot,
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
