import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import crypto from "node:crypto";
import {
    createKeyChallengeV2SigningInput,
    createExpectedAccountKeyChallengeSigningInputV1,
} from "@happier-dev/protocol";

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { registerKeyChallengeAuthRoute } from "./registerKeyChallengeAuthRoute";
import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

function ownedBytes(
    bytes: Uint8Array,
): Uint8Array<ArrayBuffer> {
    const copy =
        new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
}

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    return app.withTypeProvider<ZodTypeProvider>() as any;
}

function createContentKeyBinding(
    signingSecretKey: Uint8Array,
    contentPublicKey: Uint8Array,
): Uint8Array {
    return tweetnacl.sign.detached(
        Buffer.concat([
            Buffer.from("Happy content key v1\u0000", "utf8"),
            Buffer.from(contentPublicKey),
        ]),
        signingSecretKey,
    );
}

function createExpectedAccountLoginPayload(params: Readonly<{
    signing: tweetnacl.SignKeyPair;
    contentPublicKey: Uint8Array;
    contentPublicKeySig: Uint8Array;
    expectedAccountId: string;
}>): Readonly<Record<string, string>> {
    const challenge = new Uint8Array(crypto.randomBytes(32));
    const signingInput =
        createExpectedAccountKeyChallengeSigningInputV1({
            challenge,
            expectedAccountId: params.expectedAccountId,
        });
    return {
        publicKey: privacyKit.encodeBase64(
            ownedBytes(params.signing.publicKey),
        ),
        challenge: privacyKit.encodeBase64(challenge),
        signature: privacyKit.encodeBase64(
            ownedBytes(
                tweetnacl.sign.detached(
                    signingInput,
                    ownedBytes(
                        params.signing.secretKey,
                    ),
                ),
            ),
        ),
        contentPublicKey:
            privacyKit.encodeBase64(
                ownedBytes(params.contentPublicKey),
            ),
        contentPublicKeySig:
            privacyKit.encodeBase64(
                ownedBytes(params.contentPublicKeySig),
            ),
        expectedAccountId: params.expectedAccountId,
    };
}

type KeyChallengeV2IssueResponse = Readonly<{
    challengeId: string;
    nonce: string;
    issuedAt: string;
    expiresAt: string;
    audience: Readonly<{
        origin: string;
        serverIdentityId?: string;
    }>;
}>;

function createKeyChallengeV2LoginPayload(params: Readonly<{
    challenge: KeyChallengeV2IssueResponse;
    signing: tweetnacl.SignKeyPair;
}>): Readonly<Record<string, string>> {
    return {
        challengeId: params.challenge.challengeId,
        publicKey: privacyKit.encodeBase64(ownedBytes(params.signing.publicKey)),
        signature: privacyKit.encodeBase64(
            ownedBytes(
                tweetnacl.sign.detached(
                createKeyChallengeV2SigningInput(params.challenge),
                ownedBytes(params.signing.secretKey),
                ),
            ),
        ),
    };
}

describe("registerKeyChallengeAuthRoute (lazy auth init) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-key-challenge-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);

    afterEach(() => {
        vi.useRealTimers();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("initializes the auth module on demand so /v1/auth succeeds without server bootstrap", async () => {
        const app = createTestApp();
        registerKeyChallengeAuthRoute(app);
        await app.ready();

        const kp = tweetnacl.sign.keyPair();
        const challenge = crypto.randomBytes(32);
        const signature = tweetnacl.sign.detached(challenge, kp.secretKey);

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: {
                publicKey: privacyKit.encodeBase64(new Uint8Array(kp.publicKey)),
                challenge: privacyKit.encodeBase64(new Uint8Array(challenge)),
                signature: privacyKit.encodeBase64(new Uint8Array(signature)),
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            success: true,
            token: expect.any(String),
        });

        await app.close();
        harness.resetEnv();
    });

    it("accepts browser key-challenge signups that include content encryption keys", async () => {
        const app = createTestApp();
        registerKeyChallengeAuthRoute(app);
        await app.ready();

        const signing = tweetnacl.sign.keyPair();
        const contentKey = tweetnacl.box.keyPair();
        const challenge = crypto.randomBytes(32);
        const signature = tweetnacl.sign.detached(challenge, signing.secretKey);
        const binding = Buffer.concat([
            Buffer.from("Happy content key v1\u0000", "utf8"),
            Buffer.from(contentKey.publicKey),
        ]);
        const contentSignature = tweetnacl.sign.detached(binding, signing.secretKey);

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: {
                publicKey: privacyKit.encodeBase64(new Uint8Array(signing.publicKey)),
                challenge: privacyKit.encodeBase64(new Uint8Array(challenge)),
                signature: privacyKit.encodeBase64(new Uint8Array(signature)),
                contentPublicKey: privacyKit.encodeBase64(new Uint8Array(contentKey.publicKey)),
                contentPublicKeySig: privacyKit.encodeBase64(new Uint8Array(contentSignature)),
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            success: true,
            token: expect.any(String),
        });

        await app.close();
        harness.resetEnv();
    });

    it("preserves absent-Account provisioning but rejects a later inconsistent E2EE login without touching updatedAt", async () => {
        const app = createTestApp();
        registerKeyChallengeAuthRoute(app);
        await app.ready();

        const kp = tweetnacl.sign.keyPair();
        const publicKeyB64 = privacyKit.encodeBase64(new Uint8Array(kp.publicKey));
        const publicKeyHex = privacyKit.encodeHex(new Uint8Array(kp.publicKey));

        const challenge1 = crypto.randomBytes(32);
        const signature1 = tweetnacl.sign.detached(challenge1, kp.secretKey);

        const res1 = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: {
                publicKey: publicKeyB64,
                challenge: privacyKit.encodeBase64(new Uint8Array(challenge1)),
                signature: privacyKit.encodeBase64(new Uint8Array(signature1)),
            },
        });
        expect(res1.statusCode).toBe(200);

        const afterFirst = await db.account.findUnique({
            where: { publicKey: publicKeyHex },
            select: { id: true, updatedAt: true },
        });
        expect(afterFirst?.id).toBeTruthy();
        expect(afterFirst?.updatedAt).toBeInstanceOf(Date);

        await new Promise((resolve) => setTimeout(resolve, 25));

        const challenge2 = crypto.randomBytes(32);
        const signature2 = tweetnacl.sign.detached(challenge2, kp.secretKey);
        const res2 = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: {
                publicKey: publicKeyB64,
                challenge: privacyKit.encodeBase64(new Uint8Array(challenge2)),
                signature: privacyKit.encodeBase64(new Uint8Array(signature2)),
            },
        });

        expect(res2.statusCode).toBe(401);
        expect(res2.json()).toEqual({
            error: "Invalid token",
        });

        const afterSecond = await db.account.findUnique({
            where: { publicKey: publicKeyHex },
            select: { updatedAt: true },
        });
        expect(afterSecond?.updatedAt).toBeInstanceOf(Date);
        expect(afterSecond!.updatedAt.getTime()).toBe(afterFirst!.updatedAt.getTime());

        await app.close();
        harness.resetEnv();
    });

    it("rejects a different signed content key for an existing account without mutating it", async () => {
        const app = createTestApp();
        registerKeyChallengeAuthRoute(app);
        await app.ready();

        const signing = tweetnacl.sign.keyPair();
        const originalContentKey = tweetnacl.box.keyPair();
        const replacementContentKey = tweetnacl.box.keyPair();
        const publicKeyHex = privacyKit.encodeHex(new Uint8Array(signing.publicKey));
        const originalBinding = Buffer.concat([
            Buffer.from("Happy content key v1\u0000", "utf8"),
            Buffer.from(originalContentKey.publicKey),
        ]);
        const originalSignature = tweetnacl.sign.detached(originalBinding, signing.secretKey);
        const account = await db.account.create({
            data: {
                publicKey: publicKeyHex,
                contentPublicKey: new Uint8Array(originalContentKey.publicKey),
                contentPublicKeySig: new Uint8Array(originalSignature),
            },
            select: { id: true, updatedAt: true },
        });

        const challenge = crypto.randomBytes(32);
        const signature = tweetnacl.sign.detached(challenge, signing.secretKey);
        const replacementBinding = Buffer.concat([
            Buffer.from("Happy content key v1\u0000", "utf8"),
            Buffer.from(replacementContentKey.publicKey),
        ]);
        const replacementSignature = tweetnacl.sign.detached(replacementBinding, signing.secretKey);
        const response = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: {
                publicKey: privacyKit.encodeBase64(new Uint8Array(signing.publicKey)),
                challenge: privacyKit.encodeBase64(new Uint8Array(challenge)),
                signature: privacyKit.encodeBase64(new Uint8Array(signature)),
                contentPublicKey: privacyKit.encodeBase64(new Uint8Array(replacementContentKey.publicKey)),
                contentPublicKeySig: privacyKit.encodeBase64(new Uint8Array(replacementSignature)),
            },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: "content_public_key_mismatch" });
        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                contentPublicKey: true,
                contentPublicKeySig: true,
                updatedAt: true,
            },
        })).resolves.toEqual({
            contentPublicKey: new Uint8Array(originalContentKey.publicKey),
            contentPublicKeySig: new Uint8Array(originalSignature),
            updatedAt: account.updatedAt,
        });

        await app.close();
        harness.resetEnv();
    });

    it("fills a missing signature for the exact same content key after validating proof", async () => {
        const app = createTestApp();
        registerKeyChallengeAuthRoute(app);
        await app.ready();

        const signing = tweetnacl.sign.keyPair();
        const contentKey = tweetnacl.box.keyPair();
        const account = await db.account.create({
            data: {
                publicKey: privacyKit.encodeHex(new Uint8Array(signing.publicKey)),
                encryptionMode: "plain",
                contentPublicKey: new Uint8Array(contentKey.publicKey),
                contentPublicKeySig: null,
            },
            select: { id: true },
        });
        const challenge = crypto.randomBytes(32);
        const signature = tweetnacl.sign.detached(challenge, signing.secretKey);
        const binding = Buffer.concat([
            Buffer.from("Happy content key v1\u0000", "utf8"),
            Buffer.from(contentKey.publicKey),
        ]);
        const contentSignature = tweetnacl.sign.detached(binding, signing.secretKey);

        const response = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: {
                publicKey: privacyKit.encodeBase64(new Uint8Array(signing.publicKey)),
                challenge: privacyKit.encodeBase64(new Uint8Array(challenge)),
                signature: privacyKit.encodeBase64(new Uint8Array(signature)),
                contentPublicKey: privacyKit.encodeBase64(new Uint8Array(contentKey.publicKey)),
                contentPublicKeySig: privacyKit.encodeBase64(new Uint8Array(contentSignature)),
            },
        });

        expect(response.statusCode).toBe(200);
        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { contentPublicKey: true, contentPublicKeySig: true },
        })).resolves.toEqual({
            contentPublicKey: new Uint8Array(contentKey.publicKey),
            contentPublicKeySig: new Uint8Array(contentSignature),
        });

        await app.close();
        harness.resetEnv();
    });

    it("rejects inconsistent persisted E2EE bindings before ordinary or Account-bound token issuance", async () => {
        const app = createTestApp();
        registerKeyChallengeAuthRoute(app);
        await app.ready();

        const signing = tweetnacl.sign.keyPair();
        const contentKey = tweetnacl.box.keyPair();
        const contentPublicKeySig = createContentKeyBinding(
            signing.secretKey,
            contentKey.publicKey,
        );
        const account = await db.account.create({
            data: {
                publicKey:
                    privacyKit.encodeHex(
                        ownedBytes(signing.publicKey),
                    ),
                encryptionMode: "e2ee",
                contentPublicKey:
                    new Uint8Array(contentKey.publicKey),
                contentPublicKeySig: null,
            },
            select: {
                id: true,
                updatedAt: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
            },
        });
        const challenge =
            new Uint8Array(crypto.randomBytes(32));
        const ordinaryPayload = {
            publicKey:
                privacyKit.encodeBase64(
                    ownedBytes(signing.publicKey),
                ),
            challenge:
                privacyKit.encodeBase64(challenge),
            signature: privacyKit.encodeBase64(
                ownedBytes(
                    tweetnacl.sign.detached(
                        challenge,
                        ownedBytes(
                            signing.secretKey,
                        ),
                    ),
                ),
            ),
            contentPublicKey:
                privacyKit.encodeBase64(
                    ownedBytes(
                        contentKey.publicKey,
                    ),
                ),
            contentPublicKeySig:
                privacyKit.encodeBase64(
                    ownedBytes(
                        contentPublicKeySig,
                    ),
                ),
        };
        const createToken =
            vi.spyOn(auth, "createToken");

        for (const payload of [
            ordinaryPayload,
            createExpectedAccountLoginPayload({
                signing,
                contentPublicKey:
                    contentKey.publicKey,
                contentPublicKeySig,
                expectedAccountId: account.id,
            }),
        ]) {
            const response = await app.inject({
                method: "POST",
                url: "/v1/auth",
                payload,
            });
            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({
                error: "Invalid token",
            });
        }
        expect(createToken).not.toHaveBeenCalled();
        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                updatedAt: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
            },
        })).resolves.toEqual({
            updatedAt: account.updatedAt,
            contentPublicKey:
                account.contentPublicKey,
            contentPublicKeySig: null,
        });

        createToken.mockRestore();
        await app.close();
        harness.resetEnv();
    });

    it("does not mutate an existing exact signed content-key binding", async () => {
        const app = createTestApp();
        registerKeyChallengeAuthRoute(app);
        await app.ready();

        const signing = tweetnacl.sign.keyPair();
        const contentKey = tweetnacl.box.keyPair();
        const binding = Buffer.concat([
            Buffer.from("Happy content key v1\u0000", "utf8"),
            Buffer.from(contentKey.publicKey),
        ]);
        const contentSignature = tweetnacl.sign.detached(
            binding,
            signing.secretKey,
        );
        const account = await db.account.create({
            data: {
                publicKey: privacyKit.encodeHex(
                    new Uint8Array(signing.publicKey),
                ),
                contentPublicKey:
                    new Uint8Array(contentKey.publicKey),
                contentPublicKeySig:
                    new Uint8Array(contentSignature),
            },
            select: { id: true, updatedAt: true },
        });
        const challenge = crypto.randomBytes(32);
        const signature = tweetnacl.sign.detached(
            challenge,
            signing.secretKey,
        );

        const response = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: {
                publicKey: privacyKit.encodeBase64(
                    new Uint8Array(signing.publicKey),
                ),
                challenge: privacyKit.encodeBase64(
                    new Uint8Array(challenge),
                ),
                signature: privacyKit.encodeBase64(
                    new Uint8Array(signature),
                ),
                contentPublicKey: privacyKit.encodeBase64(
                    new Uint8Array(contentKey.publicKey),
                ),
                contentPublicKeySig: privacyKit.encodeBase64(
                    new Uint8Array(contentSignature),
                ),
            },
        });

        expect(response.statusCode).toBe(200);
        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                contentPublicKey: true,
                contentPublicKeySig: true,
                updatedAt: true,
            },
        })).resolves.toEqual({
            contentPublicKey:
                new Uint8Array(contentKey.publicKey),
            contentPublicKeySig:
                new Uint8Array(contentSignature),
            updatedAt: account.updatedAt,
        });

        await app.close();
        harness.resetEnv();
    });

    it("never provisions an Account from an Account-bound login request", async () => {
        const app = createTestApp();
        registerKeyChallengeAuthRoute(app);
        await app.ready();

        const signing = tweetnacl.sign.keyPair();
        const contentKey = tweetnacl.box.keyPair();
        const contentPublicKeySig = createContentKeyBinding(
            signing.secretKey,
            contentKey.publicKey,
        );
        const publicKeyHex = privacyKit.encodeHex(
            ownedBytes(signing.publicKey),
        );

        const response = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: createExpectedAccountLoginPayload({
                signing,
                contentPublicKey: contentKey.publicKey,
                contentPublicKeySig,
                expectedAccountId: "uncommitted-account-id",
            }),
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: "Invalid token" });
        await expect(db.account.findUnique({
            where: { publicKey: publicKeyHex },
        })).resolves.toBeNull();

        await app.close();
        harness.resetEnv();
    });

    it("logs into only the exact committed E2EE Account without mutating it", async () => {
        const app = createTestApp();
        registerKeyChallengeAuthRoute(app);
        await app.ready();

        const signing = tweetnacl.sign.keyPair();
        const contentKey = tweetnacl.box.keyPair();
        const contentPublicKeySig = createContentKeyBinding(
            signing.secretKey,
            contentKey.publicKey,
        );
        const account = await db.account.create({
            data: {
                publicKey: privacyKit.encodeHex(
                    ownedBytes(signing.publicKey),
                ),
                encryptionMode: "e2ee",
                contentPublicKey:
                    new Uint8Array(contentKey.publicKey),
                contentPublicKeySig:
                    new Uint8Array(contentPublicKeySig),
            },
            select: {
                id: true,
                updatedAt: true,
                publicKey: true,
                encryptionMode: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
            },
        });
        const payload = createExpectedAccountLoginPayload({
            signing,
            contentPublicKey: contentKey.publicKey,
            contentPublicKeySig,
            expectedAccountId: account.id,
        });

        const response = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload,
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            token: expect.any(String),
        });
        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                updatedAt: true,
                publicKey: true,
                encryptionMode: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
            },
        })).resolves.toEqual({
            updatedAt: account.updatedAt,
            publicKey: account.publicKey,
            encryptionMode: account.encryptionMode,
            contentPublicKey: account.contentPublicKey,
            contentPublicKeySig: account.contentPublicKeySig,
        });

        await app.close();
        harness.resetEnv();
    });

    it("fails Account-bound eligibility generically without issuing a token or changing Account bindings", async () => {
        harness.resetEnv({
            AUTH_REQUIRED_LOGIN_PROVIDERS: "github",
            AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
            AUTH_LOGIN_ELIGIBILITY_ACCOUNT_SNAPSHOT_CACHE_TTL_MS:
                "0",
        });
        const app = createTestApp();
        registerKeyChallengeAuthRoute(app);
        await app.ready();

        const signing = tweetnacl.sign.keyPair();
        const contentKey = tweetnacl.box.keyPair();
        const contentPublicKeySig = createContentKeyBinding(
            signing.secretKey,
            contentKey.publicKey,
        );
        const account = await db.account.create({
            data: {
                publicKey:
                    privacyKit.encodeHex(
                        ownedBytes(signing.publicKey),
                    ),
                encryptionMode: "e2ee",
                contentPublicKey:
                    new Uint8Array(contentKey.publicKey),
                contentPublicKeySig:
                    new Uint8Array(contentPublicKeySig),
            },
            select: {
                id: true,
                updatedAt: true,
                publicKey: true,
                encryptionMode: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
            },
        });
        const createToken =
            vi.spyOn(auth, "createToken");
        const accountCountBeforeRequest =
            await db.account.count();

        const response = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: createExpectedAccountLoginPayload({
                signing,
                contentPublicKey: contentKey.publicKey,
                contentPublicKeySig,
                expectedAccountId: account.id,
            }),
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({
            error: "Invalid token",
        });
        expect(createToken).not.toHaveBeenCalled();
        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                updatedAt: true,
                publicKey: true,
                encryptionMode: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
            },
        })).resolves.toEqual({
            updatedAt: account.updatedAt,
            publicKey: account.publicKey,
            encryptionMode: account.encryptionMode,
            contentPublicKey: account.contentPublicKey,
            contentPublicKeySig:
                account.contentPublicKeySig,
        });
        await expect(db.account.count()).resolves.toBe(
            accountCountBeforeRequest,
        );
        await expect(db.accountIdentity.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);

        createToken.mockRestore();
        await app.close();
        harness.resetEnv();
    });

    it("fails Account-bound login generically for wrong Account, mode, key, or content binding with zero mutation", async () => {
        const app = createTestApp();
        registerKeyChallengeAuthRoute(app);
        await app.ready();

        const signing = tweetnacl.sign.keyPair();
        const contentKey = tweetnacl.box.keyPair();
        const contentPublicKeySig = createContentKeyBinding(
            signing.secretKey,
            contentKey.publicKey,
        );
        const account = await db.account.create({
            data: {
                publicKey: privacyKit.encodeHex(
                    ownedBytes(signing.publicKey),
                ),
                encryptionMode: "e2ee",
                contentPublicKey:
                    new Uint8Array(contentKey.publicKey),
                contentPublicKeySig:
                    new Uint8Array(contentPublicKeySig),
            },
            select: {
                id: true,
                updatedAt: true,
                publicKey: true,
                encryptionMode: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
            },
        });
        const replacementContentKey = tweetnacl.box.keyPair();
        const replacementContentPublicKeySig =
            createContentKeyBinding(
                signing.secretKey,
                replacementContentKey.publicKey,
            );
        const wrongSigning = tweetnacl.sign.keyPair();
        const wrongSigningContentKey = tweetnacl.box.keyPair();
        const wrongSigningContentPublicKeySig =
            createContentKeyBinding(
                wrongSigning.secretKey,
                wrongSigningContentKey.publicKey,
            );
        const requests = [
            createExpectedAccountLoginPayload({
                signing,
                contentPublicKey: contentKey.publicKey,
                contentPublicKeySig,
                expectedAccountId: `${account.id}-wrong`,
            }),
            createExpectedAccountLoginPayload({
                signing,
                contentPublicKey: replacementContentKey.publicKey,
                contentPublicKeySig:
                    replacementContentPublicKeySig,
                expectedAccountId: account.id,
            }),
            createExpectedAccountLoginPayload({
                signing: wrongSigning,
                contentPublicKey:
                    wrongSigningContentKey.publicKey,
                contentPublicKeySig:
                    wrongSigningContentPublicKeySig,
                expectedAccountId: account.id,
            }),
            {
                ...createExpectedAccountLoginPayload({
                    signing,
                    contentPublicKey: contentKey.publicKey,
                    contentPublicKeySig,
                    expectedAccountId: account.id,
                }),
                contentPublicKey: undefined,
                contentPublicKeySig: undefined,
            },
        ];

        for (const payload of requests) {
            const response = await app.inject({
                method: "POST",
                url: "/v1/auth",
                payload,
            });
            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({
                error: "Invalid token",
            });
        }

        const plainAccount = await db.account.update({
            where: { id: account.id },
            data: { encryptionMode: "plain" },
            select: {
                updatedAt: true,
            },
        });
        const plainResponse = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: createExpectedAccountLoginPayload({
                signing,
                contentPublicKey: contentKey.publicKey,
                contentPublicKeySig,
                expectedAccountId: account.id,
            }),
        });
        expect(plainResponse.statusCode).toBe(401);
        expect(plainResponse.json()).toEqual({
            error: "Invalid token",
        });

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                updatedAt: true,
                publicKey: true,
                encryptionMode: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
            },
        })).resolves.toEqual({
            updatedAt: plainAccount.updatedAt,
            publicKey: account.publicKey,
            encryptionMode: "plain",
            contentPublicKey: account.contentPublicKey,
            contentPublicKeySig: account.contentPublicKeySig,
        });
        await expect(db.account.findUnique({
            where: {
                publicKey:
                    privacyKit.encodeHex(
                        ownedBytes(
                            wrongSigning.publicKey,
                        ),
                    ),
            },
        })).resolves.toBeNull();

        await app.close();
        harness.resetEnv();
    });

    it("refuses v2 challenge issuance rather than deriving its audience from Host", async () => {
        harness.resetEnv({
            HAPPIER_PUBLIC_SERVER_URL: "",
        });
        const app = createTestApp();
        registerKeyChallengeAuthRoute(app);
        await app.ready();

        const response = await app.inject({
            method: "POST",
            url: "/v1/auth/challenge",
            headers: { host: "attacker.example.test" },
            payload: {},
        });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({
            error: "key_challenge_v2_unavailable",
        });

        await app.close();
        harness.resetEnv();
    });

    it("issues a canonical origin-bound challenge and rejects its same-server replay", async () => {
        harness.resetEnv({
            HAPPIER_PUBLIC_SERVER_URL: "https://server-a.example.test/api",
            HAPPIER_SERVER_IDENTITY_ID: "srv_challenge_a",
        });
        const app = createTestApp();
        registerKeyChallengeAuthRoute(app);
        await app.ready();

        const signing = tweetnacl.sign.keyPair();
        await db.account.create({
            data: {
                publicKey: privacyKit.encodeHex(ownedBytes(signing.publicKey)),
                encryptionMode: "plain",
            },
        });
        const issued = await app.inject({
            method: "POST",
            url: "/v1/auth/challenge",
            payload: {},
        });
        expect(issued.statusCode).toBe(200);
        const challenge = issued.json() as KeyChallengeV2IssueResponse;
        expect(challenge).toMatchObject({
            challengeId: expect.any(String),
            nonce: expect.any(String),
            issuedAt: expect.any(String),
            expiresAt: expect.any(String),
            audience: {
                origin: "https://server-a.example.test",
                serverIdentityId: "srv_challenge_a",
            },
        });
        const payload = createKeyChallengeV2LoginPayload({
            challenge,
            signing,
        });

        const first = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload,
        });
        const replay = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload,
        });

        expect(first.statusCode).toBe(200);
        expect(replay.statusCode).toBe(401);

        await app.close();
        harness.resetEnv();
    });

    it("rejects a v2 assertion relayed from the issuing public origin to another server", async () => {
        harness.resetEnv({
            HAPPIER_PUBLIC_SERVER_URL: "https://server-a.example.test/api",
            HAPPIER_SERVER_IDENTITY_ID: "srv_challenge_a",
        });
        const issuingApp = createTestApp();
        registerKeyChallengeAuthRoute(issuingApp);
        await issuingApp.ready();

        const signing = tweetnacl.sign.keyPair();
        await db.account.create({
            data: {
                publicKey: privacyKit.encodeHex(ownedBytes(signing.publicKey)),
                encryptionMode: "plain",
            },
        });
        const issued = await issuingApp.inject({
            method: "POST",
            url: "/v1/auth/challenge",
            payload: {},
        });
        expect(issued.statusCode).toBe(200);

        harness.resetEnv({
            HAPPIER_PUBLIC_SERVER_URL: "https://server-b.example.test/api",
            HAPPIER_SERVER_IDENTITY_ID: "srv_challenge_b",
        });
        const receivingApp = createTestApp();
        registerKeyChallengeAuthRoute(receivingApp);
        await receivingApp.ready();

        const response = await receivingApp.inject({
            method: "POST",
            url: "/v1/auth",
            payload: createKeyChallengeV2LoginPayload({
                challenge: issued.json() as KeyChallengeV2IssueResponse,
                signing,
            }),
        });

        expect(response.statusCode).toBe(401);

        await issuingApp.close();
        await receivingApp.close();
        harness.resetEnv();
    });

    it("rejects a v2 assertion after the issued challenge expires", async () => {
        harness.resetEnv({
            HAPPIER_PUBLIC_SERVER_URL: "https://server-a.example.test/api",
            HAPPIER_SERVER_IDENTITY_ID: "srv_challenge_a",
        });
        const app = createTestApp();
        registerKeyChallengeAuthRoute(app);
        await app.ready();

        const signing = tweetnacl.sign.keyPair();
        await db.account.create({
            data: {
                publicKey: privacyKit.encodeHex(ownedBytes(signing.publicKey)),
                encryptionMode: "plain",
            },
        });
        const issued = await app.inject({
            method: "POST",
            url: "/v1/auth/challenge",
            payload: {},
        });
        expect(issued.statusCode).toBe(200);
        const challenge = issued.json() as KeyChallengeV2IssueResponse;
        const expiresAt = new Date(Date.now() - 1_000);
        await db.keyChallengeV2.update({
            where: { id: challenge.challengeId },
            data: { expiresAt },
        });

        const response = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: createKeyChallengeV2LoginPayload({
                challenge: {
                    ...challenge,
                    expiresAt: expiresAt.toISOString(),
                },
                signing,
            }),
        });

        expect(response.statusCode).toBe(401);

        await app.close();
        harness.resetEnv();
    });

    it("allows only one concurrent v2 redemption", async () => {
        harness.resetEnv({
            HAPPIER_PUBLIC_SERVER_URL: "https://server-a.example.test/api",
            HAPPIER_SERVER_IDENTITY_ID: "srv_challenge_a",
        });
        const app = createTestApp();
        registerKeyChallengeAuthRoute(app);
        await app.ready();

        const signing = tweetnacl.sign.keyPair();
        await db.account.create({
            data: {
                publicKey: privacyKit.encodeHex(ownedBytes(signing.publicKey)),
                encryptionMode: "plain",
            },
        });
        const issued = await app.inject({
            method: "POST",
            url: "/v1/auth/challenge",
            payload: {},
        });
        expect(issued.statusCode).toBe(200);
        const payload = createKeyChallengeV2LoginPayload({
            challenge: issued.json() as KeyChallengeV2IssueResponse,
            signing,
        });

        const responses = await Promise.all([
            app.inject({ method: "POST", url: "/v1/auth", payload }),
            app.inject({ method: "POST", url: "/v1/auth", payload }),
        ]);

        expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 401]);

        await app.close();
        harness.resetEnv();
    });
});
