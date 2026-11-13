import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import tweetnacl from "tweetnacl";
import { GENERAL_PLUGIN_PERMISSION_SUBJECT_V1, REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1 } from "@happier-dev/protocol";
import { AUTHORITY_CEILING_HEADER_V1 } from "@happier-dev/protocol/actions/invocationAuthority";

import type { Fastify as AppFastify } from "@/app/api/types";
import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createTrustedMachineInstallation } from "@/testkit/pluginInstallationPublisherTestkit";
import { db } from "@/storage/db";
import { createPluginPermissionGrantOperations } from "./operations";
import { createSqlPluginPermissionGrantStore } from "./storage";
import { registerPluginPermissionGrantRoutes } from "./routes";

const ACCOUNT_ID = "permission-route-account";
const PLUGIN_ID = "happier.review.coderabbit";
const publisher = { kind: "machine_installation", machineId: "permission-machine", installationId: "permission-installation" } as const;

describe("plugin permission grant HTTP credential admission", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-permission-route-auth-", initAuth: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: "", AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0" } });
    }, 120_000);
    beforeEach(async () => {
        await db.account.create({ data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" } });
        await createTrustedMachineInstallation({ accountId: ACCOUNT_ID, machineId: publisher.machineId,
            installationId: publisher.installationId, keyPair: tweetnacl.sign.keyPair() });
    });
    afterEach(async () => {
        await db.$executeRawUnsafe("DELETE FROM plugin_permission_grant_events");
        await db.$executeRawUnsafe("DELETE FROM plugin_permission_grants");
        await db.$executeRawUnsafe("DELETE FROM plugin_permission_grant_requests");
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });
    afterAll(async () => await harness.close());

    function buildApp() {
        const app = Fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
        enableAuthentication(typed);
        registerPluginPermissionGrantRoutes(typed);
        return app;
    }

    async function tokens() {
        return {
            account: await auth.createToken(ACCOUNT_ID, undefined, { kind: "account", authority: "present_user" }),
            directory: await auth.createToken(ACCOUNT_ID, undefined, { kind: "account_directory", authority: "present_user" }),
            terminal: await auth.createToken(ACCOUNT_ID, undefined, { kind: "terminal", authority: "account_automation" }),
        };
    }

    async function pendingRequest(projectId: string) {
        return (await createPluginPermissionGrantOperations().request({ accountId: ACCOUNT_ID, userId: ACCOUNT_ID, publisher,
            input: { pluginId: PLUGIN_ID, capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                targetScope: { kind: "project", projectId }, subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
                reason: "Publish approved review comments", requester: { kind: "plugin", pluginId: PLUGIN_ID } },
        })).pendingRequest;
    }

    it("refuses Directory grant and dismissal without mutation and admits Account and terminal credentials", async () => {
        const app = buildApp();
        const credentials = await tokens();
        const store = createSqlPluginPermissionGrantStore();
        try {
            for (const operation of ["grant", "dismissRequest"] as const) {
                const pending = await pendingRequest(`restricted-${operation}`);
                const refused = await app.inject({ method: "POST", url: `/v1/plugins/permissions/grants/${operation}`,
                    headers: { authorization: `Bearer ${credentials.directory}` }, payload: { requestId: pending.id } });
                expect(refused.statusCode).toBe(403);
                expect(refused.json()).toEqual({ error: "present_user_required" });
                expect(await store.getRequest({ accountId: ACCOUNT_ID, requestId: pending.id })).toMatchObject({ status: "pending" });
                expect(await store.list({ accountId: ACCOUNT_ID, limit: 100 })).toMatchObject({ grants: [] });
            }
            // The 2026-10-29 ruling removes terminal present-user floors, including
            // calls carrying the actual per-invocation automation ceiling.
            for (const credential of ["account", "terminal"] as const) {
                for (const operation of ["grant", "dismissRequest"] as const) {
                    const pending = await pendingRequest(`${credential}-${operation}`);
                    const response = await app.inject({ method: "POST", url: `/v1/plugins/permissions/grants/${operation}`,
                        headers: { authorization: `Bearer ${credentials[credential]}`,
                            ...(credential === "terminal" ? { [AUTHORITY_CEILING_HEADER_V1]: "account_automation" } : {}) },
                        payload: { requestId: pending.id } });
                    expect(response.statusCode).toBe(200);
                    const status = operation === "grant" ? "granted" : "dismissed";
                    expect(response.json()).toMatchObject({ pendingRequest: { id: pending.id, status } });
                    expect(await store.getRequest({ accountId: ACCOUNT_ID, requestId: pending.id })).toMatchObject({ status });
                }
            }
        } finally { await app.close(); }
    });

    it("refuses Directory revocation and persists Account and terminal revocation", async () => {
        const app = buildApp();
        const credentials = await tokens();
        const operations = createPluginPermissionGrantOperations();
        const store = createSqlPluginPermissionGrantStore();
        await db.account.create({ data: { id: "permission-other-account", publicKey: null, encryptionMode: "plain" } });
        const otherAccountToken = await auth.createToken("permission-other-account", undefined, { kind: "account", authority: "present_user" });
        try {
            for (const credential of ["account", "terminal"] as const) {
                const pending = await pendingRequest(`${credential}-revoke`);
                const { grant } = await operations.grant({ accountId: ACCOUNT_ID, userId: ACCOUNT_ID, input: { requestId: pending.id } });
                const refused = await app.inject({ method: "POST", url: "/v1/plugins/permissions/grants/revoke",
                    headers: { authorization: `Bearer ${credentials.directory}` }, payload: { grantId: grant.id } });
                expect(refused.statusCode).toBe(403);
                expect(refused.json()).toEqual({ error: "present_user_required" });
                expect(await store.getGrant({ accountId: ACCOUNT_ID, grantId: grant.id })).toMatchObject({ status: "active" });
                const crossAccount = await app.inject({ method: "POST", url: "/v1/plugins/permissions/grants/revoke",
                    headers: { authorization: `Bearer ${otherAccountToken}` }, payload: { grantId: grant.id } });
                expect(crossAccount.statusCode).toBe(404);
                expect(crossAccount.json()).toMatchObject({ error: "plugin_permission_grant_not_found" });
                expect(await store.getGrant({ accountId: ACCOUNT_ID, grantId: grant.id })).toMatchObject({ status: "active" });
                const response = await app.inject({ method: "POST", url: "/v1/plugins/permissions/grants/revoke",
                    headers: { authorization: `Bearer ${credentials[credential]}`,
                        ...(credential === "terminal" ? { [AUTHORITY_CEILING_HEADER_V1]: "account_automation" } : {}) },
                    payload: { grantId: grant.id } });
                expect(response.statusCode).toBe(200);
                expect(response.json()).toMatchObject({ grant: { id: grant.id, status: "revoked" } });
                expect(await store.getGrant({ accountId: ACCOUNT_ID, grantId: grant.id })).toMatchObject({ status: "revoked" });
            }
        } finally { await app.close(); }
    });
});
