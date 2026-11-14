import * as privacyKit from "privacy-kit";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { auth } from "@/app/auth/auth";
import { setAccountStatusInTx } from "@/app/home/governance/accountLifecycle";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { preparePlainAccountApiTokenLabel } from "@/testkit/privateLabelFixture";

const MASTER_SECRET = "compat-probe-0";

describe("auth (token epoch)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-auth-token-epoch-",
            initAuth: true,
            env: {
                HANDY_MASTER_SECRET: MASTER_SECRET,
                AUTH_TOKEN_CACHE_MAX_ENTRIES: "32",
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
            },
        });
    }, 120_000);

    afterEach(async () => {
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it.each(["suspended", "disabled"] as const)("rejects every credential boundary for a %s Account, including warm signed tokens", async (status) => {
        const account = await db.account.create({ data: { publicKey: `status-admission-${status}` } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const pat = await auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, "Before status change") });
        await expect(auth.verifyToken(token)).resolves.toMatchObject({ userId: account.id });
        await db.account.update({ where: { id: account.id }, data: { status } });

        await expect(auth.verifyToken(token)).resolves.toBeNull();
        await expect(auth.verifyPat(pat.token)).resolves.toEqual({ ok: false, reason: "invalid_token" });
        await expect(auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" })).rejects.toMatchObject({ code: "account-disabled" });
        await expect(inTx((tx) => auth.createTokenInTx(tx, account.id, undefined, { kind: "terminal", authority: "account_automation" }))).rejects.toMatchObject({ code: "account-disabled" });
        await expect(auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, "After status change") })).rejects.toMatchObject({ code: "account-disabled" });
        expect(await db.accountApiToken.count({ where: { accountId: account.id } })).toBe(1);
    });

    it("retires an inconsistent Account durably and idempotently without touching retained encryption state", async () => {
        const account = await db.account.create({ data: { encryptionMode: "e2ee", publicKey: null } });
        const machine = await db.machine.create({ data: { accountId: account.id, id: "retained-lifecycle-machine", metadata: "retained", metadataVersion: 1 } });
        const pat = await auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, "Retire me") });
        await inTx((tx) => setAccountStatusInTx(tx, { actorAccountId: account.id, targetAccountId: account.id, status: "disabled", authority: "account_erasure" }));
        const retired = await db.account.findUniqueOrThrow({ where: { id: account.id } });
        expect(retired).toEqual({ ...account, status: "disabled", tokenEpoch: 1, seq: account.seq + 1, updatedAt: expect.any(Date) });
        expect(await db.machine.findUnique({ where: { id: machine.id } })).toEqual(machine);
        await expect(auth.verifyPat(pat.token)).resolves.toEqual({ ok: false, reason: "invalid_token" });
        await inTx((tx) => setAccountStatusInTx(tx, { actorAccountId: account.id, targetAccountId: account.id, status: "disabled", authority: "account_erasure" }));
        expect(await db.account.findUnique({ where: { id: account.id } })).toEqual(retired);
    });

    it("rejects an old signed token immediately after its warmed cache entry's account epoch advances", async () => {
        const account = await db.account.create({
            data: { publicKey: "token-epoch-warm-cache" },
            select: { id: true },
        });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        await expect(auth.verifyToken(token)).resolves.toMatchObject({ userId: account.id });
        expect(auth.getCacheStats().size).toBeGreaterThan(0);

        await db.account.update({
            where: { id: account.id },
            data: { tokenEpoch: { increment: 1 } },
        });

        await expect(auth.verifyToken(token)).resolves.toBeNull();
    });

    it("rejects a cold cryptographically valid token minted at an older epoch", async () => {
        const account = await db.account.create({
            data: { publicKey: "token-epoch-cold-cache" },
            select: { id: true },
        });
        const generator = await privacyKit.createPersistentTokenGenerator({
            service: "handy",
            seed: MASTER_SECRET,
        });
        const token = await generator.new({
            user: account.id,
            extras: { tokenEpoch: 0 },
        });

        await db.account.update({
            where: { id: account.id },
            data: { tokenEpoch: { increment: 1 } },
        });

        await expect(auth.verifyToken(token)).resolves.toBeNull();
    });

    it("rejects a cryptographically valid current-format token from a future epoch", async () => {
        const account = await db.account.create({
            data: { publicKey: "token-epoch-future" },
            select: { id: true },
        });
        const generator = await privacyKit.createPersistentTokenGenerator({
            service: "handy",
            seed: MASTER_SECRET,
        });
        const token = await generator.new({
            user: account.id,
            extras: {
                tokenEpoch: 1,
                provenance: {
                    v: 1,
                    kind: "account",
                    authority: "present_user",
                },
            },
        });

        await expect(auth.verifyToken(token)).resolves.toBeNull();
    });

    it("mints a token at the account's current epoch after a bump", async () => {
        const account = await db.account.create({
            data: { publicKey: "token-epoch-new-token" },
            select: { id: true },
        });
        await db.account.update({
            where: { id: account.id },
            data: { tokenEpoch: { increment: 1 } },
        });

        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const generator = await privacyKit.createPersistentTokenGenerator({
            service: "handy",
            seed: MASTER_SECRET,
        });
        const verifier = await privacyKit.createPersistentTokenVerifier({
            service: "handy",
            publicKey: Uint8Array.from(generator.publicKey),
        });

        await expect(verifier.verify(token)).resolves.toMatchObject({
            user: account.id,
            extras: { tokenEpoch: 1 },
        });
        await expect(auth.verifyToken(token)).resolves.toMatchObject({ userId: account.id });
    });

    it("increments the persisted epoch for sign out everywhere without relying on cache eviction", async () => {
        const account = await db.account.create({
            data: { publicKey: "token-epoch-sign-out-everywhere" },
            select: { id: true },
        });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        await expect(auth.verifyToken(token)).resolves.toMatchObject({ userId: account.id });

        await expect(auth.signOutEverywhere(account.id)).resolves.toBe(1);
        await expect(db.account.findUnique({
            where: { id: account.id },
            select: { tokenEpoch: true },
        })).resolves.toEqual({ tokenEpoch: 1 });
        await expect(auth.verifyToken(token)).resolves.toBeNull();
    });

    it("commits all-credential revocation with its caller's Account mutation", async () => {
        const account = await db.account.create({ data: { publicKey: "credential-revocation-commit" } });
        const signed = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const pat = await auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, "Revoked automation") });
        await expect(auth.verifyToken(signed)).resolves.not.toBeNull();

        await inTx(async (tx) => {
            await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
            await auth.revokeAllAccountCredentialsInTx(tx, account.id);
        });

        await expect(db.account.findUnique({
            where: { id: account.id }, select: { seq: true, tokenEpoch: true },
        })).resolves.toEqual({ seq: account.seq + 1, tokenEpoch: 1 });
        await expect(auth.verifyToken(signed)).resolves.toBeNull();
        await expect(auth.verifyPat(pat.token)).resolves.toEqual({ ok: false, reason: "invalid_token" });
        await expect(auth.listApiTokens(account.id)).resolves.toEqual([]);
    });

    it("rolls back Account mutation, signed revocation and complete PAT rows together", async () => {
        const account = await db.account.create({ data: { publicKey: "credential-revocation-rollback" } });
        const signed = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const pat = await auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, "Retained automation") });
        const originalPat = await db.accountApiToken.findUniqueOrThrow({ where: { id: pat.tokenId } });

        await expect(inTx(async (tx) => {
            await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
            await auth.revokeAllAccountCredentialsInTx(tx, account.id);
            throw new Error("abort Account transition");
        })).rejects.toThrow("abort Account transition");

        await expect(db.account.findUnique({ where: { id: account.id } })).resolves.toEqual(account);
        await expect(db.accountApiToken.findUnique({ where: { id: pat.tokenId } })).resolves.toEqual(originalPat);
        await expect(auth.verifyToken(signed)).resolves.toMatchObject({ userId: account.id });
        await expect(auth.verifyPat(pat.token)).resolves.toMatchObject({ ok: true, accountId: account.id });
    });

    it("keeps transaction-scoped session sign-out and PAT-only revocation independent", async () => {
        const account = await db.account.create({ data: { publicKey: "credential-revocation-independent" } });
        const signed = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const pat = await auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: await preparePlainAccountApiTokenLabel(account.id, "Separate automation") });
        const originalPat = await db.accountApiToken.findUniqueOrThrow({ where: { id: pat.tokenId } });

        await expect(inTx((tx) => auth.signOutEverywhereInTx(tx, account.id))).resolves.toBe(1);
        await expect(db.accountApiToken.findUnique({ where: { id: pat.tokenId } })).resolves.toEqual(originalPat);
        await expect(auth.verifyToken(signed)).resolves.toBeNull();
        const freshSigned = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });

        await expect(inTx((tx) => auth.revokeAllApiTokensInTx(tx, account.id))).resolves.toMatchObject({ revokedCount: 1 });
        await expect(auth.verifyToken(freshSigned)).resolves.toMatchObject({ userId: account.id });
        await expect(auth.verifyPat(pat.token)).resolves.toEqual({ ok: false, reason: "invalid_token" });
    });
});
