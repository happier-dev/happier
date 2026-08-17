import {
    PluginWebhookAccountStatusResultV1Schema,
    PluginWebhookAutomationAdmissionUnresolvedV1Schema,
    type PluginWebhookAccountStatusRequestV1,
    type PluginWebhookAccountStatusResultV1,
} from "@happier-dev/protocol";

import { resolveCurrentClaimablePluginMachineMaterializationTx } from "@/app/plugins/availability/operations";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { resolveConfiguredCanonicalServerUrl } from "@/app/serverUrls/effectiveServerUrls";
import { inTx } from "@/storage/inTx";

import { formatPluginWebhookEndpointPublicUrlV1 } from "./endpointStore";

export async function readPluginWebhookAccountStatusV1(params: Readonly<{
    accountId: string;
    input: PluginWebhookAccountStatusRequestV1;
}>): Promise<PluginWebhookAccountStatusResultV1> {
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);
    const publicBaseUrl = resolveConfiguredCanonicalServerUrl(process.env);
    if (!publicBaseUrl) throw new Error("Plugin webhook public URL is unavailable");
    return await inTx(async (tx) => {
        const rows = await tx.pluginWebhookEndpoint.findMany({
            where: {
                accountId: params.accountId,
                ...(params.input.endpointCursor ? { id: { gt: params.input.endpointCursor } } : {}),
            },
            orderBy: { id: "asc" },
            take: params.input.pageSize + 1,
            select: {
                id: true,
                revision: true,
                pluginId: true,
                webhookContributionId: true,
                sourceInstanceId: true,
                routingKind: true,
                enabled: true,
                revokedAt: true,
                createdAt: true,
                targetMachineId: true,
                targetMachineInstallationId: true,
                targetMaterializationId: true,
                targetPluginVersion: true,
                previousTargetMachineId: true,
                previousTargetMachineInstallationId: true,
                previousTargetMaterializationId: true,
                previousTargetPluginVersion: true,
                route: {
                    select: {
                        opaqueRouteId: true,
                        enabled: true,
                        revokedAt: true,
                        previousCredential: {
                            select: { credentialVersionId: true, acceptUntil: true },
                        },
                    },
                },
            },
        });
        const page = rows.slice(0, params.input.pageSize);
        const endpointIds = page.map((row) => row.id);
        const counts = endpointIds.length === 0 ? [] : await tx.pluginWebhookDelivery.groupBy({
            by: ["endpointId", "state", "attemptCount"],
            where: { accountId: params.accountId, endpointId: { in: endpointIds } },
            _count: { _all: true },
            _min: { receivedAt: true },
        });
        const transferCounts = endpointIds.length === 0 ? [] : await tx.pluginWebhookDelivery.groupBy({
            by: [
                "endpointId",
                "targetMachineId",
                "targetMachineInstallationId",
                "targetMaterializationId",
                "targetPluginId",
                "targetPluginVersion",
            ],
            where: {
                accountId: params.accountId,
                endpointId: { in: endpointIds },
                state: { in: ["queued", "dead_letter"] },
                payloadBytes: { gt: 0n },
            },
            _count: { _all: true },
        });
        const endpoints = [];
        for (const row of page) {
            if (
                row.pluginId === null
                || row.webhookContributionId === null
                || row.sourceInstanceId === null
                || row.targetMachineId === null
                || row.targetMachineInstallationId === null
                || row.targetMaterializationId === null
                || row.targetPluginVersion === null
                || (row.routingKind !== "accountEndpoint" && row.routingKind !== "providerInstallation")
            ) continue;
            const current = await resolveCurrentClaimablePluginMachineMaterializationTx({
                tx,
                accountId: params.accountId,
                serverIdentityId,
                machineId: row.targetMachineId,
                machineInstallationId: row.targetMachineInstallationId,
                materializationId: row.targetMaterializationId,
                pluginId: row.pluginId,
                version: row.targetPluginVersion,
                requiredMachineOperationCapability: "pluginWebhookClaim",
            });
            const endpointCounts = counts.filter((count) => count.endpointId === row.id);
            const oldest = endpointCounts
                .filter((count) => count.state === "queued" || count.state === "claimed")
                .map((count) => count._min.receivedAt?.getTime() ?? null)
                .filter((value): value is number => value !== null)
                .sort((left, right) => left - right)[0] ?? null;
            const count = (state: string, predicate: (attemptCount: number) => boolean = () => true) => endpointCounts
                .filter((item) => item.state === state && predicate(item.attemptCount))
                .reduce((total, item) => total + item._count._all, 0);
            const eligibleTransferCount = row.previousTargetMachineId
                && row.previousTargetMachineInstallationId
                && row.previousTargetMaterializationId
                && row.previousTargetPluginVersion
                ? transferCounts
                    .filter((item) => (
                        item.endpointId === row.id
                        && item.targetMachineId === row.previousTargetMachineId
                        && item.targetMachineInstallationId === row.previousTargetMachineInstallationId
                        && item.targetMaterializationId === row.previousTargetMaterializationId
                        && item.targetPluginId === row.pluginId
                        && item.targetPluginVersion === row.previousTargetPluginVersion
                    ))
                    .reduce((total, item) => total + item._count._all, 0)
                : 0;
            const routeAvailable = row.enabled && row.revokedAt === null && row.route.enabled && row.route.revokedAt === null;
            endpoints.push({
                webhookEndpointId: row.id,
                revision: row.revision,
                contribution: { pluginId: row.pluginId, localId: row.webhookContributionId },
                targetMaterialization: {
                    machineId: row.targetMachineId,
                    materializationId: row.targetMaterializationId,
                    pluginId: row.pluginId,
                },
                sourceInstanceId: row.sourceInstanceId,
                routing: row.routingKind,
                readiness: !routeAvailable
                    ? "routeUnavailable" as const
                    : current.kind === "current"
                        ? "ready" as const
                        : "targetUnavailable" as const,
                targetStatus: current.kind === "current" ? "current" as const : "unavailable" as const,
                publicUrl: formatPluginWebhookEndpointPublicUrlV1(publicBaseUrl, row.route.opaqueRouteId),
                createdAt: row.createdAt.getTime(),
                ...(row.revokedAt ? { revokedAt: row.revokedAt.getTime() } : {}),
                queue: {
                    queued: count("queued", (attempts) => attempts === 0),
                    retrying: count("queued", (attempts) => attempts > 0),
                    claimed: count("claimed"),
                    deadLetter: count("dead_letter"),
                    oldestPendingAtMs: oldest,
                },
                ...(eligibleTransferCount > 0 && row.previousTargetMachineId && row.previousTargetMaterializationId ? {
                    pendingTargetTransfer: {
                        previousTargetMaterialization: {
                            machineId: row.previousTargetMachineId,
                            materializationId: row.previousTargetMaterializationId,
                            pluginId: row.pluginId,
                        },
                        eligibleDeliveryCount: eligibleTransferCount,
                    },
                } : {}),
                ...(row.routingKind === "accountEndpoint" && row.route.previousCredential?.acceptUntil ? {
                    credentialRotation: {
                        previousCredentialVersionId: row.route.previousCredential.credentialVersionId,
                        previousAcceptUntilMs: row.route.previousCredential.acceptUntil.getTime(),
                    },
                } : {}),
            });
        }
        const deadLetters = params.input.deadLetterPageSize === 0 ? [] : await tx.pluginWebhookDelivery.findMany({
            where: { accountId: params.accountId, state: "dead_letter", deadLetteredAt: { not: null } },
            orderBy: [{ deadLetteredAt: "desc" }, { id: "asc" }],
            take: params.input.deadLetterPageSize,
            select: {
                id: true,
                endpointId: true,
                revision: true,
                deliveryIdentityDigest: true,
                lastErrorCode: true,
                automationAdmissionUnresolved: true,
                attemptCount: true,
                replayCount: true,
                receivedAt: true,
                deadLetteredAt: true,
                targetMachineId: true,
                targetMaterializationId: true,
                targetPluginId: true,
            },
        });
        return PluginWebhookAccountStatusResultV1Schema.parse({
            endpoints,
            nextEndpointCursor: rows.length > params.input.pageSize ? page.at(-1)?.id ?? null : null,
            deadLetters: deadLetters.flatMap((row) => row.deadLetteredAt ? [{
                deliveryId: row.id,
                webhookEndpointId: row.endpointId,
                revision: row.revision,
                deliveryIdentityDigestPrefix: row.deliveryIdentityDigest.slice(0, 12),
                errorCode: row.lastErrorCode,
                attemptCount: row.attemptCount,
                replayCount: row.replayCount,
                receivedAtMs: row.receivedAt.getTime(),
                deadLetteredAtMs: row.deadLetteredAt.getTime(),
                targetMaterialization: {
                    machineId: row.targetMachineId,
                    materializationId: row.targetMaterializationId,
                    pluginId: row.targetPluginId,
                },
                automationAdmissionUnresolved: row.automationAdmissionUnresolved === null
                    ? null
                    : PluginWebhookAutomationAdmissionUnresolvedV1Schema.parse(row.automationAdmissionUnresolved),
            }] : []),
        });
    });
}
