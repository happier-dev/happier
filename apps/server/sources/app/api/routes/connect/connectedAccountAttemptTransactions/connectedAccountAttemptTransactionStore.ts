import { createHash } from "node:crypto";

import {
    StoredJsonContentEnvelopeSchema,
    isStoredJsonContentEnvelopeModeCompatible,
    type StoredJsonContentEnvelope,
} from "@happier-dev/protocol";
import { z } from "zod";

import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { inTx, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";

export type ConnectedAccountAttemptTransactionKind = "oauth" | "device";

export interface ConnectedAccountAttemptTransactionRecord {
    revision: number;
    content: StoredJsonContentEnvelope;
    expiresAtMs: number;
}

export type ConnectedAccountAttemptTransactionMutationResult =
    | Readonly<{
        status: "ok";
        record: ConnectedAccountAttemptTransactionRecord;
    }>
    | Readonly<{ status: "not_found" | "conflict" | "storage_mode_mismatch" }>;

const StoredConnectedAccountAttemptTransactionSchema = z.object({
    version: z.literal(1),
    revision: z.number().int().min(1),
    content: StoredJsonContentEnvelopeSchema,
}).strict();

/**
 * Persisted `Account.encryptionMode` is the sole representation authority for this
 * Account-scoped row. A plain Account writes and reads `{ t: 'plain', v }` and an
 * E2EE Account `{ t: 'encrypted', c }`; a disagreement fails closed before content is
 * disclosed or mutated instead of being reinterpreted as the other branch.
 */
async function readAccountEnvelopeAdmission(
    tx: Tx,
    accountId: string,
    content: StoredJsonContentEnvelope,
): Promise<"ok" | "storage_mode_mismatch"> {
    const account = await tx.account.findUnique({
        where: { id: accountId },
        select: {
            publicKey: true,
            encryptionMode: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    if (!account) return "storage_mode_mismatch";
    const currentness = deriveAccountEncryptionCurrentnessFromRow(account);
    if (currentness.status === "inconsistent") return "storage_mode_mismatch";
    return isStoredJsonContentEnvelopeModeCompatible(
        currentness.currentness.encryptionMode,
        content,
    )
        ? "ok"
        : "storage_mode_mismatch";
}

function transactionKey(input: Readonly<{
    accountId: string;
    kind: ConnectedAccountAttemptTransactionKind;
    attemptId: string;
}>): string {
    const digest = createHash("sha256")
        .update(JSON.stringify([
            "connected-account-attempt-transaction-v1",
            input.accountId,
            input.kind,
            input.attemptId,
        ]))
        .digest("base64url");
    return `caat_v1_${digest}`;
}

function encodeStored(
    revision: number,
    content: StoredJsonContentEnvelope,
): string {
    return JSON.stringify({
        version: 1,
        revision,
        content,
    });
}

function parseRecord(
    value: string,
    expiresAt: Date,
): ConnectedAccountAttemptTransactionRecord | null {
    let decoded: unknown;
    try {
        decoded = JSON.parse(value);
    } catch {
        return null;
    }
    const parsed = StoredConnectedAccountAttemptTransactionSchema.safeParse(decoded);
    if (!parsed.success) return null;
    return Object.freeze({
        revision: parsed.data.revision,
        content: parsed.data.content,
        expiresAtMs: expiresAt.getTime(),
    });
}

async function readCurrent(
    tx: Tx,
    key: string,
    nowMs: number,
) {
    const row = await tx.repeatKey.findUnique({ where: { key } });
    if (!row) return null;
    if (row.expiresAt.getTime() <= nowMs) {
        await tx.repeatKey.deleteMany({
            where: { key, value: row.value },
        });
        return null;
    }
    const record = parseRecord(row.value, row.expiresAt);
    return record ? Object.freeze({ row, record }) : null;
}

/**
 * Creates one exact account/flow/attempt transaction. A duplicate identity is
 * a conflict; callers must not overwrite an in-flight authorization flow.
 */
export async function createConnectedAccountAttemptTransaction(input: Readonly<{
    accountId: string;
    kind: ConnectedAccountAttemptTransactionKind;
    attemptId: string;
    content: StoredJsonContentEnvelope;
    expiresAtMs: number;
}>): Promise<ConnectedAccountAttemptTransactionMutationResult> {
    const key = transactionKey(input);
    const value = encodeStored(1, input.content);
    try {
        const admission = await inTx(async (tx) => {
            const result = await readAccountEnvelopeAdmission(
                tx,
                input.accountId,
                input.content,
            );
            if (result !== "ok") return result;
            await tx.repeatKey.create({
                data: {
                    key,
                    value,
                    expiresAt: new Date(input.expiresAtMs),
                },
            });
            return "ok" as const;
        });
        if (admission !== "ok") {
            return Object.freeze({ status: "storage_mode_mismatch" });
        }
    } catch (error) {
        if (isPrismaErrorCode(error, "P2002")) {
            return Object.freeze({ status: "conflict" });
        }
        throw error;
    }
    return Object.freeze({
        status: "ok",
        record: Object.freeze({
            revision: 1,
            content: input.content,
            expiresAtMs: input.expiresAtMs,
        }),
    });
}

/**
 * Reads only the exact authenticated account's opaque attempt transaction.
 */
export async function readConnectedAccountAttemptTransaction(input: Readonly<{
    accountId: string;
    kind: ConnectedAccountAttemptTransactionKind;
    attemptId: string;
    nowMs: number;
}>): Promise<ConnectedAccountAttemptTransactionRecord | null> {
    return await inTx(async (tx) => (
        await readCurrent(tx, transactionKey(input), input.nowMs)
    )?.record ?? null);
}

/**
 * Replaces one transaction with compare-and-swap semantics over its exact
 * current revision and bytes, preventing stale daemons from reviving state.
 */
export async function replaceConnectedAccountAttemptTransaction(input: Readonly<{
    accountId: string;
    kind: ConnectedAccountAttemptTransactionKind;
    attemptId: string;
    expectedRevision: number;
    content: StoredJsonContentEnvelope;
    expiresAtMs: number;
    nowMs: number;
}>): Promise<ConnectedAccountAttemptTransactionMutationResult> {
    return await inTx(async (tx) => {
        const admission = await readAccountEnvelopeAdmission(
            tx,
            input.accountId,
            input.content,
        );
        if (admission !== "ok") {
            return Object.freeze({ status: "storage_mode_mismatch" as const });
        }
        const key = transactionKey(input);
        const current = await readCurrent(tx, key, input.nowMs);
        if (!current) return Object.freeze({ status: "not_found" as const });
        if (current.record.revision !== input.expectedRevision) {
            return Object.freeze({ status: "conflict" as const });
        }
        const revision = current.record.revision + 1;
        const value = encodeStored(revision, input.content);
        const updated = await tx.repeatKey.updateMany({
            where: {
                key,
                value: current.row.value,
                expiresAt: { gt: new Date(input.nowMs) },
            },
            data: {
                value,
                expiresAt: new Date(input.expiresAtMs),
            },
        });
        if (updated.count !== 1) {
            return Object.freeze({ status: "conflict" as const });
        }
        return Object.freeze({
            status: "ok" as const,
            record: Object.freeze({
                revision,
                content: input.content,
                expiresAtMs: input.expiresAtMs,
            }),
        });
    });
}

/**
 * Deletes only the exact current revision. Terminal cleanup is idempotent:
 * an already absent attempt reports not-found and cannot recreate state.
 */
export async function deleteConnectedAccountAttemptTransaction(input: Readonly<{
    accountId: string;
    kind: ConnectedAccountAttemptTransactionKind;
    attemptId: string;
    expectedRevision: number;
    nowMs: number;
}>): Promise<Readonly<{ status: "deleted" | "not_found" | "conflict" }>> {
    return await inTx(async (tx) => {
        const key = transactionKey(input);
        const current = await readCurrent(tx, key, input.nowMs);
        if (!current) return Object.freeze({ status: "not_found" as const });
        if (current.record.revision !== input.expectedRevision) {
            return Object.freeze({ status: "conflict" as const });
        }
        const deleted = await tx.repeatKey.deleteMany({
            where: {
                key,
                value: current.row.value,
                expiresAt: { gt: new Date(input.nowMs) },
            },
        });
        return Object.freeze({
            status: deleted.count === 1 ? "deleted" as const : "conflict" as const,
        });
    });
}
