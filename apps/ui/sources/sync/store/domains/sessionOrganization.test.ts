import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { SessionOrganizationSnapshot } from '@happier-dev/protocol';

import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization';

import {
    createSessionOrganizationDomain,
    type SessionOrganizationDomain,
} from './sessionOrganization';

type State = SessionOrganizationDomain;

function createHarness() {
    const store = createStore<State>((set, get) => createSessionOrganizationDomain({ set, get }));
    return { get: store.getState, subscribe: store.subscribe };
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
        ...(input.attentionStandings === undefined
            ? {}
            : { attentionStandings: input.attentionStandings }),
    };
}

describe('createSessionOrganizationDomain', () => {
    it('rebases a pending replacement on the confirmed reminder clear before rollback', () => {
        const harness = createHarness();
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            attentionStandings: [{ sessionId: 's1', standing: false, remindAt: 1000, updatedAt: 1 }],
        }));
        const clear = harness.get().setSessionAttentionStandingOptimistic('srv-a', 's1', { sessionId: 's1', standing: false, updatedAt: 2 });
        const replacement = harness.get().setSessionAttentionStandingOptimistic('srv-a', 's1', { sessionId: 's1', standing: false, remindAt: 2000, updatedAt: 3 });
        const key = buildSessionOrganizationSessionKey('srv-a', 's1');
        harness.get().confirmSessionOrganizationOptimistic(clear, 'sessionOrganizationAttentionStandingsBySessionKey', key,
            { sessionId: 's1', standing: true, updatedAt: 4 });
        expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey[key]?.remindAt).toBe(2000);
        harness.get().rollbackSessionOrganizationOptimistic(replacement);
        expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey[key])
            .toEqual({ sessionId: 's1', standing: true, updatedAt: 4 });
    });

    it.each([false, true, null])('restores the original standing %s after two same-session reminder writes both fail', (originalStanding) => {
        for (const failureOrder of [[0, 1], [1, 0]]) {
            const harness = createHarness();
            const original = originalStanding === null ? [] : [{ sessionId: 's1', standing: originalStanding, updatedAt: 1 }];
            harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({ attentionStandings: original }));
            const baseline = harness.get().sessionOrganizationAttentionStandingsBySessionKey;
            const records = [2_000, 5_000].map((remindAt) => harness.get().setSessionAttentionStandingOptimistic('srv-a', 's1', {
                sessionId: 's1', standing: true, remindAt, updatedAt: remindAt,
            }));
            for (const index of failureOrder) harness.get().rollbackSessionOrganizationOptimistic(records[index]!);
            expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey).toEqual(baseline);
            expect(harness.get().sessionOrganizationOptimisticRecords).toEqual({});
        }
    });

    it('does not replay an older pending reminder over a newer confirmed reminder when another write fails', () => {
        const harness = createHarness();
        const first = harness.get().setSessionAttentionStandingOptimistic('srv-a', 's1', { sessionId: 's1', standing: true, remindAt: 2_000, updatedAt: 2 });
        const unrelated = harness.get().setSessionPinOptimistic('srv-a', 's2', { sessionId: 's2', pinnedAt: 3, sortKey: null });
        const latest = { sessionId: 's1', standing: true, remindAt: 5_000, updatedAt: 5 };
        const last = harness.get().setSessionAttentionStandingOptimistic('srv-a', 's1', latest);
        const key = buildSessionOrganizationSessionKey('srv-a', 's1');
        harness.get().confirmSessionOrganizationOptimistic(last, 'sessionOrganizationAttentionStandingsBySessionKey', key, latest);
        harness.get().rollbackSessionOrganizationOptimistic(unrelated);
        expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey[key]).toEqual(latest);
        harness.get().rollbackSessionOrganizationOptimistic(first);
        expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey[key]).toEqual(latest);
    });

    it('does not publish unchanged loading, error, assignment, or ignored reconciliation state', () => {
        const harness = createHarness();
        harness.get().setSessionOrganizationLoading('srv-a', false);
        harness.get().setSessionOrganizationError('srv-a', null);
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({ version: 2 }));
        harness.get().applySessionFolderAssignments('srv-a', [{ sessionId: 's1', folderId: null }]);
        const before = harness.get();
        let notifications = 0;
        const unsubscribe = harness.subscribe(() => { notifications += 1; });
        harness.get().setSessionFolderAssignmentsLoading('srv-a', false);
        harness.get().setSessionOrganizationError('srv-a', null);
        harness.get().applySessionFolderAssignments('srv-a', [{ sessionId: 's1', folderId: null }]);
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({ version: 1 }));
        harness.get().reconcileSessionOrganizationFolderDelete('srv-a', ['missing'], null);
        harness.get().reconcileSessionOrganizationTagDelete('srv-a', 'missing');
        harness.get().rollbackSessionOrganizationOptimistic('missing');
        harness.get().commitSessionOrganizationOptimistic('missing');
        expect(harness.get()).toBe(before);
        expect(notifications).toBe(0);

        harness.get().setSessionOrganizationLoading('srv-a', true);
        expect(harness.get().sessionOrganizationLoadingByServerId['srv-a']).toBe(true);
        expect(notifications).toBe(1);
        unsubscribe();
    });

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
            [buildSessionOrganizationSessionKey('srv-a', 's1')]: { sessionId: 's1', folderId: null },
            [buildSessionOrganizationSessionKey('srv-a', 's2')]: { sessionId: 's2', folderId: null },
            [buildSessionOrganizationSessionKey('srv-a', 's3')]: { sessionId: 's3', folderId: 'folder-c' },
            [buildSessionOrganizationSessionKey('srv-b', 'other')]: { sessionId: 'other', folderId: 'folder-other' },
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
            [buildSessionOrganizationSessionKey('srv-a', 's1')]: { sessionId: 's1', folderId: 'folder-z' },
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
            [buildSessionOrganizationSessionKey('srv-a', 's1')]: { sessionId: 's1', folderId: 'folder-new' },
            [buildSessionOrganizationSessionKey('srv-a', 's2')]: { sessionId: 's2', folderId: null },
            [buildSessionOrganizationSessionKey('srv-a', 's3')]: { sessionId: 's3', folderId: 'folder-untouched' },
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
            [buildSessionOrganizationSessionKey('srv-a', 's1')]: { sessionId: 's1', tagIds: ['tag-b'] },
            [buildSessionOrganizationSessionKey('srv-a', 's2')]: { sessionId: 's2', tagIds: ['tag-a'] },
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
            [buildSessionOrganizationSessionKey('srv-a', 's1')]: { sessionId: 's1', folderId: null },
            [buildSessionOrganizationSessionKey('srv-a', 's2')]: { sessionId: 's2', folderId: 'kept-folder' },
        });
    });

    it('rebases later optimistic tag-assignment writes when rolling back an earlier write', () => {
        const harness = createHarness();

        const firstRecordId = harness.get().setSessionTagAssignmentsOptimistic('srv-a', 's1', ['tag-a']);
        const secondRecordId = harness.get().setSessionTagAssignmentsOptimistic('srv-a', 's1', ['tag-a', 'tag-b']);

        harness.get().rollbackSessionOrganizationOptimistic(firstRecordId);

        expect(harness.get().sessionOrganizationTagAssignmentsBySessionKey).toEqual({
            [buildSessionOrganizationSessionKey('srv-a', 's1')]: { sessionId: 's1', tagIds: ['tag-a', 'tag-b'] },
        });
        expect(Object.keys(harness.get().sessionOrganizationOptimisticRecords)).toEqual([secondRecordId]);
    });

    it('keeps every Session-owned organization record distinct for delimiter-bearing addresses', () => {
        const harness = createHarness();
        const addresses = [
            { serverId: 'https://home.example/a', sessionId: 'b:c' },
            { serverId: 'https://home.example/a:b', sessionId: 'c' },
        ] as const;
        for (const [index, address] of addresses.entries()) {
            harness.get().applySessionOrganizationSnapshot(address.serverId, emptySnapshot({
                version: 1,
                pins: [{ sessionId: address.sessionId, pinnedAt: index + 1, sortKey: null }],
                folderAssignments: [{ sessionId: address.sessionId, folderId: `folder-${index}` }],
                tagAssignments: [{ sessionId: address.sessionId, tagIds: [`tag-${index}`] }],
                attentionStandings: [{ sessionId: address.sessionId, standing: true, updatedAt: index + 1 }],
            }), { includeAllFolderAssignments: true, includeAllTagAssignments: true });
        }

        for (const [index, address] of addresses.entries()) {
            const key = buildSessionOrganizationSessionKey(address.serverId, address.sessionId);
            expect(harness.get().sessionOrganizationPinsBySessionKey[key]?.sessionId).toBe(address.sessionId);
            expect(harness.get().sessionOrganizationFolderAssignmentsBySessionKey[key]?.folderId).toBe(`folder-${index}`);
            expect(harness.get().sessionOrganizationTagAssignmentsBySessionKey[key]?.tagIds).toEqual([`tag-${index}`]);
            expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey[key]?.updatedAt).toBe(index + 1);
        }
        expect(Object.keys(harness.get().sessionOrganizationPinsBySessionKey)).toHaveLength(2);
    });
});
