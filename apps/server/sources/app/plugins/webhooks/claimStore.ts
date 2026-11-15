import { randomBytes as nodeRandomBytes } from "node:crypto";

import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { PluginWebhookClaimResultV1Schema, PluginWebhookInvocationReferenceV1Schema, PluginWebhookRenewResultV1Schema, PluginWebhookSettleResultV1Schema, type PluginWebhookClaimRequestV1, type PluginWebhookClaimResultV1, type PluginWebhookInvocationReferenceV1, type PluginWebhookRenewResultV1, type PluginWebhookSettleResultV1 } from '@happier-dev/protocol/plugins/webhooks/deliveryV1';
import { PluginWebhookAutomationAdmissionUnresolvedV1Schema, type PluginWebhookAutomationAdmissionUnresolvedV1 } from '@happier-dev/protocol/plugins/webhooks/statusV1';

import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import {
    resolveCurrentClaimablePluginMachineMaterializationTx,
    resolveCurrentClaimablePluginMachineMaterializationsTx,
} from "@/app/plugins/availability/operations";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { getActivePrismaRuntime } from "@/storage/prisma";
import { resolvePluginWebhookRetryDelayMsV1 } from "./retryPolicy";
import {
    resolveCurrentPluginWebhookClaimAuthoritiesTxV1,
    resolveCurrentPluginWebhookContributionTxV1,
} from "./currentContribution";
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
// A claim deadline is armed with a platform timer on the daemon.
const PLUGIN_WEBHOOK_MAX_CLAIM_DEADLINE_MS_V1 = 2_147_483_647;

type ClaimTargetV1 = Extract<PluginWebhookClaimResultV1, { kind: "delivery" }>["target"];

type ClaimMachineInstallationV1 = PluginWebhookClaimRequestV1["machine"];

type LeaseIdentityV1 = Readonly<{ leaseId: string; revision: number }>;

function targetWhere(target: ClaimTargetV1) {
    return {
        targetMachineId: target.materialization.machineId,
        targetMachineInstallationId: target.machineInstallationId,
        targetMaterializationId: target.materialization.materializationId,
        targetPluginId: target.materialization.pluginId,
    } as const;
}

/**
 * Custody of an exact claimed attempt: the frozen delivery target, claimant
 * machine installation, lease identity and row revision, plus an unexpired
 * lease and the required execution-start state.
 *
 * Plugin, materialization and endpoint currentness are deliberately absent.
 * They are proven strictly *before* the effect — at claim, at every renewal
 * (including the `executionStarted` transition immediately before dispatch),
 * and again by the invocation-reference validator the handler's host calls run
 * through. Re-deriving them here would refuse the settlement of a result the
 * plugin already produced, leaving the row claimed until its lease expires and
 * then re-executing the same delivery — the one duplicate the at-least-once
 * contract asks the queue not to manufacture on its own.
 */
function attemptCustodyWhereV1(params: Readonly<{
    accountId: string;
    deliveryId: string;
    target: ClaimTargetV1;
    lease: LeaseIdentityV1;
    now: Date;
    execution: "started" | "startedOrPreExecutionContentUnavailable";
}>) {
    return {
        id: params.deliveryId,
        accountId: params.accountId,
        ...targetWhere(params.target),
        state: "claimed",
        leaseId: params.lease.leaseId,
        revision: params.lease.revision,
        claimedByMachineId: params.target.materialization.machineId,
        claimedByMachineInstallationId: params.target.machineInstallationId,
        ...(params.execution === "started"
            ? { executionStartedAt: { not: null } }
            : {
                OR: [
                    { executionStartedAt: { not: null } },
                    { executionStartedAt: null, attemptCount: 0 },
                ],
            }),
        leaseExpiresAt: { gt: params.now },
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

type ClaimCandidateRowV1 = PluginWebhookPreEffectRowV1 & {
    id: string;
    revision: number;
    attemptCount: number;
    replayCount: number;
    receivedAt: Date;
    payload: unknown;
    endpointId: string;
    endpointRevision: number;
    endpointWebhookContributionId: string;
    endpointHandlerActionId: string;
    endpointSourceInstanceId: string;
    verifierKind: string;
    targetMachineId: string;
    targetMachineInstallationId: string;
    targetMaterializationId: string;
    targetPluginId: string;
    targetPluginVersion: string;
    offlineSinceAt: Date | null;
    state: string;
    executionStartedAt: Date | null;
};

type EligibleClaimTargetV1 = Readonly<{
    materializationId: string;
    pluginId: string;
    version: string;
    machineId: string;
    machineInstallationId: string;
}>;

type EligibleClaimPathV1 = Readonly<{
    materializationId: string;
    pluginId: string;
    version: string;
    webhookContributionId: string;
    handlerActionId: string;
    verifierKind: string;
    routingKind: string;
}>;

function eligibleClaimPathKeyV1(path: EligibleClaimPathV1): string {
    return JSON.stringify([
        path.materializationId,
        path.pluginId,
        path.version,
        path.webhookContributionId,
        path.handlerActionId,
        path.verifierKind,
        path.routingKind,
    ]);
}

function candidateClaimPathKeyV1(candidate: ClaimCandidateRowV1): string {
    return eligibleClaimPathKeyV1({
        materializationId: candidate.targetMaterializationId,
        pluginId: candidate.targetPluginId,
        version: candidate.targetPluginVersion,
        webhookContributionId: candidate.endpointWebhookContributionId,
        handlerActionId: candidate.endpointHandlerActionId,
        verifierKind: candidate.verifierKind,
        routingKind: candidate.endpoint.routingKind,
    });
}

async function resolveEligibleClaimPathsTxV1(params: Readonly<{
    tx: Tx;
    accountId: string;
    targets: readonly EligibleClaimTargetV1[];
}>): Promise<readonly EligibleClaimPathV1[]> {
    const authorities = await resolveCurrentPluginWebhookClaimAuthoritiesTxV1({
        tx: params.tx,
        accountId: params.accountId,
        targets: params.targets,
    });
    if (authorities.length === 0) return [];
    return authorities.flatMap((authority): EligibleClaimPathV1[] => authority.contribution.handlerActionLocalId === null ? [] : [Object.freeze({
        materializationId: authority.materializationId,
        pluginId: authority.pluginId,
        version: authority.version,
        webhookContributionId: authority.contribution.localId,
        handlerActionId: authority.contribution.handlerActionLocalId,
        verifierKind: authority.contribution.verifierKind,
        routingKind: authority.contribution.routingKind,
    })]);
}

/**
 * Reads the ordered due head delivery for the authenticated machine
 * installation, optionally restricted to exact current target/contribution/
 * endpoint paths resolved by their canonical owners.
 */
async function readServerSelectedClaimCandidateTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    machine: ClaimMachineInstallationV1;
    now: Date;
    eligiblePaths?: readonly EligibleClaimPathV1[];
}>): Promise<Readonly<{ candidate: ClaimCandidateRowV1; selectedTarget: ClaimTargetV1 }> | null> {
    if (params.eligiblePaths?.length === 0) return null;
    const candidate = await params.tx.pluginWebhookDelivery.findFirst({
        where: {
            accountId: params.accountId,
            targetMachineId: params.machine.machineId,
            targetMachineInstallationId: params.machine.machineInstallationId,
            payloadBytes: { gt: 0n },
            AND: [{
                OR: [
                    // Due work. A queued row past its custody deadline is overdue: it
                    // reads as dead-lettered (statusStore) and is never offered.
                    {
                        state: "queued",
                        nextAttemptAt: { lte: params.now },
                        metadataDeleteAt: { gt: params.now },
                    },
                    // This installation's own lapsed lease; the claim recovers it first.
                    { state: "claimed", leaseExpiresAt: { lte: params.now } },
                ],
            }],
            endpoint: {
                enabled: true,
                revokedAt: null,
                releasedAt: null,
                route: { enabled: true, revokedAt: null },
            },
            ...(params.eligiblePaths === undefined ? {} : {
                OR: params.eligiblePaths.map((eligible) => ({
                    endpointWebhookContributionId: eligible.webhookContributionId,
                    endpointHandlerActionId: eligible.handlerActionId,
                    verifierKind: eligible.verifierKind,
                    targetMaterializationId: eligible.materializationId,
                    targetPluginId: eligible.pluginId,
                    targetPluginVersion: eligible.version,
                    endpoint: {
                        routingKind: eligible.routingKind,
                        enabled: true,
                        revokedAt: null,
                        releasedAt: null,
                        route: {
                            enabled: true,
                            revokedAt: null,
                            verifierKind: eligible.verifierKind,
                        },
                    },
                })),
            }),
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
            verifierKind: true,
            targetMachineId: true,
            targetMachineInstallationId: true,
            targetMaterializationId: true,
            targetPluginId: true,
            targetPluginVersion: true,
            offlineSinceAt: true,
            state: true,
            executionStartedAt: true,
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
    if (candidate === null) return null;
    return {
        candidate,
        selectedTarget: {
            materialization: {
                machineId: candidate.targetMachineId,
                materializationId: candidate.targetMaterializationId,
                pluginId: candidate.targetPluginId,
            },
            machineInstallationId: candidate.targetMachineInstallationId,
        },
    };
}

/**
 * The installation's own next claim deadline when nothing is due: the earliest
 * future retry of its queued work or expiry of a lease it holds, under the same
 * endpoint eligibility as the claim. Null when it owns neither: new work then
 * reaches the daemon as the post-commit Machine-socket wake (`wake.ts`), so an
 * idle installation is never re-claimed on a cadence.
 */
async function readNextOwnedClaimDeadlineMsTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    machine: ClaimMachineInstallationV1;
    now: Date;
}>): Promise<number | null> {
    const scope = {
        accountId: params.accountId,
        targetMachineId: params.machine.machineId,
        targetMachineInstallationId: params.machine.machineInstallationId,
        payloadBytes: { gt: 0n },
        endpoint: {
            enabled: true,
            revokedAt: null,
            releasedAt: null,
            route: { enabled: true, revokedAt: null },
        },
    } as const;
    const retry = await params.tx.pluginWebhookDelivery.findFirst({
        where: { ...scope, state: "queued", nextAttemptAt: { gt: params.now }, metadataDeleteAt: { gt: params.now } },
        orderBy: { nextAttemptAt: "asc" },
        select: { nextAttemptAt: true },
    });
    const lease = await params.tx.pluginWebhookDelivery.findFirst({
        where: { ...scope, state: "claimed", leaseExpiresAt: { gt: params.now } },
        orderBy: { leaseExpiresAt: "asc" },
        select: { leaseExpiresAt: true },
    });
    const deadlines = [retry?.nextAttemptAt, lease?.leaseExpiresAt]
        .flatMap(at => at ? [at.getTime() - params.now.getTime()] : []);
    return deadlines.length === 0 ? null
        : Math.min(PLUGIN_WEBHOOK_MAX_CLAIM_DEADLINE_MS_V1, Math.max(1, Math.min(...deadlines)));
}

export async function claimPluginWebhookDeliveryV1(params: Readonly<{
    accountId: string;
    machine: ClaimMachineInstallationV1;
    now?: Date;
    randomBytes?: (length: number) => Uint8Array;
}>): Promise<PluginWebhookClaimResultV1> {
    const now = params.now ?? new Date();
    const none = (retryAfterMs: number | null) => PluginWebhookClaimResultV1Schema.parse({
        kind: "none",
        retryAfterMs,
    });
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);
    const randomBytes = params.randomBytes
        ?? ((length: number) => Uint8Array.from(nodeRandomBytes(length)));

    return await inTx(async (tx) => {
        // Availability classifies the installation's current materializations
        // once with fixed query work. The ordered stale head receives its typed
        // transition, but selection of the eligible row does not walk stale
        // targets one by one, so none can starve work behind it and the number
        // of claim queries/writes remains fixed independently of that count.
        const eligibleTargets = (await resolveCurrentClaimablePluginMachineMaterializationsTx({
            tx,
            accountId: params.accountId,
            serverIdentityId,
            machineId: params.machine.machineId,
            machineInstallationId: params.machine.machineInstallationId,
            requiredMachineOperationCapability: "pluginWebhookClaim",
        })).map((materialization) => ({
            materializationId: materialization.materializationId,
            pluginId: materialization.pluginId,
            version: materialization.version,
            machineId: materialization.machineId,
            machineInstallationId: params.machine.machineInstallationId,
        }));
        const eligiblePaths = await resolveEligibleClaimPathsTxV1({
            tx,
            accountId: params.accountId,
            targets: eligibleTargets,
        });
        const eligiblePathKeys = new Set(eligiblePaths.map(eligibleClaimPathKeyV1));
        // A lapsed lease of this installation is recovered here, at its claimant's next
        // claim, by the same transition the hourly retention pass applies to leases
        // whose installation never returns. Each recovery changes the row's state, so
        // the loop ends once the due head is queued work (or nothing).
        const readDueHead = async (eligible?: readonly EligibleClaimPathV1[]) => {
            for (;;) {
                const due = await readServerSelectedClaimCandidateTx({
                    tx,
                    accountId: params.accountId,
                    machine: params.machine,
                    now,
                    ...(eligible === undefined ? {} : { eligiblePaths: eligible }),
                });
                if (due === null || due.candidate.state !== "claimed") return due;
                const recovered = await recoverExpiredPluginWebhookClaimTxV1(tx, {
                    ...due.candidate,
                    accountId: params.accountId,
                }, now);
                if (recovered === "raced") return null;
            }
        };
        const nothingDue = async () => none(await readNextOwnedClaimDeadlineMsTx({
            tx, accountId: params.accountId, machine: params.machine, now,
        }));
        const head = await readDueHead();
        if (head === null) return await nothingDue();
        const deferUnavailableCandidate = async (candidate: ClaimCandidateRowV1): Promise<boolean> => {
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
            if (updated.count !== 1) return false;
            await markPluginWebhookAccountChangedInTxV1(tx, {
                accountId: params.accountId,
                pluginId: candidate.targetPluginId,
            });
            return true;
        };
        let selected = head;
        if (!eligiblePathKeys.has(candidateClaimPathKeyV1(head.candidate))) {
            if (!(await deferUnavailableCandidate(head.candidate))) return none(250);
            const eligible = await readDueHead(eligiblePaths);
            if (eligible === null) return await nothingDue();
            selected = eligible;
        }
        const hasCurrentPreEffectAuthority = async (
            selection: Readonly<{ candidate: ClaimCandidateRowV1; selectedTarget: ClaimTargetV1 }>,
        ) => await hasCurrentPluginWebhookPreEffectAuthorityTxV1({
            tx,
            accountId: params.accountId,
            current: selection.candidate,
            target: selection.selectedTarget,
            serverIdentityId,
        });
        if (!(await hasCurrentPreEffectAuthority(selected))) {
            if (!(await deferUnavailableCandidate(selected.candidate))) return none(250);
            return none(5_000);
        }
        const candidate = selected.candidate;
        const target = selected.selectedTarget;
            const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId, "content");
            if (fence.status !== "ready") {
                return none(5_000);
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
                return none(5_000);
            }
            const leaseBytes = randomBytes(16);
            if (leaseBytes.byteLength !== 16) throw new TypeError("Plugin webhook lease identity requires exactly 16 bytes");
            const leaseId = `wh_lease_${encodeBase64(leaseBytes, "base64url")}`;
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
                    claimedByMachineId: target.materialization.machineId,
                    claimedByMachineInstallationId: target.machineInstallationId,
                    firstClaimAt,
                    executionStartedAt: null,
                    leaseExpiresAt: expiresAt,
                    offlineSinceAt: null,
                    automationAdmissionUnresolved: getActivePrismaRuntime().DbNull,
                    revision: { increment: 1 },
                },
            });
            if (claimed.count !== 1) return none(250);
            await markPluginWebhookAccountChangedInTxV1(tx, {
                accountId: params.accountId,
                pluginId: candidate.targetPluginId,
            });

            return PluginWebhookClaimResultV1Schema.parse({
                kind: "delivery",
                deliveryId: candidate.id,
                target,
                pluginVersion: candidate.targetPluginVersion,
                endpoint: {
                    webhookEndpointId: candidate.endpointId,
                    revision: candidate.endpointRevision,
                    webhookContribution: {
                        pluginId: target.materialization.pluginId,
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
    }, { /* Webhook endpoint, credential and contribution authority is read before the Account fence. */ isolationLevel: "Serializable" });
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

type PluginWebhookPreEffectRowV1 = Readonly<{
    endpointId: string;
    endpointRevision: number;
    endpointWebhookContributionId: string;
    endpointHandlerActionId: string;
    endpointSourceInstanceId: string;
    targetPluginId: string;
    targetPluginVersion: string;
    endpoint: Readonly<{
        id: string;
        routingKind: string;
        enabled: boolean;
        revokedAt: Date | null;
        releasedAt: Date | null;
        route: Readonly<{
            enabled: boolean;
            revokedAt: Date | null;
            verifierKind: string;
        }>;
    }>;
}>;

async function hasCurrentPluginWebhookPreEffectAuthorityTxV1(params: Readonly<{
    tx: Tx;
    accountId: string;
    current: PluginWebhookPreEffectRowV1;
    target: ClaimTargetV1;
    serverIdentityId: string;
}>): Promise<boolean> {
    const { current } = params;
    const endpoint = current.endpoint;
    if (
        endpoint.id !== current.endpointId
        || !endpoint.enabled
        || endpoint.revokedAt !== null
        || endpoint.releasedAt !== null
        || !endpoint.route.enabled
        || endpoint.route.revokedAt !== null
    ) {
        return false;
    }
    if (!(await isCurrentAuthenticatedTargetInTx({
        tx: params.tx,
        accountId: params.accountId,
        target: params.target,
        version: current.targetPluginVersion,
        serverIdentityId: params.serverIdentityId,
    }))) {
        return false;
    }
    const contribution = await resolveCurrentPluginWebhookContributionTxV1({
        tx: params.tx,
        accountId: params.accountId,
        contribution: {
            pluginId: current.targetPluginId,
            localId: current.endpointWebhookContributionId,
        },
        target: {
            materialization: params.target.materialization,
            machineInstallationId: params.target.machineInstallationId,
            pluginVersion: current.targetPluginVersion,
        },
    });
    return contribution !== null
        && contribution.handlerActionLocalId === current.endpointHandlerActionId
        && contribution.routingKind === endpoint.routingKind
        && contribution.verifierKind === endpoint.route.verifierKind;
}

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
    // Admission belongs to executionStarted. An admitted finite attempt keeps
    // its captured endpoint and lease without re-authorizing live policy.
    if (
        current.endpointId !== reference.endpoint.webhookEndpointId
        || current.endpointRevision !== reference.endpoint.revision
        || current.targetPluginId !== reference.endpoint.webhookContribution.pluginId
        || current.endpointWebhookContributionId !== reference.endpoint.webhookContribution.localId
        || current.endpointHandlerActionId !== reference.endpoint.handlerActionLocalId
        || current.endpointSourceInstanceId !== reference.endpoint.sourceInstanceId
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
                endpointId: true,
                endpointRevision: true,
                endpointWebhookContributionId: true,
                endpointHandlerActionId: true,
                endpointSourceInstanceId: true,
                targetPluginId: true,
                firstClaimAt: true,
                executionStartedAt: true,
                leaseExpiresAt: true,
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
            || !current.firstClaimAt
            || !current.leaseExpiresAt
            || current.leaseExpiresAt.getTime() <= now.getTime()
        ) {
            return PluginWebhookRenewResultV1Schema.parse({ kind: "leaseLost" });
        }
        if (current.executionStartedAt === null && !(await hasCurrentPluginWebhookPreEffectAuthorityTxV1({
            tx,
            accountId: params.accountId,
            current,
            target: params.target,
            serverIdentityId,
        }))) {
            return PluginWebhookRenewResultV1Schema.parse({ kind: "leaseLost" });
        }
        const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId, "content");
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
    }, { /* Webhook endpoint, credential and contribution authority is read before the Account fence. */ isolationLevel: "Serializable" });
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
    return await inTx(async (tx) => {
        const updated = await tx.pluginWebhookDelivery.updateMany({
            where: attemptCustodyWhereV1({
                accountId: params.accountId,
                deliveryId: params.deliveryId,
                target: params.target,
                lease: params.lease,
                now,
                execution: "started",
            }),
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
        const permitsPreExecutionContentUnavailable = params.result.kind === "deadLetter"
            && params.result.code === "content_unavailable";
        const custodyWhere = attemptCustodyWhereV1({
            accountId: params.accountId,
            deliveryId: params.deliveryId,
            target: params.target,
            lease: params.lease,
            now,
            execution: permitsPreExecutionContentUnavailable
                ? "startedOrPreExecutionContentUnavailable"
                : "started",
        });
        const current = await tx.pluginWebhookDelivery.findFirst({
            where: custodyWhere,
            select: { attemptCount: true },
        });
        if (!current) return PluginWebhookSettleResultV1Schema.parse({ kind: "leaseLost" });
        const deadLetter = params.result.kind === "deadLetter"
            || current.attemptCount >= PLUGIN_WEBHOOK_MAX_ATTEMPTS_V1;
        const updated = await tx.pluginWebhookDelivery.updateMany({
            where: custodyWhere,
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
    accountId?: string;
}> = {}): Promise<Readonly<{ requeued: number; deadLettered: number }>> {
    const now = params.now ?? new Date();
    const batchSize = params.batchSize ?? DEFAULT_RECOVERY_BATCH_SIZE_V1;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_RECOVERY_BATCH_SIZE_V1) {
        throw new TypeError("Plugin webhook claim recovery batch size must be an integer from 1 through 500");
    }
    const candidates = await db.pluginWebhookDelivery.findMany({
        where: {
            state: "claimed",
            leaseExpiresAt: { lte: now },
            ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
        },
        orderBy: [{ leaseExpiresAt: "asc" }, { id: "asc" }],
        take: batchSize,
        select: { id: true, accountId: true, targetPluginId: true, revision: true, attemptCount: true, executionStartedAt: true },
    });
    let requeued = 0;
    let deadLettered = 0;
    for (const candidate of candidates) {
        const outcome = await inTx(async (tx) => await recoverExpiredPluginWebhookClaimTxV1(tx, candidate, now));
        if (outcome === "deadLettered") deadLettered += 1;
        else if (outcome === "requeued") requeued += 1;
    }
    return { requeued, deadLettered };
}

/**
 * The one lapsed-lease transition: work that never started is offered again at once
 * without charging an attempt; started work retries after its backoff or, once
 * attempts are exhausted, dead-letters. Callers: the claimant's next claim and the
 * hourly retention pass.
 */
async function recoverExpiredPluginWebhookClaimTxV1(
    tx: Tx,
    candidate: Readonly<{
        id: string;
        accountId: string;
        targetPluginId: string;
        revision: number;
        attemptCount: number;
        executionStartedAt: Date | null;
    }>,
    now: Date,
): Promise<"requeued" | "deadLettered" | "raced"> {
    const deadLetter = candidate.executionStartedAt !== null
        && candidate.attemptCount >= PLUGIN_WEBHOOK_MAX_ATTEMPTS_V1;
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
    if (updated.count !== 1) return "raced";
    await markPluginWebhookAccountChangedInTxV1(tx, {
        accountId: candidate.accountId,
        pluginId: candidate.targetPluginId,
    });
    return deadLetter ? "deadLettered" : "requeued";
}

/**
 * Persists the dead-letter of queued work whose deadline has passed: custody expiry
 * (`metadataDeleteAt`) or a target proven offline for the maximum queued age. Claims
 * never offer such work, so persisting it is a projection step: the Account status
 * read runs it for its Account before reading, and the hourly retention pass runs it
 * for everyone else.
 */
export async function ageOverduePluginWebhookDeliveriesV1(params: Readonly<{
    now?: Date;
    batchSize?: number;
    accountId?: string;
}> = {}): Promise<Readonly<{ deadLettered: number }>> {
    const now = params.now ?? new Date();
    const batchSize = params.batchSize ?? DEFAULT_RECOVERY_BATCH_SIZE_V1;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_RECOVERY_BATCH_SIZE_V1) {
        throw new TypeError("Plugin webhook queue aging batch size must be an integer from 1 through 500");
    }
    const offlineDeadline = new Date(now.getTime() - PLUGIN_WEBHOOK_MAX_QUEUED_AGE_MS_V1);
    const candidates = await db.pluginWebhookDelivery.findMany({
        where: {
            ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
            state: "queued",
            payloadBytes: { gt: 0n },
            OR: [
                {
                    nextAttemptAt: { lte: now },
                    offlineSinceAt: { lte: offlineDeadline },
                },
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
        const retentionExpired = candidate.metadataDeleteAt.getTime() <= now.getTime();
        const transitioned = await inTx(async (tx) => {
            const updated = await tx.pluginWebhookDelivery.updateMany({
                where: {
                    id: candidate.id,
                    revision: candidate.revision,
                    state: "queued",
                    payloadBytes: { gt: 0n },
                    ...(!retentionExpired ? { nextAttemptAt: { lte: now } } : {}),
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
