import {
    computeContentPublicKeyFingerprint,
    formatSavedSecretCatalogReferenceV1,
    listAccountSettingsSavedSecretReferences,
    type AccountSettingsSavedSecretReference,
    openSavedSecretResourceStoredContentV1,
    promotePersonalSavedSecretReference,
    sealSavedSecretResourceStoredContentV1,
    SharedSavedSecretDeleteOutputV1Schema,
    SharedSavedSecretMutationOutputV1Schema,
    SavedSecretResourceEnvelopeCensusRequestV1Schema,
    SavedSecretResourceEnvelopeCensusResponseV1Schema,
    SavedSecretResourceEnvelopeRepairOutputV1Schema,
    SharedSavedSecretPromoteOutputV1Schema,
    type SavedSecret,
    type SavedSecretResourceEnvelopeCensusRecipientV1,
    type SavedSecretResourceMaterialV1,
} from '@happier-dev/protocol';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';

import { readSavedSecretCatalog } from '@/sync/api/account/apiSavedSecretCatalog';
import { requestHomeDomain } from '@/sync/api/home/homeServerActionTransport';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { encryptDataKeyForRecipientV0 } from '@/sync/encryption/directShareEncryption';
import { encodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { randomUUID } from '@/platform/randomUUID';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { isTeamActionApprovalPendingError, runTeamAction } from '@/sync/ops/teams/teamActionClient';

type SavedSecretMutationOutput = Readonly<{ resourceId: string; revision: number }>;
type SavedSecretDeleteOutput = Readonly<{ resourceId: string }>;
type SavedSecretApprovalHandlers<T> = Readonly<{
    onApprovalSucceeded?: (value: T) => void | Promise<void>;
    onApprovalFailed?: (code: string) => void;
}>;

type HealthySavedSecretResourceMaterialV1 = Extract<
    SavedSecretResourceMaterialV1,
    Readonly<{ resourceId: string }>
>;

function isHealthySavedSecretResourceMaterialV1(
    resource: SavedSecretResourceMaterialV1,
): resource is HealthySavedSecretResourceMaterialV1 {
    return 'resourceId' in resource;
}

export type SavedSecretResourceOperationResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reason: 'changed' | 'unavailable' | 'failed' | 'outcome_unknown' }>;

/**
 * Deleting a shared Saved Secret additionally reports the owner's own current
 * references, so the surface can name where it is still used instead of
 * offering a delete that would leave those bindings dangling.
 */
export type SavedSecretResourceDeleteResult =
    | SavedSecretResourceOperationResult
    | Readonly<{
        ok: false;
        reason: 'in_use';
        references: readonly AccountSettingsSavedSecretReference[];
    }>;

export type SavedSecretPromotionResult =
    | Readonly<{ ok: true; resourceRef: string }>
    | Exclude<SavedSecretResourceOperationResult, Readonly<{ ok: true }>>;

export type SavedSecretCreationResult =
    | Readonly<{ ok: true; resourceRef: string; revision: number }>
    | Exclude<SavedSecretResourceOperationResult, Readonly<{ ok: true }>>;

function operationFailureReason(kind: 'conflict' | 'outcome_unknown' | string): Exclude<SavedSecretResourceOperationResult, Readonly<{ ok: true }>>['reason'] {
    if (kind === 'conflict') return 'changed';
    if (kind === 'outcome_unknown') return 'outcome_unknown';
    return 'failed';
}

/**
 * The owner's own envelope for a resource data key this device just sealed.
 * Creation, promotion and conversion into E2EE each submit exactly this one
 * envelope with their write; every other recipient is prepared afterwards by
 * the census repair below.
 */
function sealOwnerSavedSecretResourceEnvelope(
    accountId: string,
    resourceDataKey: Uint8Array,
    contentDataKey: Uint8Array,
): Readonly<{ recipientAccountId: string; encryptedDataKey: string; recipientContentPublicKeyFingerprint: string }> {
    return {
        recipientAccountId: accountId,
        encryptedDataKey: encryptDataKeyForRecipientV0(resourceDataKey, encodeBase64(contentDataKey, 'base64')),
        recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(contentDataKey),
    };
}

export type SavedSecretResourceRecipientReadiness =
    | Readonly<{ ok: true; revision: number; recipients: readonly SavedSecretResourceEnvelopeCensusRecipientV1[] }>
    | Readonly<{ ok: false }>;

/**
 * The owner's per-recipient view of one E2EE resource: who is authorized, whether
 * each can hold an envelope at all (Plain Account, encryption not set up, keys
 * inconsistent) and whether their envelope is prepared. It is the one census
 * reader; envelope preparation consumes the same answer.
 */
export async function readSavedSecretResourceRecipientReadiness(params: Readonly<{
    scope: ServerAccountScope;
    resourceId: string;
}>): Promise<SavedSecretResourceRecipientReadiness> {
    const recipients: SavedSecretResourceEnvelopeCensusRecipientV1[] = [];
    let revision: number | null = null;
    let cursor: string | undefined;
    do {
        const request = bindHomeDomainHttpRequestV1({
            transport: { method: 'GET', path: '/v1/account/saved-secrets/resources/envelope-census' },
            inputSchema: SavedSecretResourceEnvelopeCensusRequestV1Schema,
            input: { resourceId: params.resourceId, ...(cursor ? { cursor } : {}), limit: 100 },
        });
        const census = await requestHomeDomain({
            scope: params.scope,
            path: request.path,
            method: request.method,
            effect: 'read',
            input: request.body,
            schema: SavedSecretResourceEnvelopeCensusResponseV1Schema,
        });
        // A page from another revision describes a different audience.
        if (!census.ok || (revision !== null && census.value.revision !== revision)) return { ok: false };
        revision = census.value.revision;
        recipients.push(...census.value.recipients);
        cursor = census.value.nextCursor ?? undefined;
    } while (cursor);
    return revision === null ? { ok: false } : { ok: true, revision, recipients };
}

async function repairSavedSecretResourceEnvelopesBestEffort(params: Readonly<{
    scope: ServerAccountScope;
    resourceId: string;
    expectedRevision: number;
    resourceDataKey: Uint8Array;
}>): Promise<void> {
    const census = await readSavedSecretResourceRecipientReadiness(params);
    if (!census.ok || census.revision !== params.expectedRevision) return;
    const keyEnvelopes = census.recipients.flatMap((recipient) => (
        recipient.readiness.status !== 'available' || recipient.envelopeStatus === 'prepared'
            ? []
            : [{
                recipientAccountId: recipient.account.accountId,
                encryptedDataKey: encryptDataKeyForRecipientV0(
                    params.resourceDataKey,
                    recipient.readiness.contentPublicKey,
                ),
                recipientContentPublicKeyFingerprint: recipient.readiness.contentPublicKeyFingerprint,
            }]
    ));
    if (keyEnvelopes.length === 0) return;
    await requestHomeDomain({
        scope: params.scope,
        path: '/v1/account/saved-secrets/resources/envelopes/repair',
        method: 'POST',
        effect: 'write',
        input: {
            resourceId: params.resourceId,
            expectedRevision: params.expectedRevision,
            keyEnvelopes,
        },
        schema: SavedSecretResourceEnvelopeRepairOutputV1Schema,
    });
}

async function repairCatalogedSavedSecretResourceEnvelopesBestEffort(params: Readonly<{
    scope: ServerAccountScope;
    resource: HealthySavedSecretResourceMaterialV1;
    expectedRevision: number;
    decryptDataKeyEnvelope: (encryptedDataKey: string) => Promise<Uint8Array | null>;
}>): Promise<void> {
    if (!params.resource.recipientEnvelope) return;
    const resourceDataKey = await params.decryptDataKeyEnvelope(params.resource.recipientEnvelope.encryptedDataKey);
    if (!resourceDataKey) return;
    try {
        await repairSavedSecretResourceEnvelopesBestEffort({
            scope: params.scope,
            resourceId: params.resource.resourceId,
            expectedRevision: params.expectedRevision,
            resourceDataKey,
        });
    } finally {
        resourceDataKey.fill(0);
    }
}

/**
 * Prepares every owed recipient envelope of one owned E2EE resource at its
 * current revision, opening the data key from this owner's own envelope. Used
 * after an approved write and by the owner's explicit "Finish sharing".
 */
export async function repairApprovedSavedSecretResourceEnvelopesBestEffort(params: Readonly<{
    scope: ServerAccountScope;
    resourceId: string;
    expectedRevision: number;
    decryptDataKeyEnvelope: (encryptedDataKey: string) => Promise<Uint8Array | null>;
}>): Promise<void> {
    const catalog = await readSavedSecretCatalog(params.scope);
    if (!catalog.ok) return;
    const resource = catalog.resources.find((candidate): candidate is HealthySavedSecretResourceMaterialV1 => (
        isHealthySavedSecretResourceMaterialV1(candidate)
        && candidate.resourceId === params.resourceId
    ));
    if (!resource || resource.entry.revision !== params.expectedRevision) return;
    await repairCatalogedSavedSecretResourceEnvelopesBestEffort({
        scope: params.scope,
        resource,
        expectedRevision: params.expectedRevision,
        decryptDataKeyEnvelope: params.decryptDataKeyEnvelope,
    });
}

/**
 * Prepares the envelopes this Account owes as a custodian, without changing any
 * resource.
 *
 * A recipient becomes able to open a shared Saved Secret only once the
 * custodian has wrapped its data key for that recipient's content key, and the
 * mutation paths do that only for the mutation they are already performing. A
 * recipient who became E2EE-ready afterwards — or whose own content key
 * changed — therefore waits for a custodian mutation that may never come. This
 * sweep closes that gap from the Saved Secrets surface: it asks the Home's
 * census which authorized recipients are ready and still lack a usable
 * envelope, and prepares exactly those.
 *
 * Both Home routes it reaches are custodian-only and E2EE-only, so a resource
 * received from someone else, or one this Account keeps in plaintext, is not
 * asked about at all.
 */
export async function repairCustodiedSavedSecretResourceEnvelopesBestEffort(params: Readonly<{
    scope: ServerAccountScope;
    decryptDataKeyEnvelope: (encryptedDataKey: string) => Promise<Uint8Array | null>;
}>): Promise<void> {
    const catalog = await readSavedSecretCatalog(params.scope);
    if (!catalog.ok) return;
    for (const candidate of catalog.resources) {
        if (!isHealthySavedSecretResourceMaterialV1(candidate)) continue;
        if (candidate.encryptionMode !== 'e2ee' || candidate.entry.relationship !== 'owner') continue;
        const expectedRevision = candidate.entry.revision;
        if (expectedRevision === null) continue;
        await repairCatalogedSavedSecretResourceEnvelopesBestEffort({
            scope: params.scope,
            resource: candidate,
            expectedRevision,
            decryptDataKeyEnvelope: params.decryptDataKeyEnvelope,
        }).catch(() => undefined);
    }
}

/**
 * Creates a standalone Shared Saved Secret. The active Account sync lifetime
 * already owns whether Account content is Plain or E2EE; this operation only
 * projects that mode through the resource codec and canonical Action.
 */
export async function createSavedSecretResource(params: Readonly<{
    scope: ServerAccountScope;
    name: string;
    kind: SavedSecret['kind'];
    value: string;
    accountGrants: readonly string[];
    teamGrants: readonly string[];
    groupGrants: readonly string[];
    onApprovalSucceeded?: (result: Extract<SavedSecretCreationResult, Readonly<{ ok: true }>>) => void | Promise<void>;
    onApprovalFailed?: (code: string) => void;
}>): Promise<SavedSecretCreationResult> {
    const sync = getSyncSingleton();
    const encryption = sync.encryption;
    const resourceId = randomUUID();
    const resourceRef = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const resourceDataKey = encryption ? getRandomBytes(32) : null;
    try {
        const content = { v: 1 as const, name: params.name, kind: params.kind, value: params.value };
        const storedContent = resourceDataKey
            ? sealSavedSecretResourceStoredContentV1({
                resourceId,
                mode: 'e2ee',
                resourceDataKey,
                content,
                randomBytes: getRandomBytes,
            })
            : sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain', content });
        const keyEnvelopes = encryption && resourceDataKey
            ? [sealOwnerSavedSecretResourceEnvelope(params.scope.accountId, resourceDataKey, encryption.contentDataKey)]
            : [];
        const finishApproved = async (value: { resourceId: string; revision: number }) => {
            if (encryption) {
                await repairApprovedSavedSecretResourceEnvelopesBestEffort({
                    scope: params.scope,
                    resourceId,
                    expectedRevision: value.revision,
                    decryptDataKeyEnvelope: (encryptedDataKey) => encryption.decryptEncryptionKey(
                        encryptedDataKey,
                        params.scope,
                    ),
                }).catch(() => undefined);
            }
            const result = { ok: true as const, resourceRef, revision: value.revision };
            await params.onApprovalSucceeded?.(result);
        };
        const outcome = await runTeamAction({
            scope: params.scope,
            actionId: 'secrets.shared.create',
            input: {
                resourceId,
                displayName: params.name,
                kind: params.kind,
                encryptionMode: encryption ? 'e2ee' : 'plain',
                storedContent,
                accountGrants: [...params.accountGrants],
                teamGrants: [...params.teamGrants],
                groupGrants: [...params.groupGrants],
                ...(keyEnvelopes.length > 0 ? { keyEnvelopes } : {}),
            },
            parse: (value) => SharedSavedSecretMutationOutputV1Schema.parse(value),
            onApprovalSucceeded: finishApproved,
            ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
        });
        if (outcome.kind !== 'succeeded') {
            if (outcome.failure.kind === 'outcome_unknown') {
                const catalog = await readSavedSecretCatalog(params.scope);
                const created = catalog.ok
                    ? catalog.resources.find((resource): resource is HealthySavedSecretResourceMaterialV1 => (
                        isHealthySavedSecretResourceMaterialV1(resource)
                        && resource.resourceId === resourceId
                    ))
                    : null;
                if (created?.entry.revision !== null && created?.entry.revision !== undefined) {
                    if (resourceDataKey) {
                        await repairSavedSecretResourceEnvelopesBestEffort({
                            scope: params.scope,
                            resourceId,
                            expectedRevision: created.entry.revision,
                            resourceDataKey,
                        }).catch(() => undefined);
                    }
                    return { ok: true, resourceRef, revision: created.entry.revision };
                }
            }
            return { ok: false, reason: operationFailureReason(outcome.failure.kind) };
        }
        if (resourceDataKey) {
            await repairSavedSecretResourceEnvelopesBestEffort({
                scope: params.scope,
                resourceId,
                expectedRevision: outcome.value.revision,
                resourceDataKey,
            }).catch(() => undefined);
        }
        return { ok: true, resourceRef, revision: outcome.value.revision };
    } catch (error) {
        // Approval-pending carries the exact result-bearing continuation and
        // must reach the mounted presenter unchanged. Ordinary preparation or
        // transport failures remain retryable from the preserved draft.
        if (isTeamActionApprovalPendingError(error)) throw error;
        return { ok: false, reason: 'failed' };
    } finally {
        resourceDataKey?.fill(0);
    }
}

/**
 * Promotes one personal value into the shared resource owner. The canonical
 * Settings one-shot owner prepares the complete envelope, while the Home's
 * promotion route commits that envelope and resource creation atomically.
 */
export async function promotePersonalSavedSecretResource(params: Readonly<{
    scope: ServerAccountScope;
    expectedSettingsVersion: number;
    secret: SavedSecret;
    accountGrants: readonly string[];
    teamGrants: readonly string[];
    groupGrants: readonly string[];
    onApprovalSucceeded?: (result: Readonly<{ ok: true; resourceRef: string }>) => void | Promise<void>;
    onApprovalFailed?: (code: string) => void;
}>): Promise<SavedSecretPromotionResult> {
    const sync = getSyncSingleton();
    const value = sync.decryptSecretValue(params.secret.encryptedValue);
    if (value === null) return { ok: false, reason: 'unavailable' };
    const resourceId = randomUUID();
    const resourceRef = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    // Written by the commit callback below; held in a box so the compiler
    // cannot narrow it back to its initial null at the zeroizing `finally`.
    const promotionDataKey: { value: Uint8Array | null } = { value: null };

    try {
        const mutation = await sync.mutateAccountSettingsOnce({
            expectedSettingsScope: params.scope,
            expectedSettingsVersion: params.expectedSettingsVersion,
            // Every reference to the personal secret — Profile bindings
            // included — moves to the shared reference in this one CAS write.
            // 0.3 Settings readers and writers preserve shared references, and
            // 0.3 is a one-way upgrade with no 0.2 writer left to prune them.
            // Every reference to the personal secret — Profile bindings
            // included — moves to the shared reference in this one CAS write.
            // 0.3 Settings readers and writers preserve shared references, and
            // 0.3 is a one-way upgrade with no 0.2 writer left to prune them.
            mutate: (raw) => ({
                settings: { ...promotePersonalSavedSecretReference(raw, {
                    secretId: params.secret.id,
                    expectedUpdatedAt: params.secret.updatedAt,
                    sharedSecretRef: resourceRef,
                }).settings },
                value: { resourceId, resourceRef },
            }),
            commitPrepared: async (prepared) => {
                const encryption = sync.encryption;
                if (prepared.accountMode === 'e2ee' && !encryption) {
                    return { status: 'rejected', error: new Error('saved_secret_encryption_unavailable') };
                }
                const preparedResourceDataKey = prepared.accountMode === 'e2ee'
                    ? getRandomBytes(32)
                    : null;
                promotionDataKey.value = preparedResourceDataKey;
                const storedContent = prepared.accountMode === 'plain'
                    ? sealSavedSecretResourceStoredContentV1({
                        resourceId,
                        mode: 'plain',
                        content: {
                            v: 1,
                            name: params.secret.name,
                            kind: params.secret.kind,
                            value,
                        },
                    })
                    : preparedResourceDataKey
                        ? sealSavedSecretResourceStoredContentV1({
                            resourceId,
                            mode: 'e2ee',
                            resourceDataKey: preparedResourceDataKey,
                            content: {
                                v: 1,
                                name: params.secret.name,
                                kind: params.secret.kind,
                                value,
                            },
                            randomBytes: getRandomBytes,
                        })
                        : null;
                if (!storedContent) {
                    return { status: 'rejected', error: new Error('saved_secret_encryption_unavailable') };
                }
                const keyEnvelopes = prepared.accountMode === 'e2ee' && encryption && preparedResourceDataKey
                    ? [sealOwnerSavedSecretResourceEnvelope(
                        params.scope.accountId,
                        preparedResourceDataKey,
                        encryption.contentDataKey,
                    )]
                    : [];
                const outcome = await runTeamAction({
                    scope: params.scope,
                    actionId: 'secrets.shared.promote',
                    input: {
                        resourceId,
                        displayName: params.secret.name,
                        kind: params.secret.kind,
                        encryptionMode: prepared.accountMode,
                        storedContent,
                        accountGrants: [...params.accountGrants],
                        teamGrants: [...params.teamGrants],
                        groupGrants: [...params.groupGrants],
                        ...(keyEnvelopes.length > 0 ? { keyEnvelopes } : {}),
                        expectedSettingsVersion: prepared.expectedSettingsVersion,
                        nextSettings: prepared.content,
                    },
                    parse: (value) => SharedSavedSecretPromoteOutputV1Schema.parse(value),
                    onApprovalSucceeded: async (approved) => {
                        const currentEncryption = getSyncSingleton().encryption;
                        if (currentEncryption) {
                            await repairApprovedSavedSecretResourceEnvelopesBestEffort({
                                scope: params.scope,
                                resourceId,
                                expectedRevision: 1,
                                decryptDataKeyEnvelope: (encryptedDataKey) => currentEncryption.decryptEncryptionKey(
                                    encryptedDataKey,
                                    params.scope,
                                ),
                            }).catch(() => undefined);
                        }
                        await params.onApprovalSucceeded?.({ ok: true, resourceRef });
                    },
                    ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
                });
                if (outcome.kind === 'succeeded') {
                    return { status: 'applied', settingsVersion: outcome.value.settingsVersion };
                }
                if (outcome.failure.kind === 'conflict') return { status: 'conflict' };
                if (outcome.failure.kind === 'outcome_unknown') return { status: 'outcomeUnknown' };
                return { status: 'rejected', error: new Error(`saved_secret_promotion_${outcome.failure.kind}`) };
            },
        });
        if (mutation.status === 'applied') {
            if (promotionDataKey.value) {
                await repairSavedSecretResourceEnvelopesBestEffort({
                    scope: params.scope,
                    resourceId,
                    expectedRevision: 1,
                    resourceDataKey: promotionDataKey.value,
                }).catch(() => undefined);
            }
            return { ok: true, resourceRef };
        }
        if (mutation.status === 'conflict') return { ok: false, reason: 'changed' };

        // The Home transaction is atomic. If readback lost the response but
        // the catalog sees this resource, its paired Settings rewrite committed.
        const catalog = await readSavedSecretCatalog(params.scope);
        if (catalog.ok && catalog.resources.some((resource) => (
            isHealthySavedSecretResourceMaterialV1(resource)
            && resource.resourceId === resourceId
        ))) {
            if (promotionDataKey.value) {
                await repairSavedSecretResourceEnvelopesBestEffort({
                    scope: params.scope,
                    resourceId,
                    expectedRevision: 1,
                    resourceDataKey: promotionDataKey.value,
                }).catch(() => undefined);
            }
            return { ok: true, resourceRef };
        }
        return { ok: false, reason: 'outcome_unknown' };
    } catch (error) {
        if (isTeamActionApprovalPendingError(error)) throw error;
        return { ok: false, reason: 'failed' };
    } finally {
        promotionDataKey.value?.fill(0);
    }
}

/**
 * Rewrites an owned shared resource through the one update Action: its name,
 * its value, and — when the owner explicitly asks — the mode it is stored in.
 *
 * A conversion is the same write as a rotation: the content is opened in the
 * current mode and resealed in the requested one, so the resource keeps its id,
 * reference, recipients and revision line. Converting into E2EE seals a new
 * resource data key and carries the owner's own envelope, exactly as creation
 * does; the remaining recipients are then prepared by the existing census pass.
 * Converting into Plain discloses the value to the Home, which is why its
 * caller confirms the trust change before reaching this operation.
 */
export async function updateSavedSecretResource(params: Readonly<{
    scope: ServerAccountScope;
    resourceId: string;
    expectedRevision: number;
    nextName?: string;
    nextValue?: string;
    /** Explicit mode conversion; absent keeps the resource's current mode. */
    toMode?: 'plain' | 'e2ee';
    decryptDataKeyEnvelope: (encryptedDataKey: string) => Promise<Uint8Array | null>;
}> & SavedSecretApprovalHandlers<SavedSecretMutationOutput>): Promise<SavedSecretResourceOperationResult> {
    const catalog = await readSavedSecretCatalog(params.scope);
    if (!catalog.ok) return { ok: false, reason: 'unavailable' };
    const resource = catalog.resources.find((candidate): candidate is HealthySavedSecretResourceMaterialV1 => (
        isHealthySavedSecretResourceMaterialV1(candidate)
        && candidate.resourceId === params.resourceId
    ));
    if (!resource || resource.entry.relationship !== 'owner' || resource.entry.materialStatus !== 'ready') {
        return { ok: false, reason: 'unavailable' };
    }
    if (resource.entry.revision !== params.expectedRevision) return { ok: false, reason: 'changed' };
    if (!resource.storedContent) return { ok: false, reason: 'unavailable' };

    let resourceDataKey: Uint8Array | null = null;
    let convertedResourceDataKey: Uint8Array | null = null;
    try {
        if (resource.encryptionMode === 'e2ee') {
            if (!resource.recipientEnvelope) return { ok: false, reason: 'unavailable' };
            resourceDataKey = await params.decryptDataKeyEnvelope(resource.recipientEnvelope.encryptedDataKey);
            if (!resourceDataKey) return { ok: false, reason: 'unavailable' };
        }
        const current = resource.encryptionMode === 'plain'
            ? openSavedSecretResourceStoredContentV1({
                resourceId: resource.resourceId, mode: 'plain', storedContent: resource.storedContent,
            })
            : openSavedSecretResourceStoredContentV1({
                resourceId: resource.resourceId, mode: 'e2ee', storedContent: resource.storedContent,
                resourceDataKey: resourceDataKey!,
            });
        if (!current) return { ok: false, reason: 'unavailable' };
        const content = {
            ...current,
            ...(params.nextName === undefined ? {} : { name: params.nextName }),
            ...(params.nextValue === undefined ? {} : { value: params.nextValue }),
        };
        const encryption = getSyncSingleton().encryption;
        const nextMode = params.toMode ?? resource.encryptionMode;
        if (nextMode === 'e2ee' && resource.encryptionMode === 'plain') {
            // A Plain resource holds no data key, so the conversion seals one
            // and the owner's envelope travels with it.
            if (!encryption) return { ok: false, reason: 'unavailable' };
            convertedResourceDataKey = getRandomBytes(32);
        }
        const sealingDataKey = convertedResourceDataKey ?? resourceDataKey;
        const storedContent = nextMode === 'plain'
            ? sealSavedSecretResourceStoredContentV1({ resourceId: resource.resourceId, mode: 'plain', content })
            : sealSavedSecretResourceStoredContentV1({
                resourceId: resource.resourceId,
                mode: 'e2ee',
                resourceDataKey: sealingDataKey!,
                content,
                randomBytes: getRandomBytes,
            });
        const keyEnvelopes = convertedResourceDataKey && encryption
            ? [sealOwnerSavedSecretResourceEnvelope(
                params.scope.accountId,
                convertedResourceDataKey,
                encryption.contentDataKey,
            )]
            : [];
        // An approved-later conversion re-derives its data key from the
        // committed resource, since this call's copy is zeroed on return.
        const onApprovalSucceeded = convertedResourceDataKey && encryption
            ? async (value: SavedSecretMutationOutput) => {
                await repairApprovedSavedSecretResourceEnvelopesBestEffort({
                    scope: params.scope,
                    resourceId: resource.resourceId,
                    expectedRevision: value.revision,
                    decryptDataKeyEnvelope: (encryptedDataKey) => encryption.decryptEncryptionKey(
                        encryptedDataKey,
                        params.scope,
                    ),
                }).catch(() => undefined);
                await params.onApprovalSucceeded?.(value);
            }
            : params.onApprovalSucceeded;
        const outcome = await runTeamAction({
            scope: params.scope,
            actionId: 'secrets.shared.update',
            input: {
                resourceId: resource.resourceId,
                expectedRevision: params.expectedRevision,
                displayName: content.name,
                kind: content.kind,
                storedContent,
                ...(params.toMode ? { toMode: params.toMode } : {}),
                ...(keyEnvelopes.length > 0 ? { keyEnvelopes } : {}),
            },
            parse: (value) => SharedSavedSecretMutationOutputV1Schema.parse(value),
            ...(onApprovalSucceeded ? { onApprovalSucceeded } : {}),
            ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
        });
        if (outcome.kind !== 'succeeded') {
            return { ok: false, reason: operationFailureReason(outcome.failure.kind) };
        }
        if (convertedResourceDataKey) {
            await repairSavedSecretResourceEnvelopesBestEffort({
                scope: params.scope,
                resourceId: resource.resourceId,
                expectedRevision: outcome.value.revision,
                resourceDataKey: convertedResourceDataKey,
            }).catch(() => undefined);
        }
        return { ok: true };
    } catch (error) {
        if (isTeamActionApprovalPendingError(error)) throw error;
        return { ok: false, reason: 'failed' };
    } finally {
        resourceDataKey?.fill(0);
        convertedResourceDataKey?.fill(0);
    }
}

export async function deleteSavedSecretResource(params: Readonly<{
    scope: ServerAccountScope;
    resourceId: string;
    expectedRevision: number;
    /** Owner's current Account Settings version; the reference census reads at it. */
    expectedSettingsVersion: number;
    confirmedByPresentUser?: true;
}> & SavedSecretApprovalHandlers<SavedSecretDeleteOutput>): Promise<SavedSecretResourceDeleteResult> {
    // Plan 10.08 §11.6: the owner client runs the canonical reference census
    // before the resource content, grants and envelopes go. The Home cannot
    // semantically inspect E2EE Account Settings, so a promoted MCP, Voice,
    // Provider, ACP or plugin binding can only be kept from dangling here.
    // The census reads the authoritative Settings baseline through the one
    // Account Settings writer and leaves it unchanged.
    const resourceRef = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: params.resourceId });
    let references: readonly AccountSettingsSavedSecretReference[];
    try {
        const census = await getSyncSingleton().mutateAccountSettingsOnce({
            expectedSettingsScope: params.scope,
            expectedSettingsVersion: params.expectedSettingsVersion,
            mutate: (raw) => ({
                settings: { ...raw },
                value: listAccountSettingsSavedSecretReferences(raw, resourceRef),
            }),
        });
        if (census.status !== 'applied') return { ok: false, reason: 'changed' };
        references = census.value;
    } catch {
        return { ok: false, reason: 'failed' };
    }
    if (references.length > 0) return { ok: false, reason: 'in_use', references };
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: 'secrets.shared.delete',
        input: { resourceId: params.resourceId, expectedRevision: params.expectedRevision },
        parse: (value) => SharedSavedSecretDeleteOutputV1Schema.parse(value),
        ...(params.confirmedByPresentUser ? { approval: 'surface_confirmed' } : {}),
        ...(params.onApprovalSucceeded ? { onApprovalSucceeded: params.onApprovalSucceeded } : {}),
        ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
    });
    return outcome.kind === 'succeeded'
        ? { ok: true }
        : { ok: false, reason: operationFailureReason(outcome.failure.kind) };
}

export async function setSavedSecretResourceGrants(params: Readonly<{
    scope: ServerAccountScope;
    resourceId: string;
    expectedRevision: number;
    encryptionMode: 'plain' | 'e2ee';
    accountGrants: readonly string[];
    teamGrants: readonly string[];
    groupGrants: readonly string[];
    decryptDataKeyEnvelope: (encryptedDataKey: string) => Promise<Uint8Array | null>;
}> & SavedSecretApprovalHandlers<SavedSecretMutationOutput>): Promise<SavedSecretResourceOperationResult> {
    let resourceDataKey: Uint8Array | null = null;
    try {
        if (params.encryptionMode === 'e2ee') {
            const catalog = await readSavedSecretCatalog(params.scope);
            if (!catalog.ok) return { ok: false, reason: 'unavailable' };
            const resource = catalog.resources.find((candidate): candidate is HealthySavedSecretResourceMaterialV1 => (
                isHealthySavedSecretResourceMaterialV1(candidate)
                && candidate.resourceId === params.resourceId
            ));
            if (!resource?.recipientEnvelope || resource.entry.revision !== params.expectedRevision) {
                return { ok: false, reason: resource ? 'changed' : 'unavailable' };
            }
            resourceDataKey = await params.decryptDataKeyEnvelope(resource.recipientEnvelope.encryptedDataKey);
            if (!resourceDataKey) return { ok: false, reason: 'unavailable' };

        }

        const finishApproved = async (value: SavedSecretMutationOutput) => {
            if (params.encryptionMode === 'e2ee') {
                await repairApprovedSavedSecretResourceEnvelopesBestEffort({
                    scope: params.scope,
                    resourceId: params.resourceId,
                    expectedRevision: value.revision,
                    decryptDataKeyEnvelope: params.decryptDataKeyEnvelope,
                }).catch(() => undefined);
            }
            await params.onApprovalSucceeded?.(value);
        };
        const outcome = await runTeamAction({
            scope: params.scope,
            actionId: 'secrets.shared.grants.set',
            input: {
                resourceId: params.resourceId,
                expectedRevision: params.expectedRevision,
                accountGrants: [...params.accountGrants],
                teamGrants: [...params.teamGrants],
                groupGrants: [...params.groupGrants],
            },
            parse: (value) => SharedSavedSecretMutationOutputV1Schema.parse(value),
            onApprovalSucceeded: finishApproved,
            ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
        });
        if (outcome.kind !== 'succeeded') {
            return { ok: false, reason: operationFailureReason(outcome.failure.kind) };
        }
        if (params.encryptionMode === 'e2ee' && resourceDataKey) {
            await repairSavedSecretResourceEnvelopesBestEffort({
                scope: params.scope,
                resourceId: params.resourceId,
                expectedRevision: outcome.value.revision,
                resourceDataKey,
            }).catch(() => undefined);
        }
        return { ok: true };
    } catch (error) {
        if (isTeamActionApprovalPendingError(error)) throw error;
        return { ok: false, reason: 'failed' };
    } finally {
        resourceDataKey?.fill(0);
    }
}
