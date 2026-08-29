import { PluginIdSchema } from "@happier-dev/protocol";
import { buildPluginDomainAccountChangeEntityId } from "@happier-dev/protocol/changes";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { readPluginsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { admitAccountDataEraseThroughEncryptionTransitionInTx } from "@/app/encryption/accountEncryptionTransitionCoordinator";
import { cleanupPluginWebhooksForAccountDeletionTxV1 } from "@/app/plugins/webhooks/accountDeletion";
import { deleteDefaultAccountPetPrivateObject } from "@/app/pets/accountPetLibraryRuntime";
import { deleteSessionTree } from "@/app/session/delete/deleteSessionTree";
import {
    buildPluginAccountStoragePhysicalKey,
    buildPluginDeclarativeSettingsPhysicalKey,
} from "@/app/kv/accountScopedKv";
import { applyUserKvMutationsInTx, type KVMutation } from "@/app/kv/kvMutate";
import { deletePublicFile } from "@/storage/blob/files";
import { inTx, type Tx } from "@/storage/inTx";
import { getActivePrismaRuntime } from "@/storage/prisma";

import { retirePluginCollectionCandidatePreparationStagesTx } from "./collections/candidatePreparationLifecycle";

type PluginAccountDataEraseTombstoneResult = Readonly<{
    status: "tombstoned" | "already-tombstoned";
    revision: number;
}>;

export type PluginAccountDataEraseResult =
    | Readonly<{ status: "account-not-found" }>
    | Readonly<{ status: "transition-cleanup-pending" }>
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
        revision: input.row.revision + 1,
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
}>): Promise<PluginAccountDataEraseResult> {
    const pluginId = PluginIdSchema.parse(input.pluginId);
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
        const liveRows = await input.tx.pluginCollectionRow.findMany({
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
        const historicalTombstones = await input.tx.pluginCollectionRow.findMany({
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
        const projections = await input.tx.pluginCollectionProjection.findMany({
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
        const indexStates = await input.tx.pluginCollectionIndexState.findMany({
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
        const relations = await input.tx.pluginCollectionRelation.findMany({
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
}>): Promise<PluginAccountDataEraseResult> {
    return await inTx(async (tx) => await erasePluginAccountDataInTx({ tx, ...input }));
}

export type DeleteAccountForErasureResult =
    | Readonly<{ status: "deleted" }>
    | Readonly<{ status: "already-deleted" }>
    | Readonly<{
        status: "failed";
        code: "account_erasure_blob_delete_failed" | "account_erasure_locator_mismatch";
    }>;

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
        && sameOrderedLocators(left.privatePetAssets, right.privatePetAssets, (l, r) => l.id === r.id && l.objectKey === r.objectKey);
}

async function captureAccountErasureBlobLocatorsInTx(
    tx: Tx,
    accountId: string,
): Promise<AccountErasureBlobLocators> {
    const [uploadedFiles, privatePetAssets] = await Promise.all([
        tx.uploadedFile.findMany({
            where: { accountId },
            select: { id: true, path: true },
            orderBy: [{ path: "asc" }, { id: "asc" }],
        }),
        tx.accountPetAsset.findMany({
            where: { accountId },
            select: { id: true, objectKey: true },
            orderBy: [{ objectKey: "asc" }, { id: "asc" }],
        }),
    ]);
    return Object.freeze({
        publicFiles: Object.freeze(uploadedFiles.map(({ id, path }) => Object.freeze({ id, path }))),
        privatePetAssets: Object.freeze(privatePetAssets.map(({ id, objectKey }) => Object.freeze({ id, objectKey }))),
    });
}

async function deleteAccountErasureBlobLocators(
    locators: AccountErasureBlobLocators,
): Promise<boolean> {
    const [publicResults, privateResults] = await Promise.all([
        Promise.allSettled(locators.publicFiles.map(async ({ path }) => await deletePublicFile(path))),
        Promise.allSettled(locators.privatePetAssets.map(async ({ objectKey }) => await deleteDefaultAccountPetPrivateObject(objectKey))),
    ]);
    return publicResults.every((result) => result.status === "fulfilled")
        && privateResults.every((result) => result.status === "fulfilled");
}

/**
 * Sole physical Account-deletion composition. Existing domain owners remove
 * restrictive custody in the same serializable transaction as the Account row,
 * but owned public/private blob coordinates remain in Account rows until their
 * storage owners confirm idempotent deletion. A retry therefore keeps exact
 * coordinates without adding a ledger, worker, status row, or second API.
 */
export async function deleteAccountForErasure(input: Readonly<{
    accountId: string;
    now?: Date;
}>): Promise<DeleteAccountForErasureResult> {
    const capturedLocators = await inTx(async (tx) => {
        const fence = await acquireAccountEncryptionTransitionFenceInTx(
            tx,
            input.accountId,
        );
        if (fence.status === "account_not_found") return null;
        if (fence.status === "account_inconsistent") {
            throw new Error("Plugin Account deletion requires a consistent Account encryption mode.");
        }
        return await captureAccountErasureBlobLocatorsInTx(tx, input.accountId);
    });
    if (!capturedLocators) return { status: "already-deleted" };

    const blobsDeleted = await deleteAccountErasureBlobLocators(capturedLocators);
    if (!blobsDeleted) {
        return { status: "failed", code: "account_erasure_blob_delete_failed" };
    }

    return await inTx(async (tx) => {
        const fence = await acquireAccountEncryptionTransitionFenceInTx(
            tx,
            input.accountId,
        );
        if (fence.status === "account_not_found") {
            return { status: "already-deleted" };
        }
        if (fence.status === "account_inconsistent") {
            throw new Error("Plugin Account deletion requires a consistent Account encryption mode.");
        }
        const currentLocators = await captureAccountErasureBlobLocatorsInTx(tx, input.accountId);
        if (!sameAccountErasureBlobLocators(capturedLocators, currentLocators)) {
            return { status: "failed", code: "account_erasure_locator_mismatch" };
        }

        const sessions = await tx.session.findMany({ where: { accountId: input.accountId }, select: { id: true, updatedAt: true }, orderBy: { id: "asc" } });
        await tx.sessionShareAccessLog.deleteMany({ where: { userId: input.accountId } });
        await tx.publicShareAccessLog.deleteMany({ where: { userId: input.accountId } });
        await tx.sessionShare.deleteMany({ where: { OR: [{ sharedByUserId: input.accountId }, { sharedWithUserId: input.accountId }] } });
        await tx.publicSessionShare.deleteMany({ where: { createdByUserId: input.accountId } });
        for (const session of sessions) {
            await deleteSessionTree(tx, { sessionId: session.id, sessionUpdatedAt: session.updatedAt, actorAccountId: input.accountId, reason: "user_request", sessionDeleteWhere: { accountId: input.accountId } });
        }
        await tx.accessKey.deleteMany({ where: { accountId: input.accountId } });
        await tx.usageReport.deleteMany({ where: { accountId: input.accountId } });
        await tx.accountPushToken.deleteMany({ where: { accountId: input.accountId } });
        await tx.accountPluginUiArtifact.deleteMany({ where: { release: { accountId: input.accountId } } });
        await tx.accountPluginRelease.deleteMany({ where: { accountId: input.accountId } });
        await tx.artifact.deleteMany({ where: { accountId: input.accountId } });
        await tx.uploadedFile.deleteMany({ where: { accountId: input.accountId } });
        await tx.machine.deleteMany({ where: { accountId: input.accountId } });
        await cleanupPluginWebhooksForAccountDeletionTxV1(tx, {
            accountId: input.accountId,
            ...(input.now ? { now: input.now } : {}),
        });
        await tx.account.delete({ where: { id: input.accountId } });
        return { status: "deleted" };
    }, { isolationLevel: "Serializable" });
}
