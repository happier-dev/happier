import { describe, expect, it } from 'vitest';

import {
    buildComparableBasePathPeerSessions,
    type ComparableBasePathPeerSessionSource,
} from './buildComparableBasePathPeerSessions';

describe('buildComparableBasePathPeerSessions', () => {
    it('groups peers by comparable base path and sorts each bucket by active then stable id', () => {
        const buckets = buildComparableBasePathPeerSessions({
            sessionRecords: {
                stale: { id: 'stale', active: false },
                activeNewer: { id: 'activeNewer', active: true },
                activeOlder: { id: 'activeOlder', active: true },
                other: { id: 'other', active: true },
            } satisfies Record<string, ComparableBasePathPeerSessionSource>,
            unresolvedComparableBasePaths: new Set(['/repo', '/other']),
            resolveComparableBasePathAndPeerSession: (sessionId, sessionRecord) => ({
                comparableBasePath: sessionId === 'other' ? '/other' : '/repo',
                peerSession: {
                    id: sessionRecord.id,
                    active: sessionRecord.active,
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
                matched: { id: 'matched', active: true },
                skipped: { id: 'skipped', active: true },
            } satisfies Record<string, ComparableBasePathPeerSessionSource>,
            unresolvedComparableBasePaths: new Set(['/repo']),
            resolveComparableBasePathAndPeerSession: (sessionId, sessionRecord) => ({
                comparableBasePath: sessionId === 'matched' ? '/repo' : '/other',
                peerSession: {
                    id: sessionRecord.id,
                    active: sessionRecord.active,
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
