import { recordHomeAdministrationEventInTx } from "@/app/home/audit/homeAdministrationEvents";
import { PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import { type ManagedResourceDependencyV1, type ManagedResourceDispositionV1 } from '@happier-dev/protocol/machines/managed/managedDependencyV1';
import { acceptsManagedResourceDispositions, readManagedResourceDependenciesInTx } from "@/app/machines/managed/managedRead";
import { buildPluginDomainAccountChangeEntityId } from '@happier-dev/protocol/changes/pluginDomain';

import { enqueueAccountChangePublication, markAccountChanged } from "@/app/changes/markAccountChanged";
import { withdrawPublicProfileInTx } from '@/app/account/profile/publicProfileWithdrawal';
import { readMachineAccessKeySessionBindingsInTx } from "@/app/accessKeys/sessionMachineAccessKeyMutations";
import { resolveCurrentMachineRecipientAccountIdsInTx } from "@/app/machines/machineAccess";
import { applyMachineAccessImpactsInTx, captureMachineAccessImpactsInTx } from "@/app/machines/machineAccessEffects";
import { eventRouter } from "@/app/events/eventRouter";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import {
    assertHomeOwnershipSurvivesTransitionInTx,
    authorizeHomeAccountErasureActorInTx,
    authorizeHomeGovernanceMutationInTx,
} from "@/app/home/governance/homeCapabilities";
import { acquireAccountLifecycleAdmissionInTx, setAccountStatusInTx } from "@/app/home/governance/accountLifecycle";
import { publishHomeGovernanceChangedInTx } from "@/app/home/governance/governanceChanges";
import { readPluginsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { admitAccountDataEraseThroughEncryptionTransitionInTx } from "@/app/encryption/accountEncryptionTransitionCoordinator";
import { cleanupPluginWebhooksForAccountDeletionTxV1 } from "@/app/plugins/webhooks/accountDeletion";
import { deleteDefaultAccountPetPrivateObject } from "@/app/pets/accountPetLibraryRuntime";
import { deleteSessionWithRecipientsInTx } from "@/app/session/delete/deleteOwnedSession";
import { SessionDeleteConditionLostError } from "@/app/session/delete/deleteSessionTree";
import { eraseSessionAccessGrantsForAccountInTx, readSessionAccessGrantsForAccountErasureInTx } from "@/app/session/access/sessionAccessGrantService";
import { eraseDiscussionAccessGrantsForAccountInTx, readDiscussionAccessGrantsForAccountErasureInTx } from "@/app/discussions/accessService";
import { resolveDiscussionAudienceInTx } from "@/app/discussions/access";
import { assertTeamOwnershipAllowsAccountErasureInTx } from "@/app/teams/memberships/erasurePrecondition";
import { publishAccountTeamMembershipsChangedInTx } from "@/app/teams/teamChanges";
import { clearSessionResponsibilitiesForAccountRemovalInTx, readSessionResponsibilityRemovalSessionIdsInTx } from "@/app/session/access/sessionResponsibilityService";
import { getWorkflowPublicationAudienceInTx } from "@/app/workflows/workflowPublicationAudience";
import { readAutomationMachineAssignmentRemovalPublicationAudienceInTx } from "@/app/automations/automationMachineAssignmentRemoval";
import { erasePrematerializedEphemeralRunnerActivationsForAccountInTx } from "@/app/ephemeralRunner/activationLifecycle";
import {
    buildPluginAccountStoragePhysicalKey,
    buildPluginDeclarativeSettingsPhysicalKey,
} from "@/app/kv/accountScopedKv";
import { applyUserKvMutationsInTx, type KVMutation } from "@/app/kv/kvMutate";
import { deletePublicFile, deletePrivateFile } from "@/storage/blob/files";
import { hasPendingAccountPrivateFileUploadInTx, isAccountPrivateFileUpload } from "@/storage/privateFiles/accountPrivateFileCustody";
import { afterTx, inTx, TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { getActivePrismaRuntime } from "@/storage/prisma";

import { retirePluginCollectionCandidatePreparationStagesTx } from "./collections/candidatePreparationLifecycle";
import { advancePluginCollectionRevision } from "./collections/mutation";

type PluginAccountDataEraseTombstoneResult = Readonly<{
    status: "tombstoned" | "already-tombstoned";
    revision: number;
}>;

export type PluginAccountDataEraseResult =
    | Readonly<{ status: "account-not-found" }>
    | Readonly<{ status: "transition-cleanup-pending" }>
    | Readonly<{ status: "managed-resources-review-required"; resources: readonly ManagedResourceDependencyV1[] }>
    | Readonly<{
        status: "erased";
        accountStorage: PluginAccountDataEraseTombstoneResult;
        declarativeSettings: PluginAccountDataEraseTombstoneResult;
        collections: Readonly<{
            tombstonedRowCount: number;
            scrubbedHistoricalTombstoneContentCount: number;
            deletedProjectionCount: number;
            deletedIndexEntryCount: number;
            resetIndexStateCount: number;
            retiredRelationCount: number;
        }>;
    }>;

type ReservedKvTombstone = Readonly<{
    key: string;
    result: PluginAccountDataEraseTombstoneResult;
}>;

type CollectionChange = Readonly<{
    collectionId: string;
    contractDigest: string;
    revision: number;
}>;

type ErasureLiveCollectionRow = Readonly<{
    id: string;
    collectionId: string;
    contractDigest: string;
    revision: number;
}>;

type ErasureHistoricalTombstoneRow = Readonly<{
    id: string;
    contentEnvelope: unknown;
}>;

type ErasureIdRow = Readonly<{ id: string }>;

/**
 * Tombstones one or more server-owned reserved Account KV rows through the
 * sole UserKV CAS owner. Existing tombstones are intentionally not written a
 * second time, so a retry cannot advance a revision or re-publish a change.
 */
async function tombstoneReservedAccountKvRowsInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    keys: readonly string[];
}>): Promise<readonly ReservedKvTombstone[]> {
    const existing = await Promise.all(input.keys.map(async (key) => ({
        key,
        row: await input.tx.userKVStore.findUnique({
            where: { accountId_key: { accountId: input.accountId, key } },
            select: { value: true, version: true },
        }),
    })));
    const mutations: KVMutation[] = existing
        .filter(({ row }) => row === null || row.value !== null)
        .map(({ key, row }) => ({
            key,
            value: null,
            version: row?.version ?? -1,
        }));
    const appliedByKey = new Map<string, number>();
    if (mutations.length > 0) {
        const application = await applyUserKvMutationsInTx(
            input.tx,
            { uid: input.accountId },
            mutations,
        );
        if (!application.success) {
            throw new Error("Reserved Account KV tombstone lost its transaction-local CAS.");
        }
        for (const result of application.results) appliedByKey.set(result.key, result.version);
    }
    return Object.freeze(existing.map(({ key, row }) => {
        const revision = appliedByKey.get(key);
        if (revision !== undefined) return { key, result: { status: "tombstoned" as const, revision } };
        if (!row) throw new Error("Reserved Account KV tombstone result was missing.");
        return { key, result: { status: "already-tombstoned" as const, revision: row.version } };
    }));
}

function mergeCollectionChange(input: Readonly<{
    byCollection: Map<string, CollectionChange>;
    row: Readonly<{ collectionId: string; contractDigest: string; revision: number }>;
}>): void {
    const candidate: CollectionChange = {
        collectionId: input.row.collectionId,
        contractDigest: input.row.contractDigest,
        revision: advancePluginCollectionRevision(input.row.revision),
    };
    const current = input.byCollection.get(candidate.collectionId);
    if (
        !current
        || candidate.revision > current.revision
        || (
            candidate.revision === current.revision
            && candidate.contractDigest < current.contractDigest
        )
    ) {
        input.byCollection.set(candidate.collectionId, candidate);
    }
}

function orderedCollectionChanges(
    byCollection: ReadonlyMap<string, CollectionChange>,
): readonly CollectionChange[] {
    return Object.freeze([...byCollection.values()].sort((left, right) => (
        left.collectionId < right.collectionId ? -1 : left.collectionId > right.collectionId ? 1 : 0
    )));
}

/**
 * Erases the server-owned Account-data destinations for one plugin.
 *
 * This is deliberately not the present-user Account-erase entry point: the
 * caller that has such authority must separately compose the canonical whole
 * Account Settings CAS for secret bindings. Immutable collection contracts are
 * global admission records, so this owner retains them while tombstoning only
 * the selected Account's rows and clearing their derived projections/index
 * entries/relation edges.
 */
export async function erasePluginAccountDataInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    pluginId: string;
    managedResourceDispositions?: readonly ManagedResourceDispositionV1[];
}>): Promise<PluginAccountDataEraseResult> {
    const pluginId = PluginIdSchema.parse(input.pluginId);
    const fence = await acquireAccountEncryptionTransitionFenceInTx(input.tx, input.accountId, "exclusive");
    if (fence.status === "account_not_found") return { status: "account-not-found" };
    if (fence.status === "account_inconsistent") {
        throw new Error("Plugin Account data erase requires a consistent Account encryption mode.");
    }
    // Review retained native custody before transition cancellation or any
    // selected Data destination is mutated. Manual acceptance is not cleanup.
    const resources = await readManagedResourceDependenciesInTx(input.tx, {
        kind: "plugin", accountId: input.accountId, pluginId,
    });
    if (!acceptsManagedResourceDispositions(resources, input.managedResourceDispositions)) {
        return { status: "managed-resources-review-required", resources };
    }
    // The Account-owned coordinator takes the shared serialization fence and
    // asks the active lifecycle to cancel before this Data owner reads or
    // mutates anything. A single call may only drain its bounded cleanup
    // chunk, so return a retryable result rather than tombstoning selected
    // destinations while staged envelopes remain.
    const transitionAdmission = await admitAccountDataEraseThroughEncryptionTransitionInTx({
        tx: input.tx,
        accountId: input.accountId,
    });
    if (transitionAdmission.status === "account_not_found") {
        return { status: "account-not-found" };
    }
    if (transitionAdmission.status === "account_inconsistent") {
        throw new Error("Plugin Account data erase requires a consistent Account encryption mode.");
    }
    if (transitionAdmission.status === "transition_cleanup_pending") {
        return { status: "transition-cleanup-pending" };
    }

    // Candidate target bytes are non-authoritative and scoped to this exact
    // Account/plugin lifetime. Retire them before erasure mutates the source
    // rows so retries cannot retain an erased source snapshot.
    await retirePluginCollectionCandidatePreparationStagesTx({
        tx: input.tx,
        accountId: input.accountId,
        pluginId,
    });

    const accountStorageKey = buildPluginAccountStoragePhysicalKey(pluginId);
    const declarativeSettingsKey = buildPluginDeclarativeSettingsPhysicalKey(pluginId);
    const reservedKvRows = await tombstoneReservedAccountKvRowsInTx({
        tx: input.tx,
        accountId: input.accountId,
        keys: [accountStorageKey, declarativeSettingsKey],
    });
    const accountStorage = reservedKvRows.find((row) => row.key === accountStorageKey)?.result;
    const declarativeSettings = reservedKvRows.find((row) => row.key === declarativeSettingsKey)?.result;
    if (!accountStorage || !declarativeSettings) {
        throw new Error("Plugin Account data erase did not tombstone every reserved destination.");
    }

    const maximumBatchRows = readPluginsFeatureEnv(process.env).collectionLimits.maxBatchRows;
    const collectionChangesById = new Map<string, CollectionChange>();
    const now = new Date();
    let tombstonedRowCount = 0;
    let lastLiveRowId: string | null = null;
    for (;;) {
        const liveRows: ErasureLiveCollectionRow[] = await input.tx.pluginCollectionRow.findMany({
            where: {
                accountId: input.accountId,
                pluginId,
                deletedAt: null,
                ...(lastLiveRowId ? { id: { gt: lastLiveRowId } } : {}),
            },
            orderBy: { id: "asc" },
            take: maximumBatchRows,
            select: {
                id: true,
                collectionId: true,
                contractDigest: true,
                revision: true,
            },
        });
        if (liveRows.length === 0) break;
        // `mergeCollectionChange` allocates each row's tombstone revision
        // through the canonical Collection allocator, so a row the persisted
        // column can no longer advance refuses the erase batch — inside this
        // transaction, before any tombstone write — instead of overflowing.
        for (const row of liveRows) {
            mergeCollectionChange({ byCollection: collectionChangesById, row });
        }
        const rowTombstone = await input.tx.pluginCollectionRow.updateMany({
            where: { id: { in: liveRows.map((row) => row.id) }, deletedAt: null },
            data: {
                revision: { increment: 1 },
                deletedAt: now,
                contentEnvelope: getActivePrismaRuntime().JsonNull,
            },
        });
        tombstonedRowCount += rowTombstone.count;
        lastLiveRowId = liveRows[liveRows.length - 1]!.id;
    }

    // Historical tombstones must be content-free too. Do not increment their
    // revision or rewrite deletion history: this is erasure scrubbing, not a
    // new logical Collection mutation.
    let scrubbedHistoricalTombstoneContentCount = 0;
    let lastHistoricalTombstoneId: string | null = null;
    for (;;) {
        const historicalTombstones: ErasureHistoricalTombstoneRow[] = await input.tx.pluginCollectionRow.findMany({
            where: {
                accountId: input.accountId,
                pluginId,
                deletedAt: { not: null },
                ...(lastHistoricalTombstoneId ? { id: { gt: lastHistoricalTombstoneId } } : {}),
            },
            orderBy: { id: "asc" },
            take: maximumBatchRows,
            select: { id: true, contentEnvelope: true },
        });
        if (historicalTombstones.length === 0) break;
        const historicalTombstoneContentIds = historicalTombstones
            .filter((row) => row.contentEnvelope !== null)
            .map((row) => row.id);
        if (historicalTombstoneContentIds.length > 0) {
            const scrub = await input.tx.pluginCollectionRow.updateMany({
                where: { id: { in: historicalTombstoneContentIds } },
                data: { contentEnvelope: getActivePrismaRuntime().JsonNull },
            });
            scrubbedHistoricalTombstoneContentCount += scrub.count;
        }
        lastHistoricalTombstoneId = historicalTombstones[historicalTombstones.length - 1]!.id;
    }

    let deletedProjectionCount = 0;
    let lastProjectionId: string | null = null;
    for (;;) {
        const projections: ErasureIdRow[] = await input.tx.pluginCollectionProjection.findMany({
            where: {
                accountId: input.accountId,
                pluginId,
                ...(lastProjectionId ? { id: { gt: lastProjectionId } } : {}),
            },
            orderBy: { id: "asc" },
            take: maximumBatchRows,
            select: { id: true },
        });
        if (projections.length === 0) break;
        const deletion = await input.tx.pluginCollectionProjection.deleteMany({
            where: { id: { in: projections.map((projection) => projection.id) } },
        });
        deletedProjectionCount += deletion.count;
        lastProjectionId = projections[projections.length - 1]!.id;
    }
    let deletedIndexEntryCount = 0;
    let resetIndexStateCount = 0;
    let lastIndexStateId: string | null = null;
    for (;;) {
        const indexStates: ErasureIdRow[] = await input.tx.pluginCollectionIndexState.findMany({
            where: {
                accountId: input.accountId,
                pluginId,
                ...(lastIndexStateId ? { id: { gt: lastIndexStateId } } : {}),
            },
            orderBy: { id: "asc" },
            take: maximumBatchRows,
            select: { id: true },
        });
        if (indexStates.length === 0) break;
        const indexStateIds = indexStates.map((state) => state.id);
        const indexEntryDeletion = await input.tx.pluginCollectionIndexEntry.deleteMany({
            where: { indexStateId: { in: indexStateIds } },
        });
        deletedIndexEntryCount += indexEntryDeletion.count;
        const indexStateReset = await input.tx.pluginCollectionIndexState.updateMany({
            where: {
                id: { in: indexStateIds },
                OR: [
                    { indexedThroughRevision: { not: 0 } },
                    { indexedThroughRevision: null },
                ],
            },
            data: { indexedThroughRevision: 0 },
        });
        resetIndexStateCount += indexStateReset.count;
        lastIndexStateId = indexStates[indexStates.length - 1]!.id;
    }
    let retiredRelationCount = 0;
    let lastRelationId: string | null = null;
    for (;;) {
        const relations: ErasureIdRow[] = await input.tx.pluginCollectionRelation.findMany({
            where: {
                accountId: input.accountId,
                sourcePluginId: pluginId,
                deletedAt: null,
                ...(lastRelationId ? { id: { gt: lastRelationId } } : {}),
            },
            orderBy: { id: "asc" },
            take: maximumBatchRows,
            select: { id: true },
        });
        if (relations.length === 0) break;
        const retirement = await input.tx.pluginCollectionRelation.updateMany({
            where: { id: { in: relations.map((relation) => relation.id) }, deletedAt: null },
            data: { deletedAt: now },
        });
        retiredRelationCount += retirement.count;
        lastRelationId = relations[relations.length - 1]!.id;
    }
    const collectionChanges = orderedCollectionChanges(collectionChangesById);

    if (accountStorage.status === "tombstoned") {
        const hint = {
            pluginDomain: "dataKv" as const,
            pluginId,
            full: true as const,
        };
        await markAccountChanged(input.tx, {
            accountId: input.accountId,
            kind: "pluginDomain",
            entityId: buildPluginDomainAccountChangeEntityId(hint),
            hint,
        });
    }
    if (declarativeSettings.status === "tombstoned") {
        const hint = {
            pluginDomain: "settings" as const,
            pluginId,
            scope: "account" as const,
            revision: declarativeSettings.revision,
        };
        await markAccountChanged(input.tx, {
            accountId: input.accountId,
            kind: "pluginDomain",
            entityId: buildPluginDomainAccountChangeEntityId(hint),
            hint,
        });
    }
    for (const collection of collectionChanges) {
        const hint = {
            pluginDomain: "dataCollection" as const,
            pluginId,
            collectionId: collection.collectionId,
            contractDigest: collection.contractDigest,
            revision: collection.revision,
            full: true as const,
        };
        await markAccountChanged(input.tx, {
            accountId: input.accountId,
            kind: "pluginDomain",
            entityId: buildPluginDomainAccountChangeEntityId(hint),
            hint,
        });
    }

    return {
        status: "erased",
        accountStorage,
        declarativeSettings,
        collections: {
            tombstonedRowCount,
            scrubbedHistoricalTombstoneContentCount,
            deletedProjectionCount,
            deletedIndexEntryCount,
            resetIndexStateCount,
            retiredRelationCount,
        },
    };
}

export async function erasePluginAccountData(input: Readonly<{
    accountId: string;
    pluginId: string;
    managedResourceDispositions?: readonly ManagedResourceDispositionV1[];
}>): Promise<PluginAccountDataEraseResult> {
    // Existing exclusive Account admission precedes every dependency/collection
    // census and excludes the canonical collection and managed-resource writers.
    return await inTx(async (tx) => await erasePluginAccountDataInTx({ tx, ...input }), { isolationLevel: "ReadCommitted" });
}

export type DeleteAccountForErasureResult =
    | Readonly<{ status: "deleted" }>
    | Readonly<{ status: "already-deleted" }>
    | Readonly<{ status: "failed"; code: "account_erasure_managed_resources_review_required"; resources: readonly ManagedResourceDependencyV1[] }>
    | Readonly<{
        status: "failed";
        code:
            | "account_erasure_transition_cleanup_pending"
            | "account_erasure_blob_delete_failed"
            | "account_erasure_locator_mismatch"
            // The Account was reactivated after Phase A retired it, so this
            // erasure is no longer the current intent for that Account.
            | "account_erasure_not_retired"
            | "home_owner_transfer_required"
            // A live, staffed Team would lose its last owner. Team ownership is
            // decided by its own owner; this composition only refuses to erase.
            | "team_owner_transfer_required"
            | "home_governance_forbidden"
            | "home_account_not_found";
    }>;

/**
 * Who admitted this erasure.
 *
 * This is an internal caller context established by the entry point that
 * already authenticated a principal — never a field parsed from a request
 * body. `self` is the released present-user erasure of one's own Account and
 * carries no authority over anyone else, so it is also the safe default for
 * trusted internal cleanup compositions. `home_administration` is the only way
 * to erase a different Account, and it must name the verified actor so both
 * protected transactions can reread that actor's current authority.
 */
export type AccountErasureActor =
    | Readonly<{ kind: "self" }>
    | Readonly<{ kind: "home_administration"; actorAccountId: string }>;

type AccountErasureActorRejection = "home_governance_forbidden" | "home_account_not_found";

/**
 * Rereads an administrative actor's current `eraseAccounts` authority inside
 * the deciding transaction.
 *
 * An admitted self-erasure is deliberately not rechecked: Phase A revokes that
 * Account's own credentials on purpose, and its own intentional revocation must
 * not make the invocation it already admitted impossible to finish. A later
 * self request cannot reach here at all, because those credentials no longer
 * authenticate.
 */
async function admitAccountErasureActorInTx(tx: Tx, input: Readonly<{
    actor: AccountErasureActor;
    accountId: string;
}>): Promise<AccountErasureActorRejection | null> {
    if (input.actor.kind === "self") return null;
    const admission = await authorizeHomeGovernanceMutationInTx(tx, {
        actorAccountId: input.actor.actorAccountId,
        request: { operation: "erase_account", targetAccountId: input.accountId },
    });
    return admission.status === "authorized" ? null : admission.code;
}

async function admitAccountErasureActorForAbsentTargetInTx(
    tx: Tx,
    actor: AccountErasureActor,
): Promise<"home_governance_forbidden" | null> {
    if (actor.kind === "self") return null;
    const admission = await authorizeHomeAccountErasureActorInTx(tx, actor.actorAccountId);
    return admission.status === "authorized" ? null : admission.code;
}

type AccountErasurePublicBlobLocator = Readonly<{
    id: string;
    path: string;
}>;

type AccountErasurePrivateBlobLocator = Readonly<{
    id: string;
    objectKey: string;
}>;

type AccountErasureBlobLocators = Readonly<{
    publicFiles: readonly AccountErasurePublicBlobLocator[];
    privatePetAssets: readonly AccountErasurePrivateBlobLocator[];
    privateFiles: readonly AccountErasurePrivateBlobLocator[];
}>;

function sameOrderedLocators<T>(
    left: readonly T[],
    right: readonly T[],
    matches: (left: T, right: T) => boolean,
): boolean {
    return left.length === right.length && left.every((value, index) => matches(value, right[index]!));
}

function sameAccountErasureBlobLocators(
    left: AccountErasureBlobLocators,
    right: AccountErasureBlobLocators,
): boolean {
    return sameOrderedLocators(left.publicFiles, right.publicFiles, (l, r) => l.id === r.id && l.path === r.path)
        && sameOrderedLocators(left.privatePetAssets, right.privatePetAssets, (l, r) => l.id === r.id && l.objectKey === r.objectKey)
        && sameOrderedLocators(left.privateFiles, right.privateFiles, (l, r) => l.id === r.id && l.objectKey === r.objectKey);
}

async function captureAccountErasureBlobLocatorsInTx(
    tx: Tx,
    accountId: string,
): Promise<AccountErasureBlobLocators> {
    const [uploadedFiles, privatePetAssets, privateArtifactBlobs, privateDiscussionAttachments] = await Promise.all([
        tx.uploadedFile.findMany({
            where: { accountId },
            select: { id: true, path: true, reuseKey: true },
            orderBy: [{ path: "asc" }, { id: "asc" }],
        }),
        tx.accountPetAsset.findMany({
            where: { accountId },
            select: { id: true, objectKey: true },
            orderBy: [{ objectKey: "asc" }, { id: "asc" }],
        }),
        tx.artifactBlob.findMany({
            where: { artifact: { accountId } }, select: { id: true, storageKey: true },
            orderBy: [{ storageKey: 'asc' }, { id: 'asc' }],
        }),
        tx.discussionAttachment.findMany({ where: { message: { discussion: { ownerAccountId: accountId } } },
            select: { blobId: true, storageKey: true }, orderBy: [{ storageKey: 'asc' }, { blobId: 'asc' }] }),
    ]);
    return Object.freeze({
        publicFiles: Object.freeze(uploadedFiles.filter(row => !isAccountPrivateFileUpload(row))
            .map(({ id, path }) => Object.freeze({ id, path }))),
        privatePetAssets: Object.freeze(privatePetAssets.map(({ id, objectKey }) => Object.freeze({ id, objectKey }))),
        privateFiles: Object.freeze([
            ...privateArtifactBlobs.map(({ id, storageKey }) => Object.freeze({ id, objectKey: storageKey })),
            ...privateDiscussionAttachments.map(({ blobId, storageKey }) => Object.freeze({ id: blobId, objectKey: storageKey })),
            ...uploadedFiles.filter(isAccountPrivateFileUpload).map(({ id, path }) => Object.freeze({ id, objectKey: path })),
        ]),
    });
}

async function deleteAccountErasureBlobLocators(
    locators: AccountErasureBlobLocators,
): Promise<boolean> {
    const [publicResults, privateResults, fileResults] = await Promise.all([
        Promise.allSettled(locators.publicFiles.map(async ({ path }) => await deletePublicFile(path))),
        Promise.allSettled(locators.privatePetAssets.map(async ({ objectKey }) => await deleteDefaultAccountPetPrivateObject(objectKey))),
        Promise.allSettled(locators.privateFiles.map(async ({ objectKey }) => await deletePrivateFile(objectKey))),
    ]);
    return publicResults.every((result) => result.status === "fulfilled")
        && privateResults.every((result) => result.status === "fulfilled")
        && fileResults.every((result) => result.status === 'fulfilled');
}

/** Cleanup discovery belongs to its domain owners, not the ordinary status census. */
async function readAccountErasureScopeInTx(tx: Tx, accountId: string) {
    const [shares, discussions, ownedSessions, responsibilitySessionIds, machines] = await Promise.all([
        readSessionAccessGrantsForAccountErasureInTx(tx, accountId),
        readDiscussionAccessGrantsForAccountErasureInTx(tx, accountId),
        tx.session.findMany({ where: { accountId }, select: { id: true } }),
        readSessionResponsibilityRemovalSessionIdsInTx(tx, accountId),
        tx.machine.findMany({ where: { OR: [
            { accountId },
            { accountGrants: { some: { OR: [{ accountId }, { createdByAccountId: accountId }] } } },
            { teamGrants: { some: { createdByAccountId: accountId } } },
            { groupGrants: { some: { createdByAccountId: accountId } } },
        ] }, select: { id: true } }),
    ]);
    // Physical deletion cascades owned Machines and received/authored grants.
    // Admit their current audience before lifecycle locks, even when a foreign
    // grant creator no longer has access to the Machine it once shared.
    const machineIds = machines.map(machine => machine.id).sort();
    const machineAccountIds = [...new Set((await Promise.all(machineIds.map(machineId =>
        resolveCurrentMachineRecipientAccountIdsInTx(tx, machineId)))).flat())].sort();
    const ownedSessionIds = ownedSessions.map(session => session.id);
    // Deleting an owned Session retires its scoped Automations through their
    // real owner, including review, Run, Follow and managed-wake projections.
    const scopedAutomations = await tx.automation.findMany({ where: {
        accountId, scopeSessionId: { in: ownedSessionIds }, deletedAt: null,
    }, select: { id: true } });
    const automationIds = scopedAutomations.map(automation => automation.id);
    const [discussionAudiences, workflowAudience, runners] = await Promise.all([
        Promise.all(discussions.map(discussion => resolveDiscussionAudienceInTx(tx, discussion.id))),
        getWorkflowPublicationAudienceInTx(tx, { accountId, automationIds,
            runWhere: { accountId, automationId: { in: automationIds } } }),
        tx.ephemeralRunnerActivation.findMany({ where: {
            sessionId: { in: ownedSessionIds }, state: 'materialized',
        }, select: { creatorAccountId: true, machineId: true } }),
    ]);
    const runnerAudiences = await Promise.all(runners.flatMap(runner => runner.machineId
        ? [readAutomationMachineAssignmentRemovalPublicationAudienceInTx(tx, {
            accountId: runner.creatorAccountId, machineId: runner.machineId,
        })] : []));
    return {
        machineIds,
        machineAccountIds,
        sessionIds: [...new Set([...ownedSessionIds, ...shares.map(share => share.sessionId),
            ...responsibilitySessionIds, ...workflowAudience.sessionIds,
            ...runnerAudiences.flatMap(audience => audience.sessionIds)])].sort(),
        discussionIds: discussions.map(discussion => discussion.id).sort(),
        accountIds: [...new Set([accountId, ...machineAccountIds, ...discussionAudiences.flat(), ...workflowAudience.accountIds,
            ...runners.map(runner => runner.creatorAccountId), ...runnerAudiences.flatMap(audience => audience.accountIds)])].sort(),
    };
}

/**
 * Sole physical Account-deletion composition. Existing domain owners remove
 * restrictive custody in the same fenced transaction as the Account row,
 * but owned public/private blob coordinates remain in Account rows until their
 * storage owners confirm idempotent deletion. A retry therefore keeps exact
 * coordinates without adding a ledger, worker, status row, or second API.
 */
export async function deleteAccountForErasure(input: Readonly<{
    accountId: string;
    now?: Date;
    /** Defaults to the released present-user erasure of one's own Account. */
    actor?: AccountErasureActor;
    managedResourceDispositions?: readonly ManagedResourceDispositionV1[];
}>): Promise<DeleteAccountForErasureResult> {
    const actor: AccountErasureActor = input.actor ?? { kind: "self" };
    const fenceAccounts = async (tx: Tx, erasureActor: AccountErasureActor) => {
        const captured = await readAccountErasureScopeInTx(tx, input.accountId);
        await acquireAccountLifecycleAdmissionInTx(tx, {
            accountId: input.accountId,
            additionalAccountIds: [...captured.accountIds,
                ...(erasureActor.kind === "home_administration" ? [erasureActor.actorAccountId] : [])],
            additionalSessionIds: captured.sessionIds,
            includeLifecyclePublications: true,
        });
        // A wait may expose a newly authored/received grant or cleanup resource.
        // Replay complete admission; never extend its sorted cohort afterward.
        const current = await readAccountErasureScopeInTx(tx, input.accountId);
        const grew = (ids: readonly string[], previous: readonly string[]) => {
            const admitted = new Set(previous);
            return ids.some(id => !admitted.has(id));
        };
        if (grew(current.machineIds, captured.machineIds)
            || grew(current.sessionIds, captured.sessionIds) || grew(current.discussionIds, captured.discussionIds)
            || grew(current.accountIds, captured.accountIds)) {
            throw new TransactionReplayRequiredError('transaction-account-audience-changed');
        }
        return current;
    };
    const capturePreflight = async (tx: Tx) => {
        await fenceAccounts(tx, actor);
        const fence = await acquireAccountEncryptionTransitionFenceInTx(
            tx,
            input.accountId,
            "exclusive",
        );
        if (fence.status === "account_not_found") {
            const actorRejection = await admitAccountErasureActorForAbsentTargetInTx(tx, actor);
            return actorRejection
                ? { status: "rejected" as const, code: actorRejection }
                : { status: "already-deleted" as const };
        }
        if (fence.status === "account_inconsistent") {
            throw new Error("Plugin Account deletion requires a consistent Account encryption mode.");
        }
        // The actor's authority is decided from current database state, before
        // anything is retired or deleted. A demotion that landed after the
        // request was admitted is honored here.
        const actorRejection = await admitAccountErasureActorInTx(tx, { actor, accountId: input.accountId });
        if (actorRejection) return { status: "rejected" as const, code: actorRejection };
        // Lifecycle admission already excludes competing Home/Team ownership
        // changes through the complete existing exclusive Account cohort.
        // Ownership is decided before any irreversible external deletion, and
        // it applies to every entry point: a Home must never be left without an
        // active owner because one of its owners erased their Account.
        const ownership = await assertHomeOwnershipSurvivesTransitionInTx(tx, {
            targetAccountId: input.accountId,
            removesAccount: true,
        });
        if (ownership.status === "rejected") {
            return { status: "rejected" as const, code: ownership.code };
        }
        // The same question for every Team this Account owns, answered by the
        // Team membership owner. It runs before the terminal disable for the
        // same reason as the Home check: a refused erasure must leave the
        // Account exactly as it found it.
        const teamOwnership = await assertTeamOwnershipAllowsAccountErasureInTx(tx, {
            accountId: input.accountId,
        });
        if (teamOwnership.status === "rejected") {
            return { status: "rejected" as const, code: teamOwnership.code };
        }

        const resources = await readManagedResourceDependenciesInTx(tx, { kind: "account", accountId: input.accountId });
        if (!acceptsManagedResourceDispositions(resources, input.managedResourceDispositions)) {
            return { status: "rejected" as const, code: "account_erasure_managed_resources_review_required" as const, resources };
        }

        // Reuse the transition owner's bounded cancellation before revoking
        // the caller or deleting source data. A pending chunk commits its
        // progress and leaves the Account available for the same request's retry.
        const transitionAdmission = await admitAccountDataEraseThroughEncryptionTransitionInTx({
            tx,
            accountId: input.accountId,
            ...(input.now ? { now: input.now } : {}),
        });
        if (transitionAdmission.status === "transition_cleanup_pending") {
            return { status: "rejected" as const, code: "account_erasure_transition_cleanup_pending" as const };
        }
        if (transitionAdmission.status === "account_not_found") return { status: "already-deleted" as const };
        if (transitionAdmission.status === "account_inconsistent") {
            throw new Error("Account deletion requires a consistent Account encryption mode.");
        }

        // Keep the caller's authentication usable for retry while a different API
        // replica owns pending IO. The Account fence prevents a new candidate
        // from being captured between this check and the terminal disable.
        if (await hasPendingAccountPrivateFileUploadInTx(tx, input.accountId)) {
            return { status: "rejected" as const, code: "account_erasure_blob_delete_failed" as const };
        }

        // Terminal disable and credential revocation commit before the first
        // irreversible external delete. This is what makes the final deletion
        // safe to attempt: once the Account is inactive it can no longer be
        // assigned a Home role, promoted to Team owner, or named as a
        // provisioning target, so it cannot acquire required ownership while
        // its blobs are being removed. A retry of an already-retired Account
        // reports `unchanged` and proceeds.
        const retired = await setAccountStatusInTx(tx, {
            actorAccountId: input.accountId,
            targetAccountId: input.accountId,
            status: "disabled",
            authority: "account_erasure",
        });
        if (retired.status === "rejected") {
            return retired.code === "home_owner_transfer_required"
                ? { status: "rejected" as const, code: "home_owner_transfer_required" as const }
                : { status: "already-deleted" as const };
        }
        // Public disclosure retires with access, not with retryable physical IO.
        await withdrawPublicProfileInTx(tx, input.accountId);
        // An administrator's erasure is audited when access is revoked and again when the
        // Account is gone, so an erasure that stops in between still has its row (§3.9).
        if (actor.kind === "home_administration" && retired.status === "applied") {
            await recordHomeAdministrationEventInTx(tx, {
                actor: { kind: "account", accountId: actor.actorAccountId },
                target: { kind: "account", id: input.accountId },
                detail: { action: "account.delete", summary: { outcome: "disabled_pending_completion" } },
            });
        }
        await erasePrematerializedEphemeralRunnerActivationsForAccountInTx(tx, {
            creatorAccountId: input.accountId,
        });
        return {
            status: "captured" as const,
            locators: await captureAccountErasureBlobLocatorsInTx(tx, input.accountId),
        };
    };
    const preflight = await inTx(capturePreflight, {
        isolationLevel: "ReadCommitted", transactionClass: "account-erasure.retire",
    });
    if (preflight.status === "already-deleted") return { status: "already-deleted" };
    if (preflight.status === "rejected") {
        if (preflight.code === "account_erasure_managed_resources_review_required") return { status: "failed", code: preflight.code, resources: preflight.resources };
        return { status: "failed", code: preflight.code };
    }
    const capturedLocators = preflight.locators;
    // Initial administrative admission has succeeded. Only this invocation's
    // exact self-target may now continue through its own deliberate revocation;
    // an independent administrator keeps current-authority checks in Phase C.
    const continuationActor: AccountErasureActor = actor.kind === "home_administration"
        && actor.actorAccountId === input.accountId ? { kind: "self" } : actor;

    const blobsDeleted = await deleteAccountErasureBlobLocators(capturedLocators);
    if (!blobsDeleted) {
        return { status: "failed", code: "account_erasure_blob_delete_failed" };
    }

    // Retirement and the Account fences protect admission and owned locators.
    // ReadCommitted lets late publication allocate current cursors for the wider
    // Home/Team/Session audience, including Accounts updated during this cleanup.
    return await inTx(async (tx) => {
        // Retirement already removed this Account from active ownership and
        // prevents new ownership/admission. Its existing Account fence also
        // serializes Session, content and managed-resource publication. Lock an
        // independent administrator in the same ordered audience before reading
        // current authority, so demotion cannot race the physical deletion.
        const erasureScope = await fenceAccounts(tx, continuationActor);
        const fence = await acquireAccountEncryptionTransitionFenceInTx(
            tx,
            input.accountId,
            "exclusive",
        );
        if (fence.status === "account_not_found") {
            const actorRejection = await admitAccountErasureActorForAbsentTargetInTx(tx, continuationActor);
            return actorRejection
                ? { status: "failed", code: actorRejection }
                : { status: "already-deleted" };
        }
        if (fence.status === "account_inconsistent") {
            throw new Error("Plugin Account deletion requires a consistent Account encryption mode.");
        }
        // The Account must still be the one Phase A retired. A reactivated
        // Account is a partially erased Account that something restored, and
        // deleting it here would silently finish an erasure its owner may have
        // since revoked.
        const lifecycle = await tx.account.findUnique({
            where: { id: input.accountId },
            select: { status: true },
        });
        if (!lifecycle) {
            const actorRejection = await admitAccountErasureActorForAbsentTargetInTx(tx, continuationActor);
            return actorRejection
                ? { status: "failed", code: actorRejection }
                : { status: "already-deleted" };
        }
        if (lifecycle.status !== "disabled") {
            return { status: "failed", code: "account_erasure_not_retired" };
        }
        // This transaction is the one that destroys rows, so an independent
        // administrative actor must still hold `eraseAccounts` right now. The
        // target stays terminally retired for a currently authorized retry.
        const actorRejection = await admitAccountErasureActorInTx(tx, { actor: continuationActor, accountId: input.accountId });
        if (actorRejection) return { status: "failed", code: actorRejection };
        // Ownership is rechecked defensively: another transaction may have
        // demoted or retired the remaining owners while the external objects
        // were being deleted.
        const ownership = await assertHomeOwnershipSurvivesTransitionInTx(tx, {
            targetAccountId: input.accountId,
            removesAccount: true,
        });
        if (ownership.status === "rejected") {
            return { status: "failed", code: ownership.code };
        }
        // Rechecked for the same reason as Home ownership: another transaction
        // may have removed or retired the Team's remaining owners while the
        // external objects were being deleted.
        const teamOwnership = await assertTeamOwnershipAllowsAccountErasureInTx(tx, {
            accountId: input.accountId,
        });
        if (teamOwnership.status === "rejected") {
            return { status: "failed", code: teamOwnership.code };
        }
        const resources = await readManagedResourceDependenciesInTx(tx, { kind: "account", accountId: input.accountId });
        if (!acceptsManagedResourceDispositions(resources, input.managedResourceDispositions)) {
            return { status: "failed", code: "account_erasure_managed_resources_review_required", resources };
        }
        const currentLocators = await captureAccountErasureBlobLocatorsInTx(tx, input.accountId);
        if (!sameAccountErasureBlobLocators(capturedLocators, currentLocators)) {
            return { status: "failed", code: "account_erasure_locator_mismatch" };
        }

        const machines = await tx.machine.findMany({ where: { accountId: input.accountId }, select: { id: true } });
        const machineAccessImpacts = await captureMachineAccessImpactsInTx(tx, {
            machineIds: erasureScope.machineIds,
            accountIds: erasureScope.machineAccountIds.filter(accountId => accountId !== input.accountId),
        });
        const erasedMachineBindings = await Promise.all(machines.map(async (machine) => ({
            machineId: machine.id,
            sessionBindings: await readMachineAccessKeySessionBindingsInTx(tx, {
                accountId: input.accountId,
                machineId: machine.id,
            }),
        })));
        const sessions = await tx.session.findMany({ where: { accountId: input.accountId }, select: { id: true }, orderBy: { id: "asc" } });
        await tx.sessionShareAccessLog.deleteMany({ where: { userId: input.accountId } });
        await tx.publicShareAccessLog.deleteMany({ where: { userId: input.accountId } });
        await eraseSessionAccessGrantsForAccountInTx(tx, { accountId: input.accountId });
        await eraseDiscussionAccessGrantsForAccountInTx(tx, { accountId: input.accountId });
        await tx.artifactSignedInLink.deleteMany({ where: { createdByUserId: input.accountId } });
        await tx.publicSessionShare.deleteMany({ where: { createdByUserId: input.accountId } });
        for (const session of sessions) {
            const deleted = await deleteSessionWithRecipientsInTx(tx, {
                sessionId: session.id,
                ownerAccountId: input.accountId,
                reason: "user_request",
            });
            if (!deleted.ok) throw new SessionDeleteConditionLostError();
        }
        await erasePrematerializedEphemeralRunnerActivationsForAccountInTx(tx, {
            creatorAccountId: input.accountId,
        });
        await clearSessionResponsibilitiesForAccountRemovalInTx(tx, { accountId: input.accountId });
        // Requester erasure removes its tuples, never a foreign Machine.
        // Custodian erasure also removes every tuple referencing its Machines,
        // but foreign requester Sessions and their retained history survive.
        await tx.accessKey.deleteMany({ where: { OR: [
            { accountId: input.accountId },
            { machineId: { in: machines.map((machine) => machine.id) } },
        ] } });
        await tx.usageReport.deleteMany({ where: { accountId: input.accountId } });
        await tx.accountPushToken.deleteMany({ where: { accountId: input.accountId } });
        await tx.accountPluginUiArtifact.deleteMany({ where: { release: { accountId: input.accountId } } });
        await tx.accountPluginRelease.deleteMany({ where: { accountId: input.accountId } });
        await tx.artifact.deleteMany({ where: { accountId: input.accountId } });
        await tx.uploadedFile.deleteMany({ where: { accountId: input.accountId } });
        // Manual responsibility destroys Account custody, not the native resource.
        // The exact recovery facts were reviewed before retirement; no secret escrow survives erasure.
        await tx.managedMachine.deleteMany({ where: { custodianAccountId: input.accountId } });
        // Apply Account-FK grant withdrawal before computing access effects;
        // waiting for the terminal Account cascade would lose its before-state.
        const removedAccountGrants = await tx.machineAccountGrant.deleteMany({ where: { OR: [
            { accountId: input.accountId }, { createdByAccountId: input.accountId },
        ] } });
        const removedTeamGrants = await tx.machineTeamGrant.deleteMany({ where: { createdByAccountId: input.accountId } });
        const removedGroupGrants = await tx.machineGroupGrant.deleteMany({ where: { createdByAccountId: input.accountId } });
        await tx.machine.deleteMany({ where: { accountId: input.accountId } });
        await applyMachineAccessImpactsInTx(tx, {
            impacts: machineAccessImpacts.values(),
            grantRosterChanged: removedAccountGrants.count + removedTeamGrants.count + removedGroupGrants.count > 0,
        });
        afterTx(tx, () => {
            for (const binding of erasedMachineBindings) {
                eventRouter.disconnectMachineAndSessionSockets({
                    accountId: input.accountId,
                    ...binding,
                });
            }
        });
        await cleanupPluginWebhooksForAccountDeletionTxV1(tx, {
            accountId: input.accountId,
            ...(input.now ? { now: input.now } : {}),
        });
        // Publish the physical removal in the same transaction. The existing
        // AccountChange owner schedules its socket wake after commit, so no
        // observer can refresh between this marker and the row deletion.
        await publishHomeGovernanceChangedInTx(tx, {
            excludeAccountIds: [input.accountId],
        });
        // Membership rows disappear with the Account. Publish while they still
        // identify the exact affected Teams, through the ordinary Team-change
        // audience owner, so every retained Team view observes the removal.
        await publishAccountTeamMembershipsChangedInTx(tx, {
            accountId: input.accountId,
            excludeAccountIds: [input.accountId],
        });
        if (actor.kind === "home_administration") {
            await recordHomeAdministrationEventInTx(tx, {
                actor: { kind: "account", accountId: actor.actorAccountId },
                target: { kind: "account", id: input.accountId },
                detail: { action: "account.delete", summary: { outcome: "deleted" } },
            });
        }
        // This already-exclusively-admitted erasure is the sole resource-tail
        // exception: allocate queued invalidations before the Account and its
        // retained rows disappear through their existing FK cascades/SET NULL.
        const deletedAccountId = input.accountId;
        enqueueAccountChangePublication(tx, [deletedAccountId], async publicationTx => {
            await publicationTx.account.delete({ where: { id: deletedAccountId } });
        });
        return { status: "deleted" };
    }, { isolationLevel: "ReadCommitted", transactionClass: "account-erasure.delete-retired" });
}
