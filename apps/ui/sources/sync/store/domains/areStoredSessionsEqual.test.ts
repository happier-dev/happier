import { describe, expect, it } from 'vitest';

import type { Session } from '../../domains/state/storageTypes';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
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
    it('propagates read-access revocation while reusing an equal normalized access projection', () => {
        const previous = makeSession({ access: createSessionAccessFixture('view') });
        const equivalent = { ...previous, access: structuredClone(previous.access) };
        const revoked = { ...previous, access: createSessionAccessFixture('view', { readTranscript: false }) };

        expect(areStoredSessionsEqual(previous, equivalent)).toBe(true);
        expect(areStoredSessionsEqual(previous, revoked)).toBe(false);
    });

    it('propagates encrypted content authentication failure and recovery as stored session changes', () => {
        const ready = makeSession({ encryptionMode: 'e2ee', encryptedContentAvailability: 'ready' });
        const unavailable: Session = { ...ready, encryptedContentAvailability: 'encrypted_content_unavailable' };
        const recovered: Session = { ...unavailable, encryptedContentAvailability: 'ready' };

        expect(areStoredSessionsEqual(ready, unavailable)).toBe(false);
        expect(areStoredSessionsEqual(unavailable, recovered)).toBe(false);
        expect(areStoredSessionsEqual(makeSession({ encryptionMode: 'e2ee' }), ready)).toBe(false);
    });

    it('keeps equal encrypted content availability eligible for stored session reuse', () => {
        for (const encryptedContentAvailability of ['ready', 'encrypted_content_unavailable', null, undefined] as const) {
            const previous = makeSession({ encryptionMode: 'e2ee', encryptedContentAvailability });

            expect(areStoredSessionsEqual(previous, { ...previous })).toBe(true);
        }
        expect(areStoredSessionsEqual(
            makeSession({ encryptionMode: 'e2ee', encryptedContentAvailability: null }),
            makeSession({ encryptionMode: 'e2ee' }),
        )).toBe(true);
    });

    it('treats a reportsTo edge or sub-session count change as a stored session change', () => {
        expect(areStoredSessionsEqual(
            makeSession({ reportsTo: { sessionId: 'lead-a' } }),
            makeSession({ reportsTo: { sessionId: 'lead-b' } }),
        )).toBe(false);
        expect(areStoredSessionsEqual(
            makeSession({ reportsTo: { sessionId: 'lead-a' } }),
            makeSession({ reportsTo: null }),
        )).toBe(false);
        expect(areStoredSessionsEqual(
            makeSession({ reports: { total: 2, working: 1, needsYou: 0, stalled: 0 } }),
            makeSession({ reports: { total: 2, working: 1, needsYou: 1, stalled: 0 } }),
        )).toBe(false);
        expect(areStoredSessionsEqual(
            makeSession({ reportsTo: { sessionId: 'lead-a' }, reports: { total: 1, working: 0, needsYou: 0, stalled: 0 } }),
            makeSession({ reportsTo: { sessionId: 'lead-a' }, reports: { total: 1, working: 0, needsYou: 0, stalled: 0 } }),
        )).toBe(true);
    });

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

    it('treats structured session turn projection changes as stored session changes', () => {
        const sessionTurns = {
            v: 1 as const,
            sessionId: 's1',
            latestTurnId: 'turn-1',
            updatedAt: 10,
            turns: [{
                turnId: 'turn-1',
                status: 'completed' as const,
                startedAt: 1,
                updatedAt: 10,
                terminalAt: 10,
                transcriptAnchors: {
                    startUserMessageSeq: 1,
                    userMessageSeqs: [1],
                    startSeqInclusive: 1,
                    endSeqInclusive: 2,
                },
                rollback: { state: 'eligible' as const, updatedAt: 10 },
            }],
        };
        const previous = {
            ...makeSession({ rollbackEligibleTurnStarts: [1] }),
            sessionTurns,
        } as Session;
        const next = {
            ...makeSession({ rollbackEligibleTurnStarts: [1] }),
            sessionTurns: {
                ...sessionTurns,
                updatedAt: 20,
                turns: sessionTurns.turns.map((turn) => ({
                    ...turn,
                    updatedAt: 20,
                    rollback: { state: 'not_eligible' as const, reason: 'not_latest_turn', updatedAt: 20 },
                })),
            },
        } as Session;

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
