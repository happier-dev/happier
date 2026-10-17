import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import { encodeBase64, signMachineInstallationProof } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { deriveKeylessAccountContentPublicKeyFingerprint } from "@/app/auth/keyless/keylessAccountContentKey";
import { machinesRoutes } from "./machinesRoutes";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function randomFingerprint(): string {
    return `content-public-key-sha256:${privacyKit.encodeHex(new Uint8Array(tweetnacl.randomBytes(32))).toLowerCase()}`;
}

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    machinesRoutes(typed);
    return trackApp(typed);
}

async function createAccountWithMachine(kind: "keyless" | "keyed") {
    const account = await db.account.create({
        data: kind === "keyless"
            ? { publicKey: null, encryptionMode: "plain" }
            : { publicKey: privacyKit.encodeHex(new Uint8Array(tweetnacl.sign.keyPair().publicKey)), encryptionMode: "e2ee" },
        select: { id: true },
    });
    const original = randomFingerprint();
    await db.machine.create({
        data: { id: "m1", accountId: account.id, metadata: "meta", installationId: "install-1", contentPublicKeyFingerprint: original },
    });
    return { accountId: account.id, original };
}

async function registerWithFingerprint(accountId: string, contentPublicKeyFingerprint: string) {
    const installationKey = tweetnacl.sign.keyPair();
    const installationProof = signMachineInstallationProof({
        payload: { version: 1, installationId: "install-1", machineId: "m1", contentPublicKeyFingerprint, accountId },
        privateKey: installationKey.secretKey,
    });
    const app = createTestApp();
    await app.ready();
    const res = await app.inject({
        method: "POST",
        url: "/v1/machines",
        headers: { authorization: `Bearer ${await auth.createToken(accountId)}` },
        payload: {
            id: "m1",
            metadata: "meta",
            installationId: "install-1",
            installationPublicKey: encodeBase64(installationKey.publicKey, "base64url"),
            installationProof,
            contentPublicKeyFingerprint,
        },
    });
    const row = await db.machine.findFirst({ where: { accountId, id: "m1" }, select: { contentPublicKeyFingerprint: true } });
    return { res, fingerprint: row?.contentPublicKeyFingerprint ?? null };
}

describe("machinesRoutes: keyless account content key (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-machines-keyless-content-key-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);
    afterEach(async () => {
        await closeTrackedApps();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });
    afterAll(async () => {
        await harness.close();
    });

    it("moves a keyless account's machine onto the account content key", async () => {
        const { accountId } = await createAccountWithMachine("keyless");
        const accountKeyFingerprint = deriveKeylessAccountContentPublicKeyFingerprint(accountId);

        const { res, fingerprint } = await registerWithFingerprint(accountId, accountKeyFingerprint);

        expect(res.statusCode, res.body).toBe(200);
        expect(fingerprint).toBe(accountKeyFingerprint);
    });

    it("still refuses to move a keyless account's machine onto any other key", async () => {
        const { accountId, original } = await createAccountWithMachine("keyless");

        const { res, fingerprint } = await registerWithFingerprint(accountId, randomFingerprint());

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "invalid-params", reason: "content_public_key_fingerprint_mismatch" });
        expect(fingerprint).toBe(original);
    });

    it("never moves a keyed account's machine", async () => {
        const { accountId, original } = await createAccountWithMachine("keyed");

        const { res, fingerprint } = await registerWithFingerprint(accountId, deriveKeylessAccountContentPublicKeyFingerprint(accountId));

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "invalid-params", reason: "content_public_key_fingerprint_mismatch" });
        expect(fingerprint).toBe(original);
    });
});
