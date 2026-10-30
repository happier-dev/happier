import Fastify, { type FastifyRequest } from "fastify";
import {
    buildConnectedServiceCredentialRecord,
    encodeQualifiedConnectedAccountV4StructuredQueryValue,
    QUALIFIED_CONNECTED_ACCOUNT_V4_ROUTES,
    QualifiedConnectedAccountConfigurationTargetV4Schema,
    QualifiedConnectedAccountRefSchema,
    QualifiedConnectedAccountServiceRefSchema,
} from "@happier-dev/protocol";
import {
    serializerCompiler,
    validatorCompiler,
    ZodTypeProvider,
} from "fastify-type-provider-zod";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Fastify as HappierFastify } from "../../../types";
import { resolveConnectedServicesFeature } from "@/app/features/connectedServicesFeature";
import {
    registerQualifiedConnectedAccountCredentialRoutesV4,
} from "./registerQualifiedConnectedAccountCredentialRoutesV4";
import { connectRoutes } from "../connectRoutes";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { mutateQualifiedConnectedServiceCredential, readQualifiedConnectedServiceCredential } from "./credentialRepository";
import { createConnectedServiceCredentialRevision } from "../credentials/credentialRevision";
import { resolveLegacyServiceAccountTokenIdentityFields } from "./identity";

const service = {
    pluginId: "example.connected-accounts",
    localId: "service/with/path",
} as const;

const ref = { service, accountId: "provider/account" };
let accountId: string;

async function createCredential(withConfiguration = false) {
    const result = await mutateQualifiedConnectedServiceCredential({
        accountId,
        ref,
        authenticationModeId: "token",
        expectedCredentialRevision: null,
        content: { t: "plain", v: { token: "opaque" } },
        metadata: { scopes: [] },
        ...(withConfiguration ? {
            initialConfiguration: {
                expectedConfigurationRevision: null,
                replacementContentEnvelope: { t: "plain" as const, v: { region: "eu" } },
            },
        } : {}),
    });
    if (result.status !== "written") throw new Error("Expected qualified credential create");
    return result;
}

function createTestApp(): HappierFastify {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed =
        app.withTypeProvider<ZodTypeProvider>() as HappierFastify;
    typed.decorate("authenticate", async (request: FastifyRequest) => {
        request.userId = accountId;
    });
    return typed;
}

describe("qualified Connected Account V4 credential routes", () => {
    const apps: HappierFastify[] = [];
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-qualified-route-contract-",
            initEncrypt: true,
        });
    }, 120_000);
    beforeEach(async () => {
        const owner = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        accountId = owner.id;
    });

    afterEach(async () => {
        await Promise.all(apps.splice(0).map(async (app) => {
            await app.close();
        }));
        await db.account.deleteMany();
    });
    afterAll(async () => {
        await harness.close();
    });

    it("registers the complete atomic V4 route family before capability advertisement", async () => {
        const registered: Array<readonly [string, string]> = [];
        const app = createTestApp();
        apps.push(app);
        app.addHook("onRoute", (route) => {
            if (!route.url.startsWith("/v4/connect/qualified/")) return;
            const methods = Array.isArray(route.method)
                ? route.method
                : [route.method];
            for (const method of methods) {
                // Explicit HEAD handlers are part of the contract; Fastify's
                // automatic GET aliases are intentionally omitted.
                if (method !== "HEAD" || Array.isArray(route.method)) registered.push([method, route.url]);
            }
        });

        connectRoutes(app);
        await app.ready();

        expect(app.hasRoute({ method: 'HEAD', url: '/v4/connect/qualified/provider-account-usage/history/document' })).toBe(true);
        expect(resolveConnectedServicesFeature(process.env).capabilities
            ?.connectedServices?.qualifiedAccounts?.protocolVersion).toBe(4);

        expect(
            registered.sort(([leftMethod, leftPath], [rightMethod, rightPath]) =>
                `${leftMethod} ${leftPath}`.localeCompare(
                    `${rightMethod} ${rightPath}`,
                )),
        ).toEqual(
            [...QUALIFIED_CONNECTED_ACCOUNT_V4_ROUTES].sort(
                ([leftMethod, leftPath], [rightMethod, rightPath]) =>
                    `${leftMethod} ${leftPath}`.localeCompare(
                        `${rightMethod} ${rightPath}`,
                    ),
            ),
        );
    });


    it("decodes one percent-encoded structured service query through the shared codec", async () => {
        await createCredential();
        const otherService = await mutateQualifiedConnectedServiceCredential({
            accountId,
            ref: { service: { ...service, localId: "another-service" }, accountId: ref.accountId },
            authenticationModeId: "token",
            expectedCredentialRevision: null,
            content: { t: "plain", v: { token: "other-service-secret" } },
            metadata: { scopes: [] },
        });
        expect(otherService.status).toBe("written");
        const app = createTestApp();
        apps.push(app);
        registerQualifiedConnectedAccountCredentialRoutesV4(app);
        await app.ready();
        const encodedService = encodeQualifiedConnectedAccountV4StructuredQueryValue(
            QualifiedConnectedAccountServiceRefSchema, service,
        );
        const response = await app.inject({
            method: "GET",
            url: `/v4/connect/qualified/accounts?service=${encodeURIComponent(encodedService)}`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().service).toEqual(service);
        expect(response.json().accounts).toEqual([
            expect.objectContaining({ ref }),
        ]);
    });

    it.each([
        "service=%7B%22pluginId%22%3A%22example.connected-accounts%22%7D",
        "service=%7B%22pluginId%22%3A%22example.connected-accounts%22%2C%22localId%22%3A%22one%22%7D&service=%7B%22pluginId%22%3A%22example.connected-accounts%22%2C%22localId%22%3A%22two%22%7D",
    ])("rejects malformed or duplicate structured service queries", async (query) => {
        const app = createTestApp();
        apps.push(app);
        registerQualifiedConnectedAccountCredentialRoutesV4(app);
        await app.ready();
        const response = await app.inject({
            method: "GET", url: `/v4/connect/qualified/accounts?${query}`,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "invalid-params" });
    });

    it("validates and persists a strict structured credential mutation", async () => {
        const app = createTestApp();
        apps.push(app);
        registerQualifiedConnectedAccountCredentialRoutesV4(app);
        await app.ready();
        const mutation = {
            ref, authenticationModeId: "token",
            expectedCredentialRevision: null,
            content: { t: "plain", v: { token: "opaque" } },
            metadata: {},
        };
        const response = await app.inject({
            method: "POST", url: "/v4/connect/qualified/credential", payload: mutation,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            credentialRevision: expect.any(String),
            configurationRevision: null,
        });
        await expect(readQualifiedConnectedServiceCredential({ accountId, ref })).resolves.toMatchObject({
            status: "resolved",
            credential: {
                credentialRevision: response.json().credentialRevision,
                authenticationModeId: "token",
                content: mutation.content,
                metadata: { scopes: [] },
            },
        });
    });

    it("reads an exact credential and account configuration through structured identity queries", async () => {
        const created = await createCredential(true);
        const target = { kind: "account" as const, ref };
        const app = createTestApp();
        apps.push(app);
        registerQualifiedConnectedAccountCredentialRoutesV4(app);
        await app.ready();
        const credentialQuery = encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountRefSchema, ref);
        const credentialResponse = await app.inject({
            method: "GET", url: `/v4/connect/qualified/credential?ref=${encodeURIComponent(credentialQuery)}`,
        });
        expect(credentialResponse.statusCode).toBe(200);
        expect(credentialResponse.json()).toEqual({
            ref, revisionSemantics: "revisioned",
            credentialRevision: created.credentialRevision,
            authenticationModeId: "token",
            configurationRevision: created.configurationRevision,
            content: { t: "plain", v: { token: "opaque" } },
            metadata: { scopes: [] },
        });
        const targetQuery = encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountConfigurationTargetV4Schema, target);
        const configurationResponse = await app.inject({
            method: "GET", url: `/v4/connect/qualified/configuration?target=${encodeURIComponent(targetQuery)}`,
        });
        expect(configurationResponse.statusCode).toBe(200);
        expect(configurationResponse.json()).toEqual({
            target, authenticationModeId: "token", revisionSemantics: "revisioned",
            credentialRevision: created.credentialRevision,
            configurationRevision: created.configurationRevision,
            configurationContent: { t: "plain", v: { region: "eu" } },
        });
    });


    it("keeps an absent credential on the V4 not-found path", async () => {
        const app = createTestApp();
        apps.push(app);
        registerQualifiedConnectedAccountCredentialRoutesV4(app);
        await app.ready();
        const credentialQuery = encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountRefSchema, ref);
        const response = await app.inject({
            method: "GET", url: `/v4/connect/qualified/credential?ref=${encodeURIComponent(credentialQuery)}`,
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: "connect_credential_not_found" });
    });

    it("keeps an unsupported credential health mutation distinct from not found", async () => {
        const profileId = "retained-invalid-binding";
        const identity = resolveLegacyServiceAccountTokenIdentityFields({
            serviceId: "openai-codex", profileId, credentialKind: "oauth",
        });
        const retainedRef = {
            service: { pluginId: identity.servicePluginId, localId: identity.serviceLocalId },
            accountId: identity.connectedAccountId,
        };
        const credentialRevision = createConnectedServiceCredentialRevision();
        // This retained legacy vector is parseable but bound to the wrong service/profile.
        // Corrupt native at-rest ciphertext has a distinct HTTP500 fail-closed contract.
        const record = buildConnectedServiceCredentialRecord({
            now: 1_000, serviceId: "github", profileId: "another-profile", kind: "oauth",
            oauth: {
                accessToken: "retained-secret", refreshToken: "retained-refresh", idToken: null,
                scope: null, tokenType: "Bearer", providerAccountId: null, providerEmail: null,
            },
        });
        await db.serviceAccountToken.create({
            data: {
                accountId, vendor: "openai-codex", profileId, ...identity,
                token: Buffer.from(JSON.stringify(record), "utf8"),
                metadata: { v: 3, storage: "plain_json_v1", kind: "oauth", credentialRevision },
            },
        });
        const app = createTestApp();
        apps.push(app);
        registerQualifiedConnectedAccountCredentialRoutesV4(app);
        await app.ready();
        const response = await app.inject({
            method: "PATCH", url: "/v4/connect/qualified/credential/health",
            payload: {
                ref: retainedRef, expectedCredentialRevision: credentialRevision,
                expectedConfigurationRevision: null,
                health: { v: 1, status: "needs_reauth", reconnectRequired: true, providerErrorCode: "invalid_grant" },
            },
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: "connect_credential_unsupported_format" });
        expect(response.body).not.toContain("retained-secret");
        expect(await db.serviceAccountToken.count({ where: { accountId } })).toBe(1);
    });

    it("maps credential health storage-mode mismatch to invalid params", async () => {
        const created = await createCredential();
        // A retained plain envelope cannot become readable E2EE content when Account mode changes.
        await db.account.update({
            where: { id: accountId },
            data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" },
        });
        const app = createTestApp();
        apps.push(app);
        registerQualifiedConnectedAccountCredentialRoutesV4(app);
        await app.ready();
        const response = await app.inject({
            method: "PATCH", url: "/v4/connect/qualified/credential/health",
            payload: {
                ref, expectedCredentialRevision: created.credentialRevision,
                expectedConfigurationRevision: null,
                health: { v: 1, status: "needs_reauth", reconnectRequired: true, providerErrorCode: "invalid_grant" },
            },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "invalid-params" });
        expect(await db.serviceAccountToken.count({ where: { accountId } })).toBe(1);
    });

    it("replaces account configuration through the credential/configuration CAS owner", async () => {
        const created = await createCredential(true);
        const target = { kind: "account" as const, ref };
        const app = createTestApp();
        apps.push(app);
        registerQualifiedConnectedAccountCredentialRoutesV4(app);
        await app.ready();
        const patch = {
            target,
            expectedCredentialRevision: created.credentialRevision,
            expectedConfigurationRevision: created.configurationRevision,
            replacementContentEnvelope: { t: "plain" as const, v: { region: "us" } },
        };
        const response = await app.inject({
            method: "PATCH", url: "/v4/connect/qualified/configuration", payload: patch,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true, credentialRevision: created.credentialRevision,
            configurationRevision: expect.any(String),
        });
        expect(response.json().configurationRevision).not.toBe(created.configurationRevision);
        const targetQuery = encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountConfigurationTargetV4Schema, target);
        const read = await app.inject({
            method: "GET", url: `/v4/connect/qualified/configuration?target=${encodeURIComponent(targetQuery)}`,
        });
        expect(read.statusCode).toBe(200);
        expect(read.json()).toMatchObject({
            target, credentialRevision: created.credentialRevision,
            configurationRevision: response.json().configurationRevision,
            configurationContent: patch.replacementContentEnvelope,
        });
        const stale = await app.inject({
            method: "PATCH", url: "/v4/connect/qualified/configuration", payload: patch,
        });
        expect(stale.statusCode).toBe(409);
        const afterStale = await app.inject({
            method: "GET", url: `/v4/connect/qualified/configuration?target=${encodeURIComponent(targetQuery)}`,
        });
        expect(afterStale.json()).toEqual(read.json());
    });
});
