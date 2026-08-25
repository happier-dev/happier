import { PluginIdSchema } from "@happier-dev/protocol";
import { buildPluginDomainAccountChangeEntityId } from "@happier-dev/protocol/changes";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { admitAccountDataEraseThroughEncryptionTransitionInTx } from "@/app/encryption/accountEncryptionTransitionCoordinator";
import { cleanupPluginWebhooksForAccountDeletionTxV1 } from "@/app/plugins/webhooks/accountDeletion";
import {
    buildPluginAccountStoragePhysicalKey,
    buildPluginDeclarativeSettingsPhysicalKey,
} from "@/app/kv/accountScopedKv";
import { applyUserKvMutationsInTx, type KVMutation } from "@/app/kv/kvMutate";
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

function collectCollectionChanges(rows: readonly Readonly<{
    collectionId: string;
    contractDigest: string;
    revision: number;
}>[]): readonly CollectionChange[] {
    const byCollection = new Map<string, CollectionChange>();
    for (const row of rows) {
        const candidate: CollectionChange = {
            collectionId: row.collectionId,
            contractDigest: row.contractDigest,
            revision: row.revision + 1,
        };
        const current = byCollection.get(candidate.collectionId);
        if (
            !current
            || candidate.revision > current.revision
            || (
                candidate.revision === current.revision
                && candidate.contractDigest < current.contractDigest
            )
        ) {
            byCollection.set(candidate.collectionId, candidate);
        }
    }
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

    const liveRows = await input.tx.pluginCollectionRow.findMany({
        where: {
            accountId: input.accountId,
            pluginId,
            deletedAt: null,
        },
        select: {
            id: true,
            collectionId: true,
            contractDigest: true,
            revision: true,
        },
    });
    // Historical tombstones must be content-free too. Do not increment their
    // revision or rewrite deletion history: this is erasure scrubbing, not a
    // new logical Collection mutation.
    const historicalTombstones = await input.tx.pluginCollectionRow.findMany({
        where: {
            accountId: input.accountId,
            pluginId,
            deletedAt: { not: null },
        },
        select: { id: true, contentEnvelope: true },
    });
    const indexStates = await input.tx.pluginCollectionIndexState.findMany({
        where: { accountId: input.accountId, pluginId },
        select: { id: true },
    });
    const collectionChanges = collectCollectionChanges(liveRows);
    const now = new Date();

    const rowTombstone = liveRows.length === 0
        ? { count: 0 }
        : await input.tx.pluginCollectionRow.updateMany({
            where: { id: { in: liveRows.map((row) => row.id) } },
            data: {
                revision: { increment: 1 },
                deletedAt: now,
                contentEnvelope: getActivePrismaRuntime().JsonNull,
            },
        });
    const historicalTombstoneContentIds = historicalTombstones
        .filter((row) => row.contentEnvelope !== null)
        .map((row) => row.id);
    const historicalTombstoneContentScrub = historicalTombstoneContentIds.length === 0
        ? { count: 0 }
        : await input.tx.pluginCollectionRow.updateMany({
            where: { id: { in: historicalTombstoneContentIds } },
            data: { contentEnvelope: getActivePrismaRuntime().JsonNull },
        });
    const projectionDeletion = await input.tx.pluginCollectionProjection.deleteMany({
        where: { accountId: input.accountId, pluginId },
    });
    const indexEntryDeletion = indexStates.length === 0
        ? { count: 0 }
        : await input.tx.pluginCollectionIndexEntry.deleteMany({
            where: { indexStateId: { in: indexStates.map((state) => state.id) } },
        });
    const indexStateReset = indexStates.length === 0
        ? { count: 0 }
        : await input.tx.pluginCollectionIndexState.updateMany({
            where: {
                id: { in: indexStates.map((state) => state.id) },
                OR: [
                    { indexedThroughRevision: { not: 0 } },
                    { indexedThroughRevision: null },
                ],
            },
            data: { indexedThroughRevision: 0 },
        });
    const relationRetirement = await input.tx.pluginCollectionRelation.updateMany({
        where: {
            accountId: input.accountId,
            sourcePluginId: pluginId,
            deletedAt: null,
        },
        data: { deletedAt: now },
    });

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
            tombstonedRowCount: rowTombstone.count,
            scrubbedHistoricalTombstoneContentCount: historicalTombstoneContentScrub.count,
            deletedProjectionCount: projectionDeletion.count,
            deletedIndexEntryCount: indexEntryDeletion.count,
            resetIndexStateCount: indexStateReset.count,
            retiredRelationCount: relationRetirement.count,
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
    | Readonly<{ status: "already-deleted" }>;

/**
 * The sole physical Account-deletion composition for Data-owned Account
 * erasure. Domain cleanup runs in the same transaction as the Account row
 * delete so any remaining restrictive relation aborts every prior cleanup.
 *
 * It therefore deletes only an Account that still owns nothing behind a
 * restrictive relation — today the just-created Account an OAuth finalize
 * failure rolls back. `Session`, `Machine`, `AccessKey`, `Artifact`,
 * `UploadedFile`, `UsageReport`, `AccountPushToken`, `SessionShare`,
 * `SessionShareAccessLog` and `PublicSessionShare` all reference `Account`
 * with `ON DELETE RESTRICT`, so an Account owning even one Session fails
 * here with Prisma `P2003`. (`PluginWebhookEndpoint` is restrictive too but
 * does not block, because the cleanup above detaches it in this same
 * transaction.) A present-user "delete my account" ingress cannot be
 * composed from this owner as written: those domains must be erased first,
 * along with the `UploadedFile.path` blobs that `storage/blob/files.ts` has
 * no delete owner for.
 */
export async function deleteAccountForErasure(input: Readonly<{
    accountId: string;
    now?: Date;
}>): Promise<DeleteAccountForErasureResult> {
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

        await cleanupPluginWebhooksForAccountDeletionTxV1(tx, {
            accountId: input.accountId,
            ...(input.now ? { now: input.now } : {}),
        });
        await tx.account.delete({ where: { id: input.accountId } });
        return { status: "deleted" };
    });
}
