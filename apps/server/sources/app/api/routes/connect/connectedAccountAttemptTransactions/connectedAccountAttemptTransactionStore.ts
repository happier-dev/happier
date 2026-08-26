import { createHash } from "node:crypto";

import {
    isStoredJsonContentEnvelopeModeCompatible,
    type StoredJsonContentEnvelope,
} from "@happier-dev/protocol";
import { z } from "zod";

import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { inTx, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
import {
    decodeAccountContentFromAtRestStorage,
    encodeAccountContentForAtRestStorage,
} from "../accountContentAtRestStorage";

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
    | Readonly<{
        status:
            | "not_found"
            | "conflict"
            | "storage_mode_mismatch"
            | "unreadable";
    }>;

export type ConnectedAccountAttemptTransactionReadResult =
    | Readonly<{
        status: "ok";
        record: ConnectedAccountAttemptTransactionRecord;
    }>
    | Readonly<{
        status: "not_found" | "storage_mode_mismatch" | "unreadable";
    }>;

const StoredConnectedAccountAttemptTransactionSchema = z.object({
    version: z.literal(1),
    revision: z.number().int().min(1),
    content: z.string().min(1),
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
): Promise<
    | Readonly<{ status: "ok"; accountMode: "plain" | "e2ee" }>
    | Readonly<{ status: "storage_mode_mismatch" }>
> {
    const mismatch = Object.freeze({
        status: "storage_mode_mismatch" as const,
    });
    const account = await tx.account.findUnique({
        where: { id: accountId },
        select: {
            publicKey: true,
            encryptionMode: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    if (!account) return mismatch;
    const currentness = deriveAccountEncryptionCurrentnessFromRow(account);
    if (currentness.status === "inconsistent") return mismatch;
    const accountMode = currentness.currentness.encryptionMode;
    return isStoredJsonContentEnvelopeModeCompatible(
        accountMode,
        content,
    )
        ? Object.freeze({ status: "ok" as const, accountMode })
        : mismatch;
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

/**
 * Domain-separated at-rest path for one exact attempt transaction, so a sealed
 * payload can only be opened as the attempt it was written for.
 */
function transactionStorageKeyPath(input: Readonly<{
    accountId: string;
    kind: ConnectedAccountAttemptTransactionKind;
    attemptId: string;
}>): string[] {
    return [
        "storage",
        "connected_account_attempt_transaction",
        input.kind,
        input.accountId,
        input.attemptId,
        "v1",
    ];
}

function encodeStored(
    revision: number,
    atRestContent: string,
): string {
    return JSON.stringify({
        version: 1,
        revision,
        content: atRestContent,
    });
}

function parseRecord(
    value: string,
    expiresAt: Date,
    keyPath: string[],
):
    | Readonly<{
        status: "ok";
        record: ConnectedAccountAttemptTransactionRecord;
    }>
    | Readonly<{ status: "unreadable" }> {
    let decoded: unknown;
    try {
        decoded = JSON.parse(value);
    } catch {
        return Object.freeze({ status: "unreadable" as const });
    }
    const parsed = StoredConnectedAccountAttemptTransactionSchema.safeParse(decoded);
    if (!parsed.success) {
        return Object.freeze({ status: "unreadable" as const });
    }
    let content: StoredJsonContentEnvelope;
    try {
        content = decodeAccountContentFromAtRestStorage({
            keyPath,
            value: parsed.data.content,
        });
    } catch {
        return Object.freeze({ status: "unreadable" as const });
    }
    return Object.freeze({
        status: "ok" as const,
        record: Object.freeze({
            revision: parsed.data.revision,
            content,
            expiresAtMs: expiresAt.getTime(),
        }),
    });
}

async function readCurrent(
    tx: Tx,
    accountId: string,
    key: string,
    nowMs: number,
    keyPath: string[],
): Promise<
    | Readonly<{
        status: "ok";
        row: Readonly<{ value: string; expiresAt: Date }>;
        record: ConnectedAccountAttemptTransactionRecord;
    }>
    | Readonly<{
        status: "not_found" | "storage_mode_mismatch" | "unreadable";
    }>
> {
    const row = await tx.repeatKey.findUnique({ where: { key } });
    if (!row) return Object.freeze({ status: "not_found" as const });
    if (row.expiresAt.getTime() <= nowMs) {
        await tx.repeatKey.deleteMany({
            where: { key, value: row.value },
        });
        return Object.freeze({ status: "not_found" as const });
    }
    const parsed = parseRecord(row.value, row.expiresAt, keyPath);
    if (parsed.status !== "ok") return parsed;
    const admission = await readAccountEnvelopeAdmission(
        tx,
        accountId,
        parsed.record.content,
    );
    if (admission.status !== "ok") return admission;
    return Object.freeze({
        status: "ok" as const,
        row: Object.freeze({ value: row.value, expiresAt: row.expiresAt }),
        record: parsed.record,
    });
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
    const keyPath = transactionStorageKeyPath(input);
    try {
        const admission = await inTx(async (tx) => {
            const result = await readAccountEnvelopeAdmission(
                tx,
                input.accountId,
                input.content,
            );
            if (result.status !== "ok") return result.status;
            await tx.repeatKey.create({
                data: {
                    key,
                    value: encodeStored(1, encodeAccountContentForAtRestStorage({
                        accountMode: result.accountMode,
                        keyPath,
                        content: input.content,
                    })),
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
}>): Promise<ConnectedAccountAttemptTransactionReadResult> {
    return await inTx(async (tx) => {
        const current = await readCurrent(
            tx,
            input.accountId,
            transactionKey(input),
            input.nowMs,
            transactionStorageKeyPath(input),
        );
        return current.status === "ok"
            ? Object.freeze({ status: "ok" as const, record: current.record })
            : current;
    });
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
        if (admission.status !== "ok") {
            return Object.freeze({ status: "storage_mode_mismatch" as const });
        }
        const key = transactionKey(input);
        const keyPath = transactionStorageKeyPath(input);
        const current = await readCurrent(
            tx,
            input.accountId,
            key,
            input.nowMs,
            keyPath,
        );
        if (current.status !== "ok") {
            return Object.freeze({ status: current.status });
        }
        if (current.record.revision !== input.expectedRevision) {
            return Object.freeze({ status: "conflict" as const });
        }
        const revision = current.record.revision + 1;
        const value = encodeStored(
            revision,
            encodeAccountContentForAtRestStorage({
                accountMode: admission.accountMode,
                keyPath,
                content: input.content,
            }),
        );
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
}>): Promise<Readonly<{
    status:
        | "deleted"
        | "not_found"
        | "conflict"
        | "storage_mode_mismatch"
        | "unreadable";
}>> {
    return await inTx(async (tx) => {
        const key = transactionKey(input);
        const current = await readCurrent(
            tx,
            input.accountId,
            key,
            input.nowMs,
            transactionStorageKeyPath(input),
        );
        if (current.status !== "ok") {
            return Object.freeze({ status: current.status });
        }
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
