import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { PluginWebhookActionHttpPathsV1 } from "@happier-dev/protocol";

const accountFindUnique = vi.hoisted(() => vi.fn(async () => ({ id: "account-1", tokenEpoch: 0 })));
const repeatKeyFindUnique = vi.hoisted(() => vi.fn(async () => null));

vi.mock("@/storage/db", () => ({
    db: {
        account: { findUnique: accountFindUnique },
        repeatKey: { findUnique: repeatKeyFindUnique },
    },
}));

import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "../../../utils/enableAuthentication";
import { registerPluginWebhookEndpointRoutes } from "./registerPluginWebhookEndpointRoutes";

describe("plugin webhook HTTP auth authority", () => {
    beforeAll(async () => {
        vi.stubEnv("HANDY_MASTER_SECRET", "webhook-route-real-token-authority");
        vi.stubEnv("AUTH_REQUIRED_LOGIN_PROVIDERS", "");
        vi.stubEnv("AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS", "0");
        vi.stubEnv("AUTH_LOGIN_ELIGIBILITY_ACCOUNT_SNAPSHOT_CACHE_TTL_MS", "0");
        await auth.init();
    });

    afterAll(() => vi.unstubAllEnvs());

    it("rejects a real terminal token before mutation or secret disclosure and admits a present-user token", async () => {
        const configureCredential = vi.fn(async () => ({
            kind: "configured" as const,
            webhookEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            revision: 2,
            credentialVersionId: "credential-1",
            oneTimeGeneratedSecret: "present-user-secret",
        }));
        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>() as any;
        enableAuthentication(typed);
        registerPluginWebhookEndpointRoutes(typed, {
            ensure: vi.fn(),
            read: vi.fn(),
            revoke: vi.fn(),
            retarget: vi.fn(),
            movePending: vi.fn(),
            configureCredential,
            rotateCredential: vi.fn(),
            finishCredentialRotation: vi.fn(),
        }, { HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENABLED: "1" });
        await app.ready();

        try {
            const [presentUserToken, terminalToken] = await Promise.all([
                auth.createToken("account-1"),
                auth.createToken("account-1", { session: "terminal-automation" }),
            ]);
            const url = PluginWebhookActionHttpPathsV1[
                "plugin.webhook.endpoint.credential.configure"
            ];
            const payload = {
                webhookEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
                expectedRevision: 1,
            };

            const terminalResponse = await app.inject({
                method: "POST",
                url,
                headers: { authorization: `Bearer ${terminalToken}` },
                payload,
            });
            expect(terminalResponse.statusCode).toBe(403);
            expect(terminalResponse.json()).toEqual({ error: "present_user_required" });
            expect(terminalResponse.json()).not.toHaveProperty("oneTimeGeneratedSecret");
            expect(configureCredential).not.toHaveBeenCalled();

            const presentUserResponse = await app.inject({
                method: "POST",
                url,
                headers: { authorization: `Bearer ${presentUserToken}` },
                payload,
            });
            expect(presentUserResponse.statusCode).toBe(200);
            expect(presentUserResponse.json()).toMatchObject({
                kind: "configured",
                oneTimeGeneratedSecret: "present-user-secret",
            });
            expect(configureCredential).toHaveBeenCalledTimes(1);
        } finally {
            await app.close();
        }
    });
});
