import { describe, expect, it } from 'vitest';

import {
    buildComparableBasePathPeerSessions,
    type ComparableBasePathPeerSessionSource,
} from './buildComparableBasePathPeerSessions';

describe('buildComparableBasePathPeerSessions', () => {
    it('groups peers by comparable base path and sorts each bucket by active then recency', () => {
        const buckets = buildComparableBasePathPeerSessions({
            sessionRecords: {
                stale: { id: 'stale', active: false, updatedAt: 10 },
                activeNewer: { id: 'activeNewer', active: true, updatedAt: 30 },
                activeOlder: { id: 'activeOlder', active: true, updatedAt: 20 },
                other: { id: 'other', active: true, updatedAt: 40 },
            } satisfies Record<string, ComparableBasePathPeerSessionSource>,
            unresolvedComparableBasePaths: new Set(['/repo', '/other']),
            resolveComparableBasePathAndPeerSession: (sessionId, sessionRecord) => ({
                comparableBasePath: sessionId === 'other' ? '/other' : '/repo',
                peerSession: {
                    id: sessionRecord.id,
                    active: sessionRecord.active,
                    updatedAt: sessionRecord.updatedAt,
                    machineId: sessionId === 'stale' ? 'm-stale' : 'm-active',
                    hostHint: sessionId === 'stale' ? 'host-stale' : 'host-active',
                    projectMachineId: sessionId === 'other' ? 'm-other' : 'm-repo',
                },
            }),
        });

        expect(buckets.get('/repo')?.map((peer) => peer.id)).toEqual(['activeNewer', 'activeOlder', 'stale']);
        expect(buckets.get('/other')?.map((peer) => peer.id)).toEqual(['other']);
    });

    it('skips unresolved comparable base paths', () => {
        const buckets = buildComparableBasePathPeerSessions({
            sessionRecords: {
                matched: { id: 'matched', active: true, updatedAt: 1 },
                skipped: { id: 'skipped', active: true, updatedAt: 2 },
            } satisfies Record<string, ComparableBasePathPeerSessionSource>,
            unresolvedComparableBasePaths: new Set(['/repo']),
            resolveComparableBasePathAndPeerSession: (sessionId, sessionRecord) => ({
                comparableBasePath: sessionId === 'matched' ? '/repo' : '/other',
                peerSession: {
                    id: sessionRecord.id,
                    active: sessionRecord.active,
                    updatedAt: sessionRecord.updatedAt,
                    machineId: null,
                    hostHint: null,
                    projectMachineId: null,
                },
            }),
        });

        expect(buckets.has('/repo')).toBe(true);
        expect(buckets.has('/other')).toBe(false);
    });
});
