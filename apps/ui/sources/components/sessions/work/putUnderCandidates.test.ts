import { describe, expect, it } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit';

import { canDropSessionUnder, listPutUnderCandidates, resolvePutUnderEligibility } from './putUnderCandidates';
import { createSessionManagerEligibilitySnapshot, type SessionManagerEligibilitySnapshot } from '@/sync/ops/relations/sessionManagerEligibility';
import { SessionManagerOptionsV1Schema } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { upsertServerProfile, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { resolveSessionRuntimePublication } from '@/sync/store/domains/sessionRuntimePublication';
import { sessionRuntimeObservations } from '@/sync/domains/session/sessionRuntimeObservation';
import { readPutUnderCandidatePresentation } from './putUnderPresentation';

function session(id: string, overrides: Partial<Session> = {}): Session {
    return createSessionFixture({ id, serverId: 'home', updatedAt: 1, createdAt: 1, archivedAt: null, ...overrides });
}

function facts(sessions: Readonly<Record<string, Session>>, sessionId: string): SessionManagerEligibilitySnapshot {
    // These fixture reports are descendants in the Home's current graph. Its read owns cycle
    // verdicts; a client must not rebuild that graph from a partial retained list.
    const cycleIds = new Set(['child', 'grandchild']);
    return createSessionManagerEligibilitySnapshot({ ...SessionManagerOptionsV1Schema.parse({ sessionId,
        currentManagerSessionId: sessions[sessionId]?.manager?.sessionId ?? null,
        candidates: Object.keys(sessions).map((sessionId) => cycleIds.has(sessionId)
            ? { sessionId, allowed: false, reason: 'cycle' } : { sessionId, allowed: true }),
    }), serverId: 'home', accountId: 'account',
        isCurrent: () => true, dispose: () => {},
    });
}

describe('listPutUnderCandidates', () => {
    it('reads current receipt recency for the opened chooser without replacing Session content or borrowing another Home', () => {
        const lead = session('receipt-lead', { updatedAt: 2 });
        const peer = session('receipt-peer', { updatedAt: 9 });
        const foreignPeer = session(peer.id, { serverId: 'other-home', updatedAt: 9 });
        const records = { self: session('self'), [lead.id]: lead, [peer.id]: peer };
        try {
            const receipt = { ...lead, updatedAt: 43 };
            expect(resolveSessionRuntimePublication(lead, receipt, receipt)).toBe(lead);
            const foreignReceipt = { ...foreignPeer, updatedAt: 1000 };
            expect(resolveSessionRuntimePublication(foreignPeer, foreignReceipt, foreignReceipt)).toBe(foreignPeer);

            expect(listPutUnderCandidates(records, records.self, facts(records, 'self')).map(item => item.id))
                .toEqual([lead.id, peer.id]);
            expect(readPutUnderCandidatePresentation(lead).updatedAt).toBe(43);
            expect(readPutUnderCandidatePresentation(peer).updatedAt).toBe(9);
            expect(lead.updatedAt).toBe(2);
        } finally {
            for (const address of [{ serverId: 'home', sessionId: lead.id },
                { serverId: 'other-home', sessionId: peer.id }]) sessionRuntimeObservations.forget(address);
        }
    });

    it('offers Sessions on the same Home, never itself, its reports, archived or other-Home Sessions', () => {
        const sessions = Object.fromEntries([
            session('self'),
            session('child', { manager: { sessionId: 'self' } }),
            session('grandchild', { manager: { sessionId: 'child' } }),
            session('lead', { updatedAt: 5 }),
            session('peer', { updatedAt: 9 }),
            session('old', { archivedAt: 3 }),
            session('elsewhere', { serverId: 'other-home' }),
        ].map((item) => [item.id, item]));

        expect(listPutUnderCandidates(sessions, sessions.self!, facts(sessions, 'self')).map((item) => item.id)).toEqual(['peer', 'lead']);
    });
});

describe('canDropSessionUnder', () => {
    it('admits current Home evidence when an unopened row and the Account read use established aliases of that Home', async () => {
        const profile = await upsertServerProfile({ serverUrl: 'https://put-under-alias.test', name: 'Put under Home' });
        expect(await setServerProfileIdentityForUrl(profile.serverUrl, 'srv_put_under_home')).not.toBeNull();
        const records = { source: session('source', { serverId: profile.id }),
            candidate: session('candidate', { serverId: 'srv_put_under_home' }) };
        const evidence = createSessionManagerEligibilitySnapshot({ serverId: 'srv_put_under_home', accountId: 'account',
            sessionId: 'source', currentManagerSessionId: null, candidates: [{ sessionId: 'candidate', allowed: true }],
            isCurrent: () => true, dispose: () => {} });
        expect(resolvePutUnderEligibility(records, 'source', 'candidate', evidence, { serverId: profile.id, accountId: 'account' }))
            .toEqual({ allowed: true, expectedManagerSessionId: null });
        expect(resolvePutUnderEligibility({ ...records, candidate: session('candidate', { serverId: profile.id }) },
            'source', 'candidate', evidence, { serverId: profile.id, accountId: 'account' }))
            .toEqual({ allowed: true, expectedManagerSessionId: null });
        expect(resolvePutUnderEligibility(records, 'source', 'candidate', evidence, { serverId: 'unrelated-home', accountId: 'account' }))
            .toEqual({ allowed: false, reason: 'different_home' });
    });
    const canInput = { access: createSessionAccessFixture() } satisfies Partial<Session>;
    const sessions = Object.fromEntries([
        session('self', { ...canInput, manager: { sessionId: 'lead' } }),
        session('child', { manager: { sessionId: 'self' } }),
        session('grandchild', { manager: { sessionId: 'child' } }),
        session('lead'),
        session('peer'),
        session('old', { archivedAt: 3 }),
        session('elsewhere', { serverId: 'other-home' }),
        session('viewer', { access: createSessionAccessFixture('view') }),
    ].map((item) => [item.id, item]));

    it('accepts a drop on a Session that could lead this one', () => {
        expect(canDropSessionUnder(sessions, 'self', 'peer', facts(sessions, 'self'))).toBe(true);
    });

    it('uses the Home eligibility read as the relation CAS basis when the unopened list relation is older', () => {
        const evidence = createSessionManagerEligibilitySnapshot({ serverId: 'home', accountId: 'account',
            sessionId: 'self', currentManagerSessionId: null, candidates: [{ sessionId: 'peer', allowed: true }, { sessionId: 'lead', allowed: true }],
            isCurrent: () => true, dispose: () => {},
        });
        // The Home has detached self; the retained list still says it reports to lead.
        // That stale projection cannot invalidate a current server admission or choose the CAS basis.
        expect(resolvePutUnderEligibility(sessions, 'self', 'peer', evidence, { serverId: 'home', accountId: 'account' }))
            .toEqual({ allowed: true, expectedManagerSessionId: null });
        expect(resolvePutUnderEligibility(sessions, 'self', 'lead', evidence))
            .toEqual({ allowed: true, expectedManagerSessionId: null });
        const staleAncestor = { ...sessions, peer: session('peer', { manager: { sessionId: 'self' } }) };
        expect(resolvePutUnderEligibility(staleAncestor, 'self', 'peer', evidence))
            .toEqual({ allowed: true, expectedManagerSessionId: null });
        evidence.dispose();
        expect(resolvePutUnderEligibility(sessions, 'self', 'peer', evidence)).toEqual({ allowed: false, reason: 'unavailable' });
    });

    it('refuses its current lead, itself, its own reports, archived and other-Home Sessions', () => {
        for (const target of ['lead', 'self', 'child', 'grandchild', 'old', 'elsewhere', 'missing']) {
            expect(canDropSessionUnder(sessions, 'self', target, facts(sessions, 'self'))).toBe(false);
        }
    });

    it('refuses a Session the viewer cannot steer', () => {
        expect(canDropSessionUnder(sessions, 'viewer', 'peer', facts(sessions, 'viewer'))).toBe(false);
    });

    it('uses the same refusal for a lead the viewer cannot steer in menus and drops', () => {
        const current: Record<string, Session> = { ...sessions, peer: session('peer', { access: createSessionAccessFixture('view') }) };
        expect(canDropSessionUnder(current, 'self', 'peer', facts(current, 'self'))).toBe(false);
        expect(listPutUnderCandidates(current, current.self!, facts(current, 'self')).map((item) => item.id)).not.toContain('peer');
    });

    it('refuses unknown, retired, mismatched Account/Home and pairwise facts while preserving the current lead menu option', () => {
        const evidence = facts(sessions, 'self');
        expect(resolvePutUnderEligibility(sessions, 'self', 'peer')).toEqual({ allowed: false, reason: 'unavailable' });
        expect(resolvePutUnderEligibility({ ...sessions, self: session('self', { serverId: undefined }), peer: session('peer', { serverId: undefined }) },
            'self', 'peer')).toEqual({ allowed: false, reason: 'unavailable' });
        expect(resolvePutUnderEligibility(sessions, 'self', 'peer', { ...evidence, isCurrent: () => false })).toEqual({ allowed: false, reason: 'unavailable' });
        expect(resolvePutUnderEligibility(sessions, 'self', 'peer', evidence, { accountId: 'other' })).toEqual({ allowed: false, reason: 'unavailable' });
        expect(resolvePutUnderEligibility(sessions, 'self', 'peer', evidence, { serverId: 'other' })).toEqual({ allowed: false, reason: 'different_home' });
        const denied = createSessionManagerEligibilitySnapshot({ ...evidence,
            candidates: [{ sessionId: 'peer', allowed: false, reason: 'pairwise' }] });
        expect(resolvePutUnderEligibility(sessions, 'self', 'peer', denied)).toEqual({ allowed: false, reason: 'pairwise' });
        expect(listPutUnderCandidates(sessions, sessions.self!, denied).map((item) => item.id)).not.toContain('peer');
        expect(listPutUnderCandidates(sessions, sessions.self!, evidence).map((item) => item.id)).toContain('lead');
        expect(canDropSessionUnder(sessions, 'self', 'lead', evidence)).toBe(false);
    });
});
