import * as privacyKit from 'privacy-kit';
import type { TaskResourceAddressV1, TaskResourceContentV1, TaskResourceV1, TaskResourceErrorV1,
    TaskResourceMutateRequestV1, TaskResourcesListResponseV1, TaskResourceUnavailableV1, TaskResourceSelectionV1 } from '@happier-dev/protocol/actions/internalTaskActions';
import { TaskResourceContentV1Schema } from '@happier-dev/protocol/actions/internalTaskActions';
import { inTx, inReadSnapshot, type Tx } from '@/storage/inTx';
import { acquireUserKvRowLockInTx, applyUserKvMutationsInTx } from '@/app/kv/kvMutate';
import { assertAccountJsonKvStoredContentMatchesAccountMode, assertAccountJsonKvMutationStoredContent,
    classifyAccountJsonKvStoredContent, AccountJsonKvStoredContentModeMismatchError } from '@/app/kv/accountJsonKvStoredContent';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import { deriveAccountRecipientEnvelopeReadinessFromRow, type AccountRecipientEnvelopeReadiness } from '@/app/encryption/accountRecipientEnvelopeReadiness';
import { RECIPIENT_READINESS_SELECT, type RecipientReadinessRow } from '@/app/session/encryption/sessionDataKeyRecipientProjection';
import { mergeResourceGrantArmPages, resourceGrantPageAccessArms, resolveResourceGrantAccessFromFacts, projectResourceRecipientEnvelope,
    readResourceGrantPrincipalAudienceInTx, type ResourceGrantAccess } from '@/app/teams/resourceGrantAccess';
import type { Prisma } from '@prisma/client';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { acquireAccountChangePublicationLocksInTx } from '@/app/changes/markAccountChanged';
import { ACCOUNT_DISPLAY_PROFILE_SELECT, projectAccountDisplayProfileV1, resolveAccountDisplayLabelV1 } from '@/app/account/profile/accountDisplayProfile';
import { taskAccessFactsSelect, taskGrantFacts, taskRowsWhere, resolveTaskAudienceInTx } from './taskGrantStorageAdapter';
import { publishTaskChangedInTx } from './taskChanges';

export type TaskResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: TaskResourceErrorV1 }>;
export type TaskActorInput = TaskResourceAddressV1 & Readonly<{ actorAccountId: string }>;

function taskReadSelect(actorAccountId: string) {
    return { ...taskAccessFactsSelect(actorAccountId), id: true, key: true, value: true, version: true,
        account: { select: { ...ACCOUNT_DISPLAY_PROFILE_SELECT, encryptionMode: true } },
        keyEnvelopes: { where: { recipientAccountId: actorAccountId }, select: {
            recipientAccountId: true, encryptedDataKey: true, recipientContentPublicKeyFingerprint: true,
        } } } as const;
}

async function readTaskRowInTx(tx: Tx, input: TaskActorInput) {
    if (input.taskId === 'index') return null;
    return tx.userKVStore.findFirst({ where: { accountId: input.ownerAccountId, key: `todo.${input.taskId}`, value: { not: null } },
        select: taskReadSelect(input.actorAccountId) });
}
type TaskReadRow = NonNullable<Awaited<ReturnType<typeof readTaskRowInTx>>>;
export interface TaskContext { row: TaskReadRow; access: ResourceGrantAccess; }

/** Address metadata is not authority; the shared evaluator admits every request before content/CAS. */
export async function resolveTaskContextInTx(tx: Tx, input: TaskActorInput): Promise<TaskContext | null> {
    const row = await readTaskRowInTx(tx, input);
    const access = row ? resolveResourceGrantAccessFromFacts(taskGrantFacts(row), input.actorAccountId) : null;
    return row && access ? { row, access } : null;
}

/** Projection preserves legacy ciphertext; the server never opens or reseals task content. */
export function projectTaskContent(context: TaskContext): TaskResourceContentV1 | null {
    const { row, access } = context;
    if (!row.value || !access.encryptionMode) return null;
    try {
        assertAccountJsonKvStoredContentMatchesAccountMode({ key: row.key, value: row.value,
            accountMode: access.encryptionMode, usage: 'task_resource' });
        const classification = classifyAccountJsonKvStoredContent({ key: row.key, value: row.value });
        if (classification.domain === 'generic') return null;
        if (classification.representation === 'legacy_encrypted') return { t: 'encrypted', c: privacyKit.encodeBase64(row.value) };
        return TaskResourceContentV1Schema.parse(JSON.parse(new TextDecoder().decode(row.value)));
    } catch { return null; }
}

interface TaskCallerReadiness { account: RecipientReadinessRow; readiness: AccountRecipientEnvelopeReadiness; }
async function readTaskCallerInTx(tx: Tx, actorAccountId: string): Promise<TaskCallerReadiness | null> {
    const account = await tx.account.findUnique({ where: { id: actorAccountId }, select: RECIPIENT_READINESS_SELECT });
    return account ? { account, readiness: deriveAccountRecipientEnvelopeReadinessFromRow(account) } : null;
}

function projectTaskForCaller(context: TaskContext, actor?: TaskCallerReadiness | null): TaskResult<TaskResourceV1> {
    const { row, access } = context;
    const content = projectTaskContent(context);
    if (!content || !access.encryptionMode) return { ok: false, error: 'task_content_unavailable' };
    let encryptedDataKey: string | null = null;
    if (content.t === 'encrypted' && 'k' in content && content.k === 'task') {
        const envelope = row.keyEnvelopes[0];
        const key = actor && envelope ? projectResourceRecipientEnvelope(actor.account, envelope, actor.readiness) : null;
        if (!key) return { ok: false, error: 'task_content_unavailable' };
        encryptedDataKey = privacyKit.encodeBase64(key);
    } else if (content.t === 'encrypted' && access.level !== 'owner') {
        return { ok: false, error: 'task_content_unavailable' };
    }
    return { ok: true, value: { ownerAccountId: row.accountId, taskId: row.key.slice('todo.'.length),
        ownerDisplayName: resolveAccountDisplayLabelV1(projectAccountDisplayProfileV1(row.account)),
        version: row.version, content, access: access.level, encryptionMode: access.encryptionMode, encryptedDataKey } };
}

/** Read an admitted row, using only the requester's current verified recipient envelope. */
export async function readTaskResourceInTx(tx: Tx, input: TaskActorInput): Promise<TaskResult<TaskResourceV1>> {
    const context = await resolveTaskContextInTx(tx, input);
    if (!context) return { ok: false, error: 'task_not_found' };
    const actor = context.access.encryptionMode === 'e2ee'
        ? await readTaskCallerInTx(tx, input.actorAccountId) : null;
    return projectTaskForCaller(context, actor);
}

/** Candidate selection and one captured readiness row avoid per-task database reads. */
export async function listTaskResourcesInTx(tx: Tx, actorAccountId: string, selection?: TaskResourceSelectionV1): Promise<TaskResult<TaskResourcesListResponseV1>> {
    if (selection?.tasks.length === 0) return { ok: true, value: { tasks: [], selectionApplied: true } };
    const access = resourceGrantPageAccessArms(actorAccountId, (_arm, grantWhere): Prisma.UserKVStoreWhereInput =>
        ({ grants: { some: grantWhere } }));
    const byOwner = new Map<string, string[]>();
    for (const task of selection?.tasks ?? []) {
        const keys = byOwner.get(task.ownerAccountId) ?? [];
        keys.push(`todo.${task.taskId}`);
        byOwner.set(task.ownerAccountId, keys);
    }
    // The whole visible set is the response: each access arm reads its own rows through its own index.
    const rows = mergeResourceGrantArmPages(await Promise.all([access.owned, ...access.received].map(arm => tx.userKVStore.findMany({
        where: { ...taskRowsWhere, AND: [arm,
            ...(selection === undefined ? [] : [{ OR: [...byOwner].map(([accountId, keys]) => ({ accountId, key: { in: keys } })) }]) ] },
        select: { ...taskReadSelect(actorAccountId), updatedAt: true }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] }))),
        (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime() || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const actor = rows.some(row => row.account.encryptionMode === 'e2ee')
        ? await readTaskCallerInTx(tx, actorAccountId) : null;
    const readiness = actor?.readiness;
    const tasks: TaskResourceV1[] = [];
    const unavailableTasks: TaskResourceUnavailableV1[] = [];
    for (const row of rows) {
        const access = resolveResourceGrantAccessFromFacts(taskGrantFacts(row), actorAccountId);
        if (!access) continue;
        const context = { row, access };
        const result = projectTaskForCaller(context, actor);
        if (result.ok) tasks.push(result.value);
        else {
            if (access.level === 'owner' && !projectTaskContent(context)) return result;
            unavailableTasks.push({ ownerAccountId: row.accountId, taskId: row.key.slice('todo.'.length),
                error: 'task_content_unavailable', reason: readiness?.status === 'unavailable' ? readiness.reason : 'recipient_key_pending' });
        }
    }
    return { ok: true, value: { tasks, ...(unavailableTasks.length ? { unavailableTasks } : {}),
        ...(selection === undefined ? {} : { selectionApplied: true }) } };
}

/** Lock the existing owner row under the Account conversion boundary, without a second CAS implementation. */
export async function lockTaskMutationInTx(tx: Tx, input: TaskActorInput, additionalPrincipal?: PrincipalRefV1): Promise<boolean> {
    if (input.taskId === 'index') return false;
    const row = await tx.userKVStore.findUnique({ where: { accountId_key: { accountId: input.ownerAccountId,
        key: `todo.${input.taskId}` } }, select: { id: true } });
    if (!row) return false;
    const audience = await resolveTaskAudienceInTx(tx, row.id);
    if (additionalPrincipal) audience.push(...await readResourceGrantPrincipalAudienceInTx(tx, {
        ownerAccountId: input.ownerAccountId, principal: additionalPrincipal,
    }));
    await acquireAccountChangePublicationLocksInTx(tx, [input.ownerAccountId, ...audience], { includeSingleAccount: true });
    const mode = await acquireAccountEncryptionTransitionFenceInTx(tx, input.ownerAccountId, 'content');
    return mode.status === 'ready'
        && await acquireUserKvRowLockInTx(tx, { accountId: input.ownerAccountId, key: `todo.${input.taskId}` });
}

/** Authorization precedes the canonical KV CAS, so denied callers never learn the current value/version. */
export async function mutateTaskResourceInTx(tx: Tx, input: TaskActorInput & Readonly<{
    request: TaskResourceMutateRequestV1;
}>): Promise<TaskResult<TaskResourceV1>> {
    if (!await lockTaskMutationInTx(tx, input)) return { ok: false, error: 'task_not_found' };
    const context = await resolveTaskContextInTx(tx, input);
    if (!context || context.access.level === 'view') return { ok: false, error: 'task_not_found' };
    if (!context.access.encryptionMode) return { ok: false, error: 'task_encryption_mode_mismatch' };
    const actor = context.access.encryptionMode === 'e2ee'
        ? await readTaskCallerInTx(tx, input.actorAccountId) : null;
    const admitted = projectTaskForCaller(context, actor);
    if (!admitted.ok) return admitted;
    const nextValue = new TextEncoder().encode(JSON.stringify(input.request.content));
    try {
        const applied = await applyUserKvMutationsInTx(tx, { uid: input.ownerAccountId }, [{ key: context.row.key,
            version: input.request.expectedVersion, value: privacyKit.encodeBase64(nextValue) }], (mutation, existing) => {
            assertAccountJsonKvMutationStoredContent({ key: mutation.key, persistedValue: existing?.value ?? null, nextValue,
                accountMode: context.access.encryptionMode, supportsCurrentProtocol: true, usage: 'task_resource' });
        });
        if (!applied.success) return { ok: false, error: 'task_version_conflict' };
    } catch (error) {
        if (error instanceof AccountJsonKvStoredContentModeMismatchError) return { ok: false, error: 'task_encryption_mode_mismatch' };
        throw error;
    }
    await publishTaskChangedInTx(tx, context.row.id);
    return { ok: true, value: { ...admitted.value, content: input.request.content, version: input.request.expectedVersion + 1 } };
}

export const readTaskResource = (input: TaskActorInput) => inReadSnapshot(tx => readTaskResourceInTx(tx, input));
export const listTaskResources = (actorAccountId: string, selection?: TaskResourceSelectionV1) => inReadSnapshot(tx => listTaskResourcesInTx(tx, actorAccountId, selection));
export const mutateTaskResource = (input: Parameters<typeof mutateTaskResourceInTx>[1]) => inTx(tx => mutateTaskResourceInTx(tx, input));
