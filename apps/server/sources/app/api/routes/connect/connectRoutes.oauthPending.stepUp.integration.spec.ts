import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";
import { createHash } from "node:crypto";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    consumeAccountEncryptionFirstKeyStepUpPendingInTx,
} from "./connectRoutes.oauthPending";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";

function sha256Hex(value: string): string {
    return createHash("sha256")
        .update(value, "utf8")
        .digest("hex");
}

describe("OAuth pending first-key step-up consumption", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-oauth-step-up-pending-",
            initAuth: false,
        });
    });

    afterEach(async () => {
        await harness.resetDbTables([
            () => db.accountIdentity.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    afterAll(async () => {
        await harness.close();
    });

    async function createFixture(params?: {
        expiresAt?: Date;
        requestDigest?: string;
    }) {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "github",
                providerUserId: "provider-user-1",
                profile: {},
            },
        });
        const proof = "fresh-browser-proof";
        const pending = "oauth_pending_stepup123";
        const requestDigest =
            params?.requestDigest
            ?? `aemrb1_${"A".repeat(43)}`;
        await db.repeatKey.create({
            data: {
                key: pending,
                value: JSON.stringify({
                    v: 3,
                    flow: "auth",
                    purpose: "account_encryption_first_key",
                    provider: "github",
                    userId: account.id,
                    providerUserId: "provider-user-1",
                    proofHash: sha256Hex(proof),
                    requestDigest,
                }),
                expiresAt:
                    params?.expiresAt
                    ?? new Date(Date.now() + 60_000),
            },
        });
        return {
            accountId: account.id,
            provider: "github",
            pending,
            proof,
            requestDigest,
        };
    }

    it("atomically consumes the existing pending row after every binding matches", async () => {
        const fixture = await createFixture();

        const consumed = await inTx(async (tx) =>
            await consumeAccountEncryptionFirstKeyStepUpPendingInTx(
                tx,
                fixture,
            ));
        expect(consumed).toEqual({
            ok: true,
            provider: "github",
            providerUserId: "provider-user-1",
        });
        expect(await db.repeatKey.findUnique({
            where: { key: fixture.pending },
        })).toBeNull();

        const replay = await inTx(async (tx) =>
            await consumeAccountEncryptionFirstKeyStepUpPendingInTx(
                tx,
                fixture,
            ));
        expect(replay).toEqual({
            ok: false,
            reason: "invalid_or_consumed",
        });
    });

    it("rolls proof consumption back with a rejected migration transaction so the exact request can retry", async () => {
        const fixture = await createFixture();

        await expect(inTx(async (tx) => {
            const consumed =
                await consumeAccountEncryptionFirstKeyStepUpPendingInTx(
                    tx,
                    fixture,
                );
            expect(consumed.ok).toBe(true);
            throw new Error("later-migration-write-rejected");
        })).rejects.toThrow("later-migration-write-rejected");
        expect(await db.repeatKey.findUnique({
            where: { key: fixture.pending },
        })).not.toBeNull();

        await expect(inTx(async (tx) =>
            await consumeAccountEncryptionFirstKeyStepUpPendingInTx(
                tx,
                fixture,
            ))).resolves.toEqual({
            ok: true,
            provider: "github",
            providerUserId: "provider-user-1",
        });
    });

    it.each([
        ["wrong Account", { accountId: "another-account" }],
        ["wrong request", {
            requestDigest: `aemrb1_${"B".repeat(43)}`,
        }],
        ["wrong browser proof", { proof: "wrong-proof" }],
    ])("fails closed for %s without consuming the proof", async (_label, mismatch) => {
        const fixture = await createFixture();

        const result = await inTx(async (tx) =>
            await consumeAccountEncryptionFirstKeyStepUpPendingInTx(
                tx,
                { ...fixture, ...mismatch },
            ));
        expect(result).toEqual({
            ok: false,
            reason: "binding_mismatch",
        });
        expect(await db.repeatKey.findUnique({
            where: { key: fixture.pending },
        })).not.toBeNull();
    });

    it("fails closed when expired or when the bound external identity is no longer current", async () => {
        const expired = await createFixture({
            expiresAt: new Date(Date.now() - 1),
        });
        await expect(inTx(async (tx) =>
            await consumeAccountEncryptionFirstKeyStepUpPendingInTx(
                tx,
                expired,
            ))).resolves.toEqual({
            ok: false,
            reason: "expired",
        });

        await harness.resetDbTables([
            () => db.accountIdentity.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.account.deleteMany(),
        ]);
        const staleIdentity = await createFixture();
        await db.accountIdentity.deleteMany({
            where: { accountId: staleIdentity.accountId },
        });
        await expect(inTx(async (tx) =>
            await consumeAccountEncryptionFirstKeyStepUpPendingInTx(
                tx,
                staleIdentity,
            ))).resolves.toEqual({
            ok: false,
            reason: "identity_mismatch",
        });
        expect(await db.repeatKey.findUnique({
            where: { key: staleIdentity.pending },
        })).not.toBeNull();
    });
});
