import { randomBytes as nodeRandomBytes } from "node:crypto";

import {
    encodeBase64,
    PluginWebhookClaimResultV1Schema,
    PluginWebhookAutomationAdmissionUnresolvedV1Schema,
    PluginWebhookInvocationReferenceV1Schema,
    PluginWebhookRenewResultV1Schema,
    PluginWebhookSettleResultV1Schema,
    type PluginWebhookClaimResultV1,
    type PluginWebhookAutomationAdmissionUnresolvedV1,
    type PluginWebhookInvocationReferenceV1,
    type PluginWebhookRenewResultV1,
    type PluginWebhookSettleResultV1,
} from "@happier-dev/protocol";

import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { resolveCurrentClaimablePluginMachineMaterializationTx } from "@/app/plugins/availability/operations";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { getActivePrismaRuntime } from "@/storage/prisma";
import { resolvePluginWebhookRetryDelayMsV1 } from "./retryPolicy";
import { resolveCurrentPluginWebhookContributionTxV1 } from "./currentContribution";
import {
    validatePluginWebhookStoredEnvelopeForAccountCurrentnessV1,
} from "./storedEnvelope";
import { markPluginWebhookAccountChangedInTxV1 } from "./accountChange";
import { PLUGIN_WEBHOOK_MAX_QUEUED_AGE_MS_V1 } from "./policy";

const DAY_MS = 24 * 60 * 60 * 1_000;
export const PLUGIN_WEBHOOK_LEASE_MS_V1 = 120_000;
export const PLUGIN_WEBHOOK_MAX_CONTINUOUS_CLAIM_MS_V1 = 10 * 60_000;
export const PLUGIN_WEBHOOK_MAX_ATTEMPTS_V1 = 12;
const PLUGIN_WEBHOOK_SUCCESS_METADATA_RETENTION_MS_V1 = 7 * DAY_MS;
const PLUGIN_WEBHOOK_DEAD_PAYLOAD_RETENTION_MS_V1 = 30 * DAY_MS;
const PLUGIN_WEBHOOK_DEAD_METADATA_RETENTION_MS_V1 = 90 * DAY_MS;
const DEFAULT_RECOVERY_BATCH_SIZE_V1 = 100;
const MAX_RECOVERY_BATCH_SIZE_V1 = 500;

type ClaimTargetV1 = Readonly<{
    materialization: Readonly<{ machineId: string; materializationId: string; pluginId: string }>;
    machineInstallationId: string;
}>;

type LeaseIdentityV1 = Readonly<{ leaseId: string; revision: number }>;

function targetWhere(target: ClaimTargetV1) {
    return {
        targetMachineId: target.materialization.machineId,
        targetMachineInstallationId: target.machineInstallationId,
        targetMaterializationId: target.materialization.materializationId,
        targetPluginId: target.materialization.pluginId,
    } as const;
}

function clearLeaseFields() {
    return {
        leaseId: null,
        claimedByMachineId: null,
        claimedByMachineInstallationId: null,
        firstClaimAt: null,
        executionStartedAt: null,
        leaseExpiresAt: null,
    } as const;
}

function deadLetterMutation(
    now: Date,
    code: string,
    automationAdmissionUnresolved: PluginWebhookAutomationAdmissionUnresolvedV1 | null = null,
) {
    return {
        state: "dead_letter",
        ...clearLeaseFields(),
        lastErrorCode: code,
        automationAdmissionUnresolved: automationAdmissionUnresolved ?? getActivePrismaRuntime().DbNull,
        terminalDisposition: "dead_letter",
        deadLetteredAt: now,
        payloadPurgeAt: new Date(now.getTime() + PLUGIN_WEBHOOK_DEAD_PAYLOAD_RETENTION_MS_V1),
        metadataDeleteAt: new Date(now.getTime() + PLUGIN_WEBHOOK_DEAD_METADATA_RETENTION_MS_V1),
        revision: { increment: 1 },
    } as const;
}

async function isCurrentAuthenticatedTargetInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    target: ClaimTargetV1;
    version: string;
    serverIdentityId: string;
}>): Promise<boolean> {
    const current = await resolveCurrentClaimablePluginMachineMaterializationTx({
        tx: params.tx,
        accountId: params.accountId,
        serverIdentityId: params.serverIdentityId,
        machineId: params.target.materialization.machineId,
        machineInstallationId: params.target.machineInstallationId,
        materializationId: params.target.materialization.materializationId,
        pluginId: params.target.materialization.pluginId,
        version: params.version,
        requiredMachineOperationCapability: "pluginWebhookClaim",
    });
    return current.kind === "current";
}

export async function claimPluginWebhookDeliveryV1(params: Readonly<{
    accountId: string;
    target: ClaimTargetV1;
    now?: Date;
    randomBytes?: (length: number) => Uint8Array;
}>): Promise<PluginWebhookClaimResultV1> {
    const now = params.now ?? new Date();
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);
    const randomBytes = params.randomBytes
        ?? ((length: number) => Uint8Array.from(nodeRandomBytes(length)));
    const leaseBytes = randomBytes(16);
    if (leaseBytes.byteLength !== 16) throw new TypeError("Plugin webhook lease identity requires exactly 16 bytes");
    const leaseId = `wh_lease_${encodeBase64(leaseBytes, "base64url")}`;

    return await inTx(async (tx) => {
        const candidate = await tx.pluginWebhookDelivery.findFirst({
            where: {
                accountId: params.accountId,
                ...targetWhere(params.target),
                state: "queued",
                payloadBytes: { gt: 0n },
                nextAttemptAt: { lte: now },
                endpoint: {
                    enabled: true,
                    revokedAt: null,
                    releasedAt: null,
                    route: { enabled: true, revokedAt: null },
                },
            },
            orderBy: [{ nextAttemptAt: "asc" }, { receivedAt: "asc" }, { id: "asc" }],
            select: {
                id: true,
                revision: true,
                attemptCount: true,
                replayCount: true,
                receivedAt: true,
                payload: true,
                endpointId: true,
                endpointRevision: true,
                endpointWebhookContributionId: true,
                endpointHandlerActionId: true,
                endpointSourceInstanceId: true,
                targetPluginId: true,
                targetPluginVersion: true,
                offlineSinceAt: true,
            },
        });
        if (!candidate) return PluginWebhookClaimResultV1Schema.parse({ kind: "none", retryAfterMs: 5_000 });
        if (
            candidate.targetPluginId !== params.target.materialization.pluginId
        ) {
            return PluginWebhookClaimResultV1Schema.parse({ kind: "none", retryAfterMs: 5_000 });
        }
        if (!(await isCurrentAuthenticatedTargetInTx({
                tx,
                accountId: params.accountId,
                target: params.target,
                version: candidate.targetPluginVersion,
                serverIdentityId,
            }))) {
            const offlineSinceAt = candidate.offlineSinceAt ?? now;
            const expired = now.getTime() - offlineSinceAt.getTime()
                >= PLUGIN_WEBHOOK_MAX_QUEUED_AGE_MS_V1;
            const updated = await tx.pluginWebhookDelivery.updateMany({
                where: {
                    id: candidate.id,
                    revision: candidate.revision,
                    state: "queued",
                },
                data: expired
                    ? deadLetterMutation(now, "target_offline")
                    : {
                        offlineSinceAt,
                        lastErrorCode: "target_offline",
                        automationAdmissionUnresolved: getActivePrismaRuntime().DbNull,
                        nextAttemptAt: new Date(now.getTime() + 5_000),
                        revision: { increment: 1 },
                },
            });
            if (updated.count === 1) {
                await markPluginWebhookAccountChangedInTxV1(tx, {
                    accountId: params.accountId,
                    pluginId: candidate.targetPluginId,
                });
            }
            return PluginWebhookClaimResultV1Schema.parse({ kind: "none", retryAfterMs: 5_000 });
        }
        const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (fence.status !== "ready") {
            return PluginWebhookClaimResultV1Schema.parse({ kind: "none", retryAfterMs: 5_000 });
        }
        const storedEnvelope =
            validatePluginWebhookStoredEnvelopeForAccountCurrentnessV1({
                currentness: fence.account.currentness,
                envelope: candidate.payload,
            });
        if (!storedEnvelope.ok) {
            const updated = await tx.pluginWebhookDelivery.updateMany({
                where: {
                    id: candidate.id,
                    revision: candidate.revision,
                    state: "queued",
                    payloadBytes: { gt: 0n },
                    nextAttemptAt: { lte: now },
                },
                data: deadLetterMutation(
                    now,
                    storedEnvelope.code,
                ),
            });
            if (updated.count === 1) {
                await markPluginWebhookAccountChangedInTxV1(tx, {
                    accountId: params.accountId,
                    pluginId: candidate.targetPluginId,
                });
            }
            return PluginWebhookClaimResultV1Schema.parse({ kind: "none", retryAfterMs: 5_000 });
        }
        const firstClaimAt = now;
        const maxClaimUntil = new Date(now.getTime() + PLUGIN_WEBHOOK_MAX_CONTINUOUS_CLAIM_MS_V1);
        const expiresAt = new Date(Math.min(
            now.getTime() + PLUGIN_WEBHOOK_LEASE_MS_V1,
            maxClaimUntil.getTime(),
        ));
        const claimed = await tx.pluginWebhookDelivery.updateMany({
            where: {
                id: candidate.id,
                revision: candidate.revision,
                state: "queued",
                payloadBytes: { gt: 0n },
                nextAttemptAt: { lte: now },
            },
            data: {
                state: "claimed",
                leaseId,
                claimedByMachineId: params.target.materialization.machineId,
                claimedByMachineInstallationId: params.target.machineInstallationId,
                firstClaimAt,
                executionStartedAt: null,
                leaseExpiresAt: expiresAt,
                offlineSinceAt: null,
                automationAdmissionUnresolved: getActivePrismaRuntime().DbNull,
                revision: { increment: 1 },
            },
        });
        if (claimed.count !== 1) return PluginWebhookClaimResultV1Schema.parse({ kind: "none", retryAfterMs: 250 });
        await markPluginWebhookAccountChangedInTxV1(tx, {
            accountId: params.accountId,
            pluginId: candidate.targetPluginId,
        });

        return PluginWebhookClaimResultV1Schema.parse({
            kind: "delivery",
            deliveryId: candidate.id,
            endpoint: {
                webhookEndpointId: candidate.endpointId,
                revision: candidate.endpointRevision,
                webhookContribution: {
                    pluginId: params.target.materialization.pluginId,
                    localId: candidate.endpointWebhookContributionId,
                },
                handlerActionLocalId: candidate.endpointHandlerActionId,
                sourceInstanceId: candidate.endpointSourceInstanceId,
            },
            attempt: candidate.attemptCount + 1,
            replay: candidate.replayCount,
            receivedAtMs: candidate.receivedAt.getTime(),
            envelope: storedEnvelope.envelope,
            lease: {
                leaseId,
                revision: candidate.revision + 1,
                firstClaimAtMs: firstClaimAt.getTime(),
                expiresAtMs: expiresAt.getTime(),
                maxClaimUntilMs: maxClaimUntil.getTime(),
            },
        });
    });
}

export type PluginWebhookInvocationReferenceValidationResultV1 = Readonly<
    | {
        kind: "ready";
        webhookEndpointId: string;
        revision: number;
        webhookContribution: Readonly<{ pluginId: string; localId: string }>;
        sourceInstanceId: string;
        target: ClaimTargetV1;
    }
    | { kind: "unavailable"; code: "endpoint_unavailable" | "delivery_lease_unavailable" }
>;

export async function validateCurrentPluginWebhookInvocationReferenceTxV1(params: Readonly<{
    tx: Tx;
    accountId: string;
    reference: PluginWebhookInvocationReferenceV1;
    serverIdentityId: string;
    now?: Date;
}>): Promise<PluginWebhookInvocationReferenceValidationResultV1> {
    const parsed = PluginWebhookInvocationReferenceV1Schema.safeParse(params.reference);
    if (!parsed.success) return { kind: "unavailable", code: "delivery_lease_unavailable" };
    const reference = parsed.data;
    const now = params.now ?? new Date();
    const current = await params.tx.pluginWebhookDelivery.findFirst({
        where: { id: reference.deliveryId, accountId: params.accountId },
        select: {
            endpointId: true,
            endpointRevision: true,
            endpointWebhookContributionId: true,
            endpointHandlerActionId: true,
            endpointSourceInstanceId: true,
            state: true,
            revision: true,
            leaseId: true,
            executionStartedAt: true,
            leaseExpiresAt: true,
            claimedByMachineId: true,
            claimedByMachineInstallationId: true,
            targetMachineId: true,
            targetMachineInstallationId: true,
            targetMaterializationId: true,
            targetPluginId: true,
            targetPluginVersion: true,
            endpoint: {
                select: {
                    id: true,
                    routingKind: true,
                    enabled: true,
                    revokedAt: true,
                    releasedAt: true,
                    route: { select: { enabled: true, revokedAt: true, verifierKind: true } },
                },
            },
        },
    });
    if (
        !current
        || current.state !== "claimed"
        || current.leaseId !== reference.lease.leaseId
        || reference.lease.revision > current.revision
        || current.executionStartedAt === null
        || current.leaseExpiresAt === null
        || current.leaseExpiresAt.getTime() <= now.getTime()
        || current.claimedByMachineId !== reference.target.materialization.machineId
        || current.claimedByMachineInstallationId !== reference.target.machineInstallationId
        || current.targetMachineId !== reference.target.materialization.machineId
        || current.targetMachineInstallationId !== reference.target.machineInstallationId
        || current.targetMaterializationId !== reference.target.materialization.materializationId
        || current.targetPluginId !== reference.target.materialization.pluginId
    ) {
        return { kind: "unavailable", code: "delivery_lease_unavailable" };
    }
    const endpoint = current.endpoint;
    if (
        current.endpointId !== reference.endpoint.webhookEndpointId
        || current.endpointRevision !== reference.endpoint.revision
        || current.targetPluginId !== reference.endpoint.webhookContribution.pluginId
        || current.endpointWebhookContributionId !== reference.endpoint.webhookContribution.localId
        || current.endpointHandlerActionId !== reference.endpoint.handlerActionLocalId
        || current.endpointSourceInstanceId !== reference.endpoint.sourceInstanceId
        || endpoint.id !== reference.endpoint.webhookEndpointId
        || !endpoint.enabled
        || endpoint.revokedAt !== null
        || endpoint.releasedAt !== null
        || !endpoint.route.enabled
        || endpoint.route.revokedAt !== null
    ) {
        return { kind: "unavailable", code: "endpoint_unavailable" };
    }
    if (!(await isCurrentAuthenticatedTargetInTx({
        tx: params.tx,
        accountId: params.accountId,
        target: reference.target,
        version: current.targetPluginVersion,
        serverIdentityId: params.serverIdentityId,
    }))) {
        return { kind: "unavailable", code: "endpoint_unavailable" };
    }
    const contribution = await resolveCurrentPluginWebhookContributionTxV1({
        tx: params.tx,
        accountId: params.accountId,
        contribution: reference.endpoint.webhookContribution,
        target: {
            materialization: reference.target.materialization,
            machineInstallationId: reference.target.machineInstallationId,
            pluginVersion: current.targetPluginVersion,
        },
    });
    if (
        !contribution
        || contribution.handlerActionLocalId !== reference.endpoint.handlerActionLocalId
        || contribution.routingKind !== endpoint.routingKind
        || contribution.verifierKind !== endpoint.route.verifierKind
    ) {
        return { kind: "unavailable", code: "endpoint_unavailable" };
    }
    return {
        kind: "ready",
        webhookEndpointId: current.endpointId,
        revision: current.endpointRevision,
        webhookContribution: reference.endpoint.webhookContribution,
        sourceInstanceId: current.endpointSourceInstanceId,
        target: reference.target,
    };
}

export async function renewPluginWebhookDeliveryV1(params: Readonly<{
    accountId: string;
    deliveryId: string;
    target: ClaimTargetV1;
    lease: LeaseIdentityV1;
    transition: "renew" | "executionStarted";
    now?: Date;
}>): Promise<PluginWebhookRenewResultV1> {
    const now = params.now ?? new Date();
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);
    return await inTx(async (tx) => {
        const current = await tx.pluginWebhookDelivery.findFirst({
            where: {
                id: params.deliveryId,
                accountId: params.accountId,
                ...targetWhere(params.target),
                state: "claimed",
                leaseId: params.lease.leaseId,
                revision: params.lease.revision,
                claimedByMachineId: params.target.materialization.machineId,
                claimedByMachineInstallationId: params.target.machineInstallationId,
            },
            select: {
                firstClaimAt: true,
                executionStartedAt: true,
                leaseExpiresAt: true,
                targetPluginVersion: true,
                endpoint: { select: { enabled: true, revokedAt: true, releasedAt: true } },
            },
        });
        if (
            !current
            || !current.firstClaimAt
            || !current.leaseExpiresAt
            || current.leaseExpiresAt.getTime() <= now.getTime()
            || !current.endpoint.enabled
            || current.endpoint.revokedAt !== null
            || current.endpoint.releasedAt !== null
        ) {
            return PluginWebhookRenewResultV1Schema.parse({ kind: "leaseLost" });
        }
        if (!(await isCurrentAuthenticatedTargetInTx({
            tx,
            accountId: params.accountId,
            target: params.target,
            version: current.targetPluginVersion,
            serverIdentityId,
        }))) {
            return PluginWebhookRenewResultV1Schema.parse({ kind: "leaseLost" });
        }
        const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (fence.status !== "ready") {
            return PluginWebhookRenewResultV1Schema.parse({ kind: "unavailable", code: "account_transition" });
        }
        const maxClaimUntilMs = current.firstClaimAt.getTime() + PLUGIN_WEBHOOK_MAX_CONTINUOUS_CLAIM_MS_V1;
        if (now.getTime() >= maxClaimUntilMs) {
            return PluginWebhookRenewResultV1Schema.parse({ kind: "leaseLost" });
        }
        const expiresAt = new Date(Math.min(now.getTime() + PLUGIN_WEBHOOK_LEASE_MS_V1, maxClaimUntilMs));
        const executionStarts = params.transition === "executionStarted" && current.executionStartedAt === null;
        const updated = await tx.pluginWebhookDelivery.updateMany({
            where: {
                id: params.deliveryId,
                accountId: params.accountId,
                state: "claimed",
                leaseId: params.lease.leaseId,
                revision: params.lease.revision,
                leaseExpiresAt: { gt: now },
            },
            data: {
                leaseExpiresAt: expiresAt,
                ...(executionStarts
                    ? { executionStartedAt: now, attemptCount: { increment: 1 } }
                    : {}),
                revision: { increment: 1 },
            },
        });
        if (updated.count !== 1) return PluginWebhookRenewResultV1Schema.parse({ kind: "leaseLost" });
        await markPluginWebhookAccountChangedInTxV1(tx, {
            accountId: params.accountId,
            pluginId: params.target.materialization.pluginId,
        });
        return PluginWebhookRenewResultV1Schema.parse({
            kind: "renewed",
            revision: params.lease.revision + 1,
            expiresAtMs: expiresAt.getTime(),
        });
    });
}

export async function completePluginWebhookDeliveryV1(params: Readonly<{
    accountId: string;
    deliveryId: string;
    target: ClaimTargetV1;
    lease: LeaseIdentityV1;
    disposition: "accepted" | "ignored";
    now?: Date;
}>): Promise<PluginWebhookSettleResultV1> {
    const now = params.now ?? new Date();
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);
    return await inTx(async (tx) => {
        const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (fence.status !== "ready") {
            return PluginWebhookSettleResultV1Schema.parse({ kind: "unavailable", code: "account_transition" });
        }
        const current = await tx.pluginWebhookDelivery.findFirst({
            where: {
                id: params.deliveryId,
                accountId: params.accountId,
                ...targetWhere(params.target),
                state: "claimed",
                leaseId: params.lease.leaseId,
                revision: params.lease.revision,
                executionStartedAt: { not: null },
                leaseExpiresAt: { gt: now },
                endpoint: { enabled: true, revokedAt: null, releasedAt: null },
            },
            select: { targetPluginVersion: true },
        });
        if (!current || !(await isCurrentAuthenticatedTargetInTx({
            tx,
            accountId: params.accountId,
            target: params.target,
            version: current.targetPluginVersion,
            serverIdentityId,
        }))) {
            return PluginWebhookSettleResultV1Schema.parse({ kind: "leaseLost" });
        }
        const updated = await tx.pluginWebhookDelivery.updateMany({
            where: {
                id: params.deliveryId,
                accountId: params.accountId,
                ...targetWhere(params.target),
                state: "claimed",
                leaseId: params.lease.leaseId,
                revision: params.lease.revision,
                executionStartedAt: { not: null },
                leaseExpiresAt: { gt: now },
                endpoint: { enabled: true, revokedAt: null, releasedAt: null },
            },
            data: {
                state: "succeeded",
                payload: getActivePrismaRuntime().DbNull,
                payloadBytes: 0n,
                ...clearLeaseFields(),
                lastErrorCode: null,
                automationAdmissionUnresolved: getActivePrismaRuntime().DbNull,
                terminalDisposition: params.disposition,
                succeededAt: now,
                payloadPurgeAt: null,
                metadataDeleteAt: new Date(now.getTime() + PLUGIN_WEBHOOK_SUCCESS_METADATA_RETENTION_MS_V1),
                revision: { increment: 1 },
            },
        });
        if (updated.count !== 1) return PluginWebhookSettleResultV1Schema.parse({ kind: "leaseLost" });
        await markPluginWebhookAccountChangedInTxV1(tx, {
            accountId: params.accountId,
            pluginId: params.target.materialization.pluginId,
        });
        return PluginWebhookSettleResultV1Schema.parse({ kind: "settled", state: "succeeded" });
    });
}

export async function failPluginWebhookDeliveryV1(params: Readonly<{
    accountId: string;
    deliveryId: string;
    target: ClaimTargetV1;
    lease: LeaseIdentityV1;
    result: Readonly<{ kind: "retry" | "deadLetter"; code: string }>;
    /** Host-derived only; direct plugin Action results cannot author this. */
    automationAdmissionUnresolved?: PluginWebhookAutomationAdmissionUnresolvedV1;
    retryDelayMs?: number;
    random?: () => number;
    now?: Date;
}>): Promise<PluginWebhookSettleResultV1> {
    const now = params.now ?? new Date();
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);
    if (params.retryDelayMs !== undefined && (
        !Number.isSafeInteger(params.retryDelayMs)
        || params.retryDelayMs < 1
        || params.retryDelayMs > DAY_MS
    )) {
        throw new TypeError("Plugin webhook retry delay must be an integer from 1 through one day");
    }
    if (params.automationAdmissionUnresolved !== undefined && params.result.kind !== "retry") {
        throw new TypeError("Plugin webhook unresolved Automation diagnostics require a retry result");
    }
    const automationAdmissionUnresolved = params.automationAdmissionUnresolved === undefined
        ? null
        : PluginWebhookAutomationAdmissionUnresolvedV1Schema.parse(params.automationAdmissionUnresolved);
    return await inTx(async (tx) => {
        const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId);
        if (fence.status !== "ready") {
            return PluginWebhookSettleResultV1Schema.parse({ kind: "unavailable", code: "account_transition" });
        }
        const current = await tx.pluginWebhookDelivery.findFirst({
            where: {
                id: params.deliveryId,
                accountId: params.accountId,
                ...targetWhere(params.target),
                state: "claimed",
                leaseId: params.lease.leaseId,
                revision: params.lease.revision,
                executionStartedAt: { not: null },
                leaseExpiresAt: { gt: now },
                endpoint: { enabled: true, revokedAt: null, releasedAt: null },
            },
            select: { attemptCount: true, targetPluginVersion: true },
        });
        if (!current) return PluginWebhookSettleResultV1Schema.parse({ kind: "leaseLost" });
        if (!(await isCurrentAuthenticatedTargetInTx({
            tx,
            accountId: params.accountId,
            target: params.target,
            version: current.targetPluginVersion,
            serverIdentityId,
        }))) {
            return PluginWebhookSettleResultV1Schema.parse({ kind: "leaseLost" });
        }
        const deadLetter = params.result.kind === "deadLetter"
            || current.attemptCount >= PLUGIN_WEBHOOK_MAX_ATTEMPTS_V1;
        const updated = await tx.pluginWebhookDelivery.updateMany({
            where: {
                id: params.deliveryId,
                accountId: params.accountId,
                state: "claimed",
                leaseId: params.lease.leaseId,
                revision: params.lease.revision,
                executionStartedAt: { not: null },
                leaseExpiresAt: { gt: now },
            },
            data: deadLetter
                ? deadLetterMutation(
                    now,
                    params.result.code,
                    params.result.kind === "retry" ? automationAdmissionUnresolved : null,
                )
                : {
                    state: "queued",
                    ...clearLeaseFields(),
                    lastErrorCode: params.result.code,
                    automationAdmissionUnresolved: getActivePrismaRuntime().DbNull,
                    nextAttemptAt: new Date(now.getTime() + (
                        params.retryDelayMs ?? resolvePluginWebhookRetryDelayMsV1({
                            attempt: current.attemptCount,
                            ...(params.random ? { random: params.random } : {}),
                        })
                    )),
                    revision: { increment: 1 },
                },
        });
        if (updated.count !== 1) return PluginWebhookSettleResultV1Schema.parse({ kind: "leaseLost" });
        await markPluginWebhookAccountChangedInTxV1(tx, {
            accountId: params.accountId,
            pluginId: params.target.materialization.pluginId,
        });
        return PluginWebhookSettleResultV1Schema.parse({
            kind: "settled",
            state: deadLetter ? "dead_letter" : "queued",
        });
    });
}

export async function recoverExpiredPluginWebhookClaimsV1(params: Readonly<{
    now?: Date;
    batchSize?: number;
}> = {}): Promise<Readonly<{ requeued: number; deadLettered: number }>> {
    const now = params.now ?? new Date();
    const batchSize = params.batchSize ?? DEFAULT_RECOVERY_BATCH_SIZE_V1;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_RECOVERY_BATCH_SIZE_V1) {
        throw new TypeError("Plugin webhook claim recovery batch size must be an integer from 1 through 500");
    }
    const candidates = await db.pluginWebhookDelivery.findMany({
        where: { state: "claimed", leaseExpiresAt: { lte: now } },
        orderBy: [{ leaseExpiresAt: "asc" }, { id: "asc" }],
        take: batchSize,
        select: { id: true, accountId: true, targetPluginId: true, revision: true, attemptCount: true, executionStartedAt: true },
    });
    let requeued = 0;
    let deadLettered = 0;
    for (const candidate of candidates) {
        const deadLetter = candidate.executionStartedAt !== null
            && candidate.attemptCount >= PLUGIN_WEBHOOK_MAX_ATTEMPTS_V1;
        const transitioned = await inTx(async (tx) => {
            const updated = await tx.pluginWebhookDelivery.updateMany({
                where: {
                    id: candidate.id,
                    revision: candidate.revision,
                    state: "claimed",
                    leaseExpiresAt: { lte: now },
                },
                data: deadLetter
                    ? deadLetterMutation(now, "lease_expired")
                    : {
                        state: "queued",
                        ...clearLeaseFields(),
                        lastErrorCode: candidate.executionStartedAt ? "lease_expired" : null,
                        automationAdmissionUnresolved: getActivePrismaRuntime().DbNull,
                        nextAttemptAt: candidate.executionStartedAt === null
                            ? now
                            : new Date(now.getTime() + resolvePluginWebhookRetryDelayMsV1({
                                attempt: candidate.attemptCount,
                            })),
                        revision: { increment: 1 },
                    },
            });
            if (updated.count !== 1) return false;
            await markPluginWebhookAccountChangedInTxV1(tx, {
                accountId: candidate.accountId,
                pluginId: candidate.targetPluginId,
            });
            return true;
        });
        if (!transitioned) continue;
        if (deadLetter) deadLettered += 1;
        else requeued += 1;
    }
    return { requeued, deadLettered };
}

export async function ageOverduePluginWebhookDeliveriesV1(params: Readonly<{
    now?: Date;
    batchSize?: number;
}> = {}): Promise<Readonly<{ deadLettered: number }>> {
    const now = params.now ?? new Date();
    const batchSize = params.batchSize ?? DEFAULT_RECOVERY_BATCH_SIZE_V1;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_RECOVERY_BATCH_SIZE_V1) {
        throw new TypeError("Plugin webhook queue aging batch size must be an integer from 1 through 500");
    }
    const offlineDeadline = new Date(now.getTime() - PLUGIN_WEBHOOK_MAX_QUEUED_AGE_MS_V1);
    const candidates = await db.pluginWebhookDelivery.findMany({
        where: {
            state: "queued",
            payloadBytes: { gt: 0n },
            nextAttemptAt: { lte: now },
            OR: [
                { offlineSinceAt: { lte: offlineDeadline } },
                { metadataDeleteAt: { lte: now } },
            ],
        },
        orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
        take: batchSize,
        select: {
            id: true,
            accountId: true,
            targetPluginId: true,
            revision: true,
            attemptCount: true,
            offlineSinceAt: true,
            metadataDeleteAt: true,
        },
    });
    let deadLettered = 0;
    for (const candidate of candidates) {
        const transitioned = await inTx(async (tx) => {
            const updated = await tx.pluginWebhookDelivery.updateMany({
                where: {
                    id: candidate.id,
                    revision: candidate.revision,
                    state: "queued",
                    payloadBytes: { gt: 0n },
                    nextAttemptAt: { lte: now },
                    metadataDeleteAt: candidate.metadataDeleteAt,
                },
                data: deadLetterMutation(
                    now,
                    candidate.offlineSinceAt !== null
                        && candidate.offlineSinceAt.getTime() <= offlineDeadline.getTime()
                        ? "target_offline"
                        : "retention_expired",
                ),
            });
            if (updated.count !== 1) return false;
            await markPluginWebhookAccountChangedInTxV1(tx, {
                accountId: candidate.accountId,
                pluginId: candidate.targetPluginId,
            });
            return true;
        });
        if (!transitioned) continue;
        deadLettered += 1;
    }
    return { deadLettered };
}
