import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import {
    sealTerminalProvisioningV3Payload,
    sealTerminalProvisioningV3TokenOnlyPayload,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { authRoutes } from "./authRoutes";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    return trackApp(typed);
}

function createAccountKeypair() {
    const kp = tweetnacl.box.keyPair();
    return {
        publicKeyRaw: new Uint8Array(kp.publicKey),
        secretKeyRaw: new Uint8Array(kp.secretKey),
        publicKeyBase64: privacyKit.encodeBase64(new Uint8Array(kp.publicKey)),
    };
}

function decryptTokenEncrypted(params: { tokenEncryptedBase64: string; recipientSecretKey: Uint8Array }): string | null {
    const bundle = privacyKit.decodeBase64(params.tokenEncryptedBase64);
    const ephemeralPublicKey = bundle.slice(0, tweetnacl.box.publicKeyLength);
    const nonce = bundle.slice(tweetnacl.box.publicKeyLength, tweetnacl.box.publicKeyLength + tweetnacl.box.nonceLength);
    const ciphertext = bundle.slice(tweetnacl.box.publicKeyLength + tweetnacl.box.nonceLength);
    const opened = tweetnacl.box.open(ciphertext, nonce, ephemeralPublicKey, params.recipientSecretKey);
    if (!opened) {
        return null;
    }
    return new TextDecoder().decode(opened);
}

const HOME_SERVER_IDENTITY_ID = "srv_account_auth_home";

function createProvisioningResponse(params: Readonly<{
    kind: "tokenOnly" | "dataKey";
    recipientPublicKey: Uint8Array;
}>): string {
    const pairingSecret = tweetnacl.randomBytes(32);
    const createdAtMs = Date.now() - 1_000;
    const expiresAtMs = Date.now() + 60_000;
    const payload = params.kind === "tokenOnly"
        ? sealTerminalProvisioningV3TokenOnlyPayload({
            terminalEphemeralPublicKey: params.recipientPublicKey,
            pairingSecret,
            createdAtMs,
            expiresAtMs,
            randomBytes: tweetnacl.randomBytes,
        })
        : sealTerminalProvisioningV3Payload({
            contentPrivateKey: tweetnacl.randomBytes(32),
            terminalEphemeralPublicKey: params.recipientPublicKey,
            pairingSecret,
            createdAtMs,
            expiresAtMs,
            randomBytes: tweetnacl.randomBytes,
        });
    return privacyKit.encodeBase64(new Uint8Array(payload));
}

async function createDirectQrPairing(params: Readonly<{
    accountId: string;
    publicKeyBase64: string;
}>): Promise<string> {
    const pairing = await db.authPairingSession.create({
        data: {
            accountId: params.accountId,
            secretHash: "direct-qr-secret-hash",
            requestedPublicKey: params.publicKeyBase64,
            requestedBindingProof: "direct-qr-binding-proof",
            requestedAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
            flow: "direct_qr",
        },
        select: { id: true },
    });
    return pairing.id;
}

async function createDirectQrContext(params: Readonly<{
    accountId: string;
    publicKeyBase64: string;
}>): Promise<string> {
    await db.accountAuthRequest.create({
        data: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(params.publicKeyBase64)) },
    });
    return createDirectQrPairing(params);
}

async function createCurrentE2eeAccount(): Promise<{ id: string }> {
    return db.account.create({
        data: {
            ...createSignedAccountContentBinding(),
            encryptionMode: "e2ee",
        },
        select: { id: true },
    });
}

describe("authRoutes (account auth request) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-account-",
            initAuth: true,
            initEncrypt: true,
            env: {
                ACCOUNT_AUTH_REQUEST_TTL_SECONDS: "900",
                HAPPIER_SERVER_IDENTITY_ID: HOME_SERVER_IDENTITY_ID,
            },
        });
    }, 120_000);

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        vi.unstubAllGlobals();
        await db.authPairingSession.deleteMany();
        await db.accountAuthRequest.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("returns requested from /v1/auth/account/request and recreates an expired request", async () => {
        const { publicKeyRaw, publicKeyBase64 } = createAccountKeypair();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/account/request",
            payload: { publicKey: publicKeyBase64 },
        });
        expect(createRes.statusCode).toBe(200);
        expect(createRes.json()).toEqual({ state: "requested" });

        const publicKeyHex = privacyKit.encodeHex(publicKeyRaw);
        const row = await db.accountAuthRequest.findUnique({ where: { publicKey: publicKeyHex } });
        expect(row).toBeTruthy();

        await db.accountAuthRequest.update({
            where: { id: row!.id },
            data: { createdAt: new Date(Date.now() - 901_000) },
        });

        const expiredRes = await app.inject({
            method: "POST",
            url: "/v1/auth/account/request",
            payload: { publicKey: publicKeyBase64 },
        });
        expect(expiredRes.statusCode).toBe(200);
        expect(expiredRes.json()).toEqual({ state: "requested" });

        const refreshed = await db.accountAuthRequest.findUnique({ where: { publicKey: publicKeyHex } });
        expect(refreshed).toBeTruthy();
        expect(refreshed!.id).not.toBe(row!.id);

        await app.close();
    });

    it("refuses malformed account enrollment keys", async () => {
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const response = await app.inject({
            method: "POST",
            url: "/v2/auth/account/request",
            payload: { publicKey: "malformed-requester-key" },
        });

        expect(response.statusCode).toBe(401);
    });

    it("opportunistically deletes at most 32 expired account-auth rows without deleting live rows", async () => {
        const expiredAt = new Date(Date.now() - 901_000);
        await db.accountAuthRequest.createMany({
            data: Array.from({ length: 33 }, (_, index) => ({
                publicKey: `expired-account-auth-${index}`,
                createdAt: expiredAt,
            })),
        });
        const live = await db.accountAuthRequest.create({
            data: { publicKey: "live-account-auth", createdAt: new Date() },
        });
        const requester = createAccountKeypair();
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const response = await app.inject({
            method: "POST",
            url: "/v2/auth/account/request",
            payload: { publicKey: requester.publicKeyBase64 },
        });

        expect(response.statusCode).toBe(200);
        expect(await db.accountAuthRequest.count({ where: { createdAt: { lt: new Date(Date.now() - 900_000) } } })).toBe(1);
        expect(await db.accountAuthRequest.findUnique({ where: { id: live.id } })).toBeTruthy();
    });

    it("does not return authorized from /v1/auth/account/request when the request is expired (even if responded)", async () => {
        const { publicKeyRaw, publicKeyBase64 } = createAccountKeypair();

        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/account/request",
            payload: { publicKey: publicKeyBase64 },
        });
        expect(createRes.statusCode).toBe(200);

        const pairId = await createDirectQrPairing({ accountId: account.id, publicKeyBase64 });
        const response = createProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: publicKeyRaw });

        const approveRes = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                pairId,
                publicKey: publicKeyBase64,
                response,
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                responseKind: "tokenOnly",
            },
        });
        expect(approveRes.statusCode).toBe(200);
        expect(approveRes.json()).toEqual({ success: true });

        const publicKeyHex = privacyKit.encodeHex(publicKeyRaw);
        const row = await db.accountAuthRequest.findUnique({ where: { publicKey: publicKeyHex } });
        expect(row?.response).toBe(response);

        await db.accountAuthRequest.update({
            where: { id: row!.id },
            data: { createdAt: new Date(Date.now() - 901_000) },
        });

        const expiredRes = await app.inject({
            method: "POST",
            url: "/v1/auth/account/request",
            payload: { publicKey: publicKeyBase64 },
        });
        expect(expiredRes.statusCode).toBe(200);
        expect(expiredRes.json()).toEqual({ state: "requested" });

        const refreshed = await db.accountAuthRequest.findUnique({ where: { publicKey: publicKeyHex } });
        expect(refreshed).toBeTruthy();
        expect(refreshed!.response).toBeNull();

        await app.close();
    });

    it("rejects oversized publicKey payloads", async () => {
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/account/request",
            payload: { publicKey: "a".repeat(513) },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "Invalid public key" });

        await app.close();
    });

    it("rejects unknown top-level fields on /v1 and /v2 account request", async () => {
        const { publicKeyBase64 } = createAccountKeypair();
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const v1 = await app.inject({
            method: "POST",
            url: "/v1/auth/account/request",
            payload: { publicKey: publicKeyBase64, smuggled: "field" },
        });
        expect(v1.statusCode).toBe(400);

        const v2 = await app.inject({
            method: "POST",
            url: "/v2/auth/account/request",
            payload: { publicKey: publicKeyBase64, smuggled: "field" },
        });
        expect(v2.statusCode).toBe(400);

        await app.close();
    });

    it("rejects noncanonical base64 requester keys on /v1 and /v2 account request", async () => {
        const { publicKeyBase64 } = createAccountKeypair();
        const unpadded = publicKeyBase64.replace(/=+$/u, "");
        const overPadded = `${unpadded}==`;
        // The shared base64 decoder genuinely accepts these noncanonical variants
        // of the same 32 bytes; only the exact canonical encoding may enroll.
        expect(unpadded).not.toBe(publicKeyBase64);
        expect(overPadded).not.toBe(publicKeyBase64);
        expect(privacyKit.encodeBase64(privacyKit.decodeBase64(unpadded))).toBe(publicKeyBase64);
        expect(privacyKit.encodeBase64(privacyKit.decodeBase64(overPadded))).toBe(publicKeyBase64);

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        for (const url of ["/v1/auth/account/request", "/v2/auth/account/request"]) {
            for (const publicKey of [unpadded, overPadded]) {
                const res = await app.inject({ method: "POST", url, payload: { publicKey } });
                expect(res.statusCode).toBe(401);
                expect(res.json()).toEqual({ error: "Invalid public key" });
            }
        }
        expect(await db.accountAuthRequest.count()).toBe(0);

        const canonicalRes = await app.inject({
            method: "POST",
            url: "/v2/auth/account/request",
            payload: { publicKey: publicKeyBase64 },
        });
        expect(canonicalRes.statusCode).toBe(200);
        expect(canonicalRes.json()).toEqual({ state: "requested" });

        await app.close();
    });

    it("rejects a low-order requester key before creating a request or successor token", async () => {
        const lowOrderPublicKeyRaw = new Uint8Array(tweetnacl.box.publicKeyLength);
        const lowOrderPublicKeyBase64 = privacyKit.encodeBase64(lowOrderPublicKeyRaw);
        const account = await db.account.create({
            data: { publicKey: `pk-low-order-${Date.now()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const presentUserToken = await auth.createToken(
            account.id,
            undefined,
            { kind: "account", authority: "present_user" },
        );
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const request = await app.inject({
            method: "POST",
            url: "/v2/auth/account/request",
            payload: { publicKey: lowOrderPublicKeyBase64 },
        });
        expect(request.statusCode).toBe(401);
        expect(request.json()).toEqual({ error: "Invalid public key" });
        expect(await db.accountAuthRequest.count()).toBe(0);

        const pairId = await createDirectQrContext({
            accountId: account.id,
            publicKeyBase64: lowOrderPublicKeyBase64,
        });
        const validResponseRecipient = createAccountKeypair();
        const response = createProvisioningResponse({
            kind: "tokenOnly",
            recipientPublicKey: validResponseRecipient.publicKeyRaw,
        });
        const beforeRequest = await db.accountAuthRequest.findUniqueOrThrow({
            where: { publicKey: privacyKit.encodeHex(lowOrderPublicKeyRaw) },
            select: { response: true, responseAccountId: true, tokenEncrypted: true },
        });

        const approval = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${presentUserToken}` },
            payload: {
                pairId,
                publicKey: lowOrderPublicKeyBase64,
                response,
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                responseKind: "tokenOnly",
            },
        });
        expect(approval.statusCode).toBe(401);
        expect(approval.json()).toEqual({ error: "Invalid public key" });
        expect(await db.accountAuthRequest.findUniqueOrThrow({
            where: { publicKey: privacyKit.encodeHex(lowOrderPublicKeyRaw) },
            select: { response: true, responseAccountId: true, tokenEncrypted: true },
        })).toEqual(beforeRequest);

        await app.close();
    });

    it("fails closed for noncanonical requester keys on /v1/auth/account/response", async () => {
        const { publicKeyRaw, publicKeyBase64 } = createAccountKeypair();
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const unpadded = publicKeyBase64.replace(/=+$/u, "");
        expect(unpadded).not.toBe(publicKeyBase64);

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const pairId = await createDirectQrContext({ accountId: account.id, publicKeyBase64 });
        const response = createProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: publicKeyRaw });

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                pairId,
                publicKey: unpadded,
                response,
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                responseKind: "tokenOnly",
            },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "Invalid public key" });

        await app.close();
    });

    it("requires an updated requester instead of disclosing plaintext from /v1/auth/account/request", async () => {
        const { publicKeyRaw, publicKeyBase64 } = createAccountKeypair();

        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });

        const app = createTestApp();
        authRoutes(app as any);
        app.get("/_test/whoami", { preHandler: (app as any).authenticate }, async (request: any) => {
            return { userId: request.userId };
        });
        await app.ready();

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/account/request",
            payload: { publicKey: publicKeyBase64 },
        });
        expect(createRes.statusCode).toBe(200);

        const pairId = await createDirectQrPairing({ accountId: account.id, publicKeyBase64 });
        const response = createProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: publicKeyRaw });

        const approveRes = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                pairId,
                publicKey: publicKeyBase64,
                response,
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                responseKind: "tokenOnly",
            },
        });
        expect(approveRes.statusCode).toBe(200);

        const authorizedRes = await app.inject({
            method: "POST",
            url: "/v1/auth/account/request",
            payload: { publicKey: publicKeyBase64 },
        });
        expect(authorizedRes.statusCode).toBe(426);
        expect(authorizedRes.json()).toEqual({ error: "account_provisioning_update_required" });
        expect(authorizedRes.body).not.toContain("tokenEncrypted");
        expect(authorizedRes.body).not.toContain('"token"');

        await app.close();
    });

    it("returns authorized with encrypted token and no plaintext token from /v2/auth/account/request", async () => {
        const { publicKeyRaw, secretKeyRaw, publicKeyBase64 } = createAccountKeypair();

        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const token = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
        });

        const app = createTestApp();
        authRoutes(app as any);
        app.get("/_test/whoami", { preHandler: (app as any).authenticate }, async (request: any) => {
            return { userId: request.userId };
        });
        await app.ready();

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/account/request",
            payload: { publicKey: publicKeyBase64 },
        });
        expect(createRes.statusCode).toBe(200);

        const pairId = await createDirectQrPairing({ accountId: account.id, publicKeyBase64 });
        const response = createProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: publicKeyRaw });

        const approveRes = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                pairId,
                publicKey: publicKeyBase64,
                response,
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                responseKind: "tokenOnly",
            },
        });
        expect(approveRes.statusCode).toBe(200);

        const authorizedRes = await app.inject({
            method: "POST",
            url: "/v2/auth/account/request",
            payload: { publicKey: publicKeyBase64 },
        });
        expect(authorizedRes.statusCode).toBe(200);
        const json = authorizedRes.json() as any;
        expect(json.state).toBe("authorized");
        expect(json.token).toBeUndefined();
        expect(typeof json.tokenEncrypted).toBe("string");
        expect(typeof json.response).toBe("string");

        const repeatedPoll = await app.inject({
            method: "POST",
            url: "/v2/auth/account/request",
            payload: { publicKey: publicKeyBase64 },
        });
        expect(repeatedPoll.statusCode).toBe(200);
        expect(repeatedPoll.json()).toEqual(json);

        const exactBoundPoll = await app.inject({
            method: "POST",
            url: "/v2/auth/account/request",
            payload: {
                publicKey: publicKeyBase64,
                pairId,
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
            },
        });
        expect(exactBoundPoll.json()).toEqual(json);

        for (const payload of [
            { publicKey: publicKeyBase64, pairId: "wrong-pair", homeServerIdentityId: HOME_SERVER_IDENTITY_ID },
            { publicKey: publicKeyBase64, pairId, homeServerIdentityId: "srv_wrong_home" },
        ]) {
            const wrongBoundPoll = await app.inject({ method: "POST", url: "/v2/auth/account/request", payload });
            expect(wrongBoundPoll.statusCode).toBe(200);
            expect(wrongBoundPoll.json()).toEqual({ state: "requested" });
            expect(wrongBoundPoll.body).not.toContain("tokenEncrypted");
        }

        const persisted = await db.accountAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(publicKeyRaw) },
            select: { response: true, responseAccountId: true, tokenEncrypted: true },
        });
        expect(persisted).toEqual({
            response,
            responseAccountId: account.id,
            tokenEncrypted: json.tokenEncrypted,
        });

        const decryptedToken = decryptTokenEncrypted({ tokenEncryptedBase64: json.tokenEncrypted, recipientSecretKey: secretKeyRaw });
        expect(decryptedToken).toBeTruthy();
        expect((await auth.verifyToken(decryptedToken!))?.authenticationEvidence).toBeUndefined();

        const whoamiRes = await app.inject({
            method: "GET",
            url: "/_test/whoami",
            headers: { authorization: `Bearer ${decryptedToken}` },
        });
        expect(whoamiRes.statusCode).toBe(200);
        expect(whoamiRes.json()).toEqual({ userId: account.id });

        await app.close();
    });

    it("requires a present user to approve an account-auth request before its successor token can be polled", async () => {
        const { publicKeyRaw, publicKeyBase64 } = createAccountKeypair();
        const account = await db.account.create({
            data: { publicKey: `pk-terminal-automation-${Date.now()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const [presentUserToken, terminalAutomationToken] = await Promise.all([
            auth.createToken(account.id, undefined, {
                kind: "account",
                authority: "present_user",
                authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
            }),
            auth.createToken(account.id, { session: "terminal-automation" }, {
                kind: "terminal",
                authority: "account_automation",
            }),
        ]);

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const request = await app.inject({
            method: "POST",
            url: "/v2/auth/account/request",
            payload: { publicKey: publicKeyBase64 },
        });
        expect(request.statusCode).toBe(200);
        expect(request.json()).toEqual({ state: "requested" });

        const pairId = await createDirectQrPairing({ accountId: account.id, publicKeyBase64 });
        const response = createProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: publicKeyRaw });

        const automationResponse = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${terminalAutomationToken}` },
            payload: { publicKey: publicKeyBase64, response: "automation must not approve" },
        });
        expect(automationResponse.statusCode).toBe(403);
        expect(automationResponse.json()).toEqual({ error: "present_user_required" });

        const stillRequested = await app.inject({
            method: "POST",
            url: "/v1/auth/account/request",
            payload: { publicKey: publicKeyBase64 },
        });
        expect(stillRequested.statusCode).toBe(200);
        expect(stillRequested.json()).toEqual({ state: "requested" });

        const presentUserResponse = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${presentUserToken}` },
            payload: {
                pairId,
                publicKey: publicKeyBase64,
                response,
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                responseKind: "tokenOnly",
            },
        });
        expect(presentUserResponse.statusCode).toBe(200);
        expect(presentUserResponse.json()).toEqual({ success: true });

        const authorized = await app.inject({
            method: "POST",
            url: "/v2/auth/account/request",
            payload: { publicKey: publicKeyBase64 },
        });
        expect(authorized.statusCode).toBe(200);
        expect(authorized.json()).toMatchObject({
            state: "authorized",
            tokenEncrypted: expect.any(String),
            response,
        });

        await app.close();
    });

    it("accepts only token-only terminal-v3 material for an authoritative plain Home account", async () => {
        const requester = createAccountKeypair();
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const pairId = await createDirectQrContext({
            accountId: account.id,
            publicKeyBase64: requester.publicKeyBase64,
        });
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const mismatched = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                pairId,
                publicKey: requester.publicKeyBase64,
                response: createProvisioningResponse({ kind: "dataKey", recipientPublicKey: requester.publicKeyRaw }),
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                responseKind: "dataKey",
            },
        });
        expect(mismatched.statusCode).toBe(409);
        expect(mismatched.json()).toEqual({ error: "provisioning_kind_mismatch" });
        expect(await db.accountAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(requester.publicKeyRaw) },
            select: { response: true, responseAccountId: true, tokenEncrypted: true },
        })).toEqual({ response: null, responseAccountId: null, tokenEncrypted: null });

        const response = createProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: requester.publicKeyRaw });
        const accepted = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                pairId,
                publicKey: requester.publicKeyBase64,
                response,
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                responseKind: "tokenOnly",
            },
        });
        expect(accepted.statusCode).toBe(200);
        expect(accepted.json()).toEqual({ success: true });
        expect(await db.accountAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(requester.publicKeyRaw) },
            select: { response: true, responseAccountId: true, tokenEncrypted: true },
        })).toEqual({ response, responseAccountId: account.id, tokenEncrypted: expect.any(String) });
        expect(await db.authPairingSession.findUnique({
            where: { id: pairId },
            select: { approvalStatus: true, decidedAt: true },
        })).toEqual({ approvalStatus: "approved", decidedAt: expect.any(Date) });

        const repeated = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                pairId,
                publicKey: requester.publicKeyBase64,
                response,
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                responseKind: "tokenOnly",
            },
        });
        expect(repeated.statusCode).toBe(409);
        expect(repeated.json()).toEqual({ error: "already_completed" });

        const conflicting = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                pairId,
                publicKey: requester.publicKeyBase64,
                response: createProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: requester.publicKeyRaw }),
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                responseKind: "tokenOnly",
            },
        });
        expect(conflicting.statusCode).toBe(409);
        expect(conflicting.json()).toEqual({ error: "already_completed" });
    });

    it("returns the existing direct-QR pairing rejection as a terminal requester outcome", async () => {
        const requester = createAccountKeypair();
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const rejectedPairId = await createDirectQrContext({
            accountId: account.id,
            publicKeyBase64: requester.publicKeyBase64,
        });
        await db.authPairingSession.updateMany({
            where: {
                accountId: account.id,
                flow: "direct_qr",
                requestedPublicKey: requester.publicKeyBase64,
            },
            data: { approvalStatus: "rejected", decidedAt: new Date() },
        });
        const livePairId = await createDirectQrPairing({
            accountId: account.id,
            publicKeyBase64: requester.publicKeyBase64,
        });
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const livePoll = await app.inject({
            method: "POST",
            url: "/v2/auth/account/request",
            payload: {
                publicKey: requester.publicKeyBase64,
                pairId: livePairId,
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
            },
        });
        expect(livePoll.statusCode).toBe(200);
        expect(livePoll.json()).toEqual({ state: "requested" });

        const rejectedPoll = await app.inject({
            method: "POST",
            url: "/v2/auth/account/request",
            payload: {
                publicKey: requester.publicKeyBase64,
                pairId: rejectedPairId,
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
            },
        });

        expect(rejectedPoll.statusCode).toBe(200);
        expect(rejectedPoll.json()).toEqual({ state: "rejected" });
    });

    it("commits one immutable sealed result when differing approvals race", async () => {
        const requester = createAccountKeypair();
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const pairId = await createDirectQrContext({
            accountId: account.id,
            publicKeyBase64: requester.publicKeyBase64,
        });
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();
        const responses = [
            createProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: requester.publicKeyRaw }),
            createProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: requester.publicKeyRaw }),
        ];

        const results = await Promise.all(responses.map((response) => app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                pairId,
                publicKey: requester.publicKeyBase64,
                response,
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                responseKind: "tokenOnly",
            },
        })));
        expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
        expect(results.find((result) => result.statusCode === 409)?.json()).toEqual({ error: "already_completed" });

        const persisted = await db.accountAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(requester.publicKeyRaw) },
            select: { response: true, responseAccountId: true, tokenEncrypted: true },
        });
        expect(responses).toContain(persisted?.response);
        expect(persisted).toMatchObject({
            responseAccountId: account.id,
            tokenEncrypted: expect.any(String),
        });

        const losingResponse = responses.find((response) => response !== persisted?.response)!;
        const retry = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                pairId,
                publicKey: requester.publicKeyBase64,
                response: losingResponse,
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                responseKind: "tokenOnly",
            },
        });
        expect(retry.statusCode).toBe(409);
        expect(retry.json()).toEqual({ error: "already_completed" });
        expect(await db.accountAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(requester.publicKeyRaw) },
            select: { response: true, responseAccountId: true, tokenEncrypted: true },
        })).toEqual(persisted);
    });

    it("answers already_completed only for the exact completed pairing", async () => {
        const requester = createAccountKeypair();
        const requesterPublicKeyHex = privacyKit.encodeHex(requester.publicKeyRaw);
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const otherAccount = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const token = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
        });
        const otherToken = await auth.createToken(otherAccount.id, undefined, {
            kind: "account",
            authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
        });
        const completedPairId = await createDirectQrContext({
            accountId: account.id,
            publicKeyBase64: requester.publicKeyBase64,
        });
        const foreignPairId = await createDirectQrPairing({
            accountId: otherAccount.id,
            publicKeyBase64: requester.publicKeyBase64,
        });
        const pendingPairId = await createDirectQrPairing({
            accountId: account.id,
            publicKeyBase64: requester.publicKeyBase64,
        });
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();
        const complete = (params: Readonly<{ pairId: string; bearer?: string }>) => app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${params.bearer ?? token}` },
            payload: {
                pairId: params.pairId,
                publicKey: requester.publicKeyBase64,
                response: createProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: requester.publicKeyRaw }),
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                responseKind: "tokenOnly",
            },
        });

        expect((await complete({ pairId: completedPairId })).statusCode).toBe(200);
        const persisted = await db.accountAuthRequest.findUnique({
            where: { publicKey: requesterPublicKeyHex },
            select: { response: true, responseAccountId: true, tokenEncrypted: true },
        });

        // Neither a nonexistent pairing, another account's pairing, nor another
        // pending pairing for the same requester key inherits that completion.
        for (const attempt of [
            { pairId: "no-such-pairing-row" },
            // The authenticated principal is part of the pairing lookup. A
            // valid present-user token for the completed Account cannot
            // authorize another Account's pairing even when the requester key
            // is identical.
            { pairId: foreignPairId },
            { pairId: foreignPairId, bearer: otherToken },
            { pairId: pendingPairId },
        ]) {
            const rejected = await complete(attempt);
            expect(rejected.statusCode).toBe(404);
            expect(rejected.json()).toEqual({ error: "Request not found" });
        }
        for (const pairId of [foreignPairId, pendingPairId]) {
            expect(await db.authPairingSession.findUnique({
                where: { id: pairId },
                select: { approvalStatus: true, decidedAt: true },
            })).toEqual({ approvalStatus: null, decidedAt: null });
        }
        expect(await db.accountAuthRequest.findUnique({
            where: { publicKey: requesterPublicKeyHex },
            select: { response: true, responseAccountId: true, tokenEncrypted: true },
        })).toEqual(persisted);

        // The exact pairing keeps rejoining its own immutable committed result,
        // including after the short-lived invite row itself expires.
        await db.authPairingSession.update({
            where: { id: completedPairId },
            data: { expiresAt: new Date(Date.now() - 1_000) },
        });
        const exactRetry = await complete({ pairId: completedPairId });
        expect(exactRetry.statusCode).toBe(409);
        expect(exactRetry.json()).toEqual({ error: "already_completed" });
        expect(await db.accountAuthRequest.findUnique({
            where: { publicKey: requesterPublicKeyHex },
            select: { response: true, responseAccountId: true, tokenEncrypted: true },
        })).toEqual(persisted);

        await app.close();
    });

    it("completes only one pairing when two pairings for the same requester key race", async () => {
        const requester = createAccountKeypair();
        const requesterPublicKeyHex = privacyKit.encodeHex(requester.publicKeyRaw);
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const pairIdA = await createDirectQrContext({
            accountId: account.id,
            publicKeyBase64: requester.publicKeyBase64,
        });
        const pairIdB = await createDirectQrPairing({
            accountId: account.id,
            publicKeyBase64: requester.publicKeyBase64,
        });
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();
        const complete = (pairId: string) => app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                pairId,
                publicKey: requester.publicKeyBase64,
                response: createProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: requester.publicKeyRaw }),
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                responseKind: "tokenOnly",
            },
        });

        const [resultA, resultB] = await Promise.all([complete(pairIdA), complete(pairIdB)]);
        expect([resultA.statusCode, resultB.statusCode].sort()).toEqual([200, 404]);
        const winnerPairId = resultA.statusCode === 200 ? pairIdA : pairIdB;
        const loserPairId = resultA.statusCode === 200 ? pairIdB : pairIdA;
        const loser = resultA.statusCode === 200 ? resultB : resultA;
        expect(loser.json()).toEqual({ error: "Request not found" });
        expect(await db.authPairingSession.findUnique({
            where: { id: winnerPairId },
            select: { approvalStatus: true },
        })).toEqual({ approvalStatus: "approved" });
        expect(await db.authPairingSession.findUnique({
            where: { id: loserPairId },
            select: { approvalStatus: true, decidedAt: true },
        })).toEqual({ approvalStatus: null, decidedAt: null });
        const persisted = await db.accountAuthRequest.findUnique({
            where: { publicKey: requesterPublicKeyHex },
            select: { response: true, responseAccountId: true, tokenEncrypted: true },
        });
        expect(persisted).toMatchObject({
            response: expect.any(String),
            responseAccountId: account.id,
            tokenEncrypted: expect.any(String),
        });

        // A later retry of the losing pairing still never claims the winner's result.
        const retry = await complete(loserPairId);
        expect(retry.statusCode).toBe(404);
        expect(retry.json()).toEqual({ error: "Request not found" });
        expect(await db.accountAuthRequest.findUnique({
            where: { publicKey: requesterPublicKeyHex },
            select: { response: true, responseAccountId: true, tokenEncrypted: true },
        })).toEqual(persisted);

        await app.close();
    });

    it("rechecks pairing expiry when a serializable completion transaction retries", async () => {
        harness.resetEnv({
            HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: "100",
            HAPPIER_DB_TX_RETRY_MAX_DELAY_MS: "100",
            HAPPIER_DB_TX_RETRY_JITTER_FACTOR: "0",
        });
        const requester = createAccountKeypair();
        const requesterPublicKeyHex = privacyKit.encodeHex(requester.publicKeyRaw);
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const pairId = await createDirectQrContext({
            accountId: account.id,
            publicKeyBase64: requester.publicKeyBase64,
        });
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const originalTransaction = db.$transaction.bind(db) as any;
        let injectedRetry = false;
        const retryingTransaction = vi.fn(async (callback: any, options: any) => {
            if (typeof callback !== "function" || injectedRetry) {
                return originalTransaction(callback, options);
            }
            injectedRetry = true;
            try {
                return await originalTransaction(async (tx: any) => {
                    await callback(tx);
                    throw Object.assign(new Error("retry completion after expiry"), { code: "P2034" });
                }, options);
            } catch (error) {
                // inTx waits at least 100 ms before the SQLite retry. Keep the row
                // valid for the request-start timestamp but expired for that retry.
                await db.authPairingSession.update({
                    where: { id: pairId },
                    data: { expiresAt: new Date(Date.now() + 50) },
                });
                throw error;
            }
        });
        (db as any).$transaction = retryingTransaction;

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/auth/account/response",
                headers: { authorization: `Bearer ${token}` },
                payload: {
                    pairId,
                    publicKey: requester.publicKeyBase64,
                    response: createProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: requester.publicKeyRaw }),
                    homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                    responseKind: "tokenOnly",
                },
            });

            expect(injectedRetry).toBe(true);
            expect(response.statusCode).toBe(404);
            expect(response.json()).toEqual({ error: "Request not found" });
            expect(await db.accountAuthRequest.findUnique({
                where: { publicKey: requesterPublicKeyHex },
                select: { response: true, responseAccountId: true, tokenEncrypted: true },
            })).toEqual({ response: null, responseAccountId: null, tokenEncrypted: null });
            expect(await db.authPairingSession.findUnique({
                where: { id: pairId },
                select: { approvalStatus: true, decidedAt: true },
            })).toEqual({ approvalStatus: null, decidedAt: null });
        } finally {
            (db as any).$transaction = originalTransaction;
            await app.close();
        }
    });

    it("rolls back direct-QR completion when the pairing expires during credential minting", async () => {
        const startedAt = new Date("2031-04-05T06:07:08.000Z");
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(startedAt);
        const requester = createAccountKeypair();
        const requesterPublicKeyHex = privacyKit.encodeHex(requester.publicKeyRaw);
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const token = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });
        const pairId = await createDirectQrContext({
            accountId: account.id,
            publicKeyBase64: requester.publicKeyBase64,
        });
        const expiresAt = new Date(startedAt.getTime() + 1_000);
        await db.accountAuthRequest.update({
            where: { publicKey: requesterPublicKeyHex },
            data: { createdAt: startedAt },
        });
        await db.authPairingSession.update({ where: { id: pairId }, data: { expiresAt } });

        const originalCreateTokenInTx = auth.createTokenInTx.bind(auth);
        auth.createTokenInTx = vi.fn(async (...args: Parameters<typeof auth.createTokenInTx>) => {
            const minted = await originalCreateTokenInTx(...args);
            // Model a slow mint/seal boundary without a wall-clock sleep: the
            // transaction entered while valid, but irreversible finalization
            // observes the exact expiry instant, which is already expired.
            vi.setSystemTime(expiresAt);
            return minted;
        }) as typeof auth.createTokenInTx;

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/auth/account/response",
                headers: { authorization: `Bearer ${token}` },
                payload: {
                    pairId,
                    publicKey: requester.publicKeyBase64,
                    response: createProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: requester.publicKeyRaw }),
                    homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                    responseKind: "tokenOnly",
                },
            });

            expect(response.statusCode).toBe(404);
            expect(response.json()).toEqual({ error: "Request not found" });
            expect(await db.accountAuthRequest.findUnique({
                where: { publicKey: requesterPublicKeyHex },
                select: { response: true, responseAccountId: true, tokenEncrypted: true },
            })).toEqual({ response: null, responseAccountId: null, tokenEncrypted: null });
            expect(await db.authPairingSession.findUnique({
                where: { id: pairId },
                select: { approvalStatus: true, decidedAt: true },
            })).toEqual({ approvalStatus: null, decidedAt: null });
        } finally {
            auth.createTokenInTx = originalCreateTokenInTx;
            vi.useRealTimers();
            await app.close();
        }
    });

    it("makes direct-QR approval and explicit rejection mutually exclusive under a race", async () => {
        const requester = createAccountKeypair();
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const pairId = await createDirectQrContext({
            accountId: account.id,
            publicKeyBase64: requester.publicKeyBase64,
        });
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const [approval, rejection] = await Promise.all([
            app.inject({
                method: "POST",
                url: "/v1/auth/account/response",
                headers: { authorization: `Bearer ${token}` },
                payload: {
                    pairId,
                    publicKey: requester.publicKeyBase64,
                    response: createProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: requester.publicKeyRaw }),
                    homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                    responseKind: "tokenOnly",
                },
            }),
            app.inject({
                method: "POST",
                url: "/v1/auth/pairing/consume",
                headers: { authorization: `Bearer ${token}` },
                payload: { pairId, intent: "reject" },
            }),
        ]);
        const authRequest = await db.accountAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(requester.publicKeyRaw) },
        });
        const pairing = await db.authPairingSession.findUnique({ where: { id: pairId } });

        if (rejection.statusCode === 200) {
            expect(approval.statusCode).toBe(404);
            expect(authRequest).toMatchObject({ response: null, responseAccountId: null, tokenEncrypted: null });
            expect(pairing).toMatchObject({ approvalStatus: "rejected" });
        } else {
            expect(approval.statusCode).toBe(200);
            expect(rejection.statusCode).toBe(409);
            expect(rejection.json()).toEqual({ error: "already_decided" });
            expect(authRequest).toMatchObject({
                response: expect.any(String),
                responseAccountId: account.id,
                tokenEncrypted: expect.any(String),
            });
            expect(pairing).toMatchObject({ approvalStatus: "approved" });
        }
    });

    it("fails closed when persisted completion fields are legacy or inconsistent", async () => {
        const legacyRequester = createAccountKeypair();
        const inconsistentRequester = createAccountKeypair();
        const malformedRequester = createAccountKeypair();
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        await db.accountAuthRequest.createMany({
            data: [
                {
                    publicKey: privacyKit.encodeHex(legacyRequester.publicKeyRaw),
                    response: "previously-written-response",
                    responseAccountId: account.id,
                    tokenEncrypted: null,
                },
                {
                    publicKey: privacyKit.encodeHex(inconsistentRequester.publicKeyRaw),
                    response: null,
                    responseAccountId: null,
                    tokenEncrypted: "orphaned-sealed-result",
                },
                {
                    publicKey: privacyKit.encodeHex(malformedRequester.publicKeyRaw),
                    response: "canonical-looking-response",
                    responseAccountId: account.id,
                    tokenEncrypted: "not-base64",
                },
            ],
        });
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const legacy = await app.inject({
            method: "POST",
            url: "/v2/auth/account/request",
            payload: { publicKey: legacyRequester.publicKeyBase64 },
        });
        expect(legacy.statusCode).toBe(426);
        expect(legacy.json()).toEqual({ error: "account_provisioning_update_required" });
        expect(legacy.body).not.toContain('"token"');

        const inconsistent = await app.inject({
            method: "POST",
            url: "/v2/auth/account/request",
            payload: { publicKey: inconsistentRequester.publicKeyBase64 },
        });
        expect(inconsistent.statusCode).toBe(409);
        expect(inconsistent.json()).toEqual({ error: "account_provisioning_inconsistent" });
        expect(inconsistent.body).not.toContain('"token"');

        const malformed = await app.inject({
            method: "POST",
            url: "/v2/auth/account/request",
            payload: { publicKey: malformedRequester.publicKeyBase64 },
        });
        expect(malformed.statusCode).toBe(409);
        expect(malformed.json()).toEqual({ error: "account_provisioning_inconsistent" });
    });

    it("accepts data-key terminal-v3 material for a current E2EE Home account and rejects mismatched kinds", async () => {
        const requester = createAccountKeypair();
        const account = await createCurrentE2eeAccount();
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const pairId = await createDirectQrContext({
            accountId: account.id,
            publicKeyBase64: requester.publicKeyBase64,
        });
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const unavailable = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                pairId,
                publicKey: requester.publicKeyBase64,
                response: createProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: requester.publicKeyRaw }),
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                responseKind: "tokenOnly",
            },
        });
        expect(unavailable.statusCode).toBe(409);
        expect(unavailable.json()).toEqual({ error: "provisioning_kind_mismatch" });

        const response = createProvisioningResponse({ kind: "dataKey", recipientPublicKey: requester.publicKeyRaw });
        const accepted = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                pairId,
                publicKey: requester.publicKeyBase64,
                response,
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                responseKind: "dataKey",
            },
        });
        expect(accepted.statusCode).toBe(200);
        expect(accepted.json()).toEqual({ success: true });
    });

    it("fails closed for inconsistent E2EE currentness and malformed or legacy approval material", async () => {
        const requester = createAccountKeypair();
        const signing = tweetnacl.sign.keyPair();
        const account = await db.account.create({
            data: {
                publicKey: privacyKit.encodeHex(new Uint8Array(signing.publicKey)),
                encryptionMode: "e2ee",
                contentPublicKey: null,
                contentPublicKeySig: null,
            },
            select: { id: true },
        });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const pairId = await createDirectQrContext({
            accountId: account.id,
            publicKeyBase64: requester.publicKeyBase64,
        });
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const inconsistent = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                pairId,
                publicKey: requester.publicKeyBase64,
                response: createProvisioningResponse({ kind: "dataKey", recipientPublicKey: requester.publicKeyRaw }),
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                responseKind: "dataKey",
            },
        });
        expect(inconsistent.statusCode).toBe(409);
        expect(inconsistent.json()).toEqual({ error: "provisioning_material_unavailable" });

        const mixedKind = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                pairId,
                publicKey: requester.publicKeyBase64,
                response: createProvisioningResponse({ kind: "dataKey", recipientPublicKey: requester.publicKeyRaw }),
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                responseKind: "tokenOnly",
            },
        });
        expect(mixedKind.statusCode).toBe(409);
        expect(mixedKind.json()).toEqual({ error: "provisioning_kind_mismatch" });

        const malformed = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                pairId,
                publicKey: requester.publicKeyBase64,
                response: privacyKit.encodeBase64(new Uint8Array(new TextEncoder().encode(JSON.stringify({ token: "raw", secret: "legacy" })))),
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                responseKind: "dataKey",
            },
        });
        expect(malformed.statusCode).toBe(400);
        expect(malformed.json()).toEqual({ error: "invalid_provisioning_response" });

        const unknownField = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                pairId,
                publicKey: requester.publicKeyBase64,
                response: createProvisioningResponse({ kind: "dataKey", recipientPublicKey: requester.publicKeyRaw }),
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                responseKind: "dataKey",
                secret: "must-not-be-accepted",
            },
        });
        expect(unknownField.statusCode).toBe(400);
    });

    it("binds approval to the exact direct-QR pairing session and target Home", async () => {
        const requester = createAccountKeypair();
        const otherRequester = createAccountKeypair();
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        await db.accountAuthRequest.create({
            data: { publicKey: privacyKit.encodeHex(requester.publicKeyRaw) },
        });
        const pairId = await createDirectQrContext({
            accountId: account.id,
            publicKeyBase64: otherRequester.publicKeyBase64,
        });
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();
        const response = createProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: requester.publicKeyRaw });

        const wrongHome = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                pairId,
                publicKey: requester.publicKeyBase64,
                response,
                homeServerIdentityId: "srv_wrong_home",
                responseKind: "tokenOnly",
            },
        });
        expect(wrongHome.statusCode).toBe(403);
        expect(wrongHome.json()).toEqual({ error: "wrong_home" });

        const wrongPairingKey = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                pairId,
                publicKey: requester.publicKeyBase64,
                response,
                homeServerIdentityId: HOME_SERVER_IDENTITY_ID,
                responseKind: "tokenOnly",
            },
        });
        expect(wrongPairingKey.statusCode).toBe(404);
        expect(wrongPairingKey.json()).toEqual({ error: "Request not found" });

        const legacyWriter = await app.inject({
            method: "POST",
            url: "/v1/auth/account/response",
            headers: { authorization: `Bearer ${token}` },
            payload: { publicKey: requester.publicKeyBase64, response },
        });
        expect(legacyWriter.statusCode).toBe(426);
        expect(legacyWriter.json()).toEqual({ error: "account_provisioning_update_required" });
        expect(await db.accountAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(requester.publicKeyRaw) },
            select: { response: true, responseAccountId: true, tokenEncrypted: true },
        })).toEqual({ response: null, responseAccountId: null, tokenEncrypted: null });
    });
});
