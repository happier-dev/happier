import type { PluginWebhookEndpointReadinessV1 } from "@happier-dev/protocol";

/**
 * The facts that decide whether the binding itself can carry a delivery at
 * all: the endpoint and its route exist and are live, and the exact frozen
 * target is currently claimable.
 */
export type PluginWebhookEndpointBindingFactsV1 = Readonly<{
    endpointEnabled: boolean;
    endpointRevokedAt: Date | null;
    routeEnabled: boolean;
    routeRevokedAt: Date | null;
    /**
     * Whether the endpoint's exact frozen target is currently claimable. Every
     * caller resolves it: there is no "unknown" arm, because an unresolved
     * target that projected as `ready` would report an undeliverable binding as
     * a working delivery path.
     */
    targetStatus: "current" | "unavailable";
}>;

export type PluginWebhookEndpointBindingAvailabilityV1 =
    | "available"
    | Extract<PluginWebhookEndpointReadinessV1, "routeUnavailable" | "targetUnavailable">;

export type PluginWebhookEndpointReadinessFactsV1 = PluginWebhookEndpointBindingFactsV1 & Readonly<{
    /**
     * The one durable provider-confirmation fact, written by the delivery owner
     * when this binding admits a signature-verified provider delivery under the
     * route's *current* credential, and cleared again by credential rotation.
     */
    providerConfirmedAt: Date | null;
    /**
     * Response-scoped: an ensure rejoin can no longer return the one-time
     * generated secret its creating response disclosed, so provider setup
     * cannot proceed until the user rotates the credential. Read and Account
     * status never disclose a secret, so they never set this.
     */
    oneTimeCredentialDisclosureLost: boolean;
}>;

/**
 * Whether this binding can carry a delivery at all.
 *
 * This is the persistence-correspondence half of readiness: endpoint and route
 * existence/liveness plus exact target currentness. Feature attachment
 * consumes it directly, because whether the user has finished configuring the
 * provider is setup attention rather than a persistence fact — gating
 * attachment on it would block first-time authoring behind a delivery that
 * cannot arrive before the Automation exists.
 */
export function projectPluginWebhookEndpointBindingAvailabilityV1(
    facts: PluginWebhookEndpointBindingFactsV1,
): PluginWebhookEndpointBindingAvailabilityV1 {
    if (
        !facts.endpointEnabled
        || facts.endpointRevokedAt !== null
        || !facts.routeEnabled
        || facts.routeRevokedAt !== null
    ) return "routeUnavailable";
    return facts.targetStatus === "unavailable" ? "targetUnavailable" : "available";
}

/**
 * The single readiness decision for a generic webhook endpoint binding.
 *
 * `ensure` (create and rejoin), `read`, and the Account status projection all
 * derive readiness here, so an enabled endpoint is never presented as a
 * working delivery path before a verified provider delivery proved the current
 * credential. It layers provider-setup attention on top of the one binding
 * availability projection that feature attachment also consumes, so no
 * Automation, Channel, or UI consumer keeps a second readiness rule.
 */
export function projectPluginWebhookEndpointReadinessV1(
    facts: PluginWebhookEndpointReadinessFactsV1,
): PluginWebhookEndpointReadinessV1 {
    const availability = projectPluginWebhookEndpointBindingAvailabilityV1(facts);
    if (availability !== "available") return availability;
    if (facts.providerConfirmedAt !== null) return "ready";
    return facts.oneTimeCredentialDisclosureLost
        ? "credentialDisclosureLost"
        : "providerConfirmationRequired";
}
