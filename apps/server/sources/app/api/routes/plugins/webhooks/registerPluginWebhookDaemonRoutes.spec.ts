import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PluginWebhookEndpointConvergeTargetInputV1Schema } from "@happier-dev/protocol/plugins/webhooks/endpointV1";

import { createFakeRouteApp, createReplyStub as createBaseReplyStub, getRouteEntry, getRouteHandler } from "../../../testkit/routeHarness";
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

function createReplyStub() {
    // Node's response lifecycle is the transport boundary missing from the
    // generic route fixture; retain its canonical send/status behavior.
    return Object.assign(createBaseReplyStub(), {
        raw: Object.assign(new EventEmitter(), { writableFinished: false }),
    });
}

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
            "/v1/plugins/webhooks/endpoints/converge-target",
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
            convergeTarget: vi.fn(),
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
            convergeTarget: vi.fn(),
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
            convergeTarget: vi.fn(),
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
            convergeTarget: vi.fn(),
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

    /**
     * Target convergence is a mutation, so it must reach the endpoint owner
     * through exactly the same publisher-proof and current-caller-materialization
     * admission the read-only correspondence check uses — and through no other
     * caller identity, because the Account bearer alone must never be able to
     * move an endpoint that present-user administration owns.
     */
    it.each([
        { desiredTargetMaterialization: TARGET.materialization },
        { desiredTargetRouting: { serverIdentityId: "srv_webhookRouting", machineId: TARGET.materialization.machineId } },
    ])("authenticates the exact current caller materialization before converging an endpoint target: %j", async (desiredTarget) => {
        const app = createFakeRouteApp();
        const convergeTarget = vi.fn(async () => ({
            kind: "converged" as const,
            webhookEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            revision: 6,
            targetMaterialization: TARGET.materialization,
            targetIntentEpoch: 5,
        }));
        const authenticateCaller = vi.fn(async () => ({ pluginId: "happier.channels" }));
        registerPluginWebhookDaemonRoutes(app as never, {
            claim: vi.fn(),
            renew: vi.fn(),
            complete: vi.fn(),
            fail: vi.fn(),
            checkCorrespondence: vi.fn(),
            convergeTarget,
            authenticateCaller,
            verifyPublisher: vi.fn(async () => ({ machineId: "machine-1", installationId: "installation-1" })),
        }, { HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: "1" });
        const reply = createReplyStub();
        const input = {
            webhookEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            webhookContribution: { pluginId: "acme.github", localId: "issues" },
            sourceInstanceId: "source-1",
            setup: CORRESPONDENCE_SETUP,
            ...desiredTarget,
            targetIntentEpoch: 5,
        };
        expect(PluginWebhookEndpointConvergeTargetInputV1Schema.parse(input)).toEqual(input);
        expect(PluginWebhookEndpointConvergeTargetInputV1Schema.safeParse({
            ...input,
            desiredTargetMaterialization: TARGET.materialization,
            desiredTargetRouting: { serverIdentityId: "srv_webhookRouting", machineId: TARGET.materialization.machineId },
        }).success).toBe(false);

        await getRouteHandler(app, "POST", "/v1/plugins/webhooks/endpoints/converge-target")({
            userId: "account-authenticated",
            method: "POST",
            url: "/v1/plugins/webhooks/endpoints/converge-target",
            headers: {},
            body: { caller: CALLER, input },
        }, reply);

        expect(authenticateCaller).toHaveBeenCalledWith(expect.objectContaining({
            accountId: "account-authenticated",
            caller: CALLER,
        }));
        expect(convergeTarget).toHaveBeenCalledWith({
            accountId: "account-authenticated",
            callerPluginId: "happier.channels",
            input,
        });
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ kind: "converged", revision: 6 }));
    });

    it("refuses endpoint convergence when publisher proof or the stamped caller machine does not match", async () => {
        const input = {
            webhookEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            webhookContribution: { pluginId: "acme.github", localId: "issues" },
            sourceInstanceId: "source-1",
            setup: CORRESPONDENCE_SETUP,
            desiredTargetMaterialization: TARGET.materialization,
            targetIntentEpoch: 5,
        };
        for (const attempt of [
            { caller: CALLER, publisher: null },
            { caller: { ...CALLER, machineId: "machine-other" }, publisher: { machineId: "machine-1", installationId: "installation-1" } },
        ]) {
            const app = createFakeRouteApp();
            const convergeTarget = vi.fn();
            registerPluginWebhookDaemonRoutes(app as never, {
                claim: vi.fn(),
                renew: vi.fn(),
                complete: vi.fn(),
                fail: vi.fn(),
                checkCorrespondence: vi.fn(),
                convergeTarget,
                authenticateCaller: vi.fn(async () => ({ pluginId: "happier.channels" })),
                verifyPublisher: vi.fn(async () => attempt.publisher),
            }, { HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: "1" });
            const reply = createReplyStub();

            await getRouteHandler(app, "POST", "/v1/plugins/webhooks/endpoints/converge-target")({
                userId: "account-authenticated",
                method: "POST",
                url: "/v1/plugins/webhooks/endpoints/converge-target",
                headers: {},
                body: { caller: attempt.caller, input },
            }, reply);

            expect(reply.code).toHaveBeenCalledWith(401);
            expect(convergeTarget).not.toHaveBeenCalled();
        }
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
            convergeTarget: vi.fn(),
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
        );
        expect(claim.mock.calls[0]).toHaveLength(1);
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
            convergeTarget: vi.fn(),
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

    it("rejects a machine-installation claim unless the signed machine installation proof matches exactly", async () => {
        const app = createFakeRouteApp();
        const claim = vi.fn();
        registerPluginWebhookDaemonRoutes(app as never, {
            claim,
            renew: vi.fn(),
            complete: vi.fn(),
            fail: vi.fn(),
            checkCorrespondence: vi.fn(),
            convergeTarget: vi.fn(),
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
