import type { MachinePoolAccessV1, MachinePoolAudienceV1 } from '@happier-dev/protocol/machines/pools/v1';
import type { Tx } from '@/storage/inTx';
import {
    resolveTeamActorContextInTx, resolveTeamActorContextsInTx,
    qualifyTeamOperationAuthenticationInTx, qualifyTeamOperationAuthenticationsInTx,
    type TeamOperationAuthenticationContext,
} from '@/app/teams/actorContext';
import { readTeamResourcePublicationAudienceInTx } from '@/app/teams/resourcePublicationAudience';

export type MachinePoolActor = Readonly<{ accountId: string; authentication?: Partial<TeamOperationAuthenticationContext> }>;
export type MachinePoolIdentity = Readonly<{ accountId: string; teamId: string | null }>;

export const CUSTODIAN_POOL_ACCESS = { canManage: true, canResolve: true, canViewMembers: true } as const;
export const TEAM_POOL_ACCESS = { canManage: false, canResolve: false, canViewMembers: false } as const;

export function machinePoolAudience(pool: MachinePoolIdentity): MachinePoolAudienceV1 {
    return pool.teamId ? { kind: 'team', teamId: pool.teamId } : { kind: 'private' };
}

/** Team-derived access is decided by the same current membership/authentication owner as presets. */
export async function resolveMachinePoolAccessInTx(tx: Tx, actor: MachinePoolActor,
    pool: MachinePoolIdentity): Promise<MachinePoolAccessV1 | null> {
    if (actor.accountId === pool.accountId) return CUSTODIAN_POOL_ACCESS;
    if (!pool.teamId) return null;
    return await canReadMachinePoolTeamInTx(tx, actor, pool.teamId) ? TEAM_POOL_ACCESS : null;
}

export async function canReadMachinePoolTeamInTx(tx: Tx, actor: MachinePoolActor, teamId: string): Promise<boolean> {
    const context = await resolveTeamActorContextInTx(tx, { teamId, actorAccountId: actor.accountId });
    return Boolean(context && context.team.archivedAt === null && context.teamCapabilities.viewTeam
        && (await qualifyTeamOperationAuthenticationInTx(tx, { ...actor.authentication, context })).ok);
}

/** Resolve a whole list's Team witnesses once, without one membership query per pool. */
export async function readableMachinePoolTeamsInTx(tx: Tx, actor: MachinePoolActor): Promise<readonly string[]> {
    const memberships = await tx.teamMembership.findMany({ where: { accountId: actor.accountId }, select: { teamId: true } });
    const contexts = await resolveTeamActorContextsInTx(tx, { actorAccountId: actor.accountId, teamIds: memberships.map(row => row.teamId) });
    const readable = [...contexts.values()].filter(context => context.team.archivedAt === null && context.teamCapabilities.viewTeam);
    const qualifications = await qualifyTeamOperationAuthenticationsInTx(tx, { ...actor.authentication, contexts: readable });
    return readable.flatMap(context => qualifications.get(context.team.id)?.ok ? [context.team.id] : []);
}

/** Only a custodian who currently administers a Team can publish their pool to it. */
export async function canSetMachinePoolAudienceInTx(tx: Tx, actor: MachinePoolActor,
    audience: MachinePoolAudienceV1 | undefined): Promise<boolean> {
    if (!audience || audience.kind === 'private') return true;
    const context = await resolveTeamActorContextInTx(tx, { teamId: audience.teamId, actorAccountId: actor.accountId });
    return Boolean(context && context.team.archivedAt === null && context.teamCapabilities.manageSettings
        && (await qualifyTeamOperationAuthenticationInTx(tx, { ...actor.authentication, context })).ok);
}

export async function readMachinePoolPublicationAudienceInTx(tx: Tx, pool: MachinePoolIdentity): Promise<readonly string[]> {
    return [...new Set([pool.accountId, ...(pool.teamId ? await readTeamResourcePublicationAudienceInTx(tx, pool.teamId) : [])])];
}
