import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    findUnique: vi.fn(),
}));

vi.mock("@/storage/db", () => ({
    db: { pluginWebhookRoute: { findUnique: mocks.findUnique } },
}));

import { resolveActivePluginWebhookEndpointV1 } from "./routeStore";

describe("plugin webhook route exact target projection", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.findUnique.mockResolvedValue({
            enabled: true,
            revokedAt: null,
            verifierKind: "github_hmac_sha256_v1",
            routingKind: "accountEndpoint",
            operatorPluginId: null,
            operatorWebhookContributionId: null,
            accountEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            endpoints: [],
            accountEndpoint: {
                id: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
                accountId: "account-1",
                pluginId: "acme.github",
                webhookContributionId: "github-events",
                handlerActionId: "handle-webhook",
                sourceInstanceId: "source-1",
                setupKind: "githubAccountEndpointV1",
                routeId: "route-1",
                routingKind: "accountEndpoint",
                providerInstallationId: null,
                enabled: true,
                revokedAt: null,
                releasedAt: null,
                targetMachineId: "machine-1",
                targetMachineInstallationId: "installation-1",
                targetMaterializationId: "materialization-1",
                targetPluginVersion: "1.0.0",
            },
        });
    });

    it("projects only the server-scoped materialization tuple and machine installation", async () => {
        await expect(resolveActivePluginWebhookEndpointV1({
            routeId: "route-1",
            routingKind: "accountEndpoint",
        })).resolves.toMatchObject({
            targetMaterialization: {
                machineId: "machine-1",
                materializationId: "materialization-1",
                pluginId: "acme.github",
            },
            targetMachineInstallationId: "installation-1",
            targetPluginVersion: "1.0.0",
        });
    });
});
