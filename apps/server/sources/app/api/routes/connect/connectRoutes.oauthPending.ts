import { createHash, timingSafeEqual } from "node:crypto";
import type {
    AccountEncryptionMigrateExternalAuthBindingDigestV1,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import {
    accountEncryptionFirstKeyStepUpPendingSchema,
} from "./oauthExternal/oauthExternalSchemas";

function isSafeOAuthPendingKey(key: string): boolean {
    const pendingKey = key.toString().trim();
    if (!pendingKey) return false;
    // Bound key shape to avoid accidental deletes/reads of unrelated repeatKey entries.
    // Pending keys are generated server-side as `oauth_pending_${randomKeyNaked(24)}`.
    return /^oauth_pending_[A-Za-z0-9]{8,128}$/.test(pendingKey);
}

export async function deleteOAuthPendingBestEffort(key: string): Promise<void> {
    const pendingKey = key.toString().trim();
    if (!isSafeOAuthPendingKey(pendingKey)) return;
    await db.repeatKey.delete({ where: { key: pendingKey } }).catch(() => {});
}

export async function loadValidOAuthPending(key: string): Promise<{ key: string; value: string } | null> {
    const pendingKey = key.toString().trim();
    if (!isSafeOAuthPendingKey(pendingKey)) return null;

    const pending = await db.repeatKey.findUnique({ where: { key: pendingKey } });
    if (!pending) return null;
    if (pending.expiresAt.getTime() <= Date.now()) {
        await deleteOAuthPendingBestEffort(pendingKey);
        return null;
    }

    return { key: pending.key, value: pending.value };
}

export type AccountEncryptionFirstKeyStepUpConsumeResult =
    | Readonly<{
        ok: true;
        provider: string;
        providerUserId: string;
    }>
    | Readonly<{
        ok: false;
        reason:
            | "invalid_or_consumed"
            | "expired"
            | "binding_mismatch"
            | "identity_mismatch";
    }>;

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

export async function consumeAccountEncryptionFirstKeyStepUpPendingInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        provider: string;
        pending: string;
        proof: string;
        requestDigest:
            AccountEncryptionMigrateExternalAuthBindingDigestV1;
    }>,
): Promise<AccountEncryptionFirstKeyStepUpConsumeResult> {
    const pending = params.pending.toString().trim();
    if (!isSafeOAuthPendingKey(pending)) {
        return { ok: false, reason: "invalid_or_consumed" };
    }
    const row = await tx.repeatKey.findUnique({
        where: { key: pending },
        select: { value: true, expiresAt: true },
    });
    if (!row) {
        return { ok: false, reason: "invalid_or_consumed" };
    }
    const now = new Date();
    if (row.expiresAt.getTime() <= now.getTime()) {
        return { ok: false, reason: "expired" };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(row.value);
    } catch {
        return { ok: false, reason: "invalid_or_consumed" };
    }
    const proof =
        accountEncryptionFirstKeyStepUpPendingSchema.safeParse(parsed);
    if (!proof.success) {
        return { ok: false, reason: "invalid_or_consumed" };
    }
    if (
        proof.data.userId !== params.accountId
        || proof.data.provider !== params.provider
        || proof.data.requestDigest !== params.requestDigest
        || !proofHashMatches(params.proof, proof.data.proofHash)
    ) {
        return { ok: false, reason: "binding_mismatch" };
    }
    const identity = await tx.accountIdentity.findFirst({
        where: {
            accountId: params.accountId,
            provider: proof.data.provider,
            providerUserId: proof.data.providerUserId,
        },
        select: { id: true },
    });
    if (!identity) {
        return { ok: false, reason: "identity_mismatch" };
    }
    const deleted = await tx.repeatKey.deleteMany({
        where: {
            key: pending,
            expiresAt: { gt: now },
        },
    });
    if (deleted.count !== 1) {
        return { ok: false, reason: "invalid_or_consumed" };
    }
    return {
        ok: true,
        provider: proof.data.provider,
        providerUserId: proof.data.providerUserId,
    };
}
