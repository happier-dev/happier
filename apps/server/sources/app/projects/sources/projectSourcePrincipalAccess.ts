import type { ProjectSourceGrantV1, ProjectSourceOwnerV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { isTeamPrincipalRoleV1 } from '@happier-dev/protocol/teams';
import type { TeamRole } from '@/storage/enums.generated';
import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { resolveTeamMembershipCapabilitiesV1 } from '@/app/teams/capabilities';
import { EFFECTIVE_TEAM_MEMBERSHIP_WHERE } from '@/app/teams/memberships/effectiveMembership';
import { resolveTeamGroupMembershipsForAccountsInTx } from '@/app/teams/groups/effectiveGroupMembership';

export interface ProjectSourcePrincipalReadContext {
    readonly role: TeamRole;
    readonly manageSettings: boolean;
    readonly groupIds: ReadonlySet<string>;
}

/** A group reference cannot outlive the Source principal scope that admitted it. */
export function projectSourceAdmitsGroup(principals: readonly ProjectSourceGrantV1['principal'][],
    group: Readonly<{ id: string; teamId: string }>,
): boolean {
    return principals.some(principal => principal.kind !== 'account' && principal.teamId === group.teamId
        && (principal.kind === 'team' || principal.groupId === group.id));
}

/** Source reads and selecting referenced principals consume the same visibility rule. */
export function projectSourcePrincipalCanRead(principal: ProjectSourceGrantV1['principal'], accountId: string,
    teamContext: (teamId: string) => ProjectSourcePrincipalReadContext | undefined,
): boolean {
    if (principal.kind === 'account') return principal.accountId === accountId;
    const context = teamContext(principal.teamId);
    if (context?.manageSettings) return true;
    if (!context) return false;
    return principal.kind === 'team' ? isTeamPrincipalRoleV1(context.role) : context.groupIds.has(principal.groupId);
}

/** Validate exact requested identities without enumerating the Source's audience or copying roles. */
export async function admitProjectSourcePrincipalSelectionInTx(tx: Tx,
    input: Readonly<{ owner: ProjectSourceOwnerV1; audience: readonly ProjectSourceGrantV1[];
        accountIds: readonly string[]; teamIds: readonly string[]; groups: readonly Readonly<{ id: string; teamId: string }>[] }>,
): Promise<boolean> {
    const sourcePrincipals = [input.owner, ...input.audience.map(grant => grant.principal)];
    const teamIds = [...new Set(sourcePrincipals.flatMap(principal => principal.kind === 'account' ? [] : [principal.teamId]))];
    // A whole Team is selectable only where the Source itself names that Team.
    const requestedTeamIds = [...new Set(input.teamIds)];
    if (requestedTeamIds.some(teamId => !sourcePrincipals.some(principal => principal.kind === 'team' && principal.teamId === teamId))) return false;
    if (requestedTeamIds.length > 0 && await tx.team.count({ where: { id: { in: requestedTeamIds }, archivedAt: null } }) !== requestedTeamIds.length) return false;
    const eligibleGroupIds = new Set<string>();
    for (const ids of portableQueryChunks({ values: [...new Set(input.groups.map(group => group.id))], bindingsPerValue: 1, fixedBindings: 1 })) {
        const groups = await tx.teamGroup.findMany({ where: { id: { in: [...ids] }, archivedAt: null,
            team: { archivedAt: null } }, select: { id: true, teamId: true } });
        for (const group of groups) {
            if (projectSourceAdmitsGroup(sourcePrincipals, group)
                && input.groups.every(requested => requested.id !== group.id || requested.teamId === group.teamId)) eligibleGroupIds.add(group.id);
        }
    }
    if (input.groups.some(group => !eligibleGroupIds.has(group.id))) return false;
    const accountIds = [...new Set(input.accountIds)];
    const activeAccountIds = new Set<string>();
    for (const ids of portableQueryChunks({ values: accountIds, bindingsPerValue: 1, fixedBindings: 2 })) {
        const accounts = await tx.account.findMany({ where: { id: { in: [...ids] }, status: 'active' }, select: { id: true } });
        accounts.forEach(account => activeAccountIds.add(account.id));
    }
    if (accountIds.some(id => !activeAccountIds.has(id))) return false;
    const directAccountIds = new Set(sourcePrincipals.flatMap(principal => principal.kind === 'account' ? [principal.accountId] : []));
    const teamAccountIds = accountIds.filter(accountId => !directAccountIds.has(accountId));
    if (teamAccountIds.length === 0) return true;
    const contexts = new Map<string, Map<string, Omit<ProjectSourcePrincipalReadContext, 'groupIds'> & { groupIds: Set<string> }>>();
    for (const teamId of teamIds) {
        for (const ids of portableQueryChunks({ values: teamAccountIds, bindingsPerValue: 1, fixedBindings: 4 })) {
            const memberships = await tx.teamMembership.findMany({ where: { ...EFFECTIVE_TEAM_MEMBERSHIP_WHERE,
                teamId, accountId: { in: [...ids] } },
                select: { accountId: true, role: true, status: true, account: { select: { status: true } }, team: { select: { archivedAt: true } } } });
            for (const membership of memberships) {
                let accountContexts = contexts.get(membership.accountId);
                if (!accountContexts) { accountContexts = new Map(); contexts.set(membership.accountId, accountContexts); }
                accountContexts.set(teamId, { role: membership.role, groupIds: new Set(),
                    manageSettings: resolveTeamMembershipCapabilitiesV1({ accountStatus: membership.account.status,
                        membership, teamArchivedAt: membership.team.archivedAt }).manageSettings });
            }
        }
        const groups = await resolveTeamGroupMembershipsForAccountsInTx(tx, { teamId, accountIds: teamAccountIds });
        for (const group of groups) {
            if (!group.effective) continue;
            contexts.get(group.accountId)?.get(teamId)?.groupIds.add(group.teamGroupId);
        }
    }
    // This is structural eligibility of references. At dispatch the real actor's
    // credential is independently qualified by the existing Source admission.
    return teamAccountIds.every(accountId => sourcePrincipals.some(principal =>
        projectSourcePrincipalCanRead(principal, accountId, teamId => contexts.get(accountId)?.get(teamId))));
}
