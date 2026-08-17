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
    buildAccountStoredContentCompatibilityHttpHeadersV1,
    AccountStoredContentUpgradeRequiredV1Schema,
} from "@happier-dev/protocol";
import {
    serializerCompiler,
    validatorCompiler,
    ZodTypeProvider,
} from "fastify-type-provider-zod";

import { db } from "@/storage/db";
import {
    captureAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
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
        async (request: { headers: Record<string, unknown>; userId?: string }, reply: any) => {
            const accountId = request.headers["x-test-user-id"];
            if (typeof accountId !== "string" || accountId.length === 0) {
                return reply.code(401).send({ error: "Unauthorized" });
            }
            request.userId = accountId;
            captureAccountStoredContentCompatibilityForHttpRequest(request as any);
        },
    );
    enableErrorHandlers(typed);
    registerAccountEncryptionMigrateRoutes(typed);
    return typed;
}

describe("Account encryption migration V5 transition compatibility", () => {
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

    it.each([3, 4] as const)(
        "returns the V5 operation-scoped typed refusal before mutation for V%s clients",
        async (protocolVersion) => {
            const account = await db.account.create({
                data: {
                    encryptionMode: "plain",
                    publicKey: null,
                    contentPublicKey: null,
                    contentPublicKeySig: null,
                },
                select: { id: true, seq: true },
            });
            const app = createTestApp();
            await app.ready();

            try {
                const compatibilityHeaders =
                    buildAccountStoredContentCompatibilityHttpHeadersV1({
                        v: 1,
                        protocolVersion,
                    });
                for (const operation of V5_OPERATION_REQUESTS) {
                    const response = await app.inject({
                        method: "POST",
                        url: operation.path,
                        headers: {
                            "content-type": "application/json",
                            "x-test-user-id": account.id,
                            ...compatibilityHeaders,
                        },
                        payload: operation.payload,
                    });

                    expect(response.statusCode, `${operation.path}: ${response.body}`)
                        .toBe(426);
                    expect(
                        AccountStoredContentUpgradeRequiredV1Schema.parse(
                            response.json(),
                        ),
                    ).toEqual({
                        error: "client-upgrade-required",
                        requirement: {
                            v: 1,
                            kind: "account-stored-content",
                            minimumProtocolVersion: 5,
                        },
                    });
                }

                await expect(db.account.findUniqueOrThrow({
                    where: { id: account.id },
                    select: { encryptionMode: true, seq: true },
                })).resolves.toEqual({ encryptionMode: "plain", seq: account.seq });
                await expect(db.accountEncryptionTransition.count({
                    where: { accountId: account.id },
                })).resolves.toBe(0);
                await expect(db.accountEncryptionTransitionCollectionStage.count()).resolves.toBe(0);
                await expect(db.accountChange.count({
                    where: { accountId: account.id },
                })).resolves.toBe(0);
            } finally {
                await app.close();
            }
        },
    );

    it("keeps every V5 transition operation unreachable while the server declaration remains V3", async () => {
        const account = await db.account.create({
            data: {
                encryptionMode: "plain",
                publicKey: null,
                contentPublicKey: null,
                contentPublicKeySig: null,
            },
            select: { id: true },
        });
        const app = createTestApp();
        await app.ready();
        const compatibilityHeaders =
            buildAccountStoredContentCompatibilityHttpHeadersV1({
                v: 1,
                protocolVersion: 5,
            });

        try {
            for (const operation of V5_OPERATION_REQUESTS) {
                const response = await app.inject({
                    method: "POST",
                    url: operation.path,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                        ...compatibilityHeaders,
                    },
                    payload: operation.payload,
                });
                expect(response.statusCode, `${operation.path}: ${response.body}`)
                    .toBe(426);
                expect(
                    AccountStoredContentUpgradeRequiredV1Schema.parse(response.json()),
                ).toEqual({
                    error: "client-upgrade-required",
                    requirement: {
                        v: 1,
                        kind: "account-stored-content",
                        minimumProtocolVersion: 5,
                    },
                });
            }
            await expect(db.accountEncryptionTransition.count({
                where: { accountId: account.id },
            })).resolves.toBe(0);
            await expect(db.accountEncryptionTransitionCollectionStage.count()).resolves.toBe(0);
            await expect(db.accountChange.count({ where: { accountId: account.id } })).resolves.toBe(0);
        } finally {
            await app.close();
        }
    });
});
