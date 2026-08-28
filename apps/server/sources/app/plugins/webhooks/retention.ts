import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { resolveCurrentClaimablePluginMachineMaterializationTx } from "@/app/plugins/availability/operations";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { inTx } from "@/storage/inTx";
import { getActivePrismaRuntime } from "@/storage/prisma";

import { markPluginWebhookAccountChangedInTxV1 } from "./accountChange";
import { PLUGIN_WEBHOOK_MAX_QUEUED_AGE_MS_V1 } from "./policy";

const DAY_MS = 24 * 60 * 60 * 1_000;
const DISCARDED_METADATA_RETENTION_MS_V1 = 30 * DAY_MS;
const DEFAULT_RETENTION_BATCH_SIZE_V1 = 100;
const MAX_RETENTION_BATCH_SIZE_V1 = 500;
const MAX_REPLAY_COUNT_V1 = 10;

function expiredDetachedSharedTombstoneWhereV1(now: Date, ids?: readonly string[]) {
    return {
        ...(ids ? { id: { in: [...ids] } } : {}),
        accountId: null,
        routingKind: "providerInstallation",
        providerInstallationId: { not: null },
        pluginId: null,
        webhookContributionId: null,
        handlerActionId: null,
        sourceInstanceId: null,
        ensureIdempotencyKey: null,
        ensureRequestFingerprint: null,
        setupKind: null,
        enabled: false,
        revokedAt: null,
        releasedAt: { not: null },
        tombstoneExpiresAt: { lte: now },
        targetMachineId: null,
        targetMachineInstallationId: null,
        targetMaterializationId: null,
        targetPluginVersion: null,
        previousTargetMachineId: null,
        previousTargetMachineInstallationId: null,
        previousTargetMaterializationId: null,
        previousTargetPluginVersion: null,
    };
}

export async function replayPluginWebhookDeliveryV1(params: Readonly<{
    accountId: string;
    deliveryId: string;
    expectedRevision: number;
    now?: Date;
}>): Promise<
    | Readonly<{ kind: "requeued"; revision: number }>
    | Readonly<{ kind: "revisionConflict" | "unavailable" | "replayLimit" }>
> {
    const now = params.now ?? new Date();
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);
    return await inTx(async (tx) => {
        const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (fence.status !== "ready") return { kind: "unavailable" };
        const current = await tx.pluginWebhookDelivery.findUnique({
            where: { id: params.deliveryId },
            select: {
                accountId: true,
                revision: true,
                state: true,
                replayCount: true,
                payloadBytes: true,
                payloadPurgeAt: true,
                leaseId: true,
                targetMachineId: true,
                targetMachineInstallationId: true,
                targetMaterializationId: true,
                targetPluginId: true,
                targetPluginVersion: true,
            },
        });
        if (
            !current
            || current.accountId !== params.accountId
            || current.state !== "dead_letter"
            || current.payloadBytes <= 0n
            || current.payloadPurgeAt === null
            || current.payloadPurgeAt.getTime() <= now.getTime()
            || current.leaseId !== null
        ) {
            return { kind: "unavailable" };
        }
        if (current.revision !== params.expectedRevision) return { kind: "revisionConflict" };
        if (current.replayCount >= MAX_REPLAY_COUNT_V1) return { kind: "replayLimit" };
        const target = await resolveCurrentClaimablePluginMachineMaterializationTx({
            tx,
            accountId: params.accountId,
            serverIdentityId,
            machineId: current.targetMachineId,
            machineInstallationId: current.targetMachineInstallationId,
            materializationId: current.targetMaterializationId,
            pluginId: current.targetPluginId,
            version: current.targetPluginVersion,
            requiredMachineOperationCapability: "pluginWebhookClaim",
        });
        if (target.kind !== "current") return { kind: "unavailable" };
        const updated = await tx.pluginWebhookDelivery.updateMany({
            where: {
                id: params.deliveryId,
                accountId: params.accountId,
                revision: params.expectedRevision,
                state: "dead_letter",
                replayCount: current.replayCount,
                payloadBytes: { gt: 0n },
                payloadPurgeAt: { gt: now },
                leaseId: null,
            },
            data: {
                state: "queued",
                attemptCount: 0,
                replayCount: { increment: 1 },
                nextAttemptAt: now,
                offlineSinceAt: null,
                lastErrorCode: null,
                automationAdmissionUnresolved: getActivePrismaRuntime().DbNull,
                terminalDisposition: null,
                deadLetteredAt: null,
                payloadPurgeAt: null,
                metadataDeleteAt: new Date(now.getTime() + PLUGIN_WEBHOOK_MAX_QUEUED_AGE_MS_V1),
                revision: { increment: 1 },
            },
        });
        if (updated.count !== 1) return { kind: "revisionConflict" };
        await markPluginWebhookAccountChangedInTxV1(tx, {
            accountId: params.accountId,
            pluginId: current.targetPluginId,
        });
        return { kind: "requeued", revision: params.expectedRevision + 1 };
    });
}

export async function discardPluginWebhookDeliveryV1(params: Readonly<{
    accountId: string;
    deliveryId: string;
    expectedRevision: number;
    discardedByUserId: string;
    reasonCode: string;
    now?: Date;
}>): Promise<
    | Readonly<{ kind: "discarded"; revision: number }>
    | Readonly<{ kind: "leaseActive" | "revisionConflict" | "unavailable"; currentRevision?: number }>
> {
    const now = params.now ?? new Date();
    return await inTx(async (tx) => {
        const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (fence.status !== "ready") return { kind: "unavailable" };

        const current = await tx.pluginWebhookDelivery.findUnique({
            where: { id: params.deliveryId },
            select: { accountId: true, revision: true, state: true, leaseExpiresAt: true, targetPluginId: true },
        });
        if (!current || current.accountId !== params.accountId) return { kind: "unavailable" };
        if (current.revision !== params.expectedRevision) {
            return { kind: "revisionConflict", currentRevision: current.revision };
        }
        if (
            current.state === "claimed"
            && current.leaseExpiresAt !== null
            && current.leaseExpiresAt.getTime() > now.getTime()
        ) {
            return { kind: "leaseActive", currentRevision: current.revision };
        }
        if (current.state === "succeeded" || current.state === "discarded") {
            return { kind: "unavailable" };
        }

        const updated = await tx.pluginWebhookDelivery.updateMany({
            where: { id: params.deliveryId, accountId: params.accountId, revision: params.expectedRevision },
            data: {
                state: "discarded",
                payload: getActivePrismaRuntime().DbNull,
                payloadBytes: 0n,
                revision: { increment: 1 },
                leaseId: null,
                claimedByMachineId: null,
                claimedByMachineInstallationId: null,
                firstClaimAt: null,
                executionStartedAt: null,
                leaseExpiresAt: null,
                lastErrorCode: null,
                automationAdmissionUnresolved: getActivePrismaRuntime().DbNull,
                terminalDisposition: "discarded",
                discardedAt: now,
                discardedByUserId: params.discardedByUserId,
                discardReasonCode: params.reasonCode,
                payloadPurgeAt: null,
                metadataDeleteAt: new Date(now.getTime() + DISCARDED_METADATA_RETENTION_MS_V1),
            },
        });
        if (updated.count !== 1) {
            const raced = await tx.pluginWebhookDelivery.findUnique({
                where: { id: params.deliveryId },
                select: { accountId: true, revision: true },
            });
            return raced?.accountId === params.accountId
                ? { kind: "revisionConflict", currentRevision: raced.revision }
                : { kind: "unavailable" };
        }
        await markPluginWebhookAccountChangedInTxV1(tx, {
            accountId: params.accountId,
            pluginId: current.targetPluginId,
        });
        return { kind: "discarded", revision: params.expectedRevision + 1 };
    });
}

export async function purgeExpiredPluginWebhookDeliveriesV1(params: Readonly<{
    now?: Date;
    batchSize?: number;
}>): Promise<Readonly<{
    payloadsPurged: number;
    metadataDeleted: number;
    tombstonesDeleted: number;
}>> {
    const now = params.now ?? new Date();
    const batchSize = params.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE_V1;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_RETENTION_BATCH_SIZE_V1) {
        throw new TypeError("Plugin webhook retention batch size must be an integer from 1 through 500");
    }

    const candidates = await inTx(async (tx) => {
        const expiredPayloadRows = await tx.pluginWebhookDelivery.findMany({
            where: {
                state: "dead_letter",
                payloadBytes: { gt: 0n },
                payloadPurgeAt: { lte: now },
            },
            orderBy: [{ payloadPurgeAt: "asc" }, { id: "asc" }],
            take: batchSize,
            select: { id: true, accountId: true, targetPluginId: true },
        });
        const expiredMetadataRows = await tx.pluginWebhookDelivery.findMany({
            where: {
                state: { in: ["succeeded", "dead_letter", "discarded"] },
                payloadBytes: 0n,
                metadataDeleteAt: { lte: now },
            },
            orderBy: [{ metadataDeleteAt: "asc" }, { id: "asc" }],
            take: batchSize,
            select: { id: true, accountId: true, targetPluginId: true },
        });
        // The detached row is a closed replay-isolation tombstone, not a generic orphan.
        // It has no Account left to fence, so the exact persisted shape is its currentness guard.
        const expiredTombstones = await tx.pluginWebhookEndpoint.findMany({
            where: expiredDetachedSharedTombstoneWhereV1(now),
            orderBy: [{ tombstoneExpiresAt: "asc" }, { id: "asc" }],
            take: batchSize,
            select: { id: true },
        });
        return { expiredPayloadRows, expiredMetadataRows, expiredTombstones };
    });

    const byAccount = new Map<string, Map<string, { payloadIds: string[]; metadataIds: string[] }>>();
    for (const row of candidates.expiredPayloadRows) {
        const plugins = byAccount.get(row.accountId) ?? new Map<string, { payloadIds: string[]; metadataIds: string[] }>();
        const entry = plugins.get(row.targetPluginId) ?? { payloadIds: [], metadataIds: [] };
        entry.payloadIds.push(row.id);
        plugins.set(row.targetPluginId, entry);
        byAccount.set(row.accountId, plugins);
    }
    for (const row of candidates.expiredMetadataRows) {
        const plugins = byAccount.get(row.accountId) ?? new Map<string, { payloadIds: string[]; metadataIds: string[] }>();
        const entry = plugins.get(row.targetPluginId) ?? { payloadIds: [], metadataIds: [] };
        entry.metadataIds.push(row.id);
        plugins.set(row.targetPluginId, entry);
        byAccount.set(row.accountId, plugins);
    }

    let payloadsPurged = 0;
    let metadataDeleted = 0;
    for (const [accountId, candidatePlugins] of [...byAccount.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const accountResult = await inTx(async (tx) => {
            const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, accountId);
            if (fence.status !== "ready") return { payloadsPurged: 0, metadataDeleted: 0 };

            let payloadsPurged = 0;
            let metadataDeleted = 0;
            const changedPluginIds: string[] = [];
            for (const [pluginId, candidateIds] of [...candidatePlugins.entries()].sort(([left], [right]) => left.localeCompare(right))) {
                const purged = candidateIds.payloadIds.length === 0
                    ? 0
                    : (await tx.pluginWebhookDelivery.updateMany({
                        where: {
                            id: { in: candidateIds.payloadIds },
                            accountId,
                            state: "dead_letter",
                            payloadBytes: { gt: 0n },
                            payloadPurgeAt: { lte: now },
                        },
                        data: {
                            payload: getActivePrismaRuntime().DbNull,
                            payloadBytes: 0n,
                            payloadPurgeAt: null,
                            revision: { increment: 1 },
                        },
                    })).count;
                const deleted = candidateIds.metadataIds.length === 0
                    ? 0
                    : (await tx.pluginWebhookDelivery.deleteMany({
                        where: {
                            id: { in: candidateIds.metadataIds },
                            accountId,
                            state: { in: ["succeeded", "dead_letter", "discarded"] },
                            payloadBytes: 0n,
                            metadataDeleteAt: { lte: now },
                        },
                    })).count;
                payloadsPurged += purged;
                metadataDeleted += deleted;
                if (purged > 0 || deleted > 0) changedPluginIds.push(pluginId);
            }
            for (const pluginId of changedPluginIds) {
                await markPluginWebhookAccountChangedInTxV1(tx, { accountId, pluginId });
            }
            return { payloadsPurged, metadataDeleted };
        });
        payloadsPurged += accountResult.payloadsPurged;
        metadataDeleted += accountResult.metadataDeleted;
    }
    const tombstoneIds = candidates.expiredTombstones.map((tombstone) => tombstone.id);
    const tombstonesDeleted = tombstoneIds.length === 0
        ? 0
        : (await inTx(async (tx) => (await tx.pluginWebhookEndpoint.deleteMany({
            where: expiredDetachedSharedTombstoneWhereV1(now, tombstoneIds),
        })).count));
    return { payloadsPurged, metadataDeleted, tombstonesDeleted };
}
