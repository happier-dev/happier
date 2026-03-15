import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import crypto from "node:crypto";

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { registerKeyChallengeAuthRoute } from "./registerKeyChallengeAuthRoute";
import { db } from "@/storage/db";

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    return app.withTypeProvider<ZodTypeProvider>() as any;
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
        harness.restoreEnv();
    });

    it("does not touch account updatedAt when content keys are not provided", async () => {
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

        expect(res2.statusCode).toBe(200);

        const afterSecond = await db.account.findUnique({
            where: { publicKey: publicKeyHex },
            select: { updatedAt: true },
        });
        expect(afterSecond?.updatedAt).toBeInstanceOf(Date);
        expect(afterSecond!.updatedAt.getTime()).toBe(afterFirst!.updatedAt.getTime());

        await app.close();
        harness.restoreEnv();
    });
});
