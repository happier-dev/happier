import Fastify, { type FastifyRequest } from "fastify";
import {
    serializerCompiler,
    validatorCompiler,
    ZodTypeProvider,
} from "fastify-type-provider-zod";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Fastify as HappierFastify } from "../../../types";
import { registerConnectedServiceCredentialRoutesV2 } from "./registerConnectedServiceCredentialRoutesV2";
import { registerConnectedServiceProfilesRoutesV2 } from "./registerConnectedServiceProfilesRoutesV2";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { mutateQualifiedConnectedServiceCredential } from "../qualifiedConnectedAccounts/credentialRepository";
import { resolveLegacyServiceAccountTokenIdentityFields } from "../qualifiedConnectedAccounts/identity";

let accountId: string;

function createTestApp(): HappierFastify {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed =
        app.withTypeProvider<ZodTypeProvider>() as HappierFastify;
    typed.decorate("authenticate", async (request: FastifyRequest) => {
        request.userId = accountId;
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

async function retainCredential(authenticationModeId: string, profileId: string) {
    const kind = authenticationModeId === "legacy-oauth-unsupported" ? "oauth" : "token";
    const identity = resolveLegacyServiceAccountTokenIdentityFields({ serviceId: "gemini", profileId, credentialKind: kind });
    const result = await mutateQualifiedConnectedServiceCredential({
        accountId,
        ref: { service: geminiService, accountId: identity.connectedAccountId },
        authenticationModeId,
        expectedCredentialRevision: null,
        content: { t: "encrypted", c: "ciphertext" },
        metadata: { scopes: [] },
        ...(authenticationModeId === "legacy-oauth-unsupported" ? {
            legacyIdentity: { serviceId: "gemini", profileId },
        } : {}),
    });
    if (result.status !== "written") throw new Error("Expected qualified credential create");
}

describe("Connected Service V2 old-reader projection", () => {
    const apps: HappierFastify[] = [];
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-legacy-projection-",
            initEncrypt: true,
        });
    }, 120_000);
    beforeEach(async () => {
        const owner = await db.account.create({
            data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" },
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

    it("omits unsupported qualified modes while retaining supported profiles", async () => {
        await retainCredential("legacy-oauth-unsupported", "old-oauth");
        await retainCredential("api-key", "api-key");
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
            await retainCredential(authenticationModeId, "work");
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
