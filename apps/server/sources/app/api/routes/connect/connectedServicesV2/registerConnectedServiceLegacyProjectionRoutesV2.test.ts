import Fastify, { type FastifyRequest } from "fastify";
import {
    serializerCompiler,
    validatorCompiler,
    ZodTypeProvider,
} from "fastify-type-provider-zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Fastify as HappierFastify } from "../../../types";
import { registerConnectedServiceCredentialRoutesV2 } from "./registerConnectedServiceCredentialRoutesV2";
import { registerConnectedServiceProfilesRoutesV2 } from "./registerConnectedServiceProfilesRoutesV2";

const repository = vi.hoisted(() => ({
    listQualifiedConnectedAccounts: vi.fn(),
    readQualifiedConnectedServiceCredentialForLegacyProjection: vi.fn(),
    deleteQualifiedConnectedServiceCredentialForStorageMode: vi.fn(),
}));

vi.mock("../qualifiedConnectedAccounts/credentialRepository", () => repository);

function createTestApp(): HappierFastify {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed =
        app.withTypeProvider<ZodTypeProvider>() as HappierFastify;
    typed.decorate("authenticate", async (request: FastifyRequest) => {
        request.userId = "account-owner";
    });
    registerConnectedServiceProfilesRoutesV2(typed);
    registerConnectedServiceCredentialRoutesV2(typed, {
        credentialMaxLen: 1024,
    });
    return typed;
}

const geminiService = {
    pluginId: "happier.agent.gemini",
    localId: "gemini-account",
} as const;

function account(authenticationModeId: string, accountId: string) {
    return {
        ref: { service: geminiService, accountId },
        status: "connected" as const,
        authenticationModeId,
        credentialRevision: "csr_1234567890123456789012",
        configurationReady: false,
        configurationRevision: null,
        providerIdentity: null,
        scopes: [],
        expiresAt: null,
        lastUsedAt: null,
    };
}

describe("Connected Service V2 old-reader projection", () => {
    const apps: HappierFastify[] = [];

    afterEach(async () => {
        repository.listQualifiedConnectedAccounts.mockReset();
        repository
            .readQualifiedConnectedServiceCredentialForLegacyProjection
            .mockReset();
        await Promise.all(apps.splice(0).map(async (app) => {
            await app.close();
        }));
    });

    it("omits unsupported qualified modes while retaining supported profiles", async () => {
        repository.listQualifiedConnectedAccounts.mockResolvedValue([
            account("legacy-oauth-unsupported", "old-oauth"),
            account("api-key", "api-key"),
        ]);
        const app = createTestApp();
        apps.push(app);
        await app.ready();

        const response = await app.inject({
            method: "GET",
            url: "/v2/connect/gemini/profiles",
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            serviceId: "gemini",
            profiles: [{
                profileId: "api-key",
                kind: "token",
            }],
        });
    });

    it.each([
        ["legacy-oauth-unsupported", 200, "oauth"],
        ["api-key", 200, "token"],
        ["unmapped-mode", 409, null],
    ] as const)(
        "projects credential mode %s with status %s",
        async (authenticationModeId, expectedStatus, expectedKind) => {
            repository
                .readQualifiedConnectedServiceCredentialForLegacyProjection
                .mockResolvedValue({
                    status: "resolved",
                    credential: {
                        ...account(authenticationModeId, "work"),
                        content: {
                            t: "encrypted",
                            c: "ciphertext",
                        },
                        metadata: {
                            scopes: [],
                        },
                    },
                });
            const app = createTestApp();
            apps.push(app);
            await app.ready();

            const response = await app.inject({
                method: "GET",
                url: "/v2/connect/gemini/profiles/work/credential",
            });

            expect(response.statusCode).toBe(expectedStatus);
            if (expectedKind) {
                expect(response.json()).toMatchObject({
                    sealed: {
                        format: "account_scoped_v1",
                        ciphertext: "ciphertext",
                    },
                    metadata: { kind: expectedKind },
                });
            } else {
                expect(response.json()).toEqual({
                    error: "connect_credential_unsupported_format",
                });
            }
        },
    );
});
