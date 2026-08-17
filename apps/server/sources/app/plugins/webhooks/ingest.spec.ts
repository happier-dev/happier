import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
    admitVerifiedPluginWebhookV1,
    ingestPluginWebhookV1,
    preparePluginWebhookSignatureVerifierV1,
    type PluginWebhookIngestDependenciesV1,
} from "./ingest";

const BODY = Uint8Array.from(Buffer.from('{"installation":{"id":123}}', "utf8"));
const signature = (body = BODY) => `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;

describe("plugin webhook durable ingress owner", () => {
    function dependencies(): PluginWebhookIngestDependenciesV1 {
        return {
            findRoute: vi.fn(async () => ({
                routeId: "route-1",
                verifierKind: "github_hmac_sha256_v1" as const,
                routingKind: "providerInstallation" as const,
                policyVersion: 1 as const,
            })),
            readCredentials: vi.fn(async () => [{ credentialVersionId: "credential-1", secret: "secret" }]),
            parseInstallationId: vi.fn(() => "123"),
            resolveEndpoint: vi.fn(async () => ({
                endpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
                revision: 2,
                accountId: "account-1",
                pluginId: "acme.github",
                webhookContributionId: "github-events",
                handlerActionId: "handle-webhook",
                sourceInstanceId: "source-1",
                routingKind: "providerInstallation" as const,
                providerInstallationId: "123",
                targetMaterialization: {
                    machineId: "machine-1",
                    materializationId: "materialization-1",
                    pluginId: "acme.github",
                },
                targetMachineInstallationId: "installation-1",
                targetPluginVersion: "1.0.0",
            })),
            readAccount: vi.fn(async () => ({
                publicKey: null,
                encryptionMode: "plain",
                contentPublicKey: null,
                contentPublicKeySig: null,
            })),
            admitDelivery: vi.fn(async () => ({ kind: "admitted" as const, deliveryId: "delivery-1" })),
        };
    }

    it("verifies exact raw bytes before parsing shared-route installation identity or touching Account custody", async () => {
        const deps = dependencies();
        await expect(ingestPluginWebhookV1({
            opaqueRouteId: "opaque-1",
            rawBody: BODY,
            headers: {
                "x-hub-signature-256": "sha256=" + "0".repeat(64),
                "x-github-delivery": "delivery-guid-1",
                "x-github-event": "issues",
                "content-type": "application/json; charset=utf-8",
            },
            now: new Date("2026-08-10T00:00:00.000Z"),
            dependencies: deps,
        })).resolves.toEqual({ kind: "rejected", statusCode: 401, code: "unauthorized" });
        expect(deps.parseInstallationId).not.toHaveBeenCalled();
        expect(deps.resolveEndpoint).not.toHaveBeenCalled();
        expect(deps.readAccount).not.toHaveBeenCalled();
        expect(deps.admitDelivery).not.toHaveBeenCalled();
    });

    it("feeds every raw chunk through the prepared verifier before parsing or durable admission", async () => {
        const deps = dependencies();
        const headers = {
            "x-hub-signature-256": signature(),
            "x-github-delivery": "delivery-guid-1",
            "x-github-event": "issues",
            "content-type": "application/json",
        };
        const prepared = await preparePluginWebhookSignatureVerifierV1({
            opaqueRouteId: "opaque-1",
            headers,
            now: new Date("2026-08-10T00:00:00.000Z"),
            dependencies: deps,
        });
        if (prepared.kind !== "ready") throw new Error("expected prepared verifier");

        prepared.verifier.update(BODY.subarray(0, 7));
        prepared.verifier.update(BODY.subarray(7));
        expect(deps.parseInstallationId).not.toHaveBeenCalled();

        const verification = prepared.verifier.verify();
        expect(verification).toMatchObject({
            providerDeliveryId: "delivery-guid-1",
            credentialVersionId: "credential-1",
            route: { routeId: "route-1" },
        });
        if (!verification) throw new Error("expected verified signature");

        await expect(admitVerifiedPluginWebhookV1({
            verification,
            rawBody: BODY,
            headers,
            now: new Date("2026-08-10T00:00:00.000Z"),
            dependencies: deps,
        })).resolves.toEqual({ kind: "accepted", deliveryId: "delivery-1", duplicate: false });
        expect(deps.parseInstallationId).toHaveBeenCalledWith(BODY);
    });

    it("builds the explicit bounded envelope and reports accepted only after durable admission", async () => {
        const deps = dependencies();
        const deadlineAtMs = Date.now() + 8_000;
        const ingress = {
            opaqueRouteId: "opaque-1",
            rawBody: BODY,
            headers: {
                "x-hub-signature-256": signature(),
                "x-github-delivery": "delivery-guid-1",
                "x-github-event": "issues",
                "content-type": "application/json; charset=utf-8",
            },
            now: new Date("2026-08-10T00:00:00.000Z"),
            deadlineAtMs,
            dependencies: deps,
        };
        await expect(ingestPluginWebhookV1(ingress)).resolves.toEqual({ kind: "accepted", deliveryId: "delivery-1", duplicate: false });
        expect(deps.parseInstallationId).toHaveBeenCalledWith(BODY);
        expect(deps.resolveEndpoint).toHaveBeenCalledWith(expect.objectContaining({ providerInstallationId: "123" }));
        expect(deps.admitDelivery).toHaveBeenCalledWith(expect.objectContaining({
            endpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            expectedEndpointRevision: 2,
            routeId: "route-1",
            verifierKind: "github_hmac_sha256_v1",
            deliveryIdentityDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
            stored: expect.objectContaining({
                canonicalEnvelopeBytes: expect.any(Uint8Array),
            }),
            deadlineAtMs,
        }));
        const stored = vi.mocked(deps.admitDelivery).mock.calls[0]?.[0]?.stored;
        expect(stored).toBeDefined();
        expect(JSON.parse(new TextDecoder().decode(stored!.canonicalEnvelopeBytes))).toEqual({
            t: "plain",
            v: expect.objectContaining({
                rawBodyBase64: Buffer.from(BODY).toString("base64"),
                verified: expect.objectContaining({
                    providerDeliveryId: "delivery-guid-1",
                    eventType: "issues",
                    credentialVersionId: "credential-1",
                }),
            }),
        });
    });

    it("fails closed on malformed identity, missing encryption binding, and queue admission rejection", async () => {
        const malformed = dependencies();
        await expect(ingestPluginWebhookV1({
            opaqueRouteId: "opaque-1",
            rawBody: BODY,
            headers: { "x-hub-signature-256": signature(), "x-github-delivery": "bad value" },
            dependencies: malformed,
        })).resolves.toEqual({ kind: "rejected", statusCode: 401, code: "unauthorized" });

        const unavailable: PluginWebhookIngestDependenciesV1 = {
            ...dependencies(),
            admitDelivery: vi.fn(async () => ({ kind: "quotaExceeded" as const })),
        };
        await expect(ingestPluginWebhookV1({
            opaqueRouteId: "opaque-1",
            rawBody: BODY,
            headers: { "x-hub-signature-256": signature(), "x-github-delivery": "delivery-guid-1" },
            dependencies: unavailable,
        })).resolves.toEqual({ kind: "rejected", statusCode: 503, code: "unavailable" });
    });
});
