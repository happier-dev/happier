import { SavedSecretDisclosureRecordResultV1Schema, SavedSecretDisclosureHistoryV1Schema, type SharedSavedSecretRevealInputV1,
    type SavedSecretDisclosureRecordV1Schema, type SavedSecretCopyRecordV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { requestHomeDomain } from '@/sync/api/home/homeServerActionTransport';
import { readSavedSecretReferenceInContext } from '@/sync/api/account/apiSavedSecretCatalog';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';

type DisclosureInput = ReturnType<typeof SavedSecretDisclosureRecordV1Schema.parse>;
type CopyInput = ReturnType<typeof SavedSecretCopyRecordV1Schema.parse>;

/** The generalized activity owner supplies the existing keyset-paged metadata projection. */
export async function readSavedSecretDisclosureHistoryInContext(context: LazyActionAccountContext,
    input: Readonly<{ resourceId: string; cursor?: string }>, signal?: AbortSignal) {
    context.assertCurrent();
    signal?.throwIfAborted();
    const result = await requestHomeDomain({ scope: context, path: '/v1/account/saved-secrets/resources/activity/read',
        method: 'POST', effect: 'read', input, schema: SavedSecretDisclosureHistoryV1Schema,
        requestAuthority: context, signal });
    context.assertCurrent();
    signal?.throwIfAborted();
    return result;
}

/** Reuse Account mode/key currentness without reopening a secret body. */
export async function isSavedSecretDisclosureStorageCurrentInContext(context: LazyActionAccountContext,
    accountMode: 'plain' | 'e2ee', resourceMode: 'plain' | 'e2ee' | null): Promise<boolean> {
    context.assertCurrent();
    const mode = resourceMode === 'e2ee'
        ? (await resolveAccountStorageContext(context.credentials, { encryption: (await context.resolveAccountEncryption()).encryption,
            request: context.request, usage: 'fresh-authority' })).mode
        : (await fetchAccountEncryptionMode(context.credentials, { request: context.request, usage: 'fresh-authority' })).mode;
    context.assertCurrent();
    return mode === accountMode;
}

/** History is subordinate to the person Action; it never publishes resource currentness. */
export async function recordSavedSecretDisclosureInContext(context: LazyActionAccountContext, input: DisclosureInput | CopyInput,
    kind: 'reveal' | 'copy', signal?: AbortSignal) {
    context.assertCurrent();
    signal?.throwIfAborted();
    const result = await requestHomeDomain({ scope: context, path: `/v1/account/saved-secrets/resources/activity${kind === 'copy' ? '/copy' : ''}`,
        method: 'POST', effect: 'write', input, schema: SavedSecretDisclosureRecordResultV1Schema,
        requestAuthority: context, signal });
    context.assertCurrent();
    signal?.throwIfAborted();
    return result;
}

/** Private client custody, consumed only by the admitted mounted Reveal leaf. */
export async function openSavedSecretDisclosureInContext(context: LazyActionAccountContext,
    input: SharedSavedSecretRevealInputV1, deviceId: string, signal: AbortSignal | undefined, isCurrent: () => boolean) {
    if (!isCurrent()) return { ok: false as const, reason: 'changed' as const };
    const requested = await recordSavedSecretDisclosureInContext(context, { ...input, deviceId, outcome: 'requested' }, 'reveal', signal);
    if (!isCurrent()) return { ok: false as const, reason: 'changed' as const };
    if (!requested.ok) return { ok: false as const, reason: requested.failure.code ?? requested.failure.kind };
    const historyEntryId = requested.value.historyEntryId;
    const accountMode = await context.resolveAccountMode();
    if (!isCurrent()) return { ok: false as const, reason: 'changed' as const };
    const material = await readSavedSecretReferenceInContext(context, input.ref, signal,
        { expectedRevision: input.expectedRevision, requireManage: true, isCurrent });
    if (!isCurrent()) return { ok: false as const, reason: 'changed' as const };
    const settled = await recordSavedSecretDisclosureInContext(context, { ...input, deviceId, historyEntryId,
        outcome: material.ok ? 'displayed' : 'refused' }, 'reveal', signal);
    if (!isCurrent()) return { ok: false as const, reason: 'changed' as const };
    if (!material.ok) return material;
    if (!settled.ok) return { ok: false as const, reason: settled.failure.code ?? settled.failure.kind };
    context.assertCurrent();
    signal?.throwIfAborted();
    return { ok: true as const, value: material.value, historyEntryId, accountMode };
}
