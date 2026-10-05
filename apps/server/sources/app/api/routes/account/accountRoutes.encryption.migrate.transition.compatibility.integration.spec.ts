import Fastify from "fastify";
import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";
import {
    serializerCompiler,
    validatorCompiler,
    ZodTypeProvider,
} from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import { enableErrorHandlers } from "@/app/api/utils/enableErrorHandlers";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import { registerAccountEncryptionMigrateRoutes } from "./registerAccountEncryptionMigrateRoutes";

const TRANSITION_ID = "00000000-0000-4000-8000-000000000001";

const V5_OPERATION_REQUESTS = [
    {
        path: "/v1/account/encryption/migrate/transition/prepare",
        payload: {
            toMode: "e2ee",
            expectedAccountVersion: 0,
            expectedSigningKeyFingerprint: null,
            expectedContentKeyFingerprint: null,
        },
    },
    {
        path: "/v1/account/encryption/migrate/transition/authorize",
        payload: {
            transitionId: TRANSITION_ID,
            authorization: { kind: "present_user_confirmation" },
        },
    },
    {
        path: "/v1/account/encryption/migrate/transition/collections/inventory",
        payload: { transitionId: TRANSITION_ID },
    },
    {
        path: "/v1/account/encryption/migrate/transition/collections/stage",
        payload: {
            transitionId: TRANSITION_ID,
            items: [{
                pluginId: "example.transition",
                collectionId: "documents",
                rowId: "row-1",
                expectedRevision: 1,
                sourceEnvelope: { t: "plain", v: {} },
                targetEnvelope: { t: "encrypted", c: "target-ciphertext" },
                schemaVersion: 1,
                contractDigest: "A".repeat(43),
            }],
        },
    },
    {
        path: "/v1/account/encryption/migrate/transition/cancel",
        payload: { transitionId: TRANSITION_ID },
    },
    {
        path: "/v1/account/encryption/migrate/transition/activate",
        payload: {
            transitionId: TRANSITION_ID,
            collections: { action: "staged", transitionId: TRANSITION_ID },
            automations: { action: "staged", transitionId: TRANSITION_ID },
        },
    },
] as const;

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    typed.decorate(
        "authenticate",
        async (request: { headers: Record<string, unknown>; userId?: string; authAuthority?: "present_user"; authTokenKind?: "account" }, reply: any) => {
            const accountId = request.headers["x-test-user-id"];
            if (typeof accountId !== "string" || accountId.length === 0) {
                return reply.code(401).send({ error: "Unauthorized" });
            }
            request.userId = accountId;
            request.authAuthority = "present_user";
            request.authTokenKind = "account";
        },
    );
    enableErrorHandlers(typed);
    registerAccountEncryptionMigrateRoutes(typed);
    return typed;
}

describe("Account encryption migration staged transition admission", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-encryption-transition-compatibility-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);

    afterEach(async () => {
        harness.resetEnv();
        await db.accountEncryptionTransitionCollectionStage.deleteMany();
        await db.accountEncryptionTransition.deleteMany();
        await db.accountChange.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });
    it("keeps incomplete staged transitions closed without requiring a client-version declaration", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true, seq: true },
        });
        const app = createTestApp();
        try {
            for (const operation of V5_OPERATION_REQUESTS) {
                const response = await app.inject({
                    method: "POST",
                    url: operation.path,
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: operation.payload,
                });
                if (operation.path.endsWith("/cancel")) {
                    expect(response.statusCode, response.body).toBe(404);
                    expect(response.json()).toEqual({ error: "not_found" });
                } else {
                    expect(response.statusCode, operation.path + ": " + response.body).toBe(400);
                    expect(response.json()).toEqual({ error: "migration_too_large" });
                }
            }
            expect(await db.account.findUniqueOrThrow({
                where: { id: account.id }, select: { encryptionMode: true, seq: true },
            })).toEqual({ encryptionMode: "plain", seq: account.seq });
            expect(await db.accountEncryptionTransition.count({ where: { accountId: account.id } })).toBe(0);
            expect(await db.accountEncryptionTransitionCollectionStage.count()).toBe(0);
            expect(await db.accountChange.count({ where: { accountId: account.id } })).toBe(0);
        } finally {
            await app.close();
        }
    });

});
