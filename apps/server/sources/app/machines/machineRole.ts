import { decodeMachineStoredContent, withMachineContentSelect } from '@/storage/sessionMachineStoredContent';
import type { Prisma } from '@prisma/client';
import type { MachineAccessRoleV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { projectResourceGrantRows, resourceGrantRelationsSelect, iterateResourceGrantPrincipalAccountIdsFromFacts } from '@/app/teams/resourceGrantAccess';
import { isEffectiveTeamMembership } from '@/app/teams/memberships/effectiveMembership';
import { isEffectiveTeamGroupMembership } from '@/app/teams/groups/effectiveGroupMembership';
import { resolveAccountDisplayLabelV1 } from '@/app/account/profile/accountDisplayProfile';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { Tx } from '@/storage/inTx';
import { inheritManagedControllerRole } from './managed/managedRole';
import type { MachineAdmissionFacts as MachineAdmissionStorageFacts } from './machineAccess';
type MachineAdmissionFacts = MachineAdmissionStorageFacts & ReturnType<typeof projectResourceGrantRows<MachineAdmissionStorageFacts['grants'][number]>>;

/** Machine identity extends the shared stored-grant projection. */
export function machineGrantRelationsSelect(actorAccountId?: string) {
    const { grants } = resourceGrantRelationsSelect(actorAccountId);
    return { grants: { ...grants, select: { ...grants.select,
        teamGroup: { select: { ...grants.select.teamGroup.select, teamId: true } },
    } } } as const;
}

// Bulk role maps need current permission facts, not Machine content or key material.
export const MACHINE_PERMISSION_FACTS_SELECT = {
    id: true, kind: true, accountId: true,
    managedResource: { select: { custodianAccountId: true, controllerMachineId: true } },
    account: { select: { status: true } },
    ...machineGrantRelationsSelect(),
} as const;
type MachinePermissionRow = Prisma.MachineGetPayload<{ select: typeof MACHINE_PERMISSION_FACTS_SELECT }>;
type MachinePermissionFacts = MachinePermissionRow & ReturnType<typeof projectResourceGrantRows<MachinePermissionRow['grants'][number]>>;

export function buildMachineActorPermissionFactsSelect(actorAccountId: string) {
    return { ...MACHINE_PERMISSION_FACTS_SELECT, ...machineGrantRelationsSelect(actorAccountId) } as const;
}

export type Contribution = Readonly<{
    principal: PrincipalRefV1;
    level: 'view' | 'admin';
    /** Team and Account names remain server-readable; Group names do not. */
    displayName: string | null;
    /** Opaque stored Group label, projected only by the recipient-facing roster. */
    groupNameSerialized?: string;
    accountIds: readonly string[];
}>;

export function contributions(row: MachinePermissionFacts | MachineAdmissionFacts): Contribution[] {
    return [
        ...row.accountGrants.map(grant => ({ principal: { kind: 'account' as const, accountId: grant.accountId }, level: grant.accessLevel,
            displayName: resolveAccountDisplayLabelV1('name' in grant.account ? grant.account : {}),
            accountIds: [...iterateResourceGrantPrincipalAccountIdsFromFacts({ kind: 'account', accountId: grant.accountId,
                active: grant.account.status === 'active' })] })),
        ...row.teamGrants.map(grant => ({ principal: { kind: 'team' as const, teamId: grant.teamId }, level: grant.accessLevel,
            displayName: 'name' in grant.team ? grant.team.name : null,
            accountIds: [...iterateResourceGrantPrincipalAccountIdsFromFacts({ kind: 'team', memberships: grant.team.memberships.map(member => ({
                accountId: member.accountId, role: member.role, effective: isEffectiveTeamMembership({
                    accountStatus: member.account.status, membershipStatus: member.status, teamArchivedAt: grant.team.archivedAt,
                }),
            })) })] })),
        ...row.groupGrants.map(grant => ({ principal: { kind: 'group' as const, teamId: grant.teamGroup.teamId, groupId: grant.teamGroupId }, level: grant.accessLevel,
            displayName: null, groupNameSerialized: 'name' in grant.teamGroup ? grant.teamGroup.name : undefined,
            accountIds: [...iterateResourceGrantPrincipalAccountIdsFromFacts({ kind: 'group', memberships: grant.teamGroup.memberships.map(({ teamMembership: member }) => ({
                accountId: member.accountId, effective: isEffectiveTeamGroupMembership({
                    accountStatus: member.account.status, membershipStatus: member.status,
                    teamArchivedAt: grant.teamGroup.team.archivedAt, groupArchivedAt: grant.teamGroup.archivedAt,
                }),
            })) })] })),
    ];
}
function directRole(row: MachinePermissionFacts, actorAccountId: string, sources?: readonly Contribution[]): MachineAccessRoleV1 | null {
    if (row.accountId === actorAccountId) return row.account.status === 'active' ? 'manage' : null;
    if (row.kind !== 'persistent') return null;
    let role: MachineAccessRoleV1 | null = null;
    for (const source of sources ?? contributions(row)) if (source.accountIds.includes(actorAccountId)) {
        if (source.level === 'admin') return 'manage';
        role = 'use';
    }
    return role;
}

/** Acquire the controller closure in sets. Repeated/cyclic references are read once. */
export async function readMachineRoleGraphInTx(tx: Tx, machines: readonly MachinePermissionFacts[], accountIds: readonly string[]) {
    const graph = new Map(machines.map(row => [row.id, row]));
    const visited = new Set(graph.keys());
    let pending = machines.flatMap(row => row.managedResource?.controllerMachineId ? [row.managedResource.controllerMachineId] : []);
    while (pending.length > 0) {
        const ids = [...new Set(pending)].filter(id => !visited.has(id));
        if (ids.length === 0) break;
        for (const id of ids) visited.add(id);
        pending = [];
        const select = accountIds.length === 1 ? buildMachineActorPermissionFactsSelect(accountIds[0]) : MACHINE_PERMISSION_FACTS_SELECT;
        for (const chunk of portableQueryChunks({ values: ids, bindingsPerValue: 1, fixedBindings: accountIds.length === 1 ? 12 : 9 })) {
            const rows = await tx.machine.findMany({ where: { id: { in: [...chunk] } }, select: withMachineContentSelect(select) }).then(decodeMachineStoredContent);
            for (const row of rows) {
                graph.set(row.id, { ...row, ...projectResourceGrantRows(row.grants) });
                if (row.managedResource?.controllerMachineId) pending.push(row.managedResource.controllerMachineId);
            }
        }
    }
    return graph;
}

/** Least fixed point: only actual owner/guest grants seed Manage, including in cycles. */
export function projectMachineRoles(graph: ReadonlyMap<string, MachinePermissionFacts>, accountIds: readonly string[],
    overrides?: ReadonlyMap<string, readonly Contribution[]>): Map<string, Map<string, MachineAccessRoleV1 | null>> {
    const roles = new Map([...graph].map(([id, row]) => {
        const sources = overrides?.get(id) ?? contributions(row);
        return [id, new Map(accountIds.map(accountId => [accountId, directRole(row, accountId, sources)]))];
    }));
    return inheritMachineRoles(graph, roles, accountIds);
}

/** Workload authority is the Team grant itself, never one member's personal grant. */
export function projectMachineTeamRoles(graph: ReadonlyMap<string, MachinePermissionFacts>, teamId: string): Map<string, MachineAccessRoleV1 | null> {
    const roles = new Map([...graph].map(([id, row]) => {
        const grant = row.kind === 'persistent' ? row.teamGrants.find(candidate => candidate.teamId === teamId
            && candidate.team.archivedAt === null) : undefined;
        const role: MachineAccessRoleV1 | null = grant ? grant.accessLevel === 'admin' ? 'manage' : 'use' : null;
        return [id, new Map([[teamId, role]])];
    }));
    return new Map([...inheritMachineRoles(graph, roles, [teamId])].map(([id, map]) => [id, map.get(teamId) ?? null]));
}

function inheritMachineRoles(graph: ReadonlyMap<string, MachinePermissionFacts>,
    roles: Map<string, Map<string, MachineAccessRoleV1 | null>>, accountIds: readonly string[]) {
    const children = new Map<string, string[]>();
    const pending: Array<Readonly<{ machineId: string; accountId: string }>> = [];
    for (const [id, row] of graph) {
        const controller = row.managedResource?.controllerMachineId;
        if (controller && row.kind === 'persistent') {
            const siblings = children.get(controller) ?? [];
            siblings.push(id);
            children.set(controller, siblings);
        }
        for (const accountId of accountIds) if (roles.get(id)?.get(accountId) === 'manage') pending.push({ machineId: id, accountId });
    }
    for (let index = 0; index < pending.length; index += 1) {
        const { machineId, accountId } = pending[index];
        for (const id of children.get(machineId) ?? []) {
            const current = roles.get(id)!.get(accountId) ?? null;
            const role = inheritManagedControllerRole(roles.get(machineId)?.get(accountId) ?? null, current);
            if (role === current) continue;
            roles.get(id)!.set(accountId, role);
            pending.push({ machineId: id, accountId });
        }
    }
    return roles;
}

/** Candidate discovery and grant/membership effects follow the same stored controller edges. */
export async function expandMachineIdsWithManagedGuestsInTx(tx: Tx, machineIds: readonly string[]): Promise<string[]> {
    const result = new Set(machineIds);
    let pending = [...result];
    while (pending.length > 0) {
        const next: string[] = [];
        for (const ids of portableQueryChunks({ values: pending, bindingsPerValue: 1 })) {
            const guests = await tx.managedMachine.findMany({ where: { controllerMachineId: { in: [...ids] }, enrolledMachineId: { not: null } },
                select: { enrolledMachineId: true } });
            for (const guest of guests) if (guest.enrolledMachineId && !result.has(guest.enrolledMachineId)) {
                result.add(guest.enrolledMachineId); next.push(guest.enrolledMachineId);
            }
        }
        pending = next;
    }
    return [...result].sort();
}
