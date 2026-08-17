import { createHash } from "node:crypto";
import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";

import {
    consumeAccountEncryptionFirstKeyExternalAuthProofInTx,
} from "@/app/auth/accountEncryptionFirstKeyExternalAuthProof";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import { createMtlsClaimCode } from "./mtlsClaimCode";

function sha256Hex(value: string): string {
    return createHash("sha256")
        .update(value, "utf8")
        .digest("hex");
}

describe("mTLS first-key step-up claim consumption", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-mtls-step-up-claim-",
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

    async function createFixture() {
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: "mtls",
                providerUserId: "alice@example.com",
                profile: {},
            },
        });
        const proof = "fresh-mtls-browser-proof";
        const requestDigest = `aemrb1_${"A".repeat(43)}`;
        const pending = await createMtlsClaimCode({
            userId: account.id,
            ttlMs: 60_000,
            stepUp: {
                purpose:
                    "account_encryption_first_key",
                providerUserId: "alice@example.com",
                proofHash: sha256Hex(proof),
                requestDigest,
            },
        });
        return {
            accountId: account.id,
            requestDigest,
            externalAuthProof: {
                provider: "mtls",
                pending,
                proof,
            },
        } as const;
    }

    it.each([
        [
            "wrong request",
            (fixture: Awaited<
                ReturnType<typeof createFixture>
            >) => ({
                ...fixture,
                requestDigest:
                    `aemrb1_${"B".repeat(43)}`,
            }),
            "binding_mismatch",
        ],
        [
            "wrong proof",
            (fixture: Awaited<
                ReturnType<typeof createFixture>
            >) => ({
                ...fixture,
                externalAuthProof: {
                    ...fixture.externalAuthProof,
                    proof: "wrong-proof",
                },
            }),
            "binding_mismatch",
        ],
        [
            "wrong provider",
            (fixture: Awaited<
                ReturnType<typeof createFixture>
            >) => ({
                ...fixture,
                externalAuthProof: {
                    ...fixture.externalAuthProof,
                    provider: "github",
                },
            }),
            "invalid_or_consumed",
        ],
    ])(
        "fails closed for %s and leaves the claim retryable",
        async (_label, mutate, reason) => {
            const fixture = await createFixture();
            await expect(inTx(async (tx) =>
                await consumeAccountEncryptionFirstKeyExternalAuthProofInTx(
                    tx,
                    mutate(fixture),
                ))).resolves.toEqual({
                ok: false,
                reason,
            });
            expect(await db.repeatKey.findUnique({
                where: {
                    key:
                        `mtls_claim_${
                            fixture.externalAuthProof.pending
                        }`,
                },
            })).not.toBeNull();
        },
    );

    it("fails closed for expiry and stale identity without consuming the claim", async () => {
        const expired = await createFixture();
        await db.repeatKey.update({
            where: {
                key:
                    `mtls_claim_${
                        expired.externalAuthProof.pending
                    }`,
            },
            data: { expiresAt: new Date(Date.now() - 1) },
        });
        await expect(inTx(async (tx) =>
            await consumeAccountEncryptionFirstKeyExternalAuthProofInTx(
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
            where: {
                accountId: staleIdentity.accountId,
            },
        });
        await expect(inTx(async (tx) =>
            await consumeAccountEncryptionFirstKeyExternalAuthProofInTx(
                tx,
                staleIdentity,
            ))).resolves.toEqual({
            ok: false,
            reason: "identity_mismatch",
        });
        expect(await db.repeatKey.findUnique({
            where: {
                key:
                    `mtls_claim_${
                        staleIdentity.externalAuthProof.pending
                    }`,
            },
        })).not.toBeNull();
    });

    it("rolls consumption back with the Account transaction and remains single-use after commit", async () => {
        const fixture = await createFixture();

        await expect(inTx(async (tx) => {
            const consumed =
                await consumeAccountEncryptionFirstKeyExternalAuthProofInTx(
                    tx,
                    fixture,
                );
            expect(consumed.ok).toBe(true);
            throw new Error("later-migration-write-rejected");
        })).rejects.toThrow(
            "later-migration-write-rejected",
        );

        await expect(inTx(async (tx) =>
            await consumeAccountEncryptionFirstKeyExternalAuthProofInTx(
                tx,
                fixture,
            ))).resolves.toEqual({
            ok: true,
            provider: "mtls",
            providerUserId: "alice@example.com",
        });
        await expect(inTx(async (tx) =>
            await consumeAccountEncryptionFirstKeyExternalAuthProofInTx(
                tx,
                fixture,
            ))).resolves.toEqual({
            ok: false,
            reason: "invalid_or_consumed",
        });
    });
});
