import { describe, expect, it } from 'vitest';

import type { Session } from '../../domains/state/storageTypes';
import { areStoredSessionsEqual } from './areStoredSessionsEqual';

function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 's1',
        serverId: 'server-active',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        metadata: null,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
        ...overrides,
    };
}

describe('areStoredSessionsEqual', () => {
    it('treats ready metadata changes as stored session changes', () => {
        const previous = makeSession({
            latestReadyEventSeq: 3,
            latestReadyEventAt: 30,
        });
        const next = makeSession({
            latestReadyEventSeq: 4,
            latestReadyEventAt: 40,
        });

        expect(areStoredSessionsEqual(previous, next)).toBe(false);
    });

    it('treats meaningful activity changes as stored session changes', () => {
        const previous = makeSession({ meaningfulActivityAt: 30 });
        const next = makeSession({ meaningfulActivityAt: 40 });

        expect(areStoredSessionsEqual(previous, next)).toBe(false);
    });

    it('treats runtime activity projection changes as stored session changes', () => {
        const previous = makeSession({
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_000,
            runtimeActivityRevision: 2_000,
        });
        const next = makeSession({
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_500,
            runtimeActivityRevision: 2_500,
        });

        expect(areStoredSessionsEqual(previous, next)).toBe(false);
    });

    it('treats layout and owner metadata view changes as stored session changes', () => {
        const previous = makeSession({
            metadataLayoutVersion: 1,
            metadata: null,
            ownerMetadataView: { path: '/owner/old', host: 'owner-host' },
        });
        const next = makeSession({
            metadataLayoutVersion: 1,
            metadata: null,
            ownerMetadataView: { path: '/owner/new', host: 'owner-host' },
        });

        expect(areStoredSessionsEqual(previous, next)).toBe(false);
        expect(areStoredSessionsEqual(previous, {
            ...previous,
            metadataLayoutVersion: 2,
        })).toBe(false);
    });
});
