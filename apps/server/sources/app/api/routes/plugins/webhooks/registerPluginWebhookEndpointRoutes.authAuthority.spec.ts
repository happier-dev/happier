import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { PluginWebhookActionHttpPathsV1 } from "@happier-dev/protocol";
import { AUTHORITY_CEILING_HEADER_V1 } from "@happier-dev/protocol/actions/invocationAuthority";

import type { Fastify as AppFastify } from "@/app/api/types";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { decryptPluginWebhookCredentialSecretV1 } from "@/app/plugins/webhooks/credentialCipher";
import { enableAuthentication } from "../../../utils/enableAuthentication";
import { registerPluginWebhookEndpointRoutes } from "./registerPluginWebhookEndpointRoutes";

const ACCOUNT_ID = "webhook-route-account";
const TERMINAL_ENDPOINT = "wh_ep_AAECAwQFBgcICQoLDA0ODw";
const ACCOUNT_ENDPOINT = "wh_ep_EAECAwQFBgcICQoLDA0ODw";

describe("plugin webhook HTTP credential admission", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-webhook-route-auth-", initAuth: true, initEncrypt: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: "", AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0" } });
        await db.account.create({ data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" } });
    }, 120_000);
    afterAll(async () => await harness.close());

    async function seedEndpoint(endpointId: string) {
        const route = await db.pluginWebhookRoute.create({ data: { opaqueRouteId: `opaque-${endpointId}`,
            verifierKind: "github_hmac_sha256_v1", routingKind: "accountEndpoint" } });
        await db.pluginWebhookEndpoint.create({ data: { id: endpointId, accountId: ACCOUNT_ID, pluginId: "acme.github",
            webhookContributionId: "github-events", handlerActionId: "handle-webhook", sourceInstanceId: endpointId,
            setupKind: "accountEndpointV1", routeId: route.id, routingKind: "accountEndpoint", targetMachineId: "machine-1",
            targetMachineInstallationId: "installation-1", targetMaterializationId: "materialization-1", targetPluginVersion: "1.0.0" } });
        await db.pluginWebhookRoute.update({ where: { id: route.id }, data: { accountEndpointId: endpointId } });
        return route.id;
    }

    it("refuses Directory mutation and secret disclosure and configures real credentials for Account and terminal callers", async () => {
        const terminalRouteId = await seedEndpoint(TERMINAL_ENDPOINT);
        const accountRouteId = await seedEndpoint(ACCOUNT_ENDPOINT);
        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
        enableAuthentication(typed);
        registerPluginWebhookEndpointRoutes(typed, undefined, { HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: "1" });
        const url = PluginWebhookActionHttpPathsV1["plugin.webhook.endpoint.credential.configure"];
        try {
            const directory = await auth.createToken(ACCOUNT_ID, undefined, { kind: "account_directory", authority: "present_user" });
            const refused = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${directory}` },
                payload: { webhookEndpointId: TERMINAL_ENDPOINT, expectedRevision: 1 } });
            expect(refused.statusCode).toBe(403);
            expect(refused.json()).toEqual({ error: "present_user_required" });
            expect(refused.json()).not.toHaveProperty("oneTimeGeneratedSecret");
            expect(await db.pluginWebhookCredential.count()).toBe(0);
            expect(await db.pluginWebhookEndpoint.findUniqueOrThrow({ where: { id: TERMINAL_ENDPOINT } })).toMatchObject({ revision: 1 });

            for (const [kind, endpointId, routeId] of [
                ["terminal", TERMINAL_ENDPOINT, terminalRouteId], ["account", ACCOUNT_ENDPOINT, accountRouteId],
            ] as const) {
                const token = await auth.createToken(ACCOUNT_ID, undefined, { kind, authority: kind === "terminal" ? "account_automation" : "present_user" });
                const response = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}`,
                    ...(kind === "terminal" ? { [AUTHORITY_CEILING_HEADER_V1]: "account_automation" } : {}) },
                    payload: { webhookEndpointId: endpointId, expectedRevision: 1 } });
                expect(response.statusCode).toBe(200);
                expect(response.json()).toMatchObject({ kind: "configured", webhookEndpointId: endpointId, revision: 2,
                    oneTimeGeneratedSecret: expect.any(String) });
                const credential = await db.pluginWebhookCredential.findFirstOrThrow({ where: { routeId } });
                expect(decryptPluginWebhookCredentialSecretV1({ routeId, verifierKind: "github_hmac_sha256_v1",
                    credentialVersionId: credential.credentialVersionId, encryptedSecret: new Uint8Array(credential.encryptedSecret) }))
                    .toBe(response.json().oneTimeGeneratedSecret);
                expect(await db.pluginWebhookEndpoint.findUniqueOrThrow({ where: { id: endpointId } })).toMatchObject({ revision: 2 });
            }
            expect(await db.pluginWebhookCredential.count()).toBe(2);
        } finally { await app.close(); }
    });
});
