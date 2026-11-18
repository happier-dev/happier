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
    it('authenticates Bitbucket raw bytes and keeps the colon event key without retaining signatures', async () => {
        const deps: PluginWebhookIngestDependenciesV1 = { ...accountEndpointDependencies(),
            findRoute: async () => ({ routeId: 'route-1', verifierKind: 'bitbucket_hmac_sha256_v1', routingKind: 'accountEndpoint', policyVersion: 1 }),
        };
        const headers = { 'x-hub-signature': signature(), 'x-request-uuid': 'delivery-bitbucket',
            'x-event-key': 'pullrequest:created', 'content-type': 'application/json' };
        await expect(ingestPluginWebhookV1({ opaqueRouteId: 'opaque-1', rawBody: BODY, headers, dependencies: deps }))
            .resolves.toMatchObject({ kind: 'accepted' });
        const stored = vi.mocked(deps.admitDelivery).mock.calls[0]![0].stored;
        const envelope = JSON.parse(new TextDecoder().decode(stored.canonicalEnvelopeBytes));
        expect(envelope.v.headers).toEqual([{ name: 'x-event-key', value: 'pullrequest:created' }]);
        expect(envelope.v.verified).toMatchObject({ verifier: 'bitbucket_hmac_sha256_v1', providerDeliveryId: 'delivery-bitbucket', eventType: 'pullrequest:created' });
        expect(new TextDecoder().decode(stored.canonicalEnvelopeBytes)).not.toContain('secret');
        for (const invalid of [undefined, ['signature'], 'sha256=wrong']) {
            await expect(ingestPluginWebhookV1({ opaqueRouteId: 'opaque-1', rawBody: BODY,
                headers: { ...headers, 'x-hub-signature': invalid }, dependencies: deps }))
                .resolves.toEqual({ kind: 'rejected', statusCode: 401, code: 'unauthorized' });
        }
        await expect(ingestPluginWebhookV1({ opaqueRouteId: 'opaque-1', rawBody: new TextEncoder().encode('{}'), headers, dependencies: deps }))
            .resolves.toEqual({ kind: 'rejected', statusCode: 401, code: 'unauthorized' });
        expect(deps.admitDelivery).toHaveBeenCalledTimes(1);
    });
    it("authenticates GitLab tokens and retains only the documented event and delivery identity", async () => {
        const base = accountEndpointDependencies();
        const deps: PluginWebhookIngestDependenciesV1 = { ...base,
            findRoute: async () => ({ routeId: 'route-1', verifierKind: 'gitlab_token_v1', routingKind: 'accountEndpoint', policyVersion: 1 }),
        };
        const headers = { 'x-gitlab-token': 'secret', 'x-gitlab-webhook-uuid': 'delivery-gitlab',
            'x-gitlab-event-uuid': 'different-shared-event', 'x-gitlab-event': 'Push Hook', 'content-type': 'application/json' };
        await expect(ingestPluginWebhookV1({ opaqueRouteId: 'opaque-1', rawBody: BODY, headers, dependencies: deps }))
            .resolves.toMatchObject({ kind: 'accepted' });
        const stored = vi.mocked(deps.admitDelivery).mock.calls[0]![0].stored;
        const envelope = JSON.parse(new TextDecoder().decode(stored.canonicalEnvelopeBytes));
        expect(envelope.v.headers).toEqual([{ name: 'x-gitlab-event', value: 'Push Hook' }]);
        expect(envelope.v.verified).toMatchObject({ verifier: 'gitlab_token_v1', providerDeliveryId: 'delivery-gitlab', eventType: 'Push Hook' });
        expect(new TextDecoder().decode(stored.canonicalEnvelopeBytes)).not.toContain('secret');
        for (const invalid of [undefined, ['secret'], ['secret', 'secret'], 'wrong']) {
            await expect(ingestPluginWebhookV1({ opaqueRouteId: 'opaque-1', rawBody: BODY,
                headers: { ...headers, 'x-gitlab-token': invalid }, dependencies: deps }))
                .resolves.toEqual({ kind: 'rejected', statusCode: 401, code: 'unauthorized' });
        }
        for (const invalid of [undefined, ['delivery-gitlab'], 'invalid delivery']) {
            await expect(ingestPluginWebhookV1({ opaqueRouteId: 'opaque-1', rawBody: BODY,
                headers: { ...headers, 'x-gitlab-webhook-uuid': invalid }, dependencies: deps }))
                .resolves.toEqual({ kind: 'rejected', statusCode: 401, code: 'unauthorized' });
        }
        expect(deps.admitDelivery).toHaveBeenCalledTimes(1);
    });
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

    function accountEndpointDependencies(): PluginWebhookIngestDependenciesV1 {
        const base = dependencies();
        return {
            ...base,
            findRoute: vi.fn(async () => ({
                routeId: "route-1",
                verifierKind: "github_hmac_sha256_v1" as const,
                routingKind: "accountEndpoint" as const,
                policyVersion: 1 as const,
            })),
            resolveEndpoint: vi.fn(async () => ({
                endpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
                revision: 2,
                accountId: "account-1",
                pluginId: "acme.github",
                webhookContributionId: "github-events",
                handlerActionId: "handle-webhook",
                sourceInstanceId: "source-1",
                routingKind: "accountEndpoint" as const,
                providerInstallationId: null,
                targetMaterialization: {
                    machineId: "machine-1",
                    materializationId: "materialization-1",
                    pluginId: "acme.github",
                },
                targetMachineInstallationId: "installation-1",
                targetPluginVersion: "1.0.0",
            })),
        };
    }

    it("verifies exact raw bytes before parsing shared-route installation identity or touching Account custody", async () => {
        const deps = dependencies();
        const reserveResolvedEndpoint = vi.fn();
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
            reserveResolvedEndpoint,
            dependencies: deps,
        })).resolves.toEqual({ kind: "rejected", statusCode: 401, code: "unauthorized" });
        expect(deps.parseInstallationId).not.toHaveBeenCalled();
        expect(deps.resolveEndpoint).not.toHaveBeenCalled();
        expect(deps.readAccount).not.toHaveBeenCalled();
        expect(deps.admitDelivery).not.toHaveBeenCalled();
        expect(reserveResolvedEndpoint).not.toHaveBeenCalled();
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

    /**
     * Tenant admission moved off the unauthenticated hop, so the ingest owner
     * is now the only place an Account endpoint's endpoint/Account sublimits
     * are charged. Without these two cases, deleting the reservation call here
     * would silently remove distributed tenant admission for every routing
     * kind while the ingress route's own tests — which supply their own ingest
     * double — stayed green.
     */
    it("charges the resolved endpoint's tenant admission before durable admission and releases it", async () => {
        const deps = accountEndpointDependencies();
        const order: string[] = [];
        const release = vi.fn(async () => { order.push("release"); });
        const reserveResolvedEndpoint = vi.fn(async () => {
            order.push("reserve");
            return { release };
        });
        vi.mocked(deps.admitDelivery).mockImplementation(async () => {
            order.push("admit");
            return { kind: "admitted" as const, deliveryId: "delivery-1" };
        });

        await expect(ingestPluginWebhookV1({
            opaqueRouteId: "opaque-1",
            rawBody: BODY,
            headers: { "x-hub-signature-256": signature(), "x-github-delivery": "delivery-guid-1" },
            reserveResolvedEndpoint,
            dependencies: deps,
        })).resolves.toEqual({ kind: "accepted", deliveryId: "delivery-1", duplicate: false });

        expect(reserveResolvedEndpoint).toHaveBeenCalledWith(expect.objectContaining({
            endpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            accountId: "account-1",
            routingKind: "accountEndpoint",
        }));
        expect(order).toEqual(["reserve", "admit", "release"]);
    });

    it("refuses the delivery without admitting it when tenant admission is exhausted", async () => {
        const deps = accountEndpointDependencies();

        await expect(ingestPluginWebhookV1({
            opaqueRouteId: "opaque-1",
            rawBody: BODY,
            headers: { "x-hub-signature-256": signature(), "x-github-delivery": "delivery-guid-1" },
            reserveResolvedEndpoint: async () => null,
            dependencies: deps,
        })).resolves.toEqual({ kind: "rejected", statusCode: 503, code: "unavailable" });

        expect(deps.readAccount).not.toHaveBeenCalled();
        expect(deps.admitDelivery).not.toHaveBeenCalled();
    });

    it("releases authenticated tenant admission when later Account custody fails", async () => {
        const deps = accountEndpointDependencies();
        const release = vi.fn(async () => {});
        vi.mocked(deps.readAccount).mockResolvedValue(null);

        await expect(ingestPluginWebhookV1({
            opaqueRouteId: "opaque-1",
            rawBody: BODY,
            headers: { "x-hub-signature-256": signature(), "x-github-delivery": "delivery-guid-1" },
            reserveResolvedEndpoint: async () => ({ release }),
            dependencies: deps,
        })).resolves.toEqual({ kind: "rejected", statusCode: 503, code: "unavailable" });

        expect(deps.admitDelivery).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(1);
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

describe("plugin webhook durable ingress owner — Sentry verifier", () => {
    const SENTRY_BODY = Uint8Array.from(Buffer.from('{"action":"assigned","data":{"issue":{"id":"1170820242"}}}', "utf8"));
    const sentrySignature = (body = SENTRY_BODY, secret = "sentry-secret") => createHmac("sha256", secret).update(body).digest("hex");

    function sentryDependencies(): PluginWebhookIngestDependenciesV1 {
        return {
            findRoute: vi.fn(async () => ({
                routeId: "route-sentry",
                verifierKind: "sentry_hmac_sha256_v1" as const,
                routingKind: "accountEndpoint" as const,
                policyVersion: 1 as const,
            })),
            readCredentials: vi.fn(async () => [{ credentialVersionId: "credential-sentry", secret: "sentry-secret" }]),
            parseInstallationId: vi.fn(() => null),
            resolveEndpoint: vi.fn(async () => ({
                endpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
                revision: 1,
                accountId: "account-1",
                pluginId: "acme.sentry",
                webhookContributionId: "sentry-events",
                handlerActionId: "handle-sentry-webhook",
                sourceInstanceId: "source-1",
                routingKind: "accountEndpoint" as const,
                providerInstallationId: null,
                targetMaterialization: {
                    machineId: "machine-1",
                    materializationId: "materialization-1",
                    pluginId: "acme.sentry",
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
            admitDelivery: vi.fn(async () => ({ kind: "admitted" as const, deliveryId: "delivery-sentry" })),
        };
    }

    const sentryHeaders = (overrides: Record<string, unknown> = {}) => ({
        "sentry-hook-signature": sentrySignature(),
        "request-id": "6f1d4c4e-2a7b-4a51-9f3e-7f4a0a5b9c11",
        "sentry-hook-resource": "issue",
        "sentry-hook-timestamp": "1761856800",
        "content-type": "application/json",
        ...overrides,
    });

    it("admits a Sentry-signed body as one verified delivery carrying the hook resource", async () => {
        const deps = sentryDependencies();
        await expect(ingestPluginWebhookV1({
            opaqueRouteId: "opaque-sentry",
            rawBody: SENTRY_BODY,
            headers: sentryHeaders(),
            now: new Date("2026-10-30T00:00:00.000Z"),
            dependencies: deps,
        })).resolves.toEqual({ kind: "accepted", deliveryId: "delivery-sentry", duplicate: false });
        expect(deps.parseInstallationId).not.toHaveBeenCalled();
        expect(deps.admitDelivery).toHaveBeenCalledTimes(1);
        expect(deps.admitDelivery).toHaveBeenCalledWith(expect.objectContaining({
            routeId: "route-sentry",
            verifierKind: "sentry_hmac_sha256_v1",
            credentialVersionId: "credential-sentry",
        }));
        const stored = vi.mocked(deps.admitDelivery).mock.calls[0]?.[0]?.stored;
        expect(JSON.parse(new TextDecoder().decode(stored!.canonicalEnvelopeBytes))).toEqual({
            t: "plain",
            v: {
                v: 1,
                receivedAtMs: Date.parse("2026-10-30T00:00:00.000Z"),
                contentType: "application/json",
                headers: [{ name: "sentry-hook-resource", value: "issue" }],
                rawBodyBytes: SENTRY_BODY.byteLength,
                rawBodyBase64: Buffer.from(SENTRY_BODY).toString("base64"),
                verified: {
                    verifier: "sentry_hmac_sha256_v1",
                    providerDeliveryId: "6f1d4c4e-2a7b-4a51-9f3e-7f4a0a5b9c11",
                    eventType: "issue",
                    credentialVersionId: "credential-sentry",
                },
            },
        });
    });

    it("refuses tampered bodies, wrong secrets, and missing signature or Request-ID before any Account custody", async () => {
        const tampered = SENTRY_BODY.slice();
        tampered[3] ^= 1;
        const cases: Array<{ rawBody: Uint8Array; headers: Record<string, unknown> }> = [
            { rawBody: tampered, headers: sentryHeaders() },
            { rawBody: SENTRY_BODY, headers: sentryHeaders({ "sentry-hook-signature": sentrySignature(SENTRY_BODY, "wrong-secret") }) },
            { rawBody: SENTRY_BODY, headers: sentryHeaders({ "sentry-hook-signature": undefined }) },
            { rawBody: SENTRY_BODY, headers: sentryHeaders({ "request-id": undefined }) },
            // A GitHub-shaped signature header never satisfies a Sentry route.
            { rawBody: SENTRY_BODY, headers: { ...sentryHeaders({ "sentry-hook-signature": undefined }), "x-hub-signature-256": `sha256=${sentrySignature()}`, "x-github-delivery": "delivery-1" } },
        ];
        for (const ingress of cases) {
            const deps = sentryDependencies();
            await expect(ingestPluginWebhookV1({ opaqueRouteId: "opaque-sentry", ...ingress, dependencies: deps }))
                .resolves.toEqual({ kind: "rejected", statusCode: 401, code: "unauthorized" });
            expect(deps.resolveEndpoint).not.toHaveBeenCalled();
            expect(deps.readAccount).not.toHaveBeenCalled();
            expect(deps.admitDelivery).not.toHaveBeenCalled();
        }
    });
});
