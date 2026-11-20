import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import {
    sealTerminalProvisioningV3Payload,
    sealTerminalProvisioningV3TokenOnlyPayload,
    signAccountContentKeyBindingV1,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { authRoutes } from "./authRoutes";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const { trackApp, closeTrackedApps } = createAppCloseTracker();


function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    return trackApp(typed);
}

function createSignInRequest() {
    const seed = new Uint8Array(32).fill(7);
    const kp = tweetnacl.sign.keyPair.fromSeed(seed);
    const challenge = new Uint8Array(32).fill(9);
    const signature = tweetnacl.sign.detached(challenge, kp.secretKey);
    return {
        body: {
            publicKey: privacyKit.encodeBase64(new Uint8Array(kp.publicKey)),
            challenge: privacyKit.encodeBase64(new Uint8Array(challenge)),
            signature: privacyKit.encodeBase64(new Uint8Array(signature)),
        },
    };
}

function createTerminalKeypair() {
    const kp = tweetnacl.box.keyPair();
    return {
        publicKeyRaw: new Uint8Array(kp.publicKey),
        secretKeyRaw: new Uint8Array(kp.secretKey),
        publicKeyBase64: privacyKit.encodeBase64(new Uint8Array(kp.publicKey)),
    };
}

function encodeBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

function sha256Base64Url(bytes: Uint8Array): string {
    const digest = createHash("sha256").update(Buffer.from(bytes)).digest();
    return digest.toString("base64url");
}

function createTerminalProvisioningResponse(params: Readonly<{
    kind: "tokenOnly" | "dataKey";
    recipientPublicKey: Uint8Array;
}>): string {
    const pairingSecret = new Uint8Array(randomBytes(32));
    const createdAtMs = Date.now() - 1_000;
    const expiresAtMs = Date.now() + 60_000;
    const payload = params.kind === "tokenOnly"
        ? sealTerminalProvisioningV3TokenOnlyPayload({
            terminalEphemeralPublicKey: params.recipientPublicKey,
            pairingSecret,
            createdAtMs,
            expiresAtMs,
            randomBytes: (length) => new Uint8Array(randomBytes(length)),
        })
        : sealTerminalProvisioningV3Payload({
            contentPrivateKey: new Uint8Array(randomBytes(32)),
            terminalEphemeralPublicKey: params.recipientPublicKey,
            pairingSecret,
            createdAtMs,
            expiresAtMs,
            randomBytes: (length) => new Uint8Array(randomBytes(length)),
        });
    return privacyKit.encodeBase64(new Uint8Array(payload));
}

async function createE2eeAccountWithCurrentContentKey(): Promise<Readonly<{ id: string }>> {
    const signing = tweetnacl.sign.keyPair();
    const content = tweetnacl.box.keyPair();
    return await db.account.create({
        data: {
            publicKey: privacyKit.encodeHex(new Uint8Array(signing.publicKey)),
            encryptionMode: "e2ee",
            contentPublicKey: new Uint8Array(content.publicKey),
            contentPublicKeySig: new Uint8Array(signAccountContentKeyBindingV1({
                accountSigningSecretKey: signing.secretKey,
                contentPublicKey: content.publicKey,
            })),
        },
        select: { id: true },
    });
}

async function markSignedInAccountPlain(signInBody: Readonly<{ publicKey: string }>): Promise<void> {
    await db.account.update({
        where: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(signInBody.publicKey)) },
        data: { encryptionMode: "plain" },
    });
}

describe("authRoutes (terminal auth request) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-terminal-",
            initAuth: true,
            initEncrypt: true,
            env: {
                TERMINAL_AUTH_REQUEST_TTL_SECONDS: "900",
            },
        });
    }, 120_000);
    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        vi.unstubAllGlobals();
        await db.terminalAuthRequest.deleteMany();
        await db.accountIdentity.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("returns the persisted request deadline for a configured TTL without renewing repeated requests", async () => {
        harness.resetEnv({ TERMINAL_AUTH_REQUEST_TTL_SECONDS: "240" });
        const { publicKeyBase64 } = createTerminalKeypair();
        const app = createTestApp();
        authRoutes(app);
        await app.ready();

        // A released claimless CLI still sends only its public key.
        const created = await app.inject({
            method: "POST", url: "/v1/auth/request", payload: { publicKey: publicKeyBase64 },
        });
        expect(created.statusCode).toBe(200);
        const row = await db.terminalAuthRequest.findUniqueOrThrow({
            where: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(publicKeyBase64)) },
        });
        expect(created.json()).toEqual({ state: "requested", expiresAt: row.createdAt.getTime() + 240_000 });

        const originalCreatedAt = new Date(row.createdAt.getTime() - 30_000);
        await db.terminalAuthRequest.update({ where: { id: row.id }, data: { createdAt: originalCreatedAt } });
        const repeated = await app.inject({
            method: "POST", url: "/v1/auth/request", payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(repeated.statusCode).toBe(200);
        expect(repeated.json()).toEqual({ state: "requested", expiresAt: originalCreatedAt.getTime() + 240_000 });
    });

    it("returns 410 expired from /v1/auth/request when the request exceeded TTL and deletes it", async () => {
        const { publicKeyBase64 } = createTerminalKeypair();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(createRes.statusCode).toBe(200);
        expect(createRes.json()).toEqual({ state: "requested", expiresAt: expect.any(Number) });

        const row = await db.terminalAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(publicKeyBase64)) },
        });
        expect(row).toBeTruthy();

        await db.terminalAuthRequest.update({
            where: { id: row!.id },
            data: { createdAt: new Date(Date.now() - 901_000) },
        });

        const expiredRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(expiredRes.statusCode).toBe(410);
        expect(expiredRes.json()).toEqual({ error: "expired" });

        const remaining = await db.terminalAuthRequest.findUnique({ where: { id: row!.id } });
        expect(remaining).toBeNull();

        await app.close();
    });

    it("opportunistically deletes at most 32 expired terminal-auth rows without deleting live rows", async () => {
        const expiredAt = new Date(Date.now() - 901_000);
        await db.terminalAuthRequest.createMany({
            data: Array.from({ length: 33 }, (_, index) => ({
                publicKey: `expired-terminal-auth-${index}`,
                createdAt: expiredAt,
            })),
        });
        const live = await db.terminalAuthRequest.create({
            data: { publicKey: "live-terminal-auth", createdAt: new Date() },
        });
        const requester = createTerminalKeypair();
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const response = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: requester.publicKeyBase64, supportsV2: true },
        });

        expect(response.statusCode).toBe(200);
        expect(await db.terminalAuthRequest.count({ where: { createdAt: { lt: new Date(Date.now() - 900_000) } } })).toBe(1);
        expect(await db.terminalAuthRequest.findUnique({ where: { id: live.id } })).toBeTruthy();
    });

    it("returns not_found from /v1/auth/request/status when the request exceeded TTL and deletes it", async () => {
        const { publicKeyBase64 } = createTerminalKeypair();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(createRes.statusCode).toBe(200);

        const row = await db.terminalAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(publicKeyBase64)) },
        });
        expect(row).toBeTruthy();

        await db.terminalAuthRequest.update({
            where: { id: row!.id },
            data: { createdAt: new Date(Date.now() - 901_000) },
        });

        const statusRes = await app.inject({
            method: "GET",
            url: `/v1/auth/request/status?publicKey=${encodeURIComponent(publicKeyBase64)}`,
        });
        expect(statusRes.statusCode).toBe(200);
        expect(statusRes.json()).toEqual({ status: "not_found", supportsV2: false });

        const remaining = await db.terminalAuthRequest.findUnique({ where: { id: row!.id } });
        expect(remaining).toBeNull();

        await app.close();
    });

    it("clamps TERMINAL_AUTH_REQUEST_TTL_SECONDS to a minimum safe value", async () => {
        harness.resetEnv({ TERMINAL_AUTH_REQUEST_TTL_SECONDS: "1" });

        const { publicKeyBase64 } = createTerminalKeypair();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(createRes.statusCode).toBe(200);

        const row = await db.terminalAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(publicKeyBase64)) },
        });
        expect(row).toBeTruthy();

        // If TTL were truly 1s, this would be expired. With clamping (>= 60s), it should remain valid.
        await db.terminalAuthRequest.update({
            where: { id: row!.id },
            data: { createdAt: new Date(Date.now() - 2_000) },
        });

        const statusRes = await app.inject({
            method: "GET",
            url: `/v1/auth/request/status?publicKey=${encodeURIComponent(publicKeyBase64)}`,
        });
        expect(statusRes.statusCode).toBe(200);
        expect(statusRes.json()).toEqual({ status: "pending", supportsV2: true });

        await app.close();
    });

    it("clamps TERMINAL_AUTH_REQUEST_TTL_SECONDS to a maximum safe value", async () => {
        harness.resetEnv({ TERMINAL_AUTH_REQUEST_TTL_SECONDS: "999999" });

        const { publicKeyBase64 } = createTerminalKeypair();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(createRes.statusCode).toBe(200);

        const row = await db.terminalAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(publicKeyBase64)) },
        });
        expect(row).toBeTruthy();

        // If TTL were truly huge, this would not be expired. With clamping (<= 3600s), it should expire.
        await db.terminalAuthRequest.update({
            where: { id: row!.id },
            data: { createdAt: new Date(Date.now() - 3_601_000) },
        });

        const expiredRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(expiredRes.statusCode).toBe(410);
        expect(expiredRes.json()).toEqual({ error: "expired" });

        await app.close();
    });

    it("allows one claim with the correct secret and rejects a second claim as consumed", async () => {
        harness.resetEnv({
            HAPPIER_SERVER_IDENTITY_ID: "srv_authClaimIdentity",
        });
        const { body: signInBody } = createSignInRequest();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const signInRes = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: signInBody,
        });
        expect(signInRes.statusCode).toBe(200);
        const { token } = signInRes.json() as any;
        expect(typeof token).toBe("string");
        expect(token.length).toBeGreaterThan(10);
        await markSignedInAccountPlain(signInBody);

        const { publicKeyRaw, publicKeyBase64 } = createTerminalKeypair();
        const claimSecret = new Uint8Array(randomBytes(32));
        const claimSecretB64Url = encodeBase64Url(claimSecret);
        const claimSecretHash = sha256Base64Url(claimSecret);

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true, claimSecretHash },
        });
        expect(createRes.statusCode).toBe(200);
        expect(createRes.json()).toEqual({ state: "requested", expiresAt: expect.any(Number) });

        const approveRes = await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                publicKey: publicKeyBase64,
                response: createTerminalProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: publicKeyRaw }),
                responseKind: "tokenOnly",
            },
        });
        expect(approveRes.statusCode).toBe(200);
        expect(approveRes.json()).toEqual({ success: true });

        const statusRes = await app.inject({
            method: "GET",
            url: `/v1/auth/request/status?publicKey=${encodeURIComponent(publicKeyBase64)}`,
        });
        expect(statusRes.statusCode).toBe(200);
        expect(statusRes.json()).toEqual({ status: "authorized", supportsV2: true });

        const claimRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request/claim",
            payload: { publicKey: publicKeyBase64, claimSecret: claimSecretB64Url },
        });
        expect(claimRes.statusCode).toBe(200);
        const claimJson = claimRes.json() as any;
        expect(claimJson).toEqual({
            state: "authorized",
            token: expect.any(String),
            response: expect.any(String),
            serverIdentityId: "srv_authClaimIdentity",
        });
        expect(claimJson.token.length).toBeGreaterThan(10);
        expect(claimJson.token).not.toBe(token);

        const repeatedClaimRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request/claim",
            payload: { publicKey: publicKeyBase64, claimSecret: claimSecretB64Url },
        });
        expect(repeatedClaimRes.statusCode).toBe(410);
        expect(repeatedClaimRes.json()).toEqual({ error: "consumed" });

        const row = await db.terminalAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(publicKeyBase64)) },
        });
        expect(row?.claimedAt).toBeTruthy();

        await app.close();
    });

    it("keeps an authorized request claimable when token minting fails before claim publication", async () => {
        harness.resetEnv({
            HAPPIER_SERVER_IDENTITY_ID: "srv_authClaimRetryIdentity",
        });
        const { body: signInBody } = createSignInRequest();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const signInRes = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: signInBody,
        });
        expect(signInRes.statusCode).toBe(200);
        const { token } = signInRes.json() as { token: string };
        await markSignedInAccountPlain(signInBody);

        const { publicKeyRaw, publicKeyBase64 } = createTerminalKeypair();
        const claimSecret = new Uint8Array(randomBytes(32));
        const claimSecretB64Url = encodeBase64Url(claimSecret);
        const claimSecretHash = sha256Base64Url(claimSecret);

        expect((await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true, claimSecretHash },
        })).statusCode).toBe(200);
        expect((await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                publicKey: publicKeyBase64,
                response: createTerminalProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: publicKeyRaw }),
                responseKind: "tokenOnly",
            },
        })).statusCode).toBe(200);

        const createTokenSpy = vi.spyOn(auth, "createTokenInTx")
            .mockRejectedValueOnce(new Error("injected terminal claim mint failure"));
        try {
            const failedClaim = await app.inject({
                method: "POST",
                url: "/v1/auth/request/claim",
                payload: { publicKey: publicKeyBase64, claimSecret: claimSecretB64Url },
            });
            expect(failedClaim.statusCode).toBe(500);

            const afterFailure = await db.terminalAuthRequest.findUnique({
                where: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(publicKeyBase64)) },
                select: { claimedAt: true },
            });
            expect(afterFailure?.claimedAt).toBeNull();

            const retry = await app.inject({
                method: "POST",
                url: "/v1/auth/request/claim",
                payload: { publicKey: publicKeyBase64, claimSecret: claimSecretB64Url },
            });
            expect(retry.statusCode).toBe(200);
            expect(retry.json()).toEqual({
                state: "authorized",
                token: expect.any(String),
                response: expect.any(String),
                serverIdentityId: "srv_authClaimRetryIdentity",
            });
        } finally {
            createTokenSpy.mockRestore();
        }

        await app.close();
    });

    it("requires a present user to approve a terminal-auth request before its successor token can be polled", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-terminal-approval-${Date.now()}`, encryptionMode: "plain" },
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
        const { publicKeyRaw, publicKeyBase64 } = createTerminalKeypair();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const request = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(request.statusCode).toBe(200);
        expect(request.json()).toEqual({ state: "requested", expiresAt: expect.any(Number) });

        const automationResponse = await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${terminalAutomationToken}` },
            payload: { publicKey: publicKeyBase64, response: "automation must not approve" },
        });
        expect(automationResponse.statusCode).toBe(403);
        expect(automationResponse.json()).toEqual({ error: "present_user_required" });

        const stillRequested = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(stillRequested.statusCode).toBe(200);
        expect(stillRequested.json()).toEqual({ state: "requested", expiresAt: request.json().expiresAt });

        const response = createTerminalProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: publicKeyRaw });

        const presentUserResponse = await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${presentUserToken}` },
            payload: { publicKey: publicKeyBase64, response, responseKind: "tokenOnly" },
        });
        expect(presentUserResponse.statusCode).toBe(200);
        expect(presentUserResponse.json()).toEqual({ success: true });

        const authorized = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(authorized.statusCode).toBe(200);
        expect(authorized.json()).toMatchObject({
            state: "authorized",
            token: expect.any(String),
            response,
        });

        await app.close();
    });

    it("copies approved credential evidence to the exact terminal request and revalidates it at claim", async () => {
        const account = await createE2eeAccountWithCurrentContentKey();
        const approvingToken = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
        });
        const terminal = createTerminalKeypair();
        const claimSecret = new Uint8Array(randomBytes(32));
        const claimSecretB64Url = encodeBase64Url(claimSecret);
        const claimSecretHash = sha256Base64Url(claimSecret);
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: terminal.publicKeyBase64, supportsV2: true, claimSecretHash },
        });
        const response = createTerminalProvisioningResponse({ kind: "dataKey", recipientPublicKey: terminal.publicKeyRaw });
        const approval = await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${approvingToken}` },
            payload: {
                publicKey: terminal.publicKeyBase64,
                response,
                responseKind: "dataKey",
                authorizeUnattendedTeamAccess: true,
            },
        });
        expect(approval.statusCode, approval.body).toBe(200);

        const authorized = await app.inject({
            method: "POST",
            url: "/v1/auth/request/claim",
            payload: { publicKey: terminal.publicKeyBase64, claimSecret: claimSecretB64Url },
        });
        expect(authorized.statusCode, authorized.body).toBe(200);
        const successor = await auth.verifyToken((authorized.json() as { token: string }).token);
        expect(successor?.authenticationEvidence).toEqual([
            { kind: "home_method", methodId: "key_challenge" },
        ]);
        await app.close();
    });

    it("connects a terminal from a paired device without granting factor evidence", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-terminal-no-evidence-${Date.now()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const approvingToken = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
        });
        const terminal = createTerminalKeypair();
        const claimSecret = new Uint8Array(randomBytes(32));
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();
        await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: {
                publicKey: terminal.publicKeyBase64,
                supportsV2: true,
                claimSecretHash: sha256Base64Url(claimSecret),
            },
        });
        const approval = await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${approvingToken}` },
            payload: {
                publicKey: terminal.publicKeyBase64,
                response: createTerminalProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: terminal.publicKeyRaw }),
                responseKind: "tokenOnly",
                authorizeUnattendedTeamAccess: true,
            },
        });
        expect(approval.statusCode, approval.body).toBe(200);
        const authorized = await app.inject({
            method: "POST",
            url: "/v1/auth/request/claim",
            payload: { publicKey: terminal.publicKeyBase64, claimSecret: encodeBase64Url(claimSecret) },
        });
        expect(authorized.statusCode, authorized.body).toBe(200);
        const successor = await auth.verifyToken(authorized.json<{ token: string }>().token);
        expect(successor).toMatchObject({ userId: account.id, authTokenKind: "terminal" });
        expect(successor?.authenticationEvidence ?? []).toEqual([]);
        await app.close();
    });

    it("keeps an explicitly unattended approval pending when its evidence or approval epoch is no longer current", async () => {
        const account = await createE2eeAccountWithCurrentContentKey();
        const approvingToken = await auth.createToken(account.id, undefined, {
            kind: "account",
            authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
        });
        const terminal = createTerminalKeypair();
        const claimSecret = new Uint8Array(randomBytes(32));
        const claimSecretB64Url = encodeBase64Url(claimSecret);
        const claimSecretHash = sha256Base64Url(claimSecret);
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: terminal.publicKeyBase64, supportsV2: true, claimSecretHash },
        });
        const approval = await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${approvingToken}` },
            payload: {
                publicKey: terminal.publicKeyBase64,
                response: createTerminalProvisioningResponse({ kind: "dataKey", recipientPublicKey: terminal.publicKeyRaw }),
                responseKind: "dataKey",
                authorizeUnattendedTeamAccess: true,
            },
        });
        expect(approval.statusCode, approval.body).toBe(200);
        expect(await db.terminalAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(terminal.publicKeyRaw) },
            select: { authenticationEvidence: true, approvalTokenEpoch: true },
        })).toEqual({
            authenticationEvidence: {
                v: 1,
                evidence: [{ kind: "home_method", methodId: "key_challenge" }],
            },
            approvalTokenEpoch: 0,
        });

        harness.resetEnv({ HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0" });
        const staleEvidenceClaim = await app.inject({
            method: "POST",
            url: "/v1/auth/request/claim",
            payload: { publicKey: terminal.publicKeyBase64, claimSecret: claimSecretB64Url },
        });
        expect(staleEvidenceClaim.statusCode, staleEvidenceClaim.body).toBe(409);
        expect(staleEvidenceClaim.json()).toEqual({ error: "credential_authentication_evidence_unavailable" });
        expect((await db.terminalAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(terminal.publicKeyRaw) },
            select: { claimedAt: true },
        }))?.claimedAt).toBeNull();

        harness.resetEnv();
        await auth.signOutEverywhere(account.id);
        const staleEpochClaim = await app.inject({
            method: "POST",
            url: "/v1/auth/request/claim",
            payload: { publicKey: terminal.publicKeyBase64, claimSecret: claimSecretB64Url },
        });
        expect(staleEpochClaim.statusCode, staleEpochClaim.body).toBe(409);
        expect(staleEpochClaim.json()).toEqual({ error: "credential_authentication_evidence_unavailable" });
        expect((await db.terminalAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(terminal.publicKeyRaw) },
            select: { claimedAt: true },
        }))?.claimedAt).toBeNull();
        await app.close();
    });

    it("applies the canonical account-mode policy to terminal-v3 approval responses", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const terminal = createTerminalKeypair();
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const request = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: terminal.publicKeyBase64, supportsV2: true },
        });
        expect(request.statusCode).toBe(200);

        const mismatched = await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                publicKey: terminal.publicKeyBase64,
                response: createTerminalProvisioningResponse({ kind: "dataKey", recipientPublicKey: terminal.publicKeyRaw }),
                responseKind: "dataKey",
            },
        });
        expect(mismatched.statusCode).toBe(409);
        expect(mismatched.json()).toEqual({ error: "provisioning_kind_mismatch" });

        const malformed = await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                publicKey: terminal.publicKeyBase64,
                response: privacyKit.encodeBase64(new TextEncoder().encode("raw legacy secret")),
                responseKind: "tokenOnly",
            },
        });
        expect(malformed.statusCode).toBe(400);
        expect(malformed.json()).toEqual({ error: "invalid_provisioning_response" });

        const response = createTerminalProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: terminal.publicKeyRaw });
        const nonCanonicalResponse = response.replace(/=+$/u, "");
        expect(nonCanonicalResponse).not.toBe(response);
        const nonCanonical = await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                publicKey: terminal.publicKeyBase64,
                response: nonCanonicalResponse,
                responseKind: "tokenOnly",
            },
        });
        expect(nonCanonical.statusCode).toBe(400);
        expect(nonCanonical.json()).toEqual({ error: "invalid_provisioning_response" });

        const accepted = await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                publicKey: terminal.publicKeyBase64,
                response,
                responseKind: "tokenOnly",
            },
        });
        expect(accepted.statusCode).toBe(200);
        expect(accepted.json()).toEqual({ success: true });

        const repeated = await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${token}` },
            payload: { publicKey: terminal.publicKeyBase64, response, responseKind: "tokenOnly" },
        });
        expect(repeated.statusCode).toBe(200);

        const conflicting = await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                publicKey: terminal.publicKeyBase64,
                response: createTerminalProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: terminal.publicKeyRaw }),
                responseKind: "tokenOnly",
            },
        });
        expect(conflicting.statusCode).toBe(409);
        expect(conflicting.json()).toEqual({ error: "already_completed" });
    });

    it("returns consumed when the claim write loses a race after eligibility checks", async () => {
        const { body: signInBody } = createSignInRequest();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const signInRes = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: signInBody,
        });
        expect(signInRes.statusCode).toBe(200);
        const { token } = signInRes.json() as any;
        await markSignedInAccountPlain(signInBody);

        const { publicKeyRaw, publicKeyBase64 } = createTerminalKeypair();
        const claimSecret = new Uint8Array(randomBytes(32));
        const claimSecretB64Url = encodeBase64Url(claimSecret);
        const claimSecretHash = sha256Base64Url(claimSecret);

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true, claimSecretHash },
        });
        expect(createRes.statusCode).toBe(200);

        const approveRes = await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                publicKey: publicKeyBase64,
                response: createTerminalProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: publicKeyRaw }),
                responseKind: "tokenOnly",
            },
        });
        expect(approveRes.statusCode).toBe(200);

        const updateManySpy = vi.spyOn(db.terminalAuthRequest, "updateMany").mockResolvedValueOnce({ count: 0 } as any);
        try {
            const claimRes = await app.inject({
                method: "POST",
                url: "/v1/auth/request/claim",
                payload: { publicKey: publicKeyBase64, claimSecret: claimSecretB64Url },
            });
            expect(claimRes.statusCode).toBe(410);
            expect(claimRes.json()).toEqual({ error: "consumed" });
        } finally {
            updateManySpy.mockRestore();
        }

        await app.close();
    });

    it("rejects setting claimSecretHash on an existing request that was created without one", async () => {
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const { publicKeyBase64 } = createTerminalKeypair();
        const first = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(first.statusCode).toBe(200);
        expect(first.json()).toEqual({ state: "requested", expiresAt: expect.any(Number) });

        const claimSecret = new Uint8Array(randomBytes(32));
        const claimSecretHash = sha256Base64Url(claimSecret);
        const takeoverAttempt = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true, claimSecretHash },
        });
        expect(takeoverAttempt.statusCode).toBe(409);
        expect(takeoverAttempt.json()).toEqual({ error: "claim_mismatch" });

        const row = await db.terminalAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(publicKeyBase64)) },
        });
        expect(row?.claimSecretHash ?? null).toBeNull();

        await app.close();
    });

    it("rejects oversized publicKey inputs without 500s", async () => {
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const tooLarge = "A".repeat(10_000);
        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: tooLarge, supportsV2: true },
        });
        expect(createRes.statusCode).toBe(401);
        expect(createRes.json()).toEqual({ error: "Invalid public key" });

        const statusRes = await app.inject({
            method: "GET",
            url: `/v1/auth/request/status?publicKey=${encodeURIComponent(tooLarge)}`,
        });
        expect(statusRes.statusCode).toBe(200);
        expect(statusRes.json()).toEqual({ status: "not_found", supportsV2: false });

        const claimRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request/claim",
            payload: { publicKey: tooLarge, claimSecret: tooLarge },
        });
        expect(claimRes.statusCode).toBe(400);

        await app.close();
    });

    it("returns 401 from /v1/auth when base64 decoding fails (no 500)", async () => {
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: {
                publicKey: "not-base64!!",
                challenge: "not-base64!!",
                signature: "not-base64!!",
            },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "Invalid public key" });

        await app.close();
    });

    it("returns 401 from /v1/auth/response when base64 decoding fails (no 500)", async () => {
        const { body: signInBody } = createSignInRequest();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const signInRes = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: signInBody,
        });
        expect(signInRes.statusCode).toBe(200);
        const { token } = signInRes.json() as any;

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${token}` },
            payload: { publicKey: "not-base64!!", response: "hello" },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "Invalid public key" });

        await app.close();
    });

    it("returns 401 from /v1/auth/request/claim when the claim secret is wrong", async () => {
        const { body: signInBody } = createSignInRequest();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const signInRes = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: signInBody,
        });
        expect(signInRes.statusCode).toBe(200);
        const { token } = signInRes.json() as any;
        await markSignedInAccountPlain(signInBody);

        const { publicKeyRaw, publicKeyBase64 } = createTerminalKeypair();
        const claimSecret = new Uint8Array(randomBytes(32));
        const claimSecretHash = sha256Base64Url(claimSecret);

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true, claimSecretHash },
        });
        expect(createRes.statusCode).toBe(200);

        await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                publicKey: publicKeyBase64,
                response: createTerminalProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: publicKeyRaw }),
                responseKind: "tokenOnly",
            },
        });

        const wrongSecret = encodeBase64Url(new Uint8Array(randomBytes(32)));
        const claimRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request/claim",
            payload: { publicKey: publicKeyBase64, claimSecret: wrongSecret },
        });
        expect(claimRes.statusCode).toBe(401);
        expect(claimRes.json()).toEqual({ error: "unauthorized" });

        await app.close();
    });

    it("returns 401 from /v1/auth/request when publicKey is not valid base64 (no 500)", async () => {
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: "not-base64!!", supportsV2: true },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "Invalid public key" });

        await app.close();
    });

    it("returns not_found from /v1/auth/request/status when publicKey is not valid base64 (no 500)", async () => {
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "GET",
            url: "/v1/auth/request/status?publicKey=not-base64!!",
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ status: "not_found", supportsV2: false });

        await app.close();
    });

    it("returns 410 expired from /v1/auth/request/claim when publicKey is not valid base64 (no 500)", async () => {
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/auth/request/claim",
            payload: { publicKey: "not-base64!!", claimSecret: encodeBase64Url(new Uint8Array(randomBytes(32))) },
        });
        expect(res.statusCode).toBe(410);
        expect(res.json()).toEqual({ error: "expired" });

        await app.close();
    });

    it("keeps claim-less polling while requiring a canonical v3 approval response", async () => {
        harness.resetEnv({
            HAPPIER_SERVER_IDENTITY_ID: "srv_authRequestIdentity",
        });
        const { body: signInBody } = createSignInRequest();

        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const signInRes = await app.inject({
            method: "POST",
            url: "/v1/auth",
            payload: signInBody,
        });
        expect(signInRes.statusCode).toBe(200);
        const { token } = signInRes.json() as any;
        await markSignedInAccountPlain(signInBody);

        const { publicKeyRaw, publicKeyBase64 } = createTerminalKeypair();

        const createRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(createRes.statusCode).toBe(200);
        expect(createRes.json()).toEqual({ state: "requested", expiresAt: expect.any(Number) });

        const createdRow = await db.terminalAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(publicKeyBase64)) },
        });
        expect(createdRow?.claimSecretHash ?? null).toBeNull();

        const response = createTerminalProvisioningResponse({ kind: "tokenOnly", recipientPublicKey: publicKeyRaw });
        const approveRes = await app.inject({
            method: "POST",
            url: "/v1/auth/response",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                publicKey: publicKeyBase64,
                response,
                responseKind: "tokenOnly",
            },
        });
        expect(approveRes.statusCode).toBe(200);

        const approvedRow = await db.terminalAuthRequest.findUnique({
            where: { publicKey: privacyKit.encodeHex(privacyKit.decodeBase64(publicKeyBase64)) },
        });
        expect(approvedRow?.claimSecretHash ?? null).toBeNull();

        const authorizedRes = await app.inject({
            method: "POST",
            url: "/v1/auth/request",
            payload: { publicKey: publicKeyBase64, supportsV2: true },
        });
        expect(authorizedRes.statusCode).toBe(200);
        expect(authorizedRes.json()).toEqual({
            state: "authorized",
            token: expect.any(String),
            response,
            serverIdentityId: "srv_authRequestIdentity",
        });

        await app.close();
    });
});
