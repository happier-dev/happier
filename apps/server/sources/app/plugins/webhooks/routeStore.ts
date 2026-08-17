import type { PluginMachineMaterializationRefV1 } from "@happier-dev/protocol";

import { db } from "@/storage/db";

type PluginWebhookRoutingKindV1 = "accountEndpoint" | "providerInstallation";

export type ActivePluginWebhookRouteV1 = Readonly<{
    routeId: string;
    verifierKind: "github_hmac_sha256_v1";
    routingKind: PluginWebhookRoutingKindV1;
    policyVersion: 1;
}>;

export type ActivePluginWebhookEndpointV1 = Readonly<{
    endpointId: string;
    revision: number;
    accountId: string;
    pluginId: string;
    webhookContributionId: string;
    handlerActionId: string;
    sourceInstanceId: string;
    routingKind: PluginWebhookRoutingKindV1;
    providerInstallationId: string | null;
    targetMaterialization: PluginMachineMaterializationRefV1;
    targetMachineInstallationId: string;
    targetPluginVersion: string;
}>;

const ENDPOINT_ROUTE_SELECT_V1 = {
    id: true,
    accountId: true,
    pluginId: true,
    webhookContributionId: true,
    handlerActionId: true,
    sourceInstanceId: true,
    setupKind: true,
    routeId: true,
    routingKind: true,
    providerInstallationId: true,
    revision: true,
    enabled: true,
    revokedAt: true,
    releasedAt: true,
    targetMachineId: true,
    targetMachineInstallationId: true,
    targetMaterializationId: true,
    targetPluginVersion: true,
} as const;

export async function findActivePluginWebhookRouteV1(opaqueRouteId: string): Promise<ActivePluginWebhookRouteV1 | null> {
    const route = await db.pluginWebhookRoute.findUnique({
        where: { opaqueRouteId },
        select: {
            id: true,
            verifierKind: true,
            routingKind: true,
            policyVersion: true,
            enabled: true,
            revokedAt: true,
        },
    });
    if (
        !route
        || !route.enabled
        || route.revokedAt !== null
        || route.verifierKind !== "github_hmac_sha256_v1"
        || (route.routingKind !== "accountEndpoint" && route.routingKind !== "providerInstallation")
        || route.policyVersion !== 1
    ) {
        return null;
    }
    return {
        routeId: route.id,
        verifierKind: route.verifierKind,
        routingKind: route.routingKind,
        policyVersion: 1,
    };
}

function projectActiveEndpointV1(
    endpoint: Awaited<ReturnType<typeof readEndpointForRouteV1>>,
    routingKind: PluginWebhookRoutingKindV1,
): ActivePluginWebhookEndpointV1 | null {
    if (
        !endpoint
        || !endpoint.enabled
        || endpoint.revokedAt !== null
        || endpoint.releasedAt !== null
        || endpoint.routingKind !== routingKind
        || endpoint.accountId === null
        || endpoint.pluginId === null
        || endpoint.webhookContributionId === null
        || endpoint.handlerActionId === null
        || endpoint.sourceInstanceId === null
        || endpoint.targetMachineId === null
        || endpoint.targetMachineInstallationId === null
        || endpoint.targetMaterializationId === null
        || endpoint.targetPluginVersion === null
    ) {
        return null;
    }
    if (
        (routingKind === "accountEndpoint"
            && (endpoint.setupKind !== "githubAccountEndpointV1" || endpoint.providerInstallationId !== null))
        || (routingKind === "providerInstallation"
            && (endpoint.setupKind !== "githubSharedInstallationV1" || endpoint.providerInstallationId === null))
    ) {
        return null;
    }
    return {
        endpointId: endpoint.id,
        revision: endpoint.revision,
        accountId: endpoint.accountId,
        pluginId: endpoint.pluginId,
        webhookContributionId: endpoint.webhookContributionId,
        handlerActionId: endpoint.handlerActionId,
        sourceInstanceId: endpoint.sourceInstanceId,
        routingKind,
        providerInstallationId: endpoint.providerInstallationId,
        targetMaterialization: {
            machineId: endpoint.targetMachineId,
            materializationId: endpoint.targetMaterializationId,
            pluginId: endpoint.pluginId,
        },
        targetMachineInstallationId: endpoint.targetMachineInstallationId,
        targetPluginVersion: endpoint.targetPluginVersion,
    };
}

async function readEndpointForRouteV1(routeId: string, routingKind: PluginWebhookRoutingKindV1, providerInstallationId?: string) {
    const route = await db.pluginWebhookRoute.findUnique({
        where: { id: routeId },
        select: {
            enabled: true,
            revokedAt: true,
            verifierKind: true,
            routingKind: true,
            operatorPluginId: true,
            operatorWebhookContributionId: true,
            accountEndpointId: true,
            accountEndpoint: { select: ENDPOINT_ROUTE_SELECT_V1 },
            endpoints: {
                where: { providerInstallationId: providerInstallationId ?? null },
                take: 2,
                select: ENDPOINT_ROUTE_SELECT_V1,
            },
        },
    });
    if (
        !route
        || !route.enabled
        || route.revokedAt !== null
        || route.verifierKind !== "github_hmac_sha256_v1"
        || route.routingKind !== routingKind
    ) {
        return null;
    }

    if (routingKind === "accountEndpoint") {
        if (
            providerInstallationId !== undefined
            || route.operatorPluginId !== null
            || route.operatorWebhookContributionId !== null
            || route.accountEndpointId === null
            || route.accountEndpoint?.id !== route.accountEndpointId
            || route.accountEndpoint.routeId !== routeId
        ) {
            return null;
        }
        return route.accountEndpoint;
    }

    if (
        providerInstallationId === undefined
        || providerInstallationId.length === 0
        || route.accountEndpointId !== null
        || route.operatorPluginId === null
        || route.operatorWebhookContributionId === null
        || route.endpoints.length !== 1
    ) {
        return null;
    }
    const endpoint = route.endpoints[0];
    if (
        endpoint.routeId !== routeId
        || endpoint.providerInstallationId !== providerInstallationId
        || endpoint.pluginId !== route.operatorPluginId
        || endpoint.webhookContributionId !== route.operatorWebhookContributionId
    ) {
        return null;
    }
    return endpoint;
}

export async function resolveActivePluginWebhookEndpointV1(params: Readonly<{
    routeId: string;
    routingKind: PluginWebhookRoutingKindV1;
    providerInstallationId?: string;
}>): Promise<ActivePluginWebhookEndpointV1 | null> {
    const endpoint = await readEndpointForRouteV1(
        params.routeId,
        params.routingKind,
        params.providerInstallationId,
    );
    return projectActiveEndpointV1(endpoint, params.routingKind);
}
