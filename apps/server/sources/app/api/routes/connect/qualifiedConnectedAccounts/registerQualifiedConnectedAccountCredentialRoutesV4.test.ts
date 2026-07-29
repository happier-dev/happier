import Fastify, { type FastifyRequest } from "fastify";
import {
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
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Fastify as HappierFastify } from "../../../types";
import { resolveConnectedServicesFeature } from "@/app/features/connectedServicesFeature";
import {
    registerQualifiedConnectedAccountCredentialRoutesV4,
} from "./registerQualifiedConnectedAccountCredentialRoutesV4";
import { connectRoutes } from "../connectRoutes";

const service = {
    pluginId: "example.connected-accounts",
    localId: "service/with/path",
} as const;

function createTestApp(): HappierFastify {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed =
        app.withTypeProvider<ZodTypeProvider>() as HappierFastify;
    typed.decorate("authenticate", async (request: FastifyRequest) => {
        request.userId = "account-owner";
    });
    return typed;
}

describe("qualified Connected Account V4 credential routes", () => {
    const apps: HappierFastify[] = [];

    afterEach(async () => {
        await Promise.all(apps.splice(0).map(async (app) => {
            await app.close();
        }));
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
                if (method !== "HEAD") registered.push([method, route.url]);
            }
        });

        connectRoutes(app);
        await app.ready();

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

    it("advertises V4 if and only if the exact atomic route family is registered", async () => {
        const registered: string[] = [];
        const app = createTestApp();
        apps.push(app);
        app.addHook("onRoute", (route) => {
            if (!route.url.startsWith("/v4/connect/qualified/")) return;
            const methods = Array.isArray(route.method)
                ? route.method
                : [route.method];
            for (const method of methods) {
                if (method !== "HEAD") {
                    registered.push(`${method} ${route.url}`);
                }
            }
        });

        connectRoutes(app);
        await app.ready();

        const complete = JSON.stringify(registered.sort()) === JSON.stringify(
            QUALIFIED_CONNECTED_ACCOUNT_V4_ROUTES
                .map(([method, path]) => `${method} ${path}`)
                .sort(),
        );
        const advertised =
            resolveConnectedServicesFeature(process.env)
                .capabilities
                ?.connectedServices
                ?.qualifiedAccounts
                ?.protocolVersion === 4;
        expect(advertised).toBe(complete);
    });

    it("decodes one percent-encoded structured service query through the shared codec", async () => {
        const listQualifiedConnectedAccounts = vi.fn(async () => []);
        const app = createTestApp();
        apps.push(app);
        registerQualifiedConnectedAccountCredentialRoutesV4(app, {
            listQualifiedConnectedAccounts,
            mutateQualifiedConnectedServiceCredential: vi.fn(),
        });
        await app.ready();

        const encodedService =
            encodeQualifiedConnectedAccountV4StructuredQueryValue(
                QualifiedConnectedAccountServiceRefSchema,
                service,
            );
        const response = await app.inject({
            method: "GET",
            url: `/v4/connect/qualified/accounts?service=${encodeURIComponent(encodedService)}`,
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ service, accounts: [] });
        expect(listQualifiedConnectedAccounts).toHaveBeenCalledWith({
            accountId: "account-owner",
            service,
        });
    });

    it.each([
        "service=%7B%22pluginId%22%3A%22example.connected-accounts%22%7D",
        "service=%7B%22pluginId%22%3A%22example.connected-accounts%22%2C%22localId%22%3A%22one%22%7D&service=%7B%22pluginId%22%3A%22example.connected-accounts%22%2C%22localId%22%3A%22two%22%7D",
    ])("rejects malformed or duplicate structured service queries", async (query) => {
        const listQualifiedConnectedAccounts = vi.fn(async () => []);
        const app = createTestApp();
        apps.push(app);
        registerQualifiedConnectedAccountCredentialRoutesV4(app, {
            listQualifiedConnectedAccounts,
            mutateQualifiedConnectedServiceCredential: vi.fn(),
        });
        await app.ready();

        const response = await app.inject({
            method: "GET",
            url: `/v4/connect/qualified/accounts?${query}`,
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "invalid-params" });
        expect(listQualifiedConnectedAccounts).not.toHaveBeenCalled();
    });

    it("validates and forwards a strict structured credential mutation", async () => {
        const mutateQualifiedConnectedServiceCredential = vi.fn(async () => ({
            status: "written" as const,
            credentialRevision: "csr_abcdefghijklmnopqrstuvwxyz",
            configurationRevision: null,
        }));
        const app = createTestApp();
        apps.push(app);
        registerQualifiedConnectedAccountCredentialRoutesV4(app, {
            listQualifiedConnectedAccounts: vi.fn(),
            mutateQualifiedConnectedServiceCredential,
        });
        await app.ready();

        const mutation = {
            ref: {
                service,
                accountId: "provider/account",
            },
            authenticationModeId: "token",
            expectedCredentialRevision: null,
            content: { t: "plain", v: { token: "opaque" } },
            metadata: {},
        };
        const response = await app.inject({
            method: "POST",
            url: "/v4/connect/qualified/credential",
            payload: mutation,
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            credentialRevision: "csr_abcdefghijklmnopqrstuvwxyz",
            configurationRevision: null,
        });
        expect(mutateQualifiedConnectedServiceCredential).toHaveBeenCalledWith({
            accountId: "account-owner",
            ...mutation,
            metadata: { scopes: [] },
        });
    });

    it("reads an exact credential and account configuration through structured identity queries", async () => {
        const ref = { service, accountId: "provider/account" };
        const target = { kind: "account" as const, ref };
        const credential = {
            credentialRevision: "csr_abcdefghijklmnopqrstuvwxyz",
            authenticationModeId: "token",
            configurationRevision: "configuration-revision",
            content: { t: "plain" as const, v: { token: "opaque" } },
            metadata: { scopes: [] },
        };
        const configuration = {
            target,
            authenticationModeId: "token",
            credentialRevision: credential.credentialRevision,
            configurationRevision: "configuration-revision",
            configurationContent: { t: "plain" as const, v: { region: "eu" } },
        };
        const readQualifiedConnectedServiceCredential =
            vi.fn(async () => credential);
        const readQualifiedConnectedAccountConfiguration =
            vi.fn(async () => configuration);
        const app = createTestApp();
        apps.push(app);
        registerQualifiedConnectedAccountCredentialRoutesV4(app, {
            listQualifiedConnectedAccounts: vi.fn(),
            mutateQualifiedConnectedServiceCredential: vi.fn(),
            readQualifiedConnectedServiceCredential,
            readQualifiedConnectedAccountConfiguration,
            mutateQualifiedConnectedAccountConfiguration: vi.fn(),
        });
        await app.ready();

        const credentialQuery =
            encodeQualifiedConnectedAccountV4StructuredQueryValue(
                QualifiedConnectedAccountRefSchema,
                ref,
            );
        const credentialResponse = await app.inject({
            method: "GET",
            url: `/v4/connect/qualified/credential?ref=${encodeURIComponent(credentialQuery)}`,
        });
        expect(credentialResponse.statusCode).toBe(200);
        expect(credentialResponse.json()).toEqual({ ref, ...credential });
        expect(readQualifiedConnectedServiceCredential).toHaveBeenCalledWith({
            accountId: "account-owner",
            ref,
        });

        const targetQuery =
            encodeQualifiedConnectedAccountV4StructuredQueryValue(
                QualifiedConnectedAccountConfigurationTargetV4Schema,
                target,
            );
        const configurationResponse = await app.inject({
            method: "GET",
            url: `/v4/connect/qualified/configuration?target=${encodeURIComponent(targetQuery)}`,
        });
        expect(configurationResponse.statusCode).toBe(200);
        expect(configurationResponse.json()).toEqual(configuration);
        expect(readQualifiedConnectedAccountConfiguration).toHaveBeenCalledWith({
            accountId: "account-owner",
            target,
        });
    });

    it("replaces account configuration through the credential/configuration CAS owner", async () => {
        const target = {
            kind: "account" as const,
            ref: { service, accountId: "provider/account" },
        };
        const mutateQualifiedConnectedAccountConfiguration = vi.fn(async () => ({
            status: "written" as const,
            credentialRevision: "csr_abcdefghijklmnopqrstuvwxyz",
            configurationRevision: "next-configuration-revision",
        }));
        const app = createTestApp();
        apps.push(app);
        registerQualifiedConnectedAccountCredentialRoutesV4(app, {
            listQualifiedConnectedAccounts: vi.fn(),
            mutateQualifiedConnectedServiceCredential: vi.fn(),
            readQualifiedConnectedServiceCredential: vi.fn(),
            readQualifiedConnectedAccountConfiguration: vi.fn(),
            mutateQualifiedConnectedAccountConfiguration,
        });
        await app.ready();

        const patch = {
            target,
            expectedCredentialRevision: "csr_abcdefghijklmnopqrstuvwxyz",
            expectedConfigurationRevision: "configuration-revision",
            replacementContentEnvelope: {
                t: "plain" as const,
                v: { region: "us" },
            },
        };
        const response = await app.inject({
            method: "PATCH",
            url: "/v4/connect/qualified/configuration",
            payload: patch,
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            credentialRevision: "csr_abcdefghijklmnopqrstuvwxyz",
            configurationRevision: "next-configuration-revision",
        });
        expect(mutateQualifiedConnectedAccountConfiguration).toHaveBeenCalledWith({
            accountId: "account-owner",
            target,
            expectedCredentialRevision: patch.expectedCredentialRevision,
            expectedConfigurationRevision: patch.expectedConfigurationRevision,
            replacementContentEnvelope: patch.replacementContentEnvelope,
        });
    });
});
