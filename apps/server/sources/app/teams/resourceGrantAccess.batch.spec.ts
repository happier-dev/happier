import { describe, expect, it } from 'vitest';
import { resolveResourceGrantPrincipalAudiencesFromFacts, type ResourceGrantAccessFacts } from './resourceGrantAccess';

const facts: ResourceGrantAccessFacts = {
    ownerAccountId: 'owner', encryptionMode: 'plain',
    accountGrants: [{ accountId: 'guest', accessLevel: 'view', account: { status: 'active' } }],
    teamGrants: [{ teamId: 'team', accessLevel: 'admin', team: { archivedAt: null, memberships: [
        { accountId: 'guest', role: 'guest', status: 'active', account: { status: 'active' } },
        { accountId: 'member', role: 'member', status: 'active', account: { status: 'active' } },
    ] } }],
    groupGrants: [{ accessLevel: 'edit', teamGroup: { archivedAt: null, team: { archivedAt: null }, memberships: [
        { teamMembership: { accountId: 'guest', status: 'active', account: { status: 'active' } } },
    ] } }],
};

describe('requested Principal membership census', () => {
    it('projects requested Principal members without implicitly adding the resource owner', () => {
        expect(resolveResourceGrantPrincipalAudiencesFromFacts(facts, [{ kind: 'team', teamId: 'team' },
            { kind: 'account', accountId: 'guest' }])).toEqual([['member'], ['guest']]);
        expect(resolveResourceGrantPrincipalAudiencesFromFacts({ ...facts,
            groupGrants: facts.groupGrants.map(grant => ({ ...grant, teamGroupId: 'group' })),
        }, [{ kind: 'group', teamId: 'team', groupId: 'group' }])).toEqual([['guest']]);
    });
});
