import * as privacyKit from 'privacy-kit';
import type { Prisma } from '@prisma/client';
import type { TaskResourceAddressV1 } from '@happier-dev/protocol/actions/internalTaskActions';
import { internalTaskAddressFromRefV1, type TriageEntryRefV1 } from '@happier-dev/protocol/tasks/entryRefV1';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { Tx } from '@/storage/inTx';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { deriveAccountRecipientEnvelopeReadinessFromRow } from '@/app/encryption/accountRecipientEnvelopeReadiness';
import { RECIPIENT_READINESS_SELECT } from '@/app/session/encryption/sessionDataKeyRecipientProjection';
import { resolveQualifiedSessionTeamIdsInTx, type SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { AccountJsonKvStoredContentModeMismatchError, assertAccountJsonKvStoredContentMatchesAccountMode,
    classifyAccountJsonKvStoredContent } from '@/app/kv/accountJsonKvStoredContent';
import { resourceGrantRelationsSelect, projectResourceGrantRows, resolveResourceGrantAudienceInTx,
    resolveResourceGrantAccessFromFacts, resolveResourceGrantAudienceFromFacts, projectResourceRecipientEnvelope,
    type ResourceGrantAccess, type ResourceGrantAccessDecision, type ResourceGrantAccessFacts,
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

/** Background mention/delivery reads exact Task grant rows for a set of Accounts. */
export async function resolveTaskGrantAccessForAccountsInTx(tx: Tx, input: Readonly<{
    resourceIds: readonly string[]; accountIds: readonly string[]; authentication: SessionAccessAuthentication;
}>): Promise<ReadonlyMap<string, ReadonlyMap<string, TaskGrantAdmission>>> {
    const accountIds = [...new Set(input.accountIds)];
    if (accountIds.length === 0) return new Map();
    const rows: TaskCredentialFacts[] = [];
    for (const ids of portableQueryChunks({ values: [...new Set(input.resourceIds)], bindingsPerValue: 1, fixedBindings: 2 })) {
        rows.push(...await tx.userKVStore.findMany({ where: { id: { in: [...ids] }, ...taskRowsWhere }, select: taskCredentialFactsSelect() }));
    }
    const candidates = rows.flatMap(row => {
        const facts = taskGrantFacts(row);
        return accountIds.map(accountId => taskGrantCandidate(facts, accountId));
    });
    const admitted = await qualifyTaskGrantCandidatesInTx(tx, candidates, input.authentication);
    return new Map(rows.map((row, rowIndex) => [row.id,
        new Map(accountIds.map((accountId, accountIndex) => [accountId, admitted[rowIndex * accountIds.length + accountIndex]!])),
    ]));
}

export type TaskAnchorContext = Readonly<{
    address: TaskResourceAddressV1;
    row: Readonly<{ id: string; key: string }>;
    access: ResourceGrantAccess & Readonly<{ encryptionMode: 'plain' | 'e2ee' }>;
    audienceAccountIds?: readonly string[];
    key?: Readonly<{ kind: 'plain' }> | Readonly<{ kind: 'promotion_required' }> | Readonly<{ kind: 'task'; encryptedDataKey: string | null }>;
}>;
export type TaskAnchorAdmission = TaskGrantRefusal | Readonly<{ ok: false; error: 'task_content_unavailable' }>
    | Readonly<{ ok: true; value: TaskAnchorContext }>;
type TaskAnchorQuery = TaskCredentialInput & Readonly<{ includeAudience?: boolean; includeKey?: boolean }>;

/** Resolve only exact anchor addresses, omitting body and key columns for access-only readers. */
export async function resolveTaskAnchorsInTx(
    tx: Tx, input: TaskAnchorQuery & Readonly<{ refs: readonly TriageEntryRefV1[] }>,
): Promise<ReadonlyMap<TriageEntryRefV1, TaskAnchorAdmission>> {
    const result = new Map<TriageEntryRefV1, TaskAnchorAdmission>();
    const addressKey = (ownerAccountId: string, key: string) => JSON.stringify([ownerAccountId, key]);
    const addresses = new Map<string, { accountId: string; key: string }>();
    const targets: { ref: TriageEntryRefV1; address: TaskResourceAddressV1; key: string }[] = [];
    for (const ref of input.refs) {
        const address = internalTaskAddressFromRefV1(ref, input.actorAccountId);
        if (!address) { result.set(ref, taskNotFound); continue; }
        const key = `todo.${address.taskId}`;
        const lookup = addressKey(address.ownerAccountId, key);
        addresses.set(lookup, { accountId: address.ownerAccountId, key });
        targets.push({ ref, address, key: lookup });
    }
    if (!targets.length) return result;
    const select = { ...taskCredentialFactsSelect(input.includeAudience ? undefined : input.actorAccountId), key: true,
        ...(input.includeKey ? { value: true, keyEnvelopes: { where: { recipientAccountId: input.actorAccountId }, select: {
            recipientAccountId: true, encryptedDataKey: true, recipientContentPublicKeyFingerprint: true,
        } } } : {}),
    } as const;
    type AnchorRow = Prisma.UserKVStoreGetPayload<{ select: typeof select }>;
    const rows: AnchorRow[] = [];
    for (const chunk of portableQueryChunks({ values: [...addresses.values()], bindingsPerValue: 2, fixedBindings: 6 })) {
        rows.push(...await tx.userKVStore.findMany({ where: { OR: [...chunk], value: { not: null } }, select }));
    }
    const byAddress = new Map(rows.map(row => [addressKey(row.accountId, row.key), row]));
    const admissions = await resolveTaskGrantAdmissionsForRowsInTx(tx, rows, input);
    const needsRecipient = input.includeKey && rows.some(row => admissions.get(row.id)?.ok && row.keyEnvelopes?.length);
    const caller = needsRecipient ? await tx.account.findUnique({ where: { id: input.actorAccountId }, select: RECIPIENT_READINESS_SELECT }) : null;
    const readiness = caller ? deriveAccountRecipientEnvelopeReadinessFromRow(caller) : undefined;
    for (const { ref, address, key: lookup } of targets) {
        const row = byAddress.get(lookup);
        const admission = row ? admissions.get(row.id) : undefined;
        if (!row || !admission?.ok) { result.set(ref, admission ?? taskNotFound); continue; }
        const { encryptionMode, level, ownerAccountId } = admission.value;
        const unavailable = { ok: false, error: 'task_content_unavailable' } as const;
        if (!encryptionMode) { result.set(ref, unavailable); continue; }
        const value: TaskAnchorContext = { address, row: { id: row.id, key: row.key },
            access: { ownerAccountId, level, encryptionMode },
            ...(input.includeAudience ? { audienceAccountIds: resolveResourceGrantAudienceFromFacts(taskGrantFacts(row)) } : {}),
        };
        if (!input.includeKey) { result.set(ref, { ok: true, value }); continue; }
        if (!row.value) { result.set(ref, unavailable); continue; }
        try {
            assertAccountJsonKvStoredContentMatchesAccountMode({ key: row.key, value: row.value, accountMode: encryptionMode, usage: 'task_resource' });
        } catch (error) {
            if (!(error instanceof AccountJsonKvStoredContentModeMismatchError)) throw error;
            result.set(ref, unavailable);
            continue;
        }
        const body = classifyAccountJsonKvStoredContent({ key: row.key, value: row.value });
        if (encryptionMode === 'plain') result.set(ref, { ok: true, value: { ...value, key: { kind: 'plain' } } });
        else if (body.domain !== 'generic' && body.representation === 'current_resource_encrypted') {
            const envelope = row.keyEnvelopes[0];
            const key = caller && envelope ? projectResourceRecipientEnvelope(caller, envelope, readiness) : null;
            result.set(ref, { ok: true, value: { ...value, key: { kind: 'task', encryptedDataKey: key ? privacyKit.encodeBase64(key) : null } } });
        } else if (value.access.level === 'owner') {
            result.set(ref, { ok: true, value: { ...value, key: { kind: 'promotion_required' } } });
        } else result.set(ref, unavailable);
    }
    return result;
}

export async function resolveTaskAnchorInTx(tx: Tx, input: TaskAnchorQuery & Readonly<{ ref: TriageEntryRefV1 }>): Promise<TaskAnchorAdmission> {
    return (await resolveTaskAnchorsInTx(tx, { ...input, refs: [input.ref] })).get(input.ref) ?? taskNotFound;
}
