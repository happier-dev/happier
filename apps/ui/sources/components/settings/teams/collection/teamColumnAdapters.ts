import type { TeamGroupV1, TeamMembershipV1, TeamCredentialResourceSummaryV1 } from '@happier-dev/protocol/teams';
import { teamAddressKey, type TeamAddress } from '@/sync/domains/teams/teamAddress';
import { defineSettingsCollectionAdapter, type SettingsCollectionRowFacts } from '../../shell/settingsCollectionAdapter';
import type { TeamsDirectoryRow } from '../teamsDirectoryViewState';

export const teamColumnAdapter = defineSettingsCollectionAdapter(['home', 'status']);
export const teamMemberColumnAdapter = defineSettingsCollectionAdapter(['status']);
export const teamGroupColumnAdapter = defineSettingsCollectionAdapter(['status']);
export const teamInvitationColumnAdapter = defineSettingsCollectionAdapter(['status']);
export const teamCredentialColumnAdapter = defineSettingsCollectionAdapter(['status']);
export const teamDirectoryColumnAdapter = defineSettingsCollectionAdapter(['status']);

export function teamColumnFacts(row: TeamsDirectoryRow): SettingsCollectionRowFacts<'home' | 'status'> {
    const status = row.team.archivedAt === null ? 'active' : 'archived';
    return { key: teamAddressKey(row.address), title: row.team.name, context: row.homeName, status,
        fields: { home: [row.address.serverId], status: [status] } };
}
export function teamMemberColumnFacts(address: TeamAddress, row: TeamMembershipV1, presentation: Readonly<{
    name: string; context: string | null;
}>): SettingsCollectionRowFacts<'status'> {
    return { key: `${teamAddressKey(address)}:member:${row.id}`, title: presentation.name, context: presentation.context,
        status: row.status, fields: { status: [row.status] } };
}
export function teamGroupColumnFacts(address: TeamAddress, row: TeamGroupV1, context: string | null): SettingsCollectionRowFacts<'status'> {
    const status = row.archivedAt === null ? 'active' : 'archived';
    return { key: `${teamAddressKey(address)}:group:${row.id}`, title: row.name, context, status, count: row.memberCount,
        fields: { status: [status] } };
}
/** Resource privacy/availability is decided by resourceAdministrationSummaryLines, not Team-wide permission. */
export function teamCredentialColumnFacts(address: TeamAddress, row: TeamCredentialResourceSummaryV1, presentation: Readonly<{
    context: string | null; status: string | null;
}>): SettingsCollectionRowFacts<'status'> {
    return { key: `${teamAddressKey(address)}:credential:${row.id}`, title: row.displayName,
        context: presentation.context, status: presentation.status,
        fields: { status: presentation.status ? [presentation.status] : null } };
}
/** Invitation and directory projections already include delivery/expiry and source admission. */
export function teamAdministrationColumnFacts(address: TeamAddress, kind: 'invitation' | 'directory', row: Readonly<{
    id: string; title: string; context: string | null; status: string | null;
}>): SettingsCollectionRowFacts<'status'> {
    return { key: `${teamAddressKey(address)}:${kind}:${row.id}`, title: row.title, context: row.context, status: row.status,
        fields: { status: row.status ? [row.status] : null } };
}
