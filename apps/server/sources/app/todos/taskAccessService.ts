import * as privacyKit from 'privacy-kit';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { ResourceRecipientKeyEnvelopeInputV1 } from '@happier-dev/protocol/teams/resourceGrantAccessV1';
import { listOwedResourceRecipientsV1, summarizeResourceRecipientReadinessV1 } from '@happier-dev/protocol/teams/resourceRecipientKeyPreparationV1';
import type { TaskAccessGrantSetRequestV1, TaskAccessGrantRemoveRequestV1, TaskAccessGrantsListResponseV1,
    TaskAccessGrantMutationResponseV1, TaskAccessRecipientCensusResponseV1, TaskRecipientKeyEnvelopeCommitInputV1,
    TaskRecipientKeyEnvelopeCommitResponseV1, TaskResourcePromotionV1, TaskAccessGrantRowV1, TaskOwedRecipientCensusPageV1 } from '@happier-dev/protocol/actions/internalTaskActions';
import { inTx, inReadSnapshot, type Tx } from '@/storage/inTx';
import { applyUserKvMutationsInTx } from '@/app/kv/kvMutate';
import { assertAccountJsonKvMutationStoredContent, classifyAccountJsonKvStoredContent,
    AccountJsonKvStoredContentModeMismatchError } from '@/app/kv/accountJsonKvStoredContent';
import { deriveAccountRecipientEnvelopeReadinessFromRow } from '@/app/encryption/accountRecipientEnvelopeReadiness';
import { RECIPIENT_READINESS_SELECT } from '@/app/session/encryption/sessionDataKeyRecipientProjection';
import { ACCOUNT_DISPLAY_PROFILE_SELECT, projectAccountDisplayProfileV1, resolveAccountDisplayLabelV1 } from '@/app/account/profile/accountDisplayProfile';
import { applyResourceRecipientKeyEnvelopesInTx, mayManageResourceGrants, projectResourceRecipientCensus,
    projectResourceRecipientCensusRow, projectResourceRecipientEnvelope, readResourceGrantPrincipalAudienceInTx,
    validateResourceGrantPrincipalInTx, validateResourceRecipientEnvelopeCommit,
    resourceGrantRelationsSelect, projectResourceGrantRows, resolveResourceGrantAudienceFromFacts,
    type ResourceGrantAccessFacts, type ResourceRecipientEnvelopeStorageAdapter } from '@/app/teams/resourceGrantAccess';
import { resolveTaskAudienceInTx, taskGrantStorageAdapter, taskRowsWhere } from './taskGrantStorageAdapter';
import { projectTeamGroupNameForRecipient } from '@/app/teams/groups/privateLabels';
import { lockTaskMutationInTx, projectTaskContent, resolveTaskContextInTx, type TaskActorInput, type TaskContext, type TaskResult } from './taskResourceService';
import { publishTaskChangedInTx } from './taskChanges';

/** Per-resource storage plumbing; recipient readiness and grant authority remain shared owners. */
export const taskRecipientEnvelopeStorageAdapter: ResourceRecipientEnvelopeStorageAdapter<ResourceRecipientKeyEnvelopeInputV1> = {
    ...taskGrantStorageAdapter,
    async writeRecipientEnvelopeInTx(tx, taskId, envelope) {
        const where = { taskId_recipientAccountId: { taskId, recipientAccountId: envelope.recipientAccountId } };
        const data = { encryptedDataKey: privacyKit.decodeBase64(envelope.encryptedDataKey),
            recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint };
        await tx.taskKeyEnvelope.upsert({ where, create: { ...where.taskId_recipientAccountId, ...data }, update: data });
    },
    async publishRecipientsChangedInTx(tx, resourceId, accountIds) {
        if (accountIds.length) await publishTaskChangedInTx(tx, resourceId);
    },
};

async function readPrincipalGrantInTx(tx: Tx, taskId: string, principal: PrincipalRefV1) {
    return principal.kind === 'account'
        ? tx.taskGrant.findUnique({ where: { taskId_accountId: { taskId, accountId: principal.accountId } } })
        : principal.kind === 'team'
            ? tx.taskGrant.findUnique({ where: { taskId_teamId: { taskId, teamId: principal.teamId } } })
            : tx.taskGrant.findUnique({ where: { taskId_teamGroupId: { taskId, teamGroupId: principal.groupId } } });
}

/** Census and roster share one captured readiness derivation and envelope load. */
async function readTaskRecipientFactsInTx(tx: Tx, taskId: string, audience: readonly string[]) {
    const [accounts, envelopes] = await Promise.all([
        tx.account.findMany({ where: { id: { in: [...audience] } }, select: RECIPIENT_READINESS_SELECT, orderBy: { id: 'asc' } }),
        tx.taskKeyEnvelope.findMany({ where: { taskId } }),
    ]);
    return { projectedAccounts: accounts.map(account => ({ account, readiness: deriveAccountRecipientEnvelopeReadinessFromRow(account) })), envelopes };
}

/** An admitted caller may inspect the explicit grant roster without receiving any content keys. */
export async function listTaskGrantsInTx(tx: Tx, input: TaskActorInput): Promise<TaskResult<TaskAccessGrantsListResponseV1>> {
    const context = await resolveTaskContextInTx(tx, input);
    if (!context) return { ok: false, error: 'task_not_found' };
    const taskId = context.row.id;
    const relations = resourceGrantRelationsSelect();
    const storedGrants = await tx.taskGrant.findMany({ where: { taskId }, select: {
        ...relations.grants.select, createdByAccountId: true, createdAt: true,
        account: { select: { ...relations.grants.select.account.select, ...ACCOUNT_DISPLAY_PROFILE_SELECT } },
        team: { select: { ...relations.grants.select.team.select, name: true } },
        teamGroup: { select: { ...relations.grants.select.teamGroup.select, name: true, teamId: true } },
    } });
    const { accountGrants: accounts, teamGrants: teams, groupGrants: groups } = projectResourceGrantRows(storedGrants);
    const audienceFor = (facts: Partial<Pick<ResourceGrantAccessFacts, 'accountGrants' | 'teamGrants' | 'groupGrants'>>) =>
        resolveResourceGrantAudienceFromFacts({ ownerAccountId: context.access.ownerAccountId,
            encryptionMode: context.access.encryptionMode, accountGrants: [], teamGrants: [], groupGrants: [], ...facts })
            .filter(accountId => accountId !== context.access.ownerAccountId);
    const grantRows: Readonly<{ grant: TaskAccessGrantRowV1; audience: string[] }>[] = [
        ...accounts.map(row => { const profile = projectAccountDisplayProfileV1(row.account); return {
            grant: { principal: { kind: 'account' as const, accountId: row.accountId }, accessLevel: row.accessLevel,
                createdByAccountId: row.createdByAccountId, createdAt: row.createdAt.getTime(),
                display: { name: resolveAccountDisplayLabelV1(profile), username: profile.username } },
            audience: audienceFor({ accountGrants: [row] }),
        }; }),
        ...teams.map(row => ({ grant: { principal: { kind: 'team' as const, teamId: row.teamId }, accessLevel: row.accessLevel,
            createdByAccountId: row.createdByAccountId, createdAt: row.createdAt.getTime(), display: { name: row.team.name } },
            audience: audienceFor({ teamGrants: [row] }) })),
        ...groups.map(row => ({ grant: { principal: { kind: 'group' as const, teamId: row.teamGroup.teamId, groupId: row.teamGroupId }, accessLevel: row.accessLevel,
            createdByAccountId: row.createdByAccountId, createdAt: row.createdAt.getTime(), display: { name: null },
            groupName: projectTeamGroupNameForRecipient({ serialized: row.teamGroup.name, recipientAccountId: input.actorAccountId }) },
            audience: audienceFor({ groupGrants: [row] }) })),
    ];
    const audience = [...new Set(grantRows.flatMap(row => row.audience))];
    const { projectedAccounts, envelopes } = await readTaskRecipientFactsInTx(tx, taskId, audience);
    const ownerKey = envelopes.find(envelope => envelope.recipientAccountId === context.access.ownerAccountId)?.encryptedDataKey ?? new Uint8Array();
    const envelopesByAccountId = new Map(envelopes.map(envelope => [envelope.recipientAccountId, envelope]));
    const recipientsByAccountId = new Map(projectedAccounts.map(({ account, readiness }) => [account.id,
        projectResourceRecipientCensusRow({ access: context.access, ownerDataEncryptionKey: ownerKey, account, readiness,
            envelope: envelopesByAccountId.get(account.id) })]));
    const grants = grantRows.map(({ grant, audience }) => ({ ...grant, ...(context.access.encryptionMode === null ? {} : {
        // FK-backed grant Accounts and their readiness rows share this read snapshot.
        readiness: summarizeResourceRecipientReadinessV1(context.access.encryptionMode, audience.map(accountId => recipientsByAccountId.get(accountId)!)),
    }) }));
    return { ok: true, value: { ownerAccountId: input.ownerAccountId, taskId: input.taskId, access: context.access.level,
        ownerDisplayName: resolveAccountDisplayLabelV1(projectAccountDisplayProfileV1(context.row.account)), grants } };
}

/** A prospective census prepares keys before a grant exists; it never admits that grant. */
export async function readTaskRecipientCensusInTx(tx: Tx, input: TaskActorInput & Readonly<{
    principal?: PrincipalRefV1;
}>): Promise<TaskResult<TaskAccessRecipientCensusResponseV1>> {
    const context = await resolveTaskContextInTx(tx, input);
    if (!context) return { ok: false, error: 'task_not_found' };
    const { access, row } = context;
    if (!access.encryptionMode || !projectTaskContent(context)) return { ok: false, error: 'task_content_unavailable' };
    let additional: string[] = [];
    if (input.principal) {
        if (!mayManageResourceGrants(access)) return { ok: false, error: 'task_access_forbidden' };
        const previous = await readPrincipalGrantInTx(tx, row.id, input.principal);
        const error = await validateResourceGrantPrincipalInTx(tx, { actorAccountId: input.actorAccountId,
            ownerAccountId: input.ownerAccountId, principal: input.principal, hasExistingGrant: previous !== null });
        if (error) return { ok: false, error: `task_${error}` };
        additional = await readResourceGrantPrincipalAudienceInTx(tx, { ownerAccountId: input.ownerAccountId, principal: input.principal });
    }
    const audience = [...new Set([...await resolveTaskAudienceInTx(tx, row.id), ...additional])].sort();
    const { projectedAccounts, envelopes } = await readTaskRecipientFactsInTx(tx, row.id, audience);
    const ownerEnvelope = envelopes.find(envelope => envelope.recipientAccountId === access.ownerAccountId);
    const ownerKey = ownerEnvelope?.encryptedDataKey ?? new Uint8Array();
    const caller = projectedAccounts.find(item => item.account.id === input.actorAccountId);
    const callerEnvelope = envelopes.find(envelope => envelope.recipientAccountId === input.actorAccountId);
    const callerKey = caller && callerEnvelope ? projectResourceRecipientEnvelope(caller.account, callerEnvelope, caller.readiness) : null;
    const classification = classifyAccountJsonKvStoredContent({ key: row.key, value: row.value! });
    if (access.encryptionMode === 'e2ee' && classification.domain !== 'generic'
        && classification.representation !== 'current_resource_encrypted' && access.level === 'owner') {
        return { ok: true, value: { ownerAccountId: access.ownerAccountId, taskId: input.taskId,
            access: access.level, encryptionMode: access.encryptionMode, dataEncryptionKey: null, callerDataEncryptionKey: null,
            recipients: projectedAccounts.map(({ account, readiness }) => projectResourceRecipientCensusRow({
                access, ownerDataEncryptionKey: ownerKey, account, readiness,
            })) } };
    }
    if (access.encryptionMode === 'e2ee' && (!ownerEnvelope || !callerKey)) return { ok: false, error: 'task_content_unavailable' };
    const census = projectResourceRecipientCensus({ access, ownerDataEncryptionKey: ownerKey,
        callerDataEncryptionKey: callerKey, accounts: projectedAccounts, envelopes });
    return census.ok ? { ok: true, value: { ...census.value, taskId: input.taskId } }
        : { ok: false, error: 'task_content_unavailable' };
}

async function validatePromotionInTx(tx: Tx, context: TaskContext, promotion: TaskResourcePromotionV1): Promise<TaskResult<true>> {
    if (context.access.level !== 'owner') return { ok: false, error: 'task_access_forbidden' };
    if (promotion.ownerKeyEnvelope.recipientAccountId !== context.access.ownerAccountId) return { ok: false, error: 'task_invalid_recipient_envelope' };
    const inputs = [promotion.ownerKeyEnvelope, ...promotion.recipientKeyEnvelopes];
    if (new Set(inputs.map(envelope => envelope.recipientAccountId)).size !== inputs.length) return { ok: false, error: 'task_invalid_recipient_envelope' };
    const account = await tx.account.findUnique({ where: { id: context.access.ownerAccountId }, select: RECIPIENT_READINESS_SELECT });
    if (!account || !projectResourceRecipientEnvelope(account, { ...promotion.ownerKeyEnvelope,
        encryptedDataKey: privacyKit.decodeBase64(promotion.ownerKeyEnvelope.encryptedDataKey) })) {
        return { ok: false, error: 'task_invalid_recipient_envelope' };
    }
    return { ok: true, value: true };
}

/** Plain sharing changes grants only. E2EE promotion commits body CAS, owner/recipient envelopes and grant together. */
export async function setTaskGrantInTx(tx: Tx, input: TaskActorInput & Readonly<{
    request: TaskAccessGrantSetRequestV1;
}>): Promise<TaskResult<TaskAccessGrantMutationResponseV1>> {
    if (!await lockTaskMutationInTx(tx, input, input.request.principal)) return { ok: false, error: 'task_not_found' };
    const context = await resolveTaskContextInTx(tx, input);
    if (!context) return { ok: false, error: 'task_not_found' };
    const { access, row } = context;
    const { principal, accessLevel, promotion } = input.request;
    if (!mayManageResourceGrants(access, accessLevel)) return { ok: false, error: 'task_access_forbidden' };
    if (!access.encryptionMode || !projectTaskContent(context)) return { ok: false, error: 'task_content_unavailable' };
    const previous = await readPrincipalGrantInTx(tx, row.id, principal);
    const error = await validateResourceGrantPrincipalInTx(tx, { actorAccountId: input.actorAccountId,
        ownerAccountId: input.ownerAccountId, principal, hasExistingGrant: previous !== null });
    if (error) return { ok: false, error: `task_${error}` };
    const classification = classifyAccountJsonKvStoredContent({ key: row.key, value: row.value! });
    if (access.encryptionMode === 'e2ee' && classification.domain !== 'generic'
        && classification.representation !== 'current_resource_encrypted' && !promotion) return { ok: false, error: 'task_promotion_required' };
    const previousAudience = await resolveTaskAudienceInTx(tx, row.id);
    if (promotion) {
        if (access.encryptionMode !== 'e2ee') return { ok: false, error: 'task_encryption_mode_mismatch' };
        const valid = await validatePromotionInTx(tx, context, promotion);
        if (!valid.ok) return valid;
        const nextValue = new TextEncoder().encode(JSON.stringify(promotion.content));
        try {
            const applied = await applyUserKvMutationsInTx(tx, { uid: input.ownerAccountId }, [{ key: row.key,
                version: promotion.expectedVersion, value: privacyKit.encodeBase64(nextValue) }], (mutation, existing) => {
                assertAccountJsonKvMutationStoredContent({ key: mutation.key, persistedValue: existing?.value ?? null, nextValue,
                    accountMode: access.encryptionMode, supportsCurrentProtocol: true, usage: 'task_resource_promotion' });
            });
            if (!applied.success) return { ok: false, error: 'task_version_conflict' };
        } catch (cause) {
            if (cause instanceof AccountJsonKvStoredContentModeMismatchError) return { ok: false, error: 'task_encryption_mode_mismatch' };
            throw cause;
        }
    }
    const data = { accessLevel, createdByAccountId: input.actorAccountId };
    const changed = previous?.accessLevel !== accessLevel;
    if (changed) {
        if (principal.kind === 'account') await tx.taskGrant.upsert({ where: { taskId_accountId: { taskId: row.id, accountId: principal.accountId } },
            create: { taskId: row.id, principalKind: principal.kind, accountId: principal.accountId, ...data }, update: data });
        else if (principal.kind === 'team') await tx.taskGrant.upsert({ where: { taskId_teamId: { taskId: row.id, teamId: principal.teamId } },
            create: { taskId: row.id, principalKind: principal.kind, teamId: principal.teamId, ...data }, update: data });
        else await tx.taskGrant.upsert({ where: { taskId_teamGroupId: { taskId: row.id, teamGroupId: principal.groupId } },
            create: { taskId: row.id, principalKind: principal.kind, teamGroupId: principal.groupId, ...data }, update: data });
    }
    if (promotion) {
        await taskRecipientEnvelopeStorageAdapter.writeRecipientEnvelopeInTx(tx, row.id, promotion.ownerKeyEnvelope);
        // Promotion's one publication below already covers its body, grants and keys.
        await applyResourceRecipientKeyEnvelopesInTx(tx, { ...taskRecipientEnvelopeStorageAdapter,
            publishRecipientsChangedInTx: async () => {} }, { resourceId: row.id,
            recipientKeyEnvelopes: promotion.recipientKeyEnvelopes });
    }
    if (changed || promotion) await publishTaskChangedInTx(tx, row.id, previousAudience);
    return { ok: true, value: { changed: changed || promotion !== undefined } };
}

/** Removal retires access at the next request; retained key copies are never authority. */
export async function removeTaskGrantInTx(tx: Tx, input: TaskActorInput & Readonly<{
    request: TaskAccessGrantRemoveRequestV1;
}>): Promise<TaskResult<TaskAccessGrantMutationResponseV1>> {
    if (!await lockTaskMutationInTx(tx, input)) return { ok: false, error: 'task_not_found' };
    const context = await resolveTaskContextInTx(tx, input);
    if (!context) return { ok: false, error: 'task_not_found' };
    if (!mayManageResourceGrants(context.access)) return { ok: false, error: 'task_access_forbidden' };
    const { principal } = input.request;
    if (principal.kind === 'group') {
        const group = await tx.teamGroup.findUnique({ where: { id: principal.groupId }, select: { teamId: true } });
        if (group?.teamId !== principal.teamId) return { ok: false, error: 'task_subject_not_found' };
    }
    const taskId = context.row.id;
    const previousAudience = await resolveTaskAudienceInTx(tx, taskId);
    const removed = principal.kind === 'account' ? await tx.taskGrant.deleteMany({ where: { taskId, accountId: principal.accountId } })
        : principal.kind === 'team' ? await tx.taskGrant.deleteMany({ where: { taskId, teamId: principal.teamId } })
            : await tx.taskGrant.deleteMany({ where: { taskId, teamGroupId: principal.groupId } });
    if (removed.count) await publishTaskChangedInTx(tx, taskId, previousAudience);
    return { ok: true, value: { changed: removed.count > 0 } };
}

/** A holder's key repair uses the same expected-owner-key and recipient readiness decisions as other resources. */
export async function commitTaskRecipientKeyEnvelopesInTx(tx: Tx, input: TaskActorInput & Readonly<{
    request: TaskRecipientKeyEnvelopeCommitInputV1;
}>): Promise<TaskResult<TaskRecipientKeyEnvelopeCommitResponseV1>> {
    if (!await lockTaskMutationInTx(tx, input)) return { ok: false, error: 'task_not_found' };
    const census = await readTaskRecipientCensusInTx(tx, input);
    if (!census.ok) return census;
    if (census.value.encryptionMode !== 'e2ee' || !census.value.dataEncryptionKey) return { ok: false, error: 'task_encryption_mode_mismatch' };
    const invalid = validateResourceRecipientEnvelopeCommit({ ownerDataEncryptionKey: privacyKit.decodeBase64(census.value.dataEncryptionKey), ...input.request });
    if (invalid) return { ok: false, error: `task_${invalid}` };
    const row = await tx.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: input.ownerAccountId, key: `todo.${input.taskId}` } }, select: { id: true } });
    return { ok: true, value: await applyResourceRecipientKeyEnvelopesInTx(tx, taskRecipientEnvelopeStorageAdapter,
        { resourceId: row.id, recipientKeyEnvelopes: input.request.recipientKeyEnvelopes }) };
}

/**
 * The owner's owed census (`GET /v1/tasks/recipients/owed`), read on the Team-change wake: each owned Task with a
 * grant goes through the ordinary owner census, and the shared owed predicate keeps only what it owes. Like the
 * unpaged Task inventory it answers in one page. Owed is computed from grants and envelope rows; nothing is stored.
 * Owned granted Tasks are few (QA A: 8 of 125), so each candidate reuses the single-Task census rather than a batch.
 */
export async function listOwedTaskRecipientCensusesInTx(tx: Tx, actorAccountId: string): Promise<TaskOwedRecipientCensusPageV1> {
    const candidates = await tx.userKVStore.findMany({ where: { accountId: actorAccountId, ...taskRowsWhere, grants: { some: {} } },
        orderBy: { id: 'asc' }, select: { key: true } });
    const items: TaskOwedRecipientCensusPageV1['items'] = [];
    for (const { key } of candidates) {
        const census = await readTaskRecipientCensusInTx(tx, { actorAccountId, ownerAccountId: actorAccountId, taskId: key.slice('todo.'.length) });
        if (!census.ok || census.value.access !== 'owner') continue;
        const owed = listOwedResourceRecipientsV1(census.value);
        if (owed.length) items.push({ ...census.value, recipients: owed });
    }
    return { items, nextCursor: null };
}

export const listTaskGrants = (input: TaskActorInput) => inReadSnapshot(tx => listTaskGrantsInTx(tx, input));
export const readTaskRecipientCensus = (input: Parameters<typeof readTaskRecipientCensusInTx>[1]) => inReadSnapshot(tx => readTaskRecipientCensusInTx(tx, input));
export const listOwedTaskRecipientCensuses = (actorAccountId: string) => inReadSnapshot(tx => listOwedTaskRecipientCensusesInTx(tx, actorAccountId));
export const setTaskGrant = (input: Parameters<typeof setTaskGrantInTx>[1]) => inTx(tx => setTaskGrantInTx(tx, input));
export const removeTaskGrant = (input: Parameters<typeof removeTaskGrantInTx>[1]) => inTx(tx => removeTaskGrantInTx(tx, input));
export const commitTaskRecipientKeyEnvelopes = (input: Parameters<typeof commitTaskRecipientKeyEnvelopesInTx>[1]) => inTx(tx => commitTaskRecipientKeyEnvelopesInTx(tx, input));
