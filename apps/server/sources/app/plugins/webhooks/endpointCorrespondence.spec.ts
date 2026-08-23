import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    readTarget: vi.fn(),
    readContribution: vi.fn(),
    endpointFindFirst: vi.fn(),
}));

vi.mock("./currentTarget", () => ({
    resolveCurrentPluginWebhookTargetTxV1: mocks.readTarget,
}));
vi.mock("./currentContribution", () => ({
    resolveCurrentPluginWebhookContributionTxV1: mocks.readContribution,
}));

import { checkCurrentPluginWebhookEndpointCorrespondenceTxV1 } from "./endpointCorrespondence";

const endpointId = "wh_ep_AAECAwQFBgcICQoLDA0ODw";
const contribution = { pluginId: "acme.github", localId: "issues" } as const;
const target = {
    machineId: "machine-1",
    materializationId: "materialization-1",
    pluginId: "acme.github",
} as const;

function tx() {
    return {
        pluginWebhookEndpoint: { findFirst: mocks.endpointFindFirst },
    } as never;
}

const accountEndpointInput = {
    webhookEndpointId: endpointId,
    webhookContribution: contribution,
    targetMaterialization: target,
    sourceInstanceId: "source-1",
    setup: { kind: "githubAccountEndpointV1", credential: "serverGenerated" },
} as const;

describe("plugin webhook endpoint correspondence", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readTarget.mockImplementation(async ({ target: requestedTarget }: {
            target: typeof target;
        }) => ({
            materialization: requestedTarget,
            machineInstallationId: "install-2",
            pluginVersion: "1.0.0",
        }));
        mocks.readContribution.mockResolvedValue({
            pluginId: contribution.pluginId,
            localId: contribution.localId,
            handlerActionLocalId: "receive",
            verifierKind: "github_hmac_sha256_v1",
            routingKind: "accountEndpoint",
        });
        mocks.endpointFindFirst.mockResolvedValue({ id: endpointId, revision: 2 });
    });

    it("reports the current endpoint revision when every authorizing fact still corresponds", async () => {
        await expect(checkCurrentPluginWebhookEndpointCorrespondenceTxV1({
            tx: tx(),
            serverIdentityId: "server-1",
            accountId: "account-1",
            input: accountEndpointInput,
        })).resolves.toEqual({ kind: "ready", webhookEndpointId: endpointId, revision: 2 });
        expect(mocks.endpointFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                id: endpointId,
                accountId: "account-1",
                sourceInstanceId: "source-1",
                setupKind: "githubAccountEndpointV1",
                providerInstallationId: null,
                targetMachineInstallationId: "install-2",
                targetPluginVersion: "1.0.0",
                handlerActionId: "receive",
                routingKind: "accountEndpoint",
                enabled: true,
                revokedAt: null,
            }),
        }));
    });

    it("returns one bounded unavailable result when any claimed fact is not the endpoint's", async () => {
        // The stub answers the query instead of a call count, so dropping any
        // one of these facts from the correspondence query fails this test.
        mocks.endpointFindFirst.mockImplementation(async (query: Readonly<{
            where: Readonly<{
                targetMachineId?: string;
                targetMaterializationId?: string;
                sourceInstanceId?: string;
                webhookContributionId?: string;
            }>;
        }>) => (
            query.where.targetMachineId === target.machineId
                && query.where.targetMaterializationId === target.materializationId
                && query.where.sourceInstanceId === accountEndpointInput.sourceInstanceId
                && query.where.webhookContributionId === contribution.localId
                ? { id: endpointId, revision: 2 }
                : null
        ));

        await expect(checkCurrentPluginWebhookEndpointCorrespondenceTxV1({
            tx: tx(),
            serverIdentityId: "server-1",
            accountId: "account-1",
            input: accountEndpointInput,
        })).resolves.toMatchObject({ kind: "ready" });

        for (const mismatch of [
            { targetMaterialization: { ...target, machineId: "wrong-machine" } },
            { targetMaterialization: { ...target, materializationId: "wrong-materialization" } },
            { sourceInstanceId: "source-2" },
            { webhookContribution: { ...contribution, localId: "other-webhook" } },
        ]) {
            await expect(checkCurrentPluginWebhookEndpointCorrespondenceTxV1({
                tx: tx(),
                serverIdentityId: "server-1",
                accountId: "account-1",
                input: { ...accountEndpointInput, ...mismatch },
            })).resolves.toEqual({ kind: "unavailable", code: "endpoint_unavailable" });
        }
    });

    it("refuses correspondence once the target or contribution is no longer current", async () => {
        mocks.readTarget.mockResolvedValueOnce(null);
        await expect(checkCurrentPluginWebhookEndpointCorrespondenceTxV1({
            tx: tx(),
            serverIdentityId: "server-1",
            accountId: "account-1",
            input: accountEndpointInput,
        })).resolves.toEqual({ kind: "unavailable", code: "endpoint_unavailable" });
        expect(mocks.endpointFindFirst).not.toHaveBeenCalled();

        mocks.readContribution.mockResolvedValueOnce(null);
        await expect(checkCurrentPluginWebhookEndpointCorrespondenceTxV1({
            tx: tx(),
            serverIdentityId: "server-1",
            accountId: "account-1",
            input: accountEndpointInput,
        })).resolves.toEqual({ kind: "unavailable", code: "endpoint_unavailable" });
        expect(mocks.endpointFindFirst).not.toHaveBeenCalled();
    });

    it("requires the final shared-installation setup identity to match the ensured endpoint", async () => {
        mocks.readContribution.mockResolvedValue({
            pluginId: contribution.pluginId,
            localId: contribution.localId,
            handlerActionLocalId: "receive",
            verifierKind: "github_hmac_sha256_v1",
            routingKind: "providerInstallation",
        });
        mocks.endpointFindFirst.mockImplementation(async (input: Readonly<{
            where: Readonly<{ setupKind?: string; providerInstallationId?: string | null }>;
        }>) => (
            input.where.setupKind === "githubSharedInstallationV1"
                && input.where.providerInstallationId === "123"
                ? { id: endpointId, revision: 2 }
                : null
        ));

        await expect(checkCurrentPluginWebhookEndpointCorrespondenceTxV1({
            tx: tx(),
            serverIdentityId: "server-1",
            accountId: "account-1",
            input: {
                ...accountEndpointInput,
                setup: {
                    kind: "githubSharedInstallationV1",
                    installationId: "123",
                    installationAuthorizationRef: "authorization-a",
                },
            },
        })).resolves.toMatchObject({ kind: "ready" });
        await expect(checkCurrentPluginWebhookEndpointCorrespondenceTxV1({
            tx: tx(),
            serverIdentityId: "server-1",
            accountId: "account-1",
            input: {
                ...accountEndpointInput,
                setup: {
                    kind: "githubSharedInstallationV1",
                    installationId: "456",
                    installationAuthorizationRef: "authorization-b",
                },
            },
        })).resolves.toEqual({ kind: "unavailable", code: "endpoint_unavailable" });
    });
});
