import type { Prisma } from '@prisma/client';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { Tx } from '@/storage/inTx';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { resolveQualifiedSessionTeamIdsInTx, type SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { resourceGrantRelationsSelect, projectResourceGrantRows, resolveResourceGrantAudienceInTx,
    resolveResourceGrantAccessFromFacts, type ResourceGrantAccessDecision, type ResourceGrantAccessFacts,
    type ResourceGrantStorageAdapter } from '@/app/teams/resourceGrantAccess';

export const taskRowsWhere = { key: { startsWith: 'todo.', not: 'todo.index' }, value: { not: null } } as const;

export function taskAccessFactsSelect(actorAccountId?: string) {
    return { id: true, accountId: true, account: { select: { encryptionMode: true } },
        ...resourceGrantRelationsSelect(actorAccountId) } as const;
}

async function readTaskAccessFactsBatchInTx(tx: Tx, resourceIds: readonly string[], actorAccountId?: string) {
    return tx.userKVStore.findMany({ where: { id: { in: [...resourceIds] }, ...taskRowsWhere }, select: taskAccessFactsSelect(actorAccountId) });
}

export type TaskAccessFacts = Awaited<ReturnType<typeof readTaskAccessFactsBatchInTx>>[number];

export function taskGrantFacts<Grant extends TaskAccessFacts['grants'][number]>(
    row: Omit<TaskAccessFacts, 'grants'> & Readonly<{ grants: readonly Grant[] }>,
) {
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(row.account);
    return { ownerAccountId: row.accountId, encryptionMode: mode.status === 'ready' ? mode.mode : null,
        ...projectResourceGrantRows(row.grants) } satisfies ResourceGrantAccessFacts;
}

/** The task adapter supplies grant facts without loading task content or envelopes. */
export const taskGrantStorageAdapter: ResourceGrantStorageAdapter = {
    async readAccessFactsBatchInTx(tx, resourceIds, actorAccountId) {
        const facts = new Map<string, ResourceGrantAccessFacts>();
        for (const ids of portableQueryChunks({ values: [...new Set(resourceIds)], bindingsPerValue: 1,
            fixedBindings: 2 + (actorAccountId === undefined ? 0 : 3) })) {
            for (const row of await readTaskAccessFactsBatchInTx(tx, ids, actorAccountId)) facts.set(row.id, taskGrantFacts(row));
        }
        return facts;
    },
    async readAccessFactsInTx(tx, resourceId, actorAccountId) {
        return (await taskGrantStorageAdapter.readAccessFactsBatchInTx(tx, [resourceId], actorAccountId)).get(resourceId) ?? null;
    },
};

/** Conversion, publication and key preparation consume the same live grant policy. */
export async function resolveTaskAudienceInTx(tx: Tx, resourceId: string): Promise<string[]> {
    return resolveResourceGrantAudienceInTx(tx, taskGrantStorageAdapter, resourceId);
}

export function taskCredentialFactsSelect(actorAccountId?: string) {
    const facts = taskAccessFactsSelect(actorAccountId);
    const grants = facts.grants.select;
    return { ...facts, grants: { ...facts.grants, select: { ...grants,
        team: { select: { ...grants.team.select, id: true, authenticationPolicy: true } },
        teamGroup: { select: { ...grants.teamGroup.select, team: { select: {
            ...grants.teamGroup.select.team.select, id: true, authenticationPolicy: true,
        } } } },
    } } } as const;
}

type TaskCredentialFacts = Prisma.UserKVStoreGetPayload<{ select: ReturnType<typeof taskCredentialFactsSelect> }>;
type TaskCredentialInput = Readonly<{ actorAccountId: string; authentication: SessionAccessAuthentication }>;
type TaskGrantRefusal = Readonly<{ ok: false; error: 'task_not_found' | 'team_authentication_required' }>;
export type TaskGrantAdmission = TaskGrantRefusal | Readonly<{ ok: true; value: ResourceGrantAccessDecision }>;
const taskNotFound = { ok: false, error: 'task_not_found' } as const;

function taskGrantCandidate(facts: ReturnType<typeof taskGrantFacts<TaskCredentialFacts['grants'][number]>>, actorAccountId: string) {
    const structural = resolveResourceGrantAccessFromFacts(facts, actorAccountId);
    const teamIds = new Set(structural?.matchedGrants.flatMap(grant => grant.kind === 'team' ? [grant.teamId] : []));
    const groupIds = new Set(structural?.matchedGrants.flatMap(grant => grant.kind === 'group' ? [grant.teamGroupId] : []));
    const teams = [
        ...facts.teamGrants.filter(grant => teamIds.has(grant.teamId)).map(grant => grant.team),
        ...facts.groupGrants.filter(grant => groupIds.has(grant.teamGroupId)).map(grant => grant.teamGroup.team),
    ];
    return { facts, structural, teams, actorAccountId };
}

async function qualifyTaskGrantCandidatesInTx(tx: Tx, candidates: readonly ReturnType<typeof taskGrantCandidate>[],
    authentication: SessionAccessAuthentication): Promise<TaskGrantAdmission[]> {
    const teams = new Map(candidates.flatMap(item => item.teams.map(team => [team.id, team] as const)));
    const qualified = await resolveQualifiedSessionTeamIdsInTx(tx, {
        accountIds: candidates.map(candidate => candidate.actorAccountId), teams: [...teams.values()], authentication,
    });
    return candidates.map(({ facts, structural, teams, actorAccountId }) => {
        if (!structural) return taskNotFound;
        if (teams.every(team => qualified.has(team.id))) return { ok: true, value: structural };
        const admitted = resolveResourceGrantAccessFromFacts({ ...facts,
            teamGrants: facts.teamGrants.filter(grant => qualified.has(grant.team.id)),
            groupGrants: facts.groupGrants.filter(grant => qualified.has(grant.teamGroup.team.id)),
        }, actorAccountId);
        return admitted ? { ok: true, value: admitted } : { ok: false, error: 'team_authentication_required' };
    });
}

/** A credential qualifies the live collective contributions once across the exact Task set. */
export async function resolveTaskGrantAdmissionsForRowsInTx(
    tx: Tx, rows: readonly TaskCredentialFacts[], input: TaskCredentialInput,
): Promise<ReadonlyMap<string, TaskGrantAdmission>> {
    const candidates = rows.map(row => taskGrantCandidate(taskGrantFacts(row), input.actorAccountId));
    const admitted = await qualifyTaskGrantCandidatesInTx(tx, candidates, input.authentication);
    return new Map(rows.map((row, index) => [row.id, admitted[index]!]));
}
