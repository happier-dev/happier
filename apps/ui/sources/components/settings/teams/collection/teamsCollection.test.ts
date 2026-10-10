import { describe, expect, it } from 'vitest';

import type { TeamsDirectoryRow } from '../teamsDirectoryViewState';

import {
    readTeamCredentialSourceHint,
    resolveSelectedTeamAddress,
    resolveSelectedTeamMember,
    resolveTeamsCollectionLanding,
    resolveTeamsCollectionRows,
} from './teamsCollection';

function row(serverId: string, teamId: string): TeamsDirectoryRow {
    return {
        address: { serverId, teamId },
        homeName: serverId,
        team: { name: teamId, archivedAt: null } as TeamsDirectoryRow['team'],
    };
}

describe('resolveTeamsCollectionLanding', () => {
    it('lands on the Team visited last when it is still listed, otherwise on the first Team', () => {
        const rows = [row('home-a', 'one'), row('home-b', 'two')];
        expect(resolveTeamsCollectionLanding(rows, { serverId: 'home-b', teamId: 'two' })).toEqual({ serverId: 'home-b', teamId: 'two' });
        // The same Team id on another Home is a different Team.
        expect(resolveTeamsCollectionLanding(rows, { serverId: 'home-a', teamId: 'two' })).toEqual({ serverId: 'home-a', teamId: 'one' });
        expect(resolveTeamsCollectionLanding(rows, null)).toEqual({ serverId: 'home-a', teamId: 'one' });
        expect(resolveTeamsCollectionLanding([], null)).toBeNull();
    });
});

describe('resolveTeamsCollectionRows', () => {
    it('keeps an addressed readable Team visible outside the member directory without claiming a complete count', () => {
        const selected = row('home-a', 'administered');
        expect(resolveTeamsCollectionRows([], selected)).toEqual({ rows: [selected], supplemented: true });
        const member = row('home-b', 'member');
        expect(resolveTeamsCollectionRows([member], selected)).toEqual({ rows: [member, selected], supplemented: true });
    });

    it('does not duplicate a member Team or promote an archived Team into the active collection', () => {
        const member = row('home-a', 'member');
        expect(resolveTeamsCollectionRows([member], member)).toEqual({ rows: [member], supplemented: false });
        const archived = { ...member, team: { ...member.team, archivedAt: 1 } };
        expect(resolveTeamsCollectionRows([], archived)).toEqual({ rows: [], supplemented: false });
        expect(resolveTeamsCollectionRows([], null)).toEqual({ rows: [], supplemented: false });
    });
});

describe('resolveSelectedTeamAddress', () => {
    it('reads the Team a collection pathname is about, at any depth below it', () => {
        expect(resolveSelectedTeamAddress('/settings/teams/home-a/team-1')).toEqual({ serverId: 'home-a', teamId: 'team-1' });
        expect(resolveSelectedTeamAddress('/settings/teams/home%20a/team-1/members/m-2/')).toEqual({ serverId: 'home a', teamId: 'team-1' });
        expect(resolveSelectedTeamAddress('/settings/teams')).toBeNull();
        expect(resolveSelectedTeamAddress('/settings/teams/new')).toBeNull();
        expect(resolveSelectedTeamAddress('/settings/agents/claude')).toBeNull();
    });
});

describe('readTeamCredentialSourceHint', () => {
    it('reads a complete share-with-Team source and nothing partial', () => {
        expect(readTeamCredentialSourceHint({
            credentialSourceKind: 'connected_account',
            credentialSourceServerId: 'home-a',
            credentialSourcePluginId: 'plugin',
            credentialSourceLocalId: 'local',
            credentialSourceAccountId: 'acct',
        })).toEqual({
            kind: 'connected_account',
            serverId: 'home-a',
            account: { service: { pluginId: 'plugin', localId: 'local' }, accountId: 'acct' },
        });
        expect(readTeamCredentialSourceHint({
            credentialSourceKind: 'connected_pool',
            credentialSourceServerId: 'home-a',
            credentialSourcePluginId: 'plugin',
            credentialSourceLocalId: 'local',
            credentialSourceGroupId: 'group',
        })).toEqual({
            kind: 'connected_pool',
            serverId: 'home-a',
            service: { pluginId: 'plugin', localId: 'local' },
            groupId: 'group',
        });
        expect(readTeamCredentialSourceHint({
            credentialSourceKind: 'provider_connection',
            credentialSourceServerId: 'home-a',
            credentialSourceConnectionId: 'conn',
            credentialSourceSlotId: 'slot',
            credentialSourceMachineId: 'machine',
            credentialSourceConnectionSecurityFingerprint: 'fp',
        })).toEqual({
            kind: 'provider_connection',
            serverId: 'home-a',
            machineId: 'machine',
            connectionId: 'conn',
            credentialSlotId: 'slot',
            connectionSecurityFingerprint: 'fp',
        });
        expect(readTeamCredentialSourceHint({ credentialSourceKind: 'provider_connection', credentialSourceServerId: 'home-a' })).toBeNull();
        expect(readTeamCredentialSourceHint({})).toBeNull();
    });
});

describe('resolveSelectedTeamMember', () => {
    it('names the open member on a person page and nobody anywhere else in the Team', () => {
        expect(resolveSelectedTeamMember('/settings/teams/home-a/team%201/members/m-7')).toEqual({
            address: { serverId: 'home-a', teamId: 'team 1' },
            membershipId: 'm-7',
        });
        expect(resolveSelectedTeamMember('/settings/teams/home-a/team-1/members/m-7/')).toEqual({
            address: { serverId: 'home-a', teamId: 'team-1' },
            membershipId: 'm-7',
        });
        // The roster itself and the add page are not a person.
        expect(resolveSelectedTeamMember('/settings/teams/home-a/team-1/members')).toBeNull();
        expect(resolveSelectedTeamMember('/settings/teams/home-a/team-1/members/add')).toBeNull();
        expect(resolveSelectedTeamMember('/settings/teams/home-a/team-1/groups/g-1')).toBeNull();
        expect(resolveSelectedTeamMember('/settings/teams')).toBeNull();
    });
});
