import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import type { Tx } from "@/storage/inTx";

const DAY_MS = 24 * 60 * 60 * 1_000;
const SHARED_ROUTE_TOMBSTONE_RETENTION_MS_V1 = 7 * DAY_MS;

export type PluginWebhookAccountDeletionCleanupResultV1 = Readonly<{
    deliveriesDeleted: number;
    operationsDeleted: number;
    accountEndpointsDeleted: number;
    accountRoutesDeleted: number;
    sharedEndpointsScrubbed: number;
}>;

/**
 * Transaction-local Webhooks domain hook for physical Account deletion. The
 * eventual Account-deletion owner must invoke this in the same transaction,
 * before deleting the Account row; this module is not an Account coordinator.
 */
export async function cleanupPluginWebhooksForAccountDeletionTxV1(
    tx: Tx,
    params: Readonly<{ accountId: string; now?: Date }>,
): Promise<PluginWebhookAccountDeletionCleanupResultV1> {
    const now = params.now ?? new Date();
    await acquireAccountSessionOwnerMetadataFenceInTx(tx, params.accountId);

    const endpoints = await tx.pluginWebhookEndpoint.findMany({
        where: { accountId: params.accountId },
        select: {
            id: true,
            routeId: true,
            routingKind: true,
            providerInstallationId: true,
        },
    });
    const accountEndpoints = endpoints.filter((endpoint) => endpoint.routingKind === "accountEndpoint");
    const sharedEndpoints = endpoints.filter((endpoint) => endpoint.routingKind === "providerInstallation");
    if (accountEndpoints.length + sharedEndpoints.length !== endpoints.length) {
        throw new Error("Plugin webhook Account deletion found an unknown endpoint routing kind");
    }
    if (sharedEndpoints.some((endpoint) => endpoint.providerInstallationId === null)) {
        throw new Error("Plugin webhook shared endpoint is missing canonical installation identity");
    }

    const deliveriesDeleted = (await tx.pluginWebhookDelivery.deleteMany({
        where: { accountId: params.accountId },
    })).count;
    const operationsDeleted = (await tx.pluginWebhookEndpointOperation.deleteMany({
        where: { accountId: params.accountId },
    })).count;

    const accountEndpointIds = accountEndpoints.map((endpoint) => endpoint.id);
    const accountEndpointsDeleted = accountEndpointIds.length === 0
        ? 0
        : (await tx.pluginWebhookEndpoint.deleteMany({
            where: {
                id: { in: accountEndpointIds },
                accountId: params.accountId,
                routingKind: "accountEndpoint",
            },
        })).count;
    if (accountEndpointsDeleted !== accountEndpointIds.length) {
        throw new Error("Plugin webhook Account endpoint cleanup lost endpoint currentness");
    }

    const sharedEndpointIds = sharedEndpoints.map((endpoint) => endpoint.id);
    const sharedEndpointsScrubbed = sharedEndpointIds.length === 0
        ? 0
        : (await tx.pluginWebhookEndpoint.updateMany({
            where: {
                id: { in: sharedEndpointIds },
                accountId: params.accountId,
                routingKind: "providerInstallation",
                providerInstallationId: { not: null },
            },
            data: {
                accountId: null,
                pluginId: null,
                webhookContributionId: null,
                handlerActionId: null,
                sourceInstanceId: null,
                ensureIdempotencyKey: null,
                ensureRequestFingerprint: null,
                setupKind: null,
                enabled: false,
                revision: { increment: 1 },
                revokedAt: null,
                releasedAt: now,
                tombstoneExpiresAt: new Date(now.getTime() + SHARED_ROUTE_TOMBSTONE_RETENTION_MS_V1),
                targetMachineId: null,
                targetMachineInstallationId: null,
                targetMaterializationId: null,
                targetPluginVersion: null,
                previousTargetMachineId: null,
                previousTargetMachineInstallationId: null,
                previousTargetMaterializationId: null,
                previousTargetPluginVersion: null,
            },
        })).count;
    if (sharedEndpointsScrubbed !== sharedEndpointIds.length) {
        throw new Error("Plugin webhook shared endpoint cleanup lost endpoint currentness");
    }

    const accountRouteIds = [...new Set(accountEndpoints.map((endpoint) => endpoint.routeId))];
    const accountRouteCredentialPointersCleared = accountRouteIds.length === 0
        ? 0
        : (await tx.pluginWebhookRoute.updateMany({
            where: {
                id: { in: accountRouteIds },
                routingKind: "accountEndpoint",
                endpoints: { none: {} },
            },
            data: {
                currentCredentialId: null,
                previousCredentialId: null,
            },
        })).count;
    if (accountRouteCredentialPointersCleared !== accountRouteIds.length) {
        throw new Error("Plugin webhook Account route cleanup lost credential-pointer currentness");
    }
    const accountRoutesDeleted = accountRouteIds.length === 0
        ? 0
        : (await tx.pluginWebhookRoute.deleteMany({
            where: {
                id: { in: accountRouteIds },
                routingKind: "accountEndpoint",
                endpoints: { none: {} },
            },
        })).count;
    if (accountRoutesDeleted !== accountRouteIds.length) {
        throw new Error("Plugin webhook Account route cleanup found retained route custody");
    }

    return {
        deliveriesDeleted,
        operationsDeleted,
        accountEndpointsDeleted,
        accountRoutesDeleted,
        sharedEndpointsScrubbed,
    };
}
