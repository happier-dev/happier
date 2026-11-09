/**
 * Sole owner of plugin webhook routing-kind decisions.
 *
 * `routeStore` and `endpointStore` previously each branched on
 * `routingKind` versus `setupKind` and installation presence. Those branches
 * are the same concept and must not drift into competing authorities, so they
 * delegate here. This module decides routing only; it never reads the
 * database, verifies signatures, or admits deliveries.
 */
export type PluginWebhookRoutingKindV1 = "accountEndpoint" | "providerInstallation";

export function isPluginWebhookRoutingKindV1(value: unknown): value is PluginWebhookRoutingKindV1 {
    return value === "accountEndpoint" || value === "providerInstallation";
}

/**
 * Whether this routing kind requires a verified provider installation id
 * before an endpoint can be resolved. Account endpoints route by opaque route
 * id alone; shared-installation routes additionally bind the exact
 * installation.
 */
export function requiresProviderInstallationIdV1(routingKind: PluginWebhookRoutingKindV1): boolean {
    return routingKind === "providerInstallation";
}

/**
 * Whether a persisted endpoint setup belongs to a routing kind. Account
 * endpoints use `accountEndpointV1` with no installation; shared-installation
 * endpoints use `githubSharedInstallationV1` with exactly one installation.
 */
export function isEndpointSetupCompatibleWithRoutingKindV1(params: Readonly<{
    routingKind: PluginWebhookRoutingKindV1;
    setupKind: string | null;
    providerInstallationId: string | null;
}>): boolean {
    if (params.routingKind === "accountEndpoint") {
        return (params.setupKind === "accountEndpointV1" || params.setupKind === "capabilityUrlV1") && params.providerInstallationId === null;
    }
    return params.setupKind === "githubSharedInstallationV1" && params.providerInstallationId !== null;
}

/**
 * Whether a contribution setup kind may create/own this routing kind.
 * Endpoint creation (`endpointStore.ensure`) and ingest resolution share this
 * rule so a plugin cannot mint an account endpoint for a shared-installation
 * contribution or vice versa.
 */
export function isContributionSetupCompatibleWithRoutingKindV1(params: Readonly<{
    contributionRoutingKind: PluginWebhookRoutingKindV1;
    setupKind: string;
}>): boolean {
    if (params.setupKind === "accountEndpointV1" || params.setupKind === "capabilityUrlV1") return params.contributionRoutingKind === "accountEndpoint";
    if (params.setupKind === "githubSharedInstallationV1") {
        return params.contributionRoutingKind === "providerInstallation";
    }
    return false;
}
