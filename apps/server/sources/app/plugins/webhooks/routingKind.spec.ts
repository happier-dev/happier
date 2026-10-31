import { describe, expect, it } from "vitest";

import {
    isContributionSetupCompatibleWithRoutingKindV1,
    isEndpointSetupCompatibleWithRoutingKindV1,
    isPluginWebhookRoutingKindV1,
    requiresProviderInstallationIdV1,
} from "./routingKind";

describe("plugin webhook routing-kind owner", () => {
    it("accepts only the two canonical routing kinds", () => {
        expect(isPluginWebhookRoutingKindV1("accountEndpoint")).toBe(true);
        expect(isPluginWebhookRoutingKindV1("providerInstallation")).toBe(true);
        expect(isPluginWebhookRoutingKindV1("sharedApp")).toBe(false);
        expect(isPluginWebhookRoutingKindV1(null)).toBe(false);
    });

    it("requires an installation id only for shared-installation routes", () => {
        expect(requiresProviderInstallationIdV1("providerInstallation")).toBe(true);
        expect(requiresProviderInstallationIdV1("accountEndpoint")).toBe(false);
    });

    it("keeps account and shared-installation setups on their own routing kind", () => {
        expect(isEndpointSetupCompatibleWithRoutingKindV1({
            routingKind: "accountEndpoint",
            setupKind: "accountEndpointV1",
            providerInstallationId: null,
        })).toBe(true);
        expect(isEndpointSetupCompatibleWithRoutingKindV1({
            routingKind: "accountEndpoint",
            setupKind: "githubSharedInstallationV1",
            providerInstallationId: "123",
        })).toBe(false);
        expect(isEndpointSetupCompatibleWithRoutingKindV1({
            routingKind: "providerInstallation",
            setupKind: "githubSharedInstallationV1",
            providerInstallationId: "123",
        })).toBe(true);
        expect(isEndpointSetupCompatibleWithRoutingKindV1({
            routingKind: "providerInstallation",
            setupKind: "accountEndpointV1",
            providerInstallationId: null,
        })).toBe(false);
        // A shared-installation endpoint without an installation never routes.
        expect(isEndpointSetupCompatibleWithRoutingKindV1({
            routingKind: "providerInstallation",
            setupKind: "githubSharedInstallationV1",
            providerInstallationId: null,
        })).toBe(false);
    });

    it("keeps contribution setup kinds on their own routing kind", () => {
        expect(isContributionSetupCompatibleWithRoutingKindV1({
            contributionRoutingKind: "accountEndpoint",
            setupKind: "accountEndpointV1",
        })).toBe(true);
        expect(isContributionSetupCompatibleWithRoutingKindV1({
            contributionRoutingKind: "providerInstallation",
            setupKind: "githubSharedInstallationV1",
        })).toBe(true);
        expect(isContributionSetupCompatibleWithRoutingKindV1({
            contributionRoutingKind: "accountEndpoint",
            setupKind: "githubSharedInstallationV1",
        })).toBe(false);
        expect(isContributionSetupCompatibleWithRoutingKindV1({
            contributionRoutingKind: "providerInstallation",
            setupKind: "accountEndpointV1",
        })).toBe(false);
    });

});
