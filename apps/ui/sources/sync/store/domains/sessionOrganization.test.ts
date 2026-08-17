import { describe, expect, it } from 'vitest';
import type { SessionOrganizationSnapshot } from '@happier-dev/protocol';

import { buildSessionOrganizationServerKey } from '@/sync/domains/session/organization';

import {
    createSessionOrganizationDomain,
    type SessionOrganizationDomain,
} from './sessionOrganization';

type State = SessionOrganizationDomain;

function createHarness(): {
    get: () => State;
} {
    let state = {} as State;
    const get = () => state;
    const set = (updater: (draft: State) => Partial<State>) => {
        state = { ...state, ...updater(state) };
    };
    state = createSessionOrganizationDomain({ get, set } as any);
    return { get };
}

function emptySnapshot(input: Partial<SessionOrganizationSnapshot> = {}): SessionOrganizationSnapshot {
    return {
        schemaVersion: 1,
        version: input.version ?? 1,
        pins: input.pins ?? [],
        folders: input.folders ?? [],
        folderAssignments: input.folderAssignments ?? [],
        tags: input.tags ?? [],
        tagAssignments: input.tagAssignments ?? [],
        orderEntries: input.orderEntries ?? [],
        labels: input.labels ?? [],
    };
}

describe('createSessionOrganizationDomain', () => {
    it('keeps known sessions known when a full snapshot drops their folder assignment', () => {
        const harness = createHarness();
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            version: 1,
            folderAssignments: [
                { sessionId: 's1', folderId: 'folder-a' },
                { sessionId: 's2', folderId: 'folder-b' },
            ],
        }), { includeAllFolderAssignments: true });
        harness.get().applySessionOrganizationSnapshot('srv-b', emptySnapshot({
            version: 1,
            folderAssignments: [
                { sessionId: 'other', folderId: 'folder-other' },
            ],
        }), { includeAllFolderAssignments: true });

        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            version: 2,
            folderAssignments: [
                { sessionId: 's3', folderId: 'folder-c' },
            ],
        }), { includeAllFolderAssignments: true });

        // s1/s2 lost their folder (assignment cleared) but stay KNOWN, so the
        // missing-filter does not re-arm a per-session refetch for them.
        expect(harness.get().sessionOrganizationFolderAssignmentsBySessionKey).toEqual({
            [buildSessionOrganizationServerKey('srv-a', 's1')]: null,
            [buildSessionOrganizationServerKey('srv-a', 's2')]: null,
            [buildSessionOrganizationServerKey('srv-a', 's3')]: 'folder-c',
            [buildSessionOrganizationServerKey('srv-b', 'other')]: 'folder-other',
        });
    });

    it('keeps the folder assignment record referentially stable when a full snapshot changes nothing', () => {
        const harness = createHarness();
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            version: 1,
            folderAssignments: [{ sessionId: 's1', folderId: 'folder-a' }],
        }), { includeAllFolderAssignments: true });
        const afterFirst = harness.get().sessionOrganizationFolderAssignmentsBySessionKey;

        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            version: 2,
            folderAssignments: [{ sessionId: 's1', folderId: 'folder-a' }],
        }), { includeAllFolderAssignments: true });

        expect(harness.get().sessionOrganizationFolderAssignmentsBySessionKey).toBe(afterFirst);
    });

    it('adopts an assignment a later full snapshot reports for a known-unassigned session', () => {
        const harness = createHarness();
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            version: 1,
            folderAssignments: [{ sessionId: 's1', folderId: 'folder-a' }],
        }), { includeAllFolderAssignments: true });
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            version: 2,
            folderAssignments: [],
        }), { includeAllFolderAssignments: true });
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            version: 3,
            folderAssignments: [{ sessionId: 's1', folderId: 'folder-z' }],
        }), { includeAllFolderAssignments: true });

        expect(harness.get().sessionOrganizationFolderAssignmentsBySessionKey).toEqual({
            [buildSessionOrganizationServerKey('srv-a', 's1')]: 'folder-z',
        });
    });

    it('clears requested folder assignments that are absent from a scoped snapshot', () => {
        const harness = createHarness();
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            version: 1,
            folderAssignments: [
                { sessionId: 's1', folderId: 'folder-old' },
                { sessionId: 's2', folderId: 'folder-old' },
                { sessionId: 's3', folderId: 'folder-untouched' },
            ],
        }), { includeAllFolderAssignments: true });

        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            version: 2,
            folderAssignments: [
                { sessionId: 's1', folderId: 'folder-new' },
            ],
        }), { assignmentSessionIds: ['s1', 's2'] });

        expect(harness.get().sessionOrganizationFolderAssignmentsBySessionKey).toEqual({
            [buildSessionOrganizationServerKey('srv-a', 's1')]: 'folder-new',
            [buildSessionOrganizationServerKey('srv-a', 's2')]: null,
            [buildSessionOrganizationServerKey('srv-a', 's3')]: 'folder-untouched',
        });
    });

    it('removes requested tag ids from stale scoped tag assignments', () => {
        const harness = createHarness();
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            version: 1,
            tagAssignments: [
                { sessionId: 's1', tagIds: ['tag-a', 'tag-b'] },
                { sessionId: 's2', tagIds: ['tag-a'] },
            ],
        }), { includeAllTagAssignments: true });

        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            version: 2,
            tagAssignments: [
                { sessionId: 's2', tagIds: ['tag-a'] },
            ],
        }), { tagIds: ['tag-a'] });

        expect(harness.get().sessionOrganizationTagAssignmentsBySessionKey).toEqual({
            [buildSessionOrganizationServerKey('srv-a', 's1')]: ['tag-b'],
            [buildSessionOrganizationServerKey('srv-a', 's2')]: ['tag-a'],
        });
    });

    it('reconciles deleted folder assignments', () => {
        const harness = createHarness();
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            folderAssignments: [
                { sessionId: 's1', folderId: 'deleted-folder' },
                { sessionId: 's2', folderId: 'kept-folder' },
            ],
        }), { includeAllFolderAssignments: true });

        harness.get().reconcileSessionOrganizationFolderDelete('srv-a', ['deleted-folder'], null);

        expect(harness.get().sessionOrganizationFolderAssignmentsBySessionKey).toEqual({
            [buildSessionOrganizationServerKey('srv-a', 's1')]: null,
            [buildSessionOrganizationServerKey('srv-a', 's2')]: 'kept-folder',
        });
    });

    it('rebases later optimistic tag-assignment writes when rolling back an earlier write', () => {
        const harness = createHarness();

        const firstRecordId = harness.get().setSessionTagAssignmentsOptimistic('srv-a', 's1', ['tag-a']);
        const secondRecordId = harness.get().setSessionTagAssignmentsOptimistic('srv-a', 's1', ['tag-a', 'tag-b']);

        harness.get().rollbackSessionOrganizationOptimistic(firstRecordId);

        expect(harness.get().sessionOrganizationTagAssignmentsBySessionKey).toEqual({
            [buildSessionOrganizationServerKey('srv-a', 's1')]: ['tag-a', 'tag-b'],
        });
        expect(Object.keys(harness.get().sessionOrganizationOptimisticRecords)).toEqual([secondRecordId]);
    });
});
