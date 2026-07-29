import { createHash } from "node:crypto";

import { z } from "zod";

import { inTx, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";

export type ConnectedAccountAttemptTransactionKind = "oauth" | "device";

export interface ConnectedAccountAttemptTransactionRecord {
    revision: number;
    ciphertext: string;
    expiresAtMs: number;
}

export type ConnectedAccountAttemptTransactionMutationResult =
    | Readonly<{
        status: "ok";
        record: ConnectedAccountAttemptTransactionRecord;
    }>
    | Readonly<{ status: "not_found" | "conflict" }>;

const StoredConnectedAccountAttemptTransactionSchema = z.object({
    version: z.literal(1),
    revision: z.number().int().min(1),
    ciphertext: z.string().min(1).max(524_288),
}).strict();

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
    ciphertext: string,
): string {
    return JSON.stringify({
        version: 1,
        revision,
        ciphertext,
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
        ciphertext: parsed.data.ciphertext,
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
    ciphertext: string;
    expiresAtMs: number;
}>): Promise<ConnectedAccountAttemptTransactionMutationResult> {
    const key = transactionKey(input);
    const value = encodeStored(1, input.ciphertext);
    try {
        await inTx(async (tx) => {
            await tx.repeatKey.create({
                data: {
                    key,
                    value,
                    expiresAt: new Date(input.expiresAtMs),
                },
            });
        });
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
            ciphertext: input.ciphertext,
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
    ciphertext: string;
    expiresAtMs: number;
    nowMs: number;
}>): Promise<ConnectedAccountAttemptTransactionMutationResult> {
    return await inTx(async (tx) => {
        const key = transactionKey(input);
        const current = await readCurrent(tx, key, input.nowMs);
        if (!current) return Object.freeze({ status: "not_found" as const });
        if (current.record.revision !== input.expectedRevision) {
            return Object.freeze({ status: "conflict" as const });
        }
        const revision = current.record.revision + 1;
        const value = encodeStored(revision, input.ciphertext);
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
                ciphertext: input.ciphertext,
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
