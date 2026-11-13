import { describe, expect, it, vi } from 'vitest';
import { resolveSessionAccessCapabilityDecisions, resolveSessionAccessCapabilitiesForRowsInTx, type SessionAccessProjectionRow } from './sessionAccess';
import type { Tx } from '@/storage/inTx';
import type { SessionAccessAuthentication } from './sessionAccessAuthentication';
vi.mock('@/storage/db', () => ({ db: {} }));
const authentication: SessionAccessAuthentication = { env: {}, authority: 'present_user', authenticationEvidence: [] };
const actor = { accountId: 'reader', sessionId: 'session', authentication };
function row(): SessionAccessProjectionRow {
    return { id: 'session', accountId: 'owner', primaryTeamId: null, account: { status: 'active' }, seq: 0,
        currentStorageState: 'hosted', acceptedThroughServerSeq: null, materializationPublicationId: null,
        materializedThroughSourceAt: null, publishedThroughServerSeq: null,
        grants: [{ principalKind: 'account', teamId: null, teamGroupId: null, effectiveAt: null, requiredByTeamPolicy: false, account: { status: 'active' }, team: null, teamGroup: null,  id: 'direct', accountId: 'reader', accessLevel: 'view', canApprovePermissions: false  }, { id: 'team-grant', principalKind: 'team', accountId: null, teamGroupId: null, account: null, teamGroup: null,  teamId: 'team', effectiveAt: new Date(2), accessLevel: 'admin', canApprovePermissions: false,
            requiredByTeamPolicy: false, team: { authenticationPolicy: null,
                memberships: [{ accountId: 'reader', role: 'member', sessionAccessStartsAt: new Date(1) }] }  }, { id: 'group-grant', principalKind: 'group', accountId: null, teamId: null, requiredByTeamPolicy: false, account: null, team: null,  teamGroupId: 'group', effectiveAt: new Date(2), accessLevel: 'edit', canApprovePermissions: true,
            teamGroup: { teamId: 'team', team: { authenticationPolicy: null }, memberships: [{ sessionAccessStartsAt: new Date(1),
                teamMembership: { accountId: 'reader' } }] }  }],
        
         };
}
const requests = [{}, { capability: 'readTranscript' }, { capability: 'manageAccess' },
    { capability: 'approveRuntimePermissions' }, { capability: 'managePermissionDelegation' },
    { capability: 'manageAccess', accessMode: 'legacy_owner_or_direct' }] as const;
describe('Session capability bundle admission', () => {
    it('reads facts once for multiple permissions and preserves same-grant delegation and the released seam', async () => {
        const findUnique = vi.fn(async () => row());
        const results = await resolveSessionAccessCapabilityDecisions({ session: { findUnique } } as unknown as Tx, actor, requests);
        expect(findUnique).toHaveBeenCalledTimes(1);
        expect(results.map(result => result.status)).toEqual(['allowed', 'allowed', 'allowed', 'allowed', 'unavailable', 'unavailable']);
        expect(results[0]).toMatchObject({ access: { accountId: 'reader', sessionId: 'session', level: 'admin' } });
    });
    it('keeps direct access when collective credential qualification fails and preserves per-capability continuations', async () => {
        const results = await resolveSessionAccessCapabilityDecisions({} as Tx, { ...actor, row: row() }, requests,
            new Map([['team', { status: 'authentication_required' as const, accepted: [] }]]));
        expect(results.map(result => result.status)).toEqual(['allowed', 'allowed', 'authentication_required',
            'authentication_required', 'unavailable', 'unavailable']);
    });
    it('applies strict history horizons before considering authentication continuations', async () => {
        const facts = row();
        facts.grants.find(grant => grant.principalKind === 'team')!.team!.memberships[0]!.sessionAccessStartsAt = new Date(2);
        facts.grants.find(grant => grant.principalKind === 'group')!.teamGroup!.memberships[0]!.sessionAccessStartsAt = new Date(2);
        const results = await resolveSessionAccessCapabilityDecisions({} as Tx, { ...actor, row: facts }, requests,
            new Map([['team', { status: 'authentication_required' as const, accepted: [] }]]));
        expect(results.map(result => result.status)).toEqual(['allowed', 'allowed', 'unavailable', 'unavailable', 'unavailable', 'unavailable']);
    });
    it('matches Team and explicit Group guests through the shared principal policy', async () => {
        const facts = row();
        facts.grants.find(grant => grant.principalKind === 'team')!.team!.memberships[0]!.role = 'guest';
        const results = await resolveSessionAccessCapabilityDecisions({} as Tx, { ...actor, row: facts }, requests);
        expect(results[0]).toMatchObject({ status: 'allowed', access: { level: 'edit', relationshipKinds: ['direct', 'group'] } });
        expect(results[2]).toEqual({ status: 'unavailable' });
        expect(results[3]).toMatchObject({ status: 'allowed' });
    });
    it('uses supplied row facts once per batch without multiplying storage reads by requested permissions', async () => {
        const reader = { session: { findUnique: vi.fn(), findMany: vi.fn() } };
        const rows = Array.from({ length: 200 }, (_, index) => ({ ...row(), id: 'session-' + index }));
        const results = await resolveSessionAccessCapabilitiesForRowsInTx(reader as unknown as Tx,
            { accountId: 'reader', authentication }, rows, requests);
        expect(results).toHaveLength(requests.length);
        expect([...results[0]!.values()].every(result => result.status === 'allowed')).toBe(true);
        expect(results[0]!.size).toBe(rows.length);
        expect(reader.session.findUnique).not.toHaveBeenCalled();
        expect(reader.session.findMany).not.toHaveBeenCalled();
    });
});
