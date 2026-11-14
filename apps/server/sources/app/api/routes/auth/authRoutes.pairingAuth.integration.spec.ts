import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import {
    computeHomeQrBindingProofV2,
    createHomeQrReverseInviteV2,
    deriveHomeQrRendezvousSecretV2,
    deriveHomeQrRendezvousVerifierV2,
    verifyHomeQrBindingProofV2,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { authRoutes } from "./authRoutes";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { initializeServerIdentityCache } from "@/app/serverIdentity/serverIdentity";
import { preparePlainAccountApiTokenLabel } from "@/testkit/privateLabelFixture";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    return trackApp(typed);
}

function createPhoneEphemeralKeypair() {
    const keypair = tweetnacl.box.keyPair();
    return {
        publicKeyRaw: new Uint8Array(keypair.publicKey),
        publicKeyBase64: privacyKit.encodeBase64(new Uint8Array(keypair.publicKey)),
    };
}

function randomBase64Url32Bytes(): string {
    return Buffer.from(tweetnacl.randomBytes(32)).toString("base64url");
}

function createQrPairingMaterial() {
    const qrSecret = new Uint8Array(tweetnacl.randomBytes(32));
    return {
        qrSecret,
        rendezvousSecret: Buffer.from(deriveHomeQrRendezvousSecretV2(qrSecret)).toString("base64url"),
        rendezvousVerifier: Buffer.from(deriveHomeQrRendezvousVerifierV2(qrSecret)).toString("base64url"),
    };
}

let localHomeServerIdentityId = "";

function createPresentUserToken(accountId: string): Promise<string> {
    return auth.createToken(accountId, undefined, { kind: "account", authority: "present_user" });
}

function createV2RequestPayload(input: {
    pairId: string;
    qrSecret: Uint8Array;
    rendezvousSecret: string;
    publicKey: string;
    publicKeyRaw: Uint8Array;
    expiresAtMs: number;
    deviceLabel?: string;
}, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        pairId: input.pairId,
        secret: input.rendezvousSecret,
        publicKey: input.publicKey,
        bindingProof: computeHomeQrBindingProofV2({
            qrSecret: input.qrSecret,
            pairId: input.pairId,
            homeServerIdentityId: localHomeServerIdentityId,
            requesterPublicKey: input.publicKeyRaw,
            expiresAtMs: input.expiresAtMs,
            direction: "trusted_home_displays",
        }),
        homeServerIdentityId: localHomeServerIdentityId,
        expiresAtMs: input.expiresAtMs,
        ...(input.deviceLabel === undefined ? {} : { deviceLabel: input.deviceLabel }),
        ...overrides,
    };
}

describe("authRoutes (pairing auth) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-pairing-",
            initAuth: true,
            initEncrypt: true,
            env: { HAPPIER_FEATURE_AUTH_PAIRING__DESKTOP_QR_MOBILE_SCAN_ENABLED: "1" },
        });
    }, 120_000);

    beforeEach(async () => {
        localHomeServerIdentityId = await initializeServerIdentityCache(process.env) ?? "";
        expect(localHomeServerIdentityId).not.toBe("");
    });

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        await (db as any).authPairingSession?.deleteMany?.().catch(() => {});
        await db.accountAuthRequest.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("requires a full present-user credential and an exact rendezvous verifier to start", async () => {
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();
        const unauthenticated = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            payload: { direction: "trusted_home_displays", secretHash: randomBase64Url32Bytes() },
        });
        expect(unauthenticated.statusCode).toBe(401);

        const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}` }, select: { id: true } });
        const token = await createPresentUserToken(account.id);
        const valid = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { direction: "trusted_home_displays", secretHash: randomBase64Url32Bytes() },
        });
        expect(valid.statusCode).toBe(200);

        const malformed = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { direction: "trusted_home_displays", secretHash: "not-a-32-byte-verifier" },
        });
        expect(malformed.statusCode).toBe(400);

        const expiredSentinel = await db.authPairingSession.create({
            data: {
                accountId: account.id,
                secretHash: "released-v1-refusal-must-not-clean-up",
                expiresAt: new Date(Date.now() - 1_000),
                flow: "direct_qr",
            },
            select: { id: true },
        });
        const rowsBeforeReleasedV1 = await db.authPairingSession.count();
        // Golden request vector from immutable server-v0.2.11
        // (98ea8fb76733b1dd785d38c31360179cafa84824): the released client sent
        // exactly `{ secretHash }` to this route.
        const releasedV1Start = Object.freeze({
            secretHash: "3xIu03WT5jsxt8icsUBCZIDRy8ctvUvaNl83J5xQB3U",
        });
        const missingDirection = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: releasedV1Start,
        });
        expect(missingDirection.statusCode).toBe(426);
        expect(missingDirection.json()).toEqual({ error: "client_update_required" });
        expect(await db.authPairingSession.count()).toBe(rowsBeforeReleasedV1);
        expect(await db.authPairingSession.findUnique({ where: { id: expiredSentinel.id } })).not.toBeNull();
    });

    it("keeps independently issued direct-QR invitations live for the same account", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const token = await createPresentUserToken(account.id);
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const first = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { direction: "trusted_home_displays", secretHash: createQrPairingMaterial().rendezvousVerifier },
        });
        const second = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { direction: "trusted_home_displays", secretHash: createQrPairingMaterial().rendezvousVerifier },
        });
        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);

        const firstStatus = await app.inject({
            method: "GET",
            url: `/v1/auth/pairing/status?pairId=${encodeURIComponent(String(first.json().pairId))}`,
            headers: { authorization: `Bearer ${token}` },
        });
        expect(firstStatus.statusCode).toBe(200);
        expect(firstStatus.json()).toMatchObject({
            state: "pending",
            pairId: first.json().pairId,
        });

        await app.close();
    });

    it("admits only a same-account Home present user to start, inspect, and consume a direct-QR rendezvous", async () => {
        const owner = await db.account.create({ data: { publicKey: `pk-${Date.now()}-admission-owner` }, select: { id: true } });
        const other = await db.account.create({ data: { publicKey: `pk-${Date.now()}-admission-other` }, select: { id: true } });
        const [presentUserToken, otherPresentUserToken, directoryToken, terminalToken, apiToken] = await Promise.all([
            createPresentUserToken(owner.id),
            createPresentUserToken(other.id),
            auth.createToken(owner.id, undefined, { kind: "account_directory", authority: "present_user" }),
            auth.createToken(owner.id, { session: "pairing-admission-terminal" }, { kind: "terminal", authority: "account_automation" }),
            auth.createApiToken({ accountId: owner.id, tokenId: crypto.randomUUID(), label: await preparePlainAccountApiTokenLabel(owner.id, "Pairing admission PAT") }),
        ]);
        const restrictedTokens = [directoryToken, terminalToken, apiToken.token];
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        for (const token of restrictedTokens) {
            const response = await app.inject({
                method: "POST",
                url: "/v1/auth/pairing/start",
                headers: { authorization: `Bearer ${token}` },
                payload: { direction: "trusted_home_displays", secretHash: createQrPairingMaterial().rendezvousVerifier },
            });
            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({ error: "present_user_required" });
        }

        const start = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${presentUserToken}` },
            payload: { direction: "trusted_home_displays", secretHash: createQrPairingMaterial().rendezvousVerifier },
        });
        expect(start.statusCode).toBe(200);
        const pairId = String(start.json().pairId);

        for (const token of restrictedTokens) {
            const response = await app.inject({
                method: "GET",
                url: `/v1/auth/pairing/status?pairId=${encodeURIComponent(pairId)}`,
                headers: { authorization: `Bearer ${token}` },
            });
            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({ error: "present_user_required" });
        }
        const wrongAccountStatus = await app.inject({
            method: "GET",
            url: `/v1/auth/pairing/status?pairId=${encodeURIComponent(pairId)}`,
            headers: { authorization: `Bearer ${otherPresentUserToken}` },
        });
        expect(wrongAccountStatus.statusCode).toBe(404);
        const ownerStatus = await app.inject({
            method: "GET",
            url: `/v1/auth/pairing/status?pairId=${encodeURIComponent(pairId)}`,
            headers: { authorization: `Bearer ${presentUserToken}` },
        });
        expect(ownerStatus.statusCode).toBe(200);

        for (const token of restrictedTokens) {
            const response = await app.inject({
                method: "POST",
                url: "/v1/auth/pairing/consume",
                headers: { authorization: `Bearer ${token}` },
                payload: { pairId },
            });
            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({ error: "present_user_required" });
        }
        const wrongAccountConsume = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/consume",
            headers: { authorization: `Bearer ${otherPresentUserToken}` },
            payload: { pairId },
        });
        expect(wrongAccountConsume.statusCode).toBe(404);
        expect(await db.authPairingSession.findUnique({ where: { id: pairId } })).not.toBeNull();
        const ownerConsume = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/consume",
            headers: { authorization: `Bearer ${presentUserToken}` },
            payload: { pairId },
        });
        expect(ownerConsume.statusCode).toBe(200);
        expect(await db.authPairingSession.findUnique({ where: { id: pairId } })).toBeNull();
    });

    it("binds the exact V2 tuple, makes exact retries harmless, and returns proof through owner status", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}-owner` }, select: { id: true } });
        const otherAccount = await db.account.create({ data: { publicKey: `pk-${Date.now()}-other` }, select: { id: true } });
        const token = await createPresentUserToken(account.id);
        const otherToken = await createPresentUserToken(otherAccount.id);
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const material = createQrPairingMaterial();
        const startRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { direction: "trusted_home_displays", secretHash: material.rendezvousVerifier },
        });
        expect(startRes.statusCode).toBe(200);
        const pairId = String(startRes.json().pairId);
        const expiresAtMs = Date.parse(String(startRes.json().expiresAt));
        const requester = createPhoneEphemeralKeypair();
        const validPayload = createV2RequestPayload({
            pairId,
            qrSecret: material.qrSecret,
            rendezvousSecret: material.rendezvousSecret,
            publicKey: requester.publicKeyBase64,
            publicKeyRaw: requester.publicKeyRaw,
            expiresAtMs,
            deviceLabel: "  My   iPhone  ",
        });

        const missingProof = { ...validPayload };
        delete missingProof.bindingProof;
        expect((await app.inject({ method: "POST", url: "/v1/auth/pairing/request", payload: missingProof })).statusCode).toBe(400);
        const missingHome = { ...validPayload };
        delete missingHome.homeServerIdentityId;
        expect((await app.inject({ method: "POST", url: "/v1/auth/pairing/request", payload: missingHome })).statusCode).toBe(400);
        const missingExpiry = { ...validPayload };
        delete missingExpiry.expiresAtMs;
        expect((await app.inject({ method: "POST", url: "/v1/auth/pairing/request", payload: missingExpiry })).statusCode).toBe(400);
        expect((await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/request",
            payload: { ...validPayload, bindingProof: Buffer.from(tweetnacl.randomBytes(31)).toString("base64url") },
        })).statusCode).toBe(400);
        expect((await app.inject({ method: "POST", url: "/v1/auth/pairing/request", payload: { ...validPayload, publicKey: "not-base64!!" } })).statusCode).toBe(401);
        expect((await app.inject({ method: "POST", url: "/v1/auth/pairing/request", payload: { ...validPayload, secret: "short" } })).statusCode).toBe(400);
        expect((await app.inject({ method: "POST", url: "/v1/auth/pairing/request", payload: { ...validPayload, smuggled: "field" } })).statusCode).toBe(400);

        const requestRes = await app.inject({ method: "POST", url: "/v1/auth/pairing/request", payload: validPayload });
        expect(requestRes.statusCode).toBe(200);
        expect(requestRes.json()).toEqual({ state: "requested" });
        const sameTupleRetry = await app.inject({ method: "POST", url: "/v1/auth/pairing/request", payload: validPayload });
        expect(sameTupleRetry.statusCode).toBe(200);
        expect(sameTupleRetry.json()).toEqual({ state: "requested" });

        const changedProof = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/request",
            payload: { ...validPayload, bindingProof: randomBase64Url32Bytes() },
        });
        expect(changedProof.statusCode).toBe(409);
        expect(changedProof.json()).toEqual({ error: "already_requested" });

        const otherRequester = createPhoneEphemeralKeypair();
        const changedKey = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/request",
            payload: createV2RequestPayload({
                pairId,
                qrSecret: material.qrSecret,
                rendezvousSecret: material.rendezvousSecret,
                publicKey: otherRequester.publicKeyBase64,
                publicKeyRaw: otherRequester.publicKeyRaw,
                expiresAtMs,
            }),
        });
        expect(changedKey.statusCode).toBe(409);
        expect(changedKey.json()).toEqual({ error: "already_requested" });

        const wrongOwnerStatus = await app.inject({
            method: "GET",
            url: `/v1/auth/pairing/status?pairId=${encodeURIComponent(pairId)}`,
            headers: { authorization: `Bearer ${otherToken}` },
        });
        expect(wrongOwnerStatus.statusCode).toBe(404);

        const statusRes = await app.inject({
            method: "GET",
            url: `/v1/auth/pairing/status?pairId=${encodeURIComponent(pairId)}`,
            headers: { authorization: `Bearer ${token}` },
        });
        expect(statusRes.statusCode).toBe(200);
        expect(statusRes.json()).toEqual({
            state: "requested",
            pairId,
            expiresAt: new Date(expiresAtMs).toISOString(),
            homeServerIdentityId: localHomeServerIdentityId,
            requestedPublicKey: requester.publicKeyBase64,
            bindingProof: validPayload.bindingProof,
            requestedDeviceLabel: "My iPhone",
        });
    });

    it("rejects wrong rendezvous, Home, invite expiry, expired rows, and non-direct flows", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}-negative` }, select: { id: true } });
        const token = await createPresentUserToken(account.id);
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();
        const material = createQrPairingMaterial();
        const startRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { direction: "trusted_home_displays", secretHash: material.rendezvousVerifier },
        });
        const pairId = String(startRes.json().pairId);
        const expiresAtMs = Date.parse(String(startRes.json().expiresAt));
        const requester = createPhoneEphemeralKeypair();
        const baseInput = {
            pairId,
            qrSecret: material.qrSecret,
            rendezvousSecret: material.rendezvousSecret,
            publicKey: requester.publicKeyBase64,
            publicKeyRaw: requester.publicKeyRaw,
            expiresAtMs,
        };

        const wrongSecret = createQrPairingMaterial();
        const wrongSecretRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/request",
            payload: createV2RequestPayload({ ...baseInput, rendezvousSecret: wrongSecret.rendezvousSecret }),
        });
        expect(wrongSecretRes.statusCode).toBe(404);
        const wrongHome = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/request",
            payload: createV2RequestPayload(baseInput, { homeServerIdentityId: "srv_foreign_home" }),
        });
        expect(wrongHome.statusCode).toBe(403);
        expect(wrongHome.json()).toEqual({ error: "wrong_home" });
        const wrongExpiry = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/request",
            payload: createV2RequestPayload({ ...baseInput, expiresAtMs: expiresAtMs + 1 }),
        });
        expect(wrongExpiry.statusCode).toBe(403);
        expect(wrongExpiry.json()).toEqual({ error: "wrong_expiry" });

        const expiredMaterial = createQrPairingMaterial();
        const expiredRow = await db.authPairingSession.create({
            data: { accountId: account.id, secretHash: expiredMaterial.rendezvousVerifier, expiresAt: new Date(Date.now() - 1_000), flow: "direct_qr" },
        });
        const expiredRequester = createPhoneEphemeralKeypair();
        const expiredRequest = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/request",
            payload: createV2RequestPayload({
                pairId: expiredRow.id,
                qrSecret: expiredMaterial.qrSecret,
                rendezvousSecret: expiredMaterial.rendezvousSecret,
                publicKey: expiredRequester.publicKeyBase64,
                publicKeyRaw: expiredRequester.publicKeyRaw,
                expiresAtMs: expiredRow.expiresAt.getTime(),
            }),
        });
        expect(expiredRequest.statusCode).toBe(404);

        const assertionRow = await db.authPairingSession.create({
            data: {
                accountId: account.id,
                secretHash: material.rendezvousVerifier,
                expiresAt: new Date(Date.now() + 120_000),
                flow: "account_assertion",
                requesterIssuerServerIdentityId: "srv_issuer",
                requesterIssuerSubjectId: "issuer-subject",
                approvalStatus: "pending",
            },
        });
        const crossFlow = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/request",
            payload: createV2RequestPayload({ ...baseInput, pairId: assertionRow.id, expiresAtMs: assertionRow.expiresAt.getTime() }),
        });
        expect(crossFlow.statusCode).toBe(404);
    });

    it("cleans only direct-QR rows when starting and preserves account-assertion approvals", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}-cleanup` }, select: { id: true } });
        const otherAccount = await db.account.create({ data: { publicKey: `pk-${Date.now()}-cleanup-other` }, select: { id: true } });
        const token = await createPresentUserToken(account.id);
        const expiredDirect = await db.authPairingSession.create({
            data: { accountId: otherAccount.id, secretHash: randomBase64Url32Bytes(), expiresAt: new Date(Date.now() - 1_000), flow: "direct_qr" },
        });
        const assertionRow = await db.authPairingSession.create({
            data: {
                accountId: account.id,
                secretHash: randomBase64Url32Bytes(),
                requestedPublicKey: "requester-key",
                expiresAt: new Date(Date.now() + 120_000),
                flow: "account_assertion",
                requesterIssuerServerIdentityId: "srv_issuer",
                requesterIssuerSubjectId: "issuer-subject",
                approvalStatus: "pending",
            },
        });
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();
        const startRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { direction: "trusted_home_displays", secretHash: createQrPairingMaterial().rendezvousVerifier },
        });
        expect(startRes.statusCode).toBe(200);
        expect(await db.authPairingSession.findUnique({ where: { id: expiredDirect.id } })).toBeNull();
        expect(await db.authPairingSession.findUnique({ where: { id: assertionRow.id } })).toMatchObject({ flow: "account_assertion", approvalStatus: "pending" });
    });

    it("atomically binds one requester tuple under concurrent substitution", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}-race` }, select: { id: true } });
        const token = await createPresentUserToken(account.id);
        const material = createQrPairingMaterial();
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();
        const startRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { direction: "trusted_home_displays", secretHash: material.rendezvousVerifier },
        });
        const pairId = String(startRes.json().pairId);
        const expiresAtMs = Date.parse(String(startRes.json().expiresAt));
        const keyA = createPhoneEphemeralKeypair();
        const keyB = createPhoneEphemeralKeypair();
        const payloadFor = (key: ReturnType<typeof createPhoneEphemeralKeypair>) => createV2RequestPayload({
            pairId,
            qrSecret: material.qrSecret,
            rendezvousSecret: material.rendezvousSecret,
            publicKey: key.publicKeyBase64,
            publicKeyRaw: key.publicKeyRaw,
            expiresAtMs,
        });
        const [resA, resB] = await Promise.all([
            app.inject({ method: "POST", url: "/v1/auth/pairing/request", payload: payloadFor(keyA) }),
            app.inject({ method: "POST", url: "/v1/auth/pairing/request", payload: payloadFor(keyB) }),
        ]);
        expect([resA.statusCode, resB.statusCode].sort()).toEqual([200, 409]);
        const row = await db.authPairingSession.findUnique({ where: { id: pairId } });
        const winningKey = row?.requestedPublicKey === keyA.publicKeyBase64 ? keyA : keyB;
        expect(row?.requestedPublicKey).toBe(winningKey.publicKeyBase64);
        expect(row?.requestedBindingProof).toBe(payloadFor(winningKey).bindingProof);
    });

    it("consumes one live direct-QR row exactly once and never consumes expired or assertion rows", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}-consume` }, select: { id: true } });
        const token = await createPresentUserToken(account.id);
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();
        const startRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { direction: "trusted_home_displays", secretHash: createQrPairingMaterial().rendezvousVerifier },
        });
        const pairId = String(startRes.json().pairId);
        const [resA, resB] = await Promise.all([
            app.inject({ method: "POST", url: "/v1/auth/pairing/consume", headers: { authorization: `Bearer ${token}` }, payload: { pairId } }),
            app.inject({ method: "POST", url: "/v1/auth/pairing/consume", headers: { authorization: `Bearer ${token}` }, payload: { pairId } }),
        ]);
        expect([resA.statusCode, resB.statusCode].sort()).toEqual([200, 404]);

        const expiredRow = await db.authPairingSession.create({
            data: { accountId: account.id, secretHash: randomBase64Url32Bytes(), expiresAt: new Date(Date.now() - 1_000), flow: "direct_qr" },
        });
        const expiredConsume = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/consume",
            headers: { authorization: `Bearer ${token}` },
            payload: { pairId: expiredRow.id },
        });
        expect(expiredConsume.statusCode).toBe(404);

        const assertionRow = await db.authPairingSession.create({
            data: {
                accountId: account.id,
                secretHash: randomBase64Url32Bytes(),
                expiresAt: new Date(Date.now() + 120_000),
                flow: "account_assertion",
                requesterIssuerServerIdentityId: "srv_issuer",
                requesterIssuerSubjectId: "issuer-subject",
                approvalStatus: "pending",
            },
        });
        const assertionConsume = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/consume",
            headers: { authorization: `Bearer ${token}` },
            payload: { pairId: assertionRow.id },
        });
        expect(assertionConsume.statusCode).toBe(404);
        expect(await db.authPairingSession.findUnique({ where: { id: assertionRow.id } })).toMatchObject({ approvalStatus: "pending" });
    });

    it("atomically rejects a requested direct-QR row through the existing consume owner", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}-reject` }, select: { id: true } });
        const token = await createPresentUserToken(account.id);
        const requestedPublicKey = privacyKit.encodeBase64(new Uint8Array(tweetnacl.box.keyPair().publicKey));
        const row = await db.authPairingSession.create({
            data: {
                accountId: account.id,
                secretHash: randomBase64Url32Bytes(),
                requestedPublicKey,
                requestedBindingProof: randomBase64Url32Bytes(),
                requestedAt: new Date(),
                expiresAt: new Date(Date.now() + 120_000),
                flow: "direct_qr",
            },
        });
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const rejected = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/consume",
            headers: { authorization: `Bearer ${token}` },
            payload: { pairId: row.id, intent: "reject" },
        });

        expect(rejected.statusCode).toBe(200);
        expect(await db.authPairingSession.findUnique({ where: { id: row.id } })).toMatchObject({
            approvalStatus: "rejected",
            decidedAt: expect.any(Date),
        });
    });

    it("retains older post-approval consume as cleanup instead of changing the approved decision", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}-approved-cleanup` }, select: { id: true } });
        const token = await createPresentUserToken(account.id);
        const row = await db.authPairingSession.create({
            data: {
                accountId: account.id,
                secretHash: randomBase64Url32Bytes(),
                requestedPublicKey: privacyKit.encodeBase64(new Uint8Array(tweetnacl.box.keyPair().publicKey)),
                requestedBindingProof: randomBase64Url32Bytes(),
                requestedAt: new Date(),
                expiresAt: new Date(Date.now() + 120_000),
                flow: "direct_qr",
                approvalStatus: "approved",
                decidedAt: new Date(),
            },
        });
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const cleanup = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/consume",
            headers: { authorization: `Bearer ${token}` },
            payload: { pairId: row.id },
        });

        expect(cleanup.statusCode).toBe(200);
        expect(await db.authPairingSession.findUnique({ where: { id: row.id } })).toBeNull();
    });

    it("fails closed for a bare consume of an undecided requester and preserves joining-device polling", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-bare-requested`, encryptionMode: "plain" },
            select: { id: true },
        });
        const token = await createPresentUserToken(account.id);
        const requester = createPhoneEphemeralKeypair();
        await db.accountAuthRequest.create({
            data: { publicKey: privacyKit.encodeHex(requester.publicKeyRaw) },
        });
        const row = await db.authPairingSession.create({
            data: {
                accountId: account.id,
                secretHash: randomBase64Url32Bytes(),
                requestedPublicKey: requester.publicKeyBase64,
                requestedBindingProof: randomBase64Url32Bytes(),
                requestedAt: new Date(),
                expiresAt: new Date(Date.now() + 120_000),
                flow: "direct_qr",
            },
        });
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const cleanup = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/consume",
            headers: { authorization: `Bearer ${token}` },
            payload: { pairId: row.id },
        });
        expect(cleanup.statusCode).toBe(404);
        expect(await db.authPairingSession.findUnique({ where: { id: row.id } })).toMatchObject({
            requestedPublicKey: requester.publicKeyBase64,
            approvalStatus: null,
            decidedAt: null,
        });

        const joiningPoll = await app.inject({
            method: "POST",
            url: "/v2/auth/account/request",
            payload: {
                publicKey: requester.publicKeyBase64,
                pairId: row.id,
                homeServerIdentityId: localHomeServerIdentityId,
            },
        });
        expect(joiningPoll.statusCode).toBe(200);
        expect(joiningPoll.json()).toEqual({ state: "requested" });
    });

    it("reject intent fails as already decided when approval won and preserves the approved row", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}-approved-reject` }, select: { id: true } });
        const token = await createPresentUserToken(account.id);
        const row = await db.authPairingSession.create({
            data: {
                accountId: account.id,
                secretHash: randomBase64Url32Bytes(),
                requestedPublicKey: privacyKit.encodeBase64(new Uint8Array(tweetnacl.box.keyPair().publicKey)),
                requestedBindingProof: randomBase64Url32Bytes(),
                requestedAt: new Date(),
                expiresAt: new Date(Date.now() + 120_000),
                flow: "direct_qr",
                approvalStatus: "approved",
                decidedAt: new Date(),
            },
        });
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const rejected = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/consume",
            headers: { authorization: `Bearer ${token}` },
            payload: { pairId: row.id, intent: "reject" },
        });

        expect(rejected.statusCode).toBe(409);
        expect(rejected.json()).toEqual({ error: "already_decided" });
        expect(await db.authPairingSession.findUnique({ where: { id: row.id } })).toMatchObject({
            approvalStatus: "approved",
        });
    });

    it("makes requester installation and explicit cancellation atomic and reports a winning request as terminally rejected", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}-cancel-race`, encryptionMode: "plain" },
            select: { id: true },
        });
        const token = await createPresentUserToken(account.id);
        const material = createQrPairingMaterial();
        const requester = createPhoneEphemeralKeypair();
        await db.accountAuthRequest.create({
            data: { publicKey: privacyKit.encodeHex(requester.publicKeyRaw) },
        });
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const started = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { direction: "trusted_home_displays", secretHash: material.rendezvousVerifier },
        });
        const pairId = String(started.json().pairId);
        const expiresAtMs = Date.parse(String(started.json().expiresAt));
        const requestPayload = createV2RequestPayload({
            pairId,
            qrSecret: material.qrSecret,
            rendezvousSecret: material.rendezvousSecret,
            publicKey: requester.publicKeyBase64,
            publicKeyRaw: requester.publicKeyRaw,
            expiresAtMs,
        });

        const [requested, cancelled] = await Promise.all([
            app.inject({ method: "POST", url: "/v1/auth/pairing/request", payload: requestPayload }),
            app.inject({
                method: "POST",
                url: "/v1/auth/pairing/consume",
                headers: { authorization: `Bearer ${token}` },
                payload: { pairId, intent: "cancel" },
            }),
        ]);

        expect(cancelled.statusCode).toBe(200);
        expect([200, 404]).toContain(requested.statusCode);
        const pairing = await db.authPairingSession.findUnique({ where: { id: pairId } });
        if (requested.statusCode === 200) {
            expect(pairing).toMatchObject({
                requestedPublicKey: requester.publicKeyBase64,
                approvalStatus: "rejected",
                decidedAt: expect.any(Date),
            });
            const terminalPoll = await app.inject({
                method: "POST",
                url: "/v2/auth/account/request",
                payload: {
                    publicKey: requester.publicKeyBase64,
                    pairId,
                    homeServerIdentityId: localHomeServerIdentityId,
                },
            });
            expect(terminalPoll.statusCode).toBe(200);
            expect(terminalPoll.json()).toEqual({ state: "rejected" });
        } else {
            expect(pairing).toBeNull();
        }
    });

    it("accepts default requester-displayed reverse invite material under the production start policy", async () => {
        delete process.env.AUTH_PAIRING_TTL_SECONDS;
        const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}-reverse-start-default` }, select: { id: true } });
        const token = await createPresentUserToken(account.id);
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const reverse = createHomeQrReverseInviteV2({
            home: {
                v: 1,
                homeServerIdentityId: localHomeServerIdentityId,
                canonicalServerUrl: "https://home.example",
                revision: 1,
                endpoints: [{ kind: "https", url: "https://home.example" }],
            },
            // A real requester renders before the enrolled device scans and starts the row.
            // Keep a small elapsed interval so this test proves the default remains valid
            // after that handoff rather than only at zero latency.
            nowMs: Date.now() - 1_000,
        });

        const start = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                direction: reverse.invite.direction,
                secretHash: Buffer.from(deriveHomeQrRendezvousVerifierV2(reverse.qrSecret)).toString("base64url"),
                pairId: reverse.invite.pairId,
                expiresAtMs: reverse.invite.expiresAtMs,
            },
        });

        expect(start.statusCode).toBe(200);
        expect(start.json()).toEqual({
            pairId: reverse.invite.pairId,
            expiresAt: new Date(reverse.invite.expiresAtMs).toISOString(),
        });

        await app.close();
    });

    it("accepts the A6 requester-displayed proposed tuple with exact expiry, idempotent retries, typed conflicts, and present-user authority", async () => {
        process.env.AUTH_PAIRING_TTL_SECONDS = "600";
        const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}-reverse-start` }, select: { id: true } });
        const other = await db.account.create({ data: { publicKey: `pk-${Date.now()}-reverse-start-other` }, select: { id: true } });
        const token = await createPresentUserToken(account.id);
        const otherToken = await createPresentUserToken(other.id);
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const reverse = createHomeQrReverseInviteV2({
            home: {
                v: 1,
                homeServerIdentityId: localHomeServerIdentityId,
                canonicalServerUrl: "https://home.example",
                revision: 1,
                endpoints: [{ kind: "https", url: "https://home.example" }],
            },
            nowMs: Date.now(),
            ttlMs: 45_000,
        });
        const proposedPairId = reverse.invite.pairId;
        const proposedExpiresAtMs = reverse.invite.expiresAtMs;
        const proposedTuple = {
            direction: "requester_displays" as const,
            secretHash: Buffer.from(deriveHomeQrRendezvousVerifierV2(reverse.qrSecret)).toString("base64url"),
            pairId: proposedPairId,
            expiresAtMs: proposedExpiresAtMs,
        };

        // A proposed tuple requires a full present-user Home credential, exactly
        // like the forward start.
        const unauthenticated = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            payload: proposedTuple,
        });
        expect(unauthenticated.statusCode).toBe(401);
        const [directoryToken, terminalToken, apiToken] = await Promise.all([
            auth.createToken(account.id, undefined, { kind: "account_directory", authority: "present_user" }),
            auth.createToken(account.id, { session: "reverse-start-terminal" }, { kind: "terminal", authority: "account_automation" }),
            auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, "Reverse start PAT") }),
        ]);
        for (const restricted of [directoryToken, terminalToken, apiToken.token]) {
            const response = await app.inject({
                method: "POST",
                url: "/v1/auth/pairing/start",
                headers: { authorization: `Bearer ${restricted}` },
                payload: proposedTuple,
            });
            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({ error: "present_user_required" });
        }

        // The exact proposed expiry is honored, never rewritten.
        const start = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: proposedTuple,
        });
        expect(start.statusCode).toBe(200);
        expect(start.json()).toEqual({
            pairId: proposedPairId,
            expiresAt: new Date(proposedExpiresAtMs).toISOString(),
        });

        // An exact retry (same account, pair ID, verifier, expiry) is idempotent.
        const retry = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: proposedTuple,
        });
        expect(retry.statusCode).toBe(200);
        expect(retry.json()).toEqual(start.json());
        expect(await db.authPairingSession.findMany({ where: { id: proposedPairId } })).toHaveLength(1);

        // Any other tuple shape for the same pair ID is a typed conflict.
        for (const mismatch of [
            { ...proposedTuple, secretHash: createQrPairingMaterial().rendezvousVerifier },
            { ...proposedTuple, expiresAtMs: proposedExpiresAtMs + 1 },
        ]) {
            const sameAccount = await app.inject({
                method: "POST",
                url: "/v1/auth/pairing/start",
                headers: { authorization: `Bearer ${token}` },
                payload: mismatch,
            });
            expect(sameAccount.statusCode).toBe(409);
            expect(sameAccount.json()).toEqual({ error: "pair_id_conflict" });
        }
        const otherAccount = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${otherToken}` },
            payload: proposedTuple,
        });
        expect(otherAccount.statusCode).toBe(409);
        expect(otherAccount.json()).toEqual({ error: "pair_id_conflict" });
        expect(await db.authPairingSession.findMany({ where: { id: proposedPairId } })).toHaveLength(1);

        // Reverse input is strict: the discriminator, canonical 32-byte pair ID,
        // and canonical 32-byte verifier are all mandatory.
        for (const invalid of [
            { ...proposedTuple, direction: undefined },
            { ...proposedTuple, pairId: "not-a-canonical-32-byte-id" },
            { ...proposedTuple, secretHash: "not-a-canonical-32-byte-verifier" },
        ]) {
            const rejected = await app.inject({
                method: "POST",
                url: "/v1/auth/pairing/start",
                headers: { authorization: `Bearer ${token}` },
                payload: invalid,
            });
            expect(rejected.statusCode).toBe(400);
        }

        // Already-expired proposals and proposals beyond the existing
        // 600-second policy ceiling are rejected before any row exists.
        for (const invalid of [
            {
                ...proposedTuple,
                pairId: randomBase64Url32Bytes(),
                expiresAtMs: Date.now() - 1,
            },
            {
                ...proposedTuple,
                pairId: randomBase64Url32Bytes(),
                expiresAtMs: Date.now() + 601_000,
            },
        ]) {
            const rejected = await app.inject({
                method: "POST",
                url: "/v1/auth/pairing/start",
                headers: { authorization: `Bearer ${token}` },
                payload: invalid,
            });
            expect(rejected.statusCode).toBe(400);
            expect(rejected.json()).toEqual({ error: "invalid_proposed_expiry" });
        }
        expect(await db.authPairingSession.findMany({ where: { accountId: account.id } })).toHaveLength(1);

        // The released forward start body remains strict and server-owned.
        const forward = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: { direction: "trusted_home_displays", secretHash: createQrPairingMaterial().rendezvousVerifier },
        });
        expect(forward.statusCode).toBe(200);
        expect(forward.json().pairId).not.toBe(proposedPairId);
        expect(Date.parse(String(forward.json().expiresAt))).toBeGreaterThan(Date.now());

        await app.close();
    });

    it("carries a requester-displayed pairing through the existing routes with a direction-bound proof", async () => {
        const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}-reverse-e2e` }, select: { id: true } });
        const token = await createPresentUserToken(account.id);
        const app = createTestApp();
        authRoutes(app as any);
        await app.ready();

        const reverse = createHomeQrReverseInviteV2({
            home: {
                v: 1,
                homeServerIdentityId: localHomeServerIdentityId,
                canonicalServerUrl: "https://home.example",
                revision: 1,
                endpoints: [{ kind: "https", url: "https://home.example" }],
            },
            nowMs: Date.now(),
            ttlMs: 60_000,
        });
        const qrSecret = reverse.qrSecret;
        const requesterPublicKey = new Uint8Array(reverse.requesterPublicKey);

        // The enrolled scanner authenticates the existing start route with the
        // requester's proposed tuple from the displayed invite.
        const start = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/start",
            headers: { authorization: `Bearer ${token}` },
            payload: {
                direction: reverse.invite.direction,
                secretHash: Buffer.from(deriveHomeQrRendezvousVerifierV2(qrSecret)).toString("base64url"),
                pairId: reverse.invite.pairId,
                expiresAtMs: reverse.invite.expiresAtMs,
            },
        });
        expect(start.statusCode).toBe(200);
        expect(start.json().pairId).toBe(reverse.invite.pairId);

        // The requester itself holds the QR secret and installs its own bound
        // tuple through the existing unauthenticated request route.
        const requestRes = await app.inject({
            method: "POST",
            url: "/v1/auth/pairing/request",
            payload: {
                pairId: reverse.invite.pairId,
                secret: Buffer.from(deriveHomeQrRendezvousSecretV2(qrSecret)).toString("base64url"),
                publicKey: privacyKit.encodeBase64(requesterPublicKey),
                bindingProof: computeHomeQrBindingProofV2({
                    qrSecret,
                    pairId: reverse.invite.pairId,
                    homeServerIdentityId: localHomeServerIdentityId,
                    requesterPublicKey,
                    expiresAtMs: reverse.invite.expiresAtMs,
                    direction: "requester_displays",
                }),
                homeServerIdentityId: localHomeServerIdentityId,
                expiresAtMs: reverse.invite.expiresAtMs,
            },
        });
        expect(requestRes.statusCode).toBe(200);
        expect(requestRes.json()).toEqual({ state: "requested" });

        // The scanner polls the existing status route and verifies the stored
        // proof only against the requester-displayed direction.
        const statusRes = await app.inject({
            method: "GET",
            url: `/v1/auth/pairing/status?pairId=${encodeURIComponent(reverse.invite.pairId)}`,
            headers: { authorization: `Bearer ${token}` },
        });
        expect(statusRes.statusCode).toBe(200);
        const status = statusRes.json();
        expect(status.state).toBe("requested");
        expect(status.requestedPublicKey).toBe(privacyKit.encodeBase64(requesterPublicKey));
        const verifyParams = {
            qrSecret,
            pairId: reverse.invite.pairId,
            homeServerIdentityId: localHomeServerIdentityId,
            requesterPublicKey,
            expiresAtMs: reverse.invite.expiresAtMs,
        };
        expect(verifyHomeQrBindingProofV2({ ...verifyParams, direction: "requester_displays" }, status.bindingProof)).toBe(true);
        // The forward direction can never verify a requester-displayed proof.
        expect(verifyHomeQrBindingProofV2({ ...verifyParams, direction: "trusted_home_displays" }, status.bindingProof)).toBe(false);

        await app.close();
    });
});
