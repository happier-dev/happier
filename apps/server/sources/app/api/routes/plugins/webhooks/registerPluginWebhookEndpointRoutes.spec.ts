import { describe, expect, it, vi } from "vitest";

import {
    PluginWebhookActionHttpPathsV1,
    PLUGIN_WEBHOOK_ACCOUNT_STATUS_HTTP_PATH_V1,
    PLUGIN_WEBHOOK_DELIVERY_DISCARD_HTTP_PATH_V1,
    PLUGIN_WEBHOOK_DELIVERY_REPLAY_HTTP_PATH_V1,
} from "@happier-dev/protocol";

import {
    createFakeRouteApp,
    createReplyStub,
    getRouteEntry,
    getRouteHandler,
} from "../../../testkit/routeHarness";

const endpointActions = vi.hoisted(() => ({
    create: vi.fn(),
}));

vi.mock("@/app/plugins/webhooks/endpointActions", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/plugins/webhooks/endpointActions")>();
    return { ...actual, createPluginWebhookEndpointActionsV1: endpointActions.create };
});

import { registerPluginWebhookEndpointRoutes } from "./registerPluginWebhookEndpointRoutes";

describe("plugin webhook present-user endpoint routes", () => {
    it("registers only the present-user lifecycle projections behind authentication", () => {
        const app = createFakeRouteApp();
        registerPluginWebhookEndpointRoutes(app as never, {
            ensure: vi.fn(),
            read: vi.fn(),
            revoke: vi.fn(),
            retarget: vi.fn(),
            movePending: vi.fn(),
            configureCredential: vi.fn(),
            rotateCredential: vi.fn(),
            finishCredentialRotation: vi.fn(),
        }, { HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: "1" });

        for (const path of Object.values(PluginWebhookActionHttpPathsV1)) {
            expect(getRouteEntry(app, "POST", path).opts.preHandler).toEqual([
                app.authenticate,
                expect.any(Function),
            ]);
        }
        for (const path of [
            PLUGIN_WEBHOOK_ACCOUNT_STATUS_HTTP_PATH_V1,
            PLUGIN_WEBHOOK_DELIVERY_REPLAY_HTTP_PATH_V1,
            PLUGIN_WEBHOOK_DELIVERY_DISCARD_HTTP_PATH_V1,
        ]) {
            expect(getRouteEntry(app, "POST", path).opts.preHandler).toEqual([
                app.authenticate,
                expect.any(Function),
            ]);
        }
        expect([...app.routes.keys()]).not.toContain(
            "POST /v1/plugins/webhooks/endpoints/check-correspondence",
        );
    });

    it("derives Account authority from authentication and does not accept it from input", async () => {
        const app = createFakeRouteApp();
        const read = vi.fn(async () => ({
            webhookEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            revision: 1,
            contribution: { pluginId: "acme.github", localId: "issues" },
            targetMaterialization: {
                machineId: "machine-1",
                materializationId: "materialization-1",
                pluginId: "acme.github",
            },
            sourceInstanceId: "source-1",
            routing: "accountEndpoint" as const,
            readiness: "ready" as const,
            publicUrl: "https://server.example/v1/plugins/webhooks/opaque",
            createdAt: 1,
        }));
        registerPluginWebhookEndpointRoutes(app as never, {
            ensure: vi.fn(),
            read,
            revoke: vi.fn(),
            retarget: vi.fn(),
            movePending: vi.fn(),
            configureCredential: vi.fn(),
            rotateCredential: vi.fn(),
            finishCredentialRotation: vi.fn(),
        }, { HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: "1" });
        const reply = createReplyStub();
        const input = { webhookEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw" };

        await getRouteHandler(
            app,
            "POST",
            PluginWebhookActionHttpPathsV1["plugin.webhook.endpoint.read"],
        )({ userId: "account-authenticated", body: input }, reply);

        expect(read).toHaveBeenCalledWith({ accountId: "account-authenticated", input });
        expect(reply.headers).toEqual({ "Cache-Control": "no-store" });
    });

    it("accepts a canonical shared-installation authorizer at live route composition while the default remains fail-closed", () => {
        const app = createFakeRouteApp();
        const authorizeSharedInstallation = vi.fn(async () => true);
        const resolvedActions = {
            ensure: vi.fn(),
            read: vi.fn(),
            revoke: vi.fn(),
            retarget: vi.fn(),
            movePending: vi.fn(),
            configureCredential: vi.fn(),
            rotateCredential: vi.fn(),
            finishCredentialRotation: vi.fn(),
        };
        endpointActions.create.mockReturnValueOnce(resolvedActions);

        registerPluginWebhookEndpointRoutes(
            app as never,
            undefined,
            { HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: "1" },
            { authorizeSharedInstallation },
        );

        expect(endpointActions.create).toHaveBeenCalledWith({ authorizeSharedInstallation });
        expect(getRouteEntry(app, "POST", PluginWebhookActionHttpPathsV1["plugin.webhook.endpoint.ensure"])).toBeDefined();
    });
});
