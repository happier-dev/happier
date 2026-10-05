import { describe, expect, it } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit';

import { canDropSessionUnder, listPutUnderCandidates, resolvePutUnderEligibility } from './putUnderCandidates';
import { createSessionReportsToEligibilitySnapshot, type SessionReportsToEligibilitySnapshot } from '@/sync/ops/relations/sessionReportsToEligibility';

function session(id: string, overrides: Partial<Session> = {}): Session {
    return createSessionFixture({ id, serverId: 'home', updatedAt: 1, createdAt: 1, archivedAt: null, ...overrides });
}

function facts(sessions: Readonly<Record<string, Session>>, sessionId: string): SessionReportsToEligibilitySnapshot {
    return createSessionReportsToEligibilitySnapshot({ serverId: 'home', accountId: 'account', sessionId,
        currentLeadSessionId: sessions[sessionId]?.reportsTo?.sessionId ?? null,
        candidates: Object.keys(sessions).map((sessionId) => ({ sessionId, allowed: true })),
        isCurrent: () => true, dispose: () => {},
    });
}

describe('listPutUnderCandidates', () => {
    it('offers Sessions on the same Home, never itself, its reports, archived or other-Home Sessions', () => {
        const sessions = Object.fromEntries([
            session('self'),
            session('child', { reportsTo: { sessionId: 'self' } }),
            session('grandchild', { reportsTo: { sessionId: 'child' } }),
            session('lead', { updatedAt: 5 }),
            session('peer', { updatedAt: 9 }),
            session('old', { archivedAt: 3 }),
            session('elsewhere', { serverId: 'other-home' }),
        ].map((item) => [item.id, item]));

        expect(listPutUnderCandidates(sessions, sessions.self!, facts(sessions, 'self')).map((item) => item.id)).toEqual(['peer', 'lead']);
    });
});

describe('canDropSessionUnder', () => {
    const canInput = { access: createSessionAccessFixture() } satisfies Partial<Session>;
    const sessions = Object.fromEntries([
        session('self', { ...canInput, reportsTo: { sessionId: 'lead' } }),
        session('child', { reportsTo: { sessionId: 'self' } }),
        session('grandchild', { reportsTo: { sessionId: 'child' } }),
        session('lead'),
        session('peer'),
        session('old', { archivedAt: 3 }),
        session('elsewhere', { serverId: 'other-home' }),
        session('viewer', { access: createSessionAccessFixture('view') }),
    ].map((item) => [item.id, item]));

    it('accepts a drop on a Session that could lead this one', () => {
        expect(canDropSessionUnder(sessions, 'self', 'peer', facts(sessions, 'self'))).toBe(true);
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
        expect(resolvePutUnderEligibility(sessions, 'self', 'peer', { ...evidence, isCurrent: () => false })).toEqual({ allowed: false, reason: 'unavailable' });
        expect(resolvePutUnderEligibility(sessions, 'self', 'peer', evidence, { accountId: 'other' })).toEqual({ allowed: false, reason: 'unavailable' });
        expect(resolvePutUnderEligibility(sessions, 'self', 'peer', evidence, { serverId: 'other' })).toEqual({ allowed: false, reason: 'different_home' });
        const denied = createSessionReportsToEligibilitySnapshot({ ...evidence,
            candidates: [{ sessionId: 'peer', allowed: false, reason: 'pairwise' }] });
        expect(resolvePutUnderEligibility(sessions, 'self', 'peer', denied)).toEqual({ allowed: false, reason: 'pairwise' });
        expect(listPutUnderCandidates(sessions, sessions.self!, denied).map((item) => item.id)).not.toContain('peer');
        expect(listPutUnderCandidates(sessions, sessions.self!, evidence).map((item) => item.id)).toContain('lead');
        expect(canDropSessionUnder(sessions, 'self', 'lead', evidence)).toBe(false);
    });
});
