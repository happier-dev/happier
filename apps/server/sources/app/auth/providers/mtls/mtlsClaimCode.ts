import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
    AccountEncryptionMigrateExternalAuthBindingDigestV1Schema,
    type AccountEncryptionMigrateExternalAuthBindingDigestV1,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";

const MTLS_CLAIM_CODE_PREFIX = "mtls_claim_";

const MtlsFirstKeyStepUpClaimSchema = z
    .object({
        userId: z.string().min(1),
        purpose:
            z.literal("account_encryption_first_key"),
        providerUserId: z.string().min(1),
        proofHash: z.string().regex(/^[0-9a-f]{64}$/),
        requestDigest:
            AccountEncryptionMigrateExternalAuthBindingDigestV1Schema,
    })
    .strict();

export async function createMtlsClaimCode(params: {
    userId: string;
    ttlMs: number;
    stepUp?: Readonly<{
        purpose: "account_encryption_first_key";
        providerUserId: string;
        proofHash: string;
        requestDigest:
            AccountEncryptionMigrateExternalAuthBindingDigestV1;
    }>;
}): Promise<string> {
    const ttlMs =
        Number.isFinite(params.ttlMs) && params.ttlMs > 0
            ? params.ttlMs
            : 60_000;
    for (let i = 0; i < 3; i++) {
        const code = randomKeyNaked(32);
        const key = `${MTLS_CLAIM_CODE_PREFIX}${code}`;
        try {
            await db.repeatKey.create({
                data: {
                    key,
                    value: JSON.stringify({
                        userId: params.userId,
                        ...(params.stepUp ?? {}),
                    }),
                    expiresAt: new Date(Date.now() + ttlMs),
                },
            });
            return code;
        } catch {
            // Retry the existing claim allocation on a rare key collision.
        }
    }
    throw new Error("mtls-claim-code-unavailable");
}

export async function consumeMtlsClaimCode(
    code: string,
): Promise<{ userId: string } | null> {
    const raw = code.toString().trim();
    if (!raw) return null;
    const key = `${MTLS_CLAIM_CODE_PREFIX}${raw}`;

    return await db.$transaction(async (tx) => {
        const row = await tx.repeatKey.findUnique({
            where: { key },
            select: { value: true, expiresAt: true },
        });
        if (!row) return null;
        const now = new Date();
        const deleted = await tx.repeatKey.deleteMany({
            where: {
                key,
                expiresAt: { gt: now },
            },
        });
        if (deleted.count !== 1) {
            await tx.repeatKey.deleteMany({ where: { key } })
                .catch(() => undefined);
            return null;
        }
        try {
            const parsed = JSON.parse(row.value) as {
                userId?: unknown;
                purpose?: unknown;
            };
            const userId =
                typeof parsed.userId === "string"
                    ? parsed.userId.trim()
                    : "";
            if (
                !userId
                || parsed.purpose
                    === "account_encryption_first_key"
            ) return null;
            return { userId };
        } catch {
            return null;
        }
    });
}

function proofHashMatches(
    proof: string,
    expectedHex: string,
): boolean {
    const actual = createHash("sha256")
        .update(proof, "utf8")
        .digest();
    const expected = Buffer.from(expectedHex, "hex");
    return expected.length === actual.length
        && timingSafeEqual(actual, expected);
}

export async function consumeMtlsFirstKeyStepUpClaimInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        pending: string;
        proof: string;
        requestDigest:
            AccountEncryptionMigrateExternalAuthBindingDigestV1;
    }>,
): Promise<
    | Readonly<{
        ok: true;
        provider: "mtls";
        providerUserId: string;
    }>
    | Readonly<{
        ok: false;
        reason:
            | "invalid_or_consumed"
            | "expired"
            | "binding_mismatch"
            | "identity_mismatch";
    }>
> {
    const pending = params.pending.toString().trim();
    if (!/^[A-Za-z0-9]{8,128}$/.test(pending)) {
        return { ok: false, reason: "invalid_or_consumed" };
    }
    const key = `${MTLS_CLAIM_CODE_PREFIX}${pending}`;
    const row = await tx.repeatKey.findUnique({
        where: { key },
        select: { value: true, expiresAt: true },
    });
    if (!row) {
        return { ok: false, reason: "invalid_or_consumed" };
    }
    const now = new Date();
    if (row.expiresAt.getTime() <= now.getTime()) {
        return { ok: false, reason: "expired" };
    }
    let decoded: unknown;
    try {
        decoded = JSON.parse(row.value);
    } catch {
        return { ok: false, reason: "invalid_or_consumed" };
    }
    const claim =
        MtlsFirstKeyStepUpClaimSchema.safeParse(decoded);
    if (!claim.success) {
        return { ok: false, reason: "invalid_or_consumed" };
    }
    if (
        claim.data.userId !== params.accountId
        || claim.data.requestDigest !== params.requestDigest
        || !proofHashMatches(params.proof, claim.data.proofHash)
    ) {
        return { ok: false, reason: "binding_mismatch" };
    }
    const identity = await tx.accountIdentity.findFirst({
        where: {
            accountId: params.accountId,
            provider: "mtls",
            providerUserId: claim.data.providerUserId,
        },
        select: { id: true },
    });
    if (!identity) {
        return { ok: false, reason: "identity_mismatch" };
    }
    const deleted = await tx.repeatKey.deleteMany({
        where: {
            key,
            expiresAt: { gt: now },
        },
    });
    if (deleted.count !== 1) {
        return { ok: false, reason: "invalid_or_consumed" };
    }
    return {
        ok: true,
        provider: "mtls",
        providerUserId: claim.data.providerUserId,
    };
}
