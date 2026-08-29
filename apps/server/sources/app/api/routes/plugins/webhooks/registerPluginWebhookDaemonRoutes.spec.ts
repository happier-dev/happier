import { describe, expect, it, vi } from "vitest";

import { createFakeRouteApp, createReplyStub, getRouteEntry, getRouteHandler } from "../../../testkit/routeHarness";
import { registerPluginWebhookDaemonRoutes } from "./registerPluginWebhookDaemonRoutes";

const TARGET = {
    materialization: { machineId: "machine-1", materializationId: "materialization-1", pluginId: "acme.github" },
    machineInstallationId: "installation-1",
};
const MACHINE = { machineId: "machine-1", machineInstallationId: "installation-1" };
const CALLER = {
    pluginId: "happier.channels",
    machineId: "machine-1",
    materializationId: "materialization-caller",
};
const CORRESPONDENCE_SETUP = {
    kind: "accountEndpointV1",
    credential: "serverGenerated",
} as const;

describe("plugin webhook daemon HTTP routes", () => {
    it("registers authenticated and feature-gated daemon operations plus plugin correspondence with strict schemas", () => {
        const app = createFakeRouteApp();
        registerPluginWebhookDaemonRoutes(app as never);

        for (const path of [
            "/v1/daemon/plugins/webhooks/claim",
            "/v1/daemon/plugins/webhooks/:deliveryId/renew",
            "/v1/daemon/plugins/webhooks/:deliveryId/complete",
            "/v1/daemon/plugins/webhooks/:deliveryId/fail",
            "/v1/plugins/webhooks/endpoints/check-correspondence",
        ]) {
            const route = getRouteEntry(app, "POST", path);
            expect(route.opts.preHandler).toEqual([app.authenticate, expect.any(Function)]);
            expect(route.opts.schema).toEqual(expect.objectContaining({ body: expect.anything(), response: expect.anything() }));
        }
    });

    it("authenticates exact current caller materialization before checking correspondence", async () => {
        const app = createFakeRouteApp();
        const checkCorrespondence = vi.fn(async () => ({
            kind: "ready" as const,
            webhookEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            revision: 1,
        }));
        const authenticateCaller = vi.fn(async () => ({ pluginId: "happier.channels" }));
        registerPluginWebhookDaemonRoutes(app as never, {
            claim: vi.fn(),
            renew: vi.fn(),
            complete: vi.fn(),
            fail: vi.fn(),
            checkCorrespondence,
            authenticateCaller,
            verifyPublisher: vi.fn(async () => ({ machineId: "machine-1", installationId: "installation-1" })),
        }, { HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: "1" });
        const reply = createReplyStub();
        const input = {
            webhookEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            webhookContribution: { pluginId: "acme.github", localId: "issues" },
            targetMaterialization: TARGET.materialization,
            sourceInstanceId: "source-1",
            setup: CORRESPONDENCE_SETUP,
        };
        const body = {
            caller: CALLER,
            input,
        };

        await getRouteHandler(app, "POST", "/v1/plugins/webhooks/endpoints/check-correspondence")({
            userId: "account-authenticated",
            method: "POST",
            url: "/v1/plugins/webhooks/endpoints/check-correspondence",
            headers: {},
            body,
        }, reply);

        expect(authenticateCaller).toHaveBeenCalledWith(expect.objectContaining({
            accountId: "account-authenticated",
            caller: body.caller,
            publisher: { machineId: "machine-1", installationId: "installation-1" },
        }));
        expect(checkCorrespondence).toHaveBeenCalledWith({
            accountId: "account-authenticated",
            callerPluginId: "happier.channels",
            input,
        });
        expect(reply.send).toHaveBeenCalledWith({
            kind: "ready",
            webhookEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            revision: 1,
        });
    });

    it("rejects correspondence when publisher proof fails", async () => {
        const input = {
            webhookEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            webhookContribution: { pluginId: "acme.github", localId: "issues" },
            targetMaterialization: TARGET.materialization,
            sourceInstanceId: "source-1",
            setup: CORRESPONDENCE_SETUP,
        };
        const app = createFakeRouteApp();
        const checkCorrespondence = vi.fn();
        registerPluginWebhookDaemonRoutes(app as never, {
            claim: vi.fn(),
            renew: vi.fn(),
            complete: vi.fn(),
            fail: vi.fn(),
            checkCorrespondence,
            verifyPublisher: vi.fn(async () => null),
            authenticateCaller: vi.fn(async () => ({ pluginId: "happier.channels" })),
        }, { HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: "1" });
        const reply = createReplyStub();

        await getRouteHandler(app, "POST", "/v1/plugins/webhooks/endpoints/check-correspondence")({
            userId: "account-authenticated",
            method: "POST",
            url: "/v1/plugins/webhooks/endpoints/check-correspondence",
            headers: {},
            body: {
                caller: CALLER,
                input,
            },
        }, reply);

        expect(reply.code).toHaveBeenCalledWith(401);
        expect(checkCorrespondence).not.toHaveBeenCalled();
    });

    it("collapses unavailable caller materialization into the bounded correspondence response", async () => {
        const app = createFakeRouteApp();
        const checkCorrespondence = vi.fn();
        registerPluginWebhookDaemonRoutes(app as never, {
            claim: vi.fn(),
            renew: vi.fn(),
            complete: vi.fn(),
            fail: vi.fn(),
            checkCorrespondence,
            verifyPublisher: vi.fn(async () => ({ machineId: "machine-1", installationId: "installation-1" })),
            authenticateCaller: vi.fn(async () => null),
        }, { HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: "1" });
        const reply = createReplyStub();

        await getRouteHandler(app, "POST", "/v1/plugins/webhooks/endpoints/check-correspondence")({
            userId: "account-authenticated",
            method: "POST",
            url: "/v1/plugins/webhooks/endpoints/check-correspondence",
            headers: {},
            body: {
                caller: CALLER,
                input: {
                    webhookEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
                    webhookContribution: { pluginId: "acme.github", localId: "issues" },
                    targetMaterialization: TARGET.materialization,
                    sourceInstanceId: "source-1",
                    setup: CORRESPONDENCE_SETUP,
                },
            },
        }, reply);

        expect(reply.code).not.toHaveBeenCalled();
        expect(reply.send).toHaveBeenCalledWith({ kind: "unavailable", code: "endpoint_unavailable" });
        expect(checkCorrespondence).not.toHaveBeenCalled();
    });

    it("rejects correspondence when the stamped caller machine differs from the publisher proof", async () => {
        const app = createFakeRouteApp();
        const authenticateCaller = vi.fn(async () => ({ pluginId: "happier.channels" }));
        const checkCorrespondence = vi.fn();
        registerPluginWebhookDaemonRoutes(app as never, {
            claim: vi.fn(),
            renew: vi.fn(),
            complete: vi.fn(),
            fail: vi.fn(),
            checkCorrespondence,
            authenticateCaller,
            verifyPublisher: vi.fn(async () => ({ machineId: "machine-1", installationId: "installation-1" })),
        }, { HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: "1" });
        const reply = createReplyStub();

        await getRouteHandler(app, "POST", "/v1/plugins/webhooks/endpoints/check-correspondence")({
            userId: "account-authenticated",
            method: "POST",
            url: "/v1/plugins/webhooks/endpoints/check-correspondence",
            headers: {},
            body: {
                caller: { ...CALLER, machineId: "machine-other" },
                input: {
                    webhookEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
                    webhookContribution: { pluginId: "acme.github", localId: "issues" },
                    targetMaterialization: TARGET.materialization,
                    sourceInstanceId: "source-1",
                    setup: CORRESPONDENCE_SETUP,
                },
            },
        }, reply);

        expect(reply.code).toHaveBeenCalledWith(401);
        expect(authenticateCaller).not.toHaveBeenCalled();
        expect(checkCorrespondence).not.toHaveBeenCalled();
    });

    it("derives Account authority from authentication and never from mutable claim input", async () => {
        const app = createFakeRouteApp();
        const claim = vi.fn(async () => ({ kind: "none" as const, retryAfterMs: 5_000 }));
        registerPluginWebhookDaemonRoutes(app as never, {
            claim,
            renew: vi.fn(),
            complete: vi.fn(),
            fail: vi.fn(),
            checkCorrespondence: vi.fn(),
            authenticateCaller: vi.fn(),
            verifyPublisher: vi.fn(async () => ({ machineId: "machine-1", installationId: "installation-1" })),
        }, { HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: "1" });
        const reply = createReplyStub();
        const body = { v: 1, policyVersion: 1, machine: MACHINE };

        await getRouteHandler(app, "POST", "/v1/daemon/plugins/webhooks/claim")({
            userId: "account-authenticated",
            body,
        }, reply);

        expect(claim).toHaveBeenCalledWith(
            expect.objectContaining({
                accountId: "account-authenticated",
                machine: MACHINE,
            }),
            { signal: expect.any(AbortSignal) },
        );
        expect(reply.headers).toEqual({ "Cache-Control": "no-store" });
        expect(reply.send).toHaveBeenCalledWith({ kind: "none", retryAfterMs: 5_000 });
    });

    it("forwards a bounded host-private Automation diagnostic only with a retry failure", async () => {
        const app = createFakeRouteApp();
        const fail = vi.fn(async () => ({ kind: "settled" as const, state: "queued" as const }));
        registerPluginWebhookDaemonRoutes(app as never, {
            claim: vi.fn(),
            renew: vi.fn(),
            complete: vi.fn(),
            fail,
            checkCorrespondence: vi.fn(),
            authenticateCaller: vi.fn(),
            verifyPublisher: vi.fn(async () => ({ machineId: "machine-1", installationId: "installation-1" })),
        }, { HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: "1" });
        const reply = createReplyStub();
        const automationAdmissionUnresolved = {
            v: 1,
            kind: "automationAdmissionUnresolved",
            totalCount: 1,
            entries: [{
                automationId: "automation-1",
                status: { kind: "blocked", reason: "capacity" },
            }],
            omittedCount: 0,
        } as const;

        await getRouteHandler(app, "POST", "/v1/daemon/plugins/webhooks/:deliveryId/fail")({
            userId: "account-authenticated",
            method: "POST",
            headers: {},
            params: { deliveryId: "delivery-1" },
            body: {
                v: 1,
                target: TARGET,
                lease: { leaseId: "lease-1", revision: 2 },
                result: { kind: "retry", code: "github.automation-unavailable" },
                automationAdmissionUnresolved,
            },
        }, reply);

        expect(fail).toHaveBeenCalledWith({
            accountId: "account-authenticated",
            deliveryId: "delivery-1",
            target: TARGET,
            lease: { leaseId: "lease-1", revision: 2 },
            result: { kind: "retry", code: "github.automation-unavailable" },
            automationAdmissionUnresolved,
        });
    });

    it("forwards only a per-request abort signal to the bounded claim", async () => {
        const app = createFakeRouteApp();
        let capturedWait: unknown;
        const claim = vi.fn(async (_params: unknown, wait: unknown) => {
            capturedWait = wait;
            return { kind: "none" as const, retryAfterMs: 5_000 };
        });
        registerPluginWebhookDaemonRoutes(app as never, {
            claim,
            renew: vi.fn(),
            complete: vi.fn(),
            fail: vi.fn(),
            checkCorrespondence: vi.fn(),
            authenticateCaller: vi.fn(),
            verifyPublisher: vi.fn(async () => ({ machineId: "machine-1", installationId: "installation-1" })),
        }, { HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: "1" });
        const reply = createReplyStub();
        const request: Record<string, unknown> = {
            userId: "account-authenticated",
            method: "POST",
            headers: {},
            body: { v: 1, policyVersion: 1, machine: MACHINE },
        };

        await getRouteHandler(app, "POST", "/v1/daemon/plugins/webhooks/claim")(request, reply);

        // The parked window is a fixed implementation constant of the claim
        // owner; the route carries no policy input except the disconnect abort.
        expect(claim).toHaveBeenCalledWith(
            expect.objectContaining({ accountId: "account-authenticated", machine: MACHINE }),
            { signal: expect.any(AbortSignal) },
        );
        expect((capturedWait as { signal?: AbortSignal }).signal?.aborted).toBe(false);
    });

    it("aborts the forwarded claim signal when the client disconnects", async () => {
        const app = createFakeRouteApp();
        let capturedWait: unknown;
        const claim = vi.fn(async (_params: unknown, wait: unknown) => {
            capturedWait = wait;
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { kind: "none" as const, retryAfterMs: 5_000 };
        });
        registerPluginWebhookDaemonRoutes(app as never, {
            claim,
            renew: vi.fn(),
            complete: vi.fn(),
            fail: vi.fn(),
            checkCorrespondence: vi.fn(),
            authenticateCaller: vi.fn(),
            verifyPublisher: vi.fn(async () => ({ machineId: "machine-1", installationId: "installation-1" })),
        }, { HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: "1" });
        const reply = createReplyStub();
        const request: Record<string, unknown> = {
            userId: "account-authenticated",
            method: "POST",
            headers: {},
            body: { v: 1, policyVersion: 1, machine: MACHINE },
        };

        await getRouteHandler(app, "POST", "/v1/daemon/plugins/webhooks/claim")(request, reply);

        const entry = getRouteEntry(app, "POST", "/v1/daemon/plugins/webhooks/claim");
        const onRequestAbort = entry.opts.onRequestAbort as ((request: unknown) => Promise<void>) | undefined;
        expect(onRequestAbort).toBeTypeOf("function");
        await onRequestAbort?.(request);

        expect((capturedWait as { signal?: AbortSignal }).signal?.aborted).toBe(true);
    });

    it("rejects a machine-installation claim unless the signed machine installation proof matches exactly", async () => {
        const app = createFakeRouteApp();
        const claim = vi.fn();
        registerPluginWebhookDaemonRoutes(app as never, {
            claim,
            renew: vi.fn(),
            complete: vi.fn(),
            fail: vi.fn(),
            checkCorrespondence: vi.fn(),
            authenticateCaller: vi.fn(),
            verifyPublisher: vi.fn(async () => ({ machineId: "machine-other", installationId: "installation-other" })),
        }, { HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: "1" });
        const reply = createReplyStub();

        await getRouteHandler(app, "POST", "/v1/daemon/plugins/webhooks/claim")({
            userId: "account-authenticated",
            method: "POST",
            headers: {},
            body: { v: 1, policyVersion: 1, machine: MACHINE },
        }, reply);

        expect(reply.code).toHaveBeenCalledWith(401);
        expect(claim).not.toHaveBeenCalled();
    });
});
