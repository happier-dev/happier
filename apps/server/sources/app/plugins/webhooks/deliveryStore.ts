import type { Prisma } from "@prisma/client";
import type {
    ContentPublicKeyFingerprint,
    PluginMachineMaterializationRefV1,
    PluginWebhookDeliveryMovePendingResultV1,
} from "@happier-dev/protocol";
import {
    decodeBase64,
    encodeBase64,
    PLUGIN_WEBHOOK_MAX_STORED_ENVELOPE_BYTES_V1,
    StoredPluginWebhookDeliveryContentV1Schema,
} from "@happier-dev/protocol";

import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { resolveCurrentClaimablePluginMachineMaterializationTx } from "@/app/plugins/availability/operations";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { db, isPrismaErrorCode } from "@/storage/db";
import { afterTx, inTx } from "@/storage/inTx";

import {
    PLUGIN_WEBHOOK_ACCOUNT_TERMINAL_ROWS_V1,
    resolvePluginWebhookDeliveryQuotaRejectionV1,
} from "./policy";
import { markPluginWebhookAccountChangedInTxV1 } from "./accountChange";
import type { PluginWebhookStoredEnvelopeReadyV1 } from "./storedEnvelope";
import type { PluginWebhookCommittedDeliveryWakeV1 } from "./wake";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_DELIVERY_METADATA_LIFETIME_MS_V1 = 97 * DAY_MS;
const TERMINAL_COMPACTION_BATCH_V1 = 500;
// Reserve the public response/error path; this never extends ingress custody.
const WEBHOOK_INGRESS_TRANSACTION_SETTLEMENT_RESERVE_MS_V1 = 1_000;

function resolveWebhookDeliveryTransactionDeadlineAtMsV1(
    deadlineAtMs: number | undefined,
): number | undefined {
    if (deadlineAtMs === undefined) return undefined;
    if (!Number.isSafeInteger(deadlineAtMs)) {
        throw new TypeError("Plugin webhook ingress deadline must be a safe integer timestamp");
    }
    return deadlineAtMs - WEBHOOK_INGRESS_TRANSACTION_SETTLEMENT_RESERVE_MS_V1;
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function readCanonicalStoredEnvelopeV1(bytes: Uint8Array): Readonly<{
    envelope: ReturnType<typeof StoredPluginWebhookDeliveryContentV1Schema.parse>;
    payload: Prisma.InputJsonValue;
}> {
    let value: unknown;
    try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
        throw new TypeError("Plugin webhook delivery canonical stored-envelope bytes must be UTF-8 JSON");
    }
    return {
        envelope: StoredPluginWebhookDeliveryContentV1Schema.parse(value),
        payload: toPrismaJson(value),
    };
}

function decodeMoveCursorV1(cursor: string | undefined): string | null {
    if (cursor === undefined) return null;
    if (!cursor.startsWith("wh_move_")) throw new TypeError("Invalid plugin webhook move cursor");
    try {
        const value = new TextDecoder("utf-8", { fatal: true }).decode(
            decodeBase64(cursor.slice("wh_move_".length), "base64url"),
        );
        if (value.length === 0) throw new Error("empty cursor");
        return value;
    } catch {
        throw new TypeError("Invalid plugin webhook move cursor");
    }
}

function encodeMoveCursorV1(deliveryId: string): string {
    return `wh_move_${encodeBase64(new TextEncoder().encode(deliveryId), "base64url")}`;
}

export async function movePendingPluginWebhookDeliveriesV1(params: Readonly<{
    accountId: string;
    webhookEndpointId: string;
    endpointRevision: number;
    previousTargetMaterialization: PluginMachineMaterializationRefV1;
    targetMaterialization: PluginMachineMaterializationRefV1;
    cursor?: string;
    pageSize?: number;
}>): Promise<PluginWebhookDeliveryMovePendingResultV1> {
    const pageSize = params.pageSize ?? 500;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
        throw new TypeError("Plugin webhook move page size must be an integer from 1 through 500");
    }
    const afterId = decodeMoveCursorV1(params.cursor);
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);
    return await inTx(async (tx) => {
        const endpoint = await tx.pluginWebhookEndpoint.findFirst({
            where: { id: params.webhookEndpointId, accountId: params.accountId },
            select: {
                id: true,
                accountId: true,
                pluginId: true,
                revision: true,
                enabled: true,
                revokedAt: true,
                targetMachineId: true,
                targetMachineInstallationId: true,
                targetMaterializationId: true,
                targetPluginVersion: true,
                previousTargetMachineId: true,
                previousTargetMachineInstallationId: true,
                previousTargetMaterializationId: true,
                previousTargetPluginVersion: true,
            },
        });
        if (!endpoint || !endpoint.enabled || endpoint.revokedAt !== null) return { kind: "unavailable" };
        if (endpoint.revision !== params.endpointRevision) return { kind: "revisionConflict" };
        if (
            endpoint.pluginId !== params.targetMaterialization.pluginId
            || endpoint.pluginId !== params.previousTargetMaterialization.pluginId
        ) return { kind: "incompatible" };
        if (
            endpoint.targetMachineId !== params.targetMaterialization.machineId
            || endpoint.targetMaterializationId !== params.targetMaterialization.materializationId
            || endpoint.previousTargetMachineId !== params.previousTargetMaterialization.machineId
            || endpoint.previousTargetMaterializationId !== params.previousTargetMaterialization.materializationId
            || endpoint.targetMachineInstallationId === null
            || endpoint.targetPluginVersion === null
            || endpoint.previousTargetMachineInstallationId === null
            || endpoint.previousTargetPluginVersion === null
        ) return { kind: "targetMismatch" };
        const current = await resolveCurrentClaimablePluginMachineMaterializationTx({
            tx,
            accountId: params.accountId,
            serverIdentityId,
            machineId: endpoint.targetMachineId,
            machineInstallationId: endpoint.targetMachineInstallationId,
            materializationId: endpoint.targetMaterializationId,
            pluginId: endpoint.pluginId,
            version: endpoint.targetPluginVersion,
            requiredMachineOperationCapability: "pluginWebhookClaim",
        });
        if (current.kind !== "current") return { kind: "unavailable" };

        const scanned = await tx.pluginWebhookDelivery.findMany({
            where: {
                endpointId: endpoint.id,
                accountId: params.accountId,
                targetMachineId: params.previousTargetMaterialization.machineId,
                targetMachineInstallationId: endpoint.previousTargetMachineInstallationId,
                targetMaterializationId: params.previousTargetMaterialization.materializationId,
                targetPluginId: params.previousTargetMaterialization.pluginId,
                targetPluginVersion: endpoint.previousTargetPluginVersion,
                state: { in: ["queued", "claimed", "dead_letter"] },
                payloadBytes: { gt: 0n },
                ...(afterId ? { id: { gt: afterId } } : {}),
            },
            orderBy: { id: "asc" },
            take: pageSize + 1,
            select: { id: true, state: true, revision: true },
        });
        const page = scanned.slice(0, pageSize);
        let moved = 0;
        let skippedClaimed = 0;
        for (const row of page) {
            if (row.state === "claimed") {
                skippedClaimed += 1;
                continue;
            }
            const updated = await tx.pluginWebhookDelivery.updateMany({
                where: {
                    id: row.id,
                    endpointId: endpoint.id,
                    revision: row.revision,
                    state: row.state,
                    payloadBytes: { gt: 0n },
                    targetMachineId: params.previousTargetMaterialization.machineId,
                    targetMachineInstallationId: endpoint.previousTargetMachineInstallationId,
                    targetMaterializationId: params.previousTargetMaterialization.materializationId,
                    targetPluginId: params.previousTargetMaterialization.pluginId,
                    targetPluginVersion: endpoint.previousTargetPluginVersion,
                },
                data: {
                    targetMachineId: endpoint.targetMachineId,
                    targetMachineInstallationId: endpoint.targetMachineInstallationId,
                    targetMaterializationId: endpoint.targetMaterializationId,
                    targetPluginId: endpoint.pluginId,
                    targetPluginVersion: endpoint.targetPluginVersion,
                    revision: { increment: 1 },
                },
            });
            moved += updated.count;
        }
        if (moved > 0 && endpoint.pluginId !== null) {
            await markPluginWebhookAccountChangedInTxV1(tx, {
                accountId: params.accountId,
                pluginId: endpoint.pluginId,
            });
        }
        const hasMore = scanned.length > pageSize;
        return {
            moved,
            skippedClaimed,
            nextCursor: hasMore && page.length > 0 ? encodeMoveCursorV1(page[page.length - 1]!.id) : null,
            done: !hasMore,
        };
    });
}

function accountEncryptionMatches(params: Readonly<{
    expectedMode: "plain" | "e2ee";
    expectedContentKeyFingerprint: ContentPublicKeyFingerprint | null;
    actualMode: "plain" | "e2ee";
    actualContentKeyFingerprint: ContentPublicKeyFingerprint | null;
}>): boolean {
    return params.expectedMode === params.actualMode
        && params.expectedContentKeyFingerprint === params.actualContentKeyFingerprint;
}

export async function admitPluginWebhookDeliveryV1(params: Readonly<{
    endpointId: string;
    expectedEndpointRevision: number;
    routeId: string;
    verifierKind: "github_hmac_sha256_v1";
    deliveryIdentityDigest: string;
    stored: PluginWebhookStoredEnvelopeReadyV1;
    now?: Date;
    deadlineAtMs?: number;
    onCommittedWake?: (wake: PluginWebhookCommittedDeliveryWakeV1) => void;
}>): Promise<
    | Readonly<{ kind: "admitted" | "duplicate"; deliveryId: string }>
    | Readonly<{ kind: "endpointUnavailable" | "accountEncryptionChanged" | "targetUnavailable" | "quotaExceeded" }>
> {
    const storedEnvelope = readCanonicalStoredEnvelopeV1(params.stored.canonicalEnvelopeBytes);
    const envelope = storedEnvelope.envelope;
    const payloadBytes = params.stored.canonicalEnvelopeBytes.byteLength;
    if (
        !Number.isSafeInteger(payloadBytes)
        || payloadBytes <= 0
        || payloadBytes > PLUGIN_WEBHOOK_MAX_STORED_ENVELOPE_BYTES_V1
    ) {
        throw new TypeError("Plugin webhook delivery payload must have bounded canonical stored-envelope bytes");
    }
    const now = params.now ?? new Date();
    const transactionDeadlineAtMs =
        resolveWebhookDeliveryTransactionDeadlineAtMsV1(
            params.deadlineAtMs,
        );
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);
    const preexisting = await db.pluginWebhookDelivery.findUnique({
        where: { deliveryIdentityDigest: params.deliveryIdentityDigest },
        select: { id: true },
    });
    if (preexisting) return { kind: "duplicate", deliveryId: preexisting.id };

    try {
        return await inTx(async (tx) => {
            const duplicate = await tx.pluginWebhookDelivery.findUnique({
                where: { deliveryIdentityDigest: params.deliveryIdentityDigest },
                select: { id: true },
            });
            if (duplicate) return { kind: "duplicate", deliveryId: duplicate.id };

            const endpoint = await tx.pluginWebhookEndpoint.findFirst({
                where: {
                    id: params.endpointId,
                    routeId: params.routeId,
                    revision: params.expectedEndpointRevision,
                    enabled: true,
                    revokedAt: null,
                    releasedAt: null,
                    accountId: { not: null },
                    route: {
                        enabled: true,
                        revokedAt: null,
                        verifierKind: params.verifierKind,
                    },
                },
                select: {
                    id: true,
                    accountId: true,
                    pluginId: true,
                    routeId: true,
                    revision: true,
                    targetMachineId: true,
                    targetMachineInstallationId: true,
                    targetMaterializationId: true,
                    targetPluginVersion: true,
                    webhookContributionId: true,
                    handlerActionId: true,
                    sourceInstanceId: true,
                },
            });
            if (
                !endpoint
                || endpoint.accountId === null
                || endpoint.pluginId === null
                || endpoint.targetMachineId === null
                || endpoint.targetMachineInstallationId === null
                || endpoint.targetMaterializationId === null
                || endpoint.targetPluginVersion === null
                || endpoint.webhookContributionId === null
                || endpoint.handlerActionId === null
                || endpoint.sourceInstanceId === null
            ) {
                return { kind: "endpointUnavailable" };
            }

        const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, endpoint.accountId);
        if (
            fence.status !== "ready"
            || !accountEncryptionMatches({
                expectedMode: params.stored.encryption.mode,
                expectedContentKeyFingerprint: params.stored.encryption.contentKeyFingerprint,
                actualMode: fence.status === "ready"
                    ? fence.account.currentness.encryptionMode
                    : params.stored.encryption.mode,
                actualContentKeyFingerprint: fence.status === "ready"
                    ? fence.account.currentness.contentPublicKeyFingerprint
                    : params.stored.encryption.contentKeyFingerprint,
            })
            || (params.stored.encryption.mode === "plain" && envelope.t !== "plain")
            || (params.stored.encryption.mode === "e2ee" && envelope.t !== "encrypted")
        ) {
            return { kind: "accountEncryptionChanged" };
        }

            const target = await resolveCurrentClaimablePluginMachineMaterializationTx({
                tx,
                accountId: endpoint.accountId,
                serverIdentityId,
                machineId: endpoint.targetMachineId,
                machineInstallationId: endpoint.targetMachineInstallationId,
                materializationId: endpoint.targetMaterializationId,
                pluginId: endpoint.pluginId,
                version: endpoint.targetPluginVersion,
                requiredMachineOperationCapability: "pluginWebhookClaim",
            });
        if (target.kind !== "current") return { kind: "targetUnavailable" };

        const payloadStates = ["queued", "claimed", "dead_letter"];
        let [endpointPayloadRows, accountPayloadRows, endpointPayloadBytes, accountPayloadBytes, accountTerminalRows] = await Promise.all([
            tx.pluginWebhookDelivery.count({
                where: { endpointId: endpoint.id, state: { in: payloadStates }, payloadBytes: { gt: 0n } },
            }),
            tx.pluginWebhookDelivery.count({
                where: { accountId: endpoint.accountId, state: { in: payloadStates }, payloadBytes: { gt: 0n } },
            }),
            tx.pluginWebhookDelivery.aggregate({
                where: { endpointId: endpoint.id, state: { in: payloadStates }, payloadBytes: { gt: 0n } },
                _sum: { payloadBytes: true },
            }),
            tx.pluginWebhookDelivery.aggregate({
                where: { accountId: endpoint.accountId, state: { in: payloadStates }, payloadBytes: { gt: 0n } },
                _sum: { payloadBytes: true },
            }),
            tx.pluginWebhookDelivery.count({
                where: {
                    accountId: endpoint.accountId,
                    state: { in: ["succeeded", "dead_letter", "discarded"] },
                    payloadBytes: 0n,
                },
            }),
        ]);

        let compactedTerminalRows = 0;
        if (accountTerminalRows >= PLUGIN_WEBHOOK_ACCOUNT_TERMINAL_ROWS_V1) {
            const expired = await tx.pluginWebhookDelivery.findMany({
                where: {
                    accountId: endpoint.accountId,
                    state: { in: ["succeeded", "dead_letter", "discarded"] },
                    payloadBytes: 0n,
                    metadataDeleteAt: { lte: now },
                },
                orderBy: [{ metadataDeleteAt: "asc" }, { id: "asc" }],
                take: TERMINAL_COMPACTION_BATCH_V1,
                select: { id: true },
            });
            if (expired.length > 0) {
                compactedTerminalRows = (await tx.pluginWebhookDelivery.deleteMany({
                    where: { id: { in: expired.map((row) => row.id) } },
                })).count;
                accountTerminalRows = await tx.pluginWebhookDelivery.count({
                    where: {
                        accountId: endpoint.accountId,
                        state: { in: ["succeeded", "dead_letter", "discarded"] },
                        payloadBytes: 0n,
                    },
                });
            }
        }

        const quotaRejection = resolvePluginWebhookDeliveryQuotaRejectionV1({
            endpointPayloadRows,
            accountPayloadRows,
            endpointPayloadBytes: endpointPayloadBytes._sum.payloadBytes ?? 0n,
            accountPayloadBytes: accountPayloadBytes._sum.payloadBytes ?? 0n,
            accountTerminalRows,
            candidatePayloadBytes: BigInt(payloadBytes),
        });
        if (quotaRejection) {
            if (compactedTerminalRows > 0) {
                await markPluginWebhookAccountChangedInTxV1(tx, {
                    accountId: endpoint.accountId,
                    pluginId: endpoint.pluginId,
                });
            }
            return { kind: "quotaExceeded" };
        }

        const created = await tx.pluginWebhookDelivery.create({
            data: {
                endpointId: endpoint.id,
                accountId: endpoint.accountId,
                routeId: endpoint.routeId,
                deliveryIdentityDigest: params.deliveryIdentityDigest,
                verifierKind: params.verifierKind,
                targetMachineId: endpoint.targetMachineId,
                targetMachineInstallationId: endpoint.targetMachineInstallationId,
                targetMaterializationId: endpoint.targetMaterializationId,
                targetPluginId: endpoint.pluginId,
                targetPluginVersion: endpoint.targetPluginVersion,
                endpointRevision: endpoint.revision,
                endpointWebhookContributionId: endpoint.webhookContributionId,
                endpointHandlerActionId: endpoint.handlerActionId,
                endpointSourceInstanceId: endpoint.sourceInstanceId,
                payloadKind: envelope.t,
                payload: storedEnvelope.payload,
                payloadBytes: BigInt(payloadBytes),
                wireVersion: 1,
                payloadVersion: 1,
                state: "queued",
                attemptCount: 0,
                replayCount: 0,
                nextAttemptAt: now,
                revision: 0,
                metadataDeleteAt: new Date(now.getTime() + MAX_DELIVERY_METADATA_LIFETIME_MS_V1),
                receivedAt: now,
            },
            select: { id: true },
        });
        const accountId = endpoint.accountId;
        const targetMachineId = endpoint.targetMachineId;
        const accountChangeCursor = await markPluginWebhookAccountChangedInTxV1(tx, {
            accountId,
            pluginId: endpoint.pluginId,
        });
        if (params.onCommittedWake) {
            afterTx(tx, () => {
                params.onCommittedWake?.({
                    accountId,
                    targetMachineId,
                    accountChangeCursor,
                });
            });
        }
        return { kind: "admitted", deliveryId: created.id };
        }, transactionDeadlineAtMs === undefined
            ? undefined
            : { deadlineAtMs: transactionDeadlineAtMs });
    } catch (error) {
        if (!isPrismaErrorCode(error, "P2002")) throw error;
        const duplicate = await db.pluginWebhookDelivery.findUnique({
            where: { deliveryIdentityDigest: params.deliveryIdentityDigest },
            select: { id: true },
        });
        if (!duplicate) throw error;
        return { kind: "duplicate", deliveryId: duplicate.id };
    }
}
