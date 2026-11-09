import { createHash } from "node:crypto";

import { isStoredJsonContentEnvelopeModeCompatible, type StoredJsonContentEnvelope } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import { z } from "zod/mini";

import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { inTx, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
import {
    decodeAccountContentFromAtRestStorage,
    encodeAccountContentForAtRestStorage,
} from "../accountContentAtRestStorage";

export type ConnectedAccountAttemptTransactionKind = "manual" | "oauth" | "device";

export interface ConnectedAccountAttemptTransactionScope {
    machineId?: string;
    service: Readonly<{ pluginId: string; localId: string }>;
    modeId: string;
    intent: "connect" | "reconnect";
    phase: "starting" | "configurationRequired" | "awaitingManual" | "awaitingOAuth" | "awaitingDeviceAuthorization" | "outcomeUnknown";
    createdAtMs: number;
}

export interface PendingConnectedAccountAttemptTransaction {
    attemptId: string;
    kind: ConnectedAccountAttemptTransactionKind;
    modeId: string;
    intent: ConnectedAccountAttemptTransactionScope["intent"];
    phase: Exclude<ConnectedAccountAttemptTransactionScope["phase"], "starting">;
    createdAtMs: number;
    expiresAtMs: number;
}

export interface ConnectedAccountAttemptTransactionRecord {
    kind: ConnectedAccountAttemptTransactionKind;
    revision: number;
    content: StoredJsonContentEnvelope;
    expiresAtMs: number;
    scope: ConnectedAccountAttemptTransactionScope;
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

const StoredConnectedAccountAttemptTransactionSchema = z.strictObject({
    version: z.literal(2),
    revision: z.number().check(z.int(), z.minimum(1)),
    attemptId: z.string().check(z.minLength(1), z.maxLength(160)),
    kind: z.enum(["manual", "oauth", "device"]),
    scope: z.strictObject({
        machineId: z.optional(z.string().check(z.minLength(1), z.maxLength(256))),
        service: z.strictObject({
            pluginId: z.string().check(z.minLength(1), z.maxLength(256)),
            localId: z.string().check(z.minLength(1), z.maxLength(256)),
        }),
        modeId: z.string().check(z.minLength(1), z.maxLength(256)),
        intent: z.enum(["connect", "reconnect"]),
        phase: z.enum(["starting", "configurationRequired", "awaitingManual", "awaitingOAuth", "awaitingDeviceAuthorization", "outcomeUnknown"]),
        createdAtMs: z.number().check(z.int(), z.nonnegative()),
    }),
    content: z.string().check(z.minLength(1)),
});

function accountTransactionPrefix(accountId: string): string {
    const accountDigest = createHash("sha256")
        .update(JSON.stringify(["connected-account-attempt-account-v2", accountId]))
        .digest("base64url");
    return `caat_v3_${accountDigest}_`;
}

/**
 * Persisted `Account.encryptionMode` is the sole representation authority for this
 * Account-scoped row. A plain Account writes and reads `{ t: 'plain', v }` and an
 * E2EE Account `{ t: 'encrypted', c }`; a disagreement fails closed before content is
 * disclosed or mutated instead of being reinterpreted as the other branch.
 */
async function readAccountMode(
    tx: Tx,
    accountId: string,
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
    return Object.freeze({ status: "ok" as const, accountMode });
}

async function readAccountEnvelopeAdmission(
    tx: Tx,
    accountId: string,
    content: StoredJsonContentEnvelope,
): Promise<
    | Readonly<{ status: "ok"; accountMode: "plain" | "e2ee" }>
    | Readonly<{ status: "storage_mode_mismatch" }>
> {
    const admission = await readAccountMode(tx, accountId);
    return admission.status === "ok" && !isStoredJsonContentEnvelopeModeCompatible(admission.accountMode, content)
        ? Object.freeze({ status: "storage_mode_mismatch" as const })
        : admission;
}

function transactionKey(input: Readonly<{
    accountId: string;
    attemptId: string;
}>): string {
    const digest = createHash("sha256")
        .update(JSON.stringify([
            "connected-account-attempt-transaction-v3",
            input.attemptId,
        ]))
        .digest("base64url");
    return `${accountTransactionPrefix(input.accountId)}${digest}`;
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
    identity: Readonly<{
        kind: ConnectedAccountAttemptTransactionKind;
        attemptId: string;
        scope: ConnectedAccountAttemptTransactionScope;
    }>,
): string {
    return JSON.stringify({
        version: 2,
        revision,
        attemptId: identity.attemptId,
        kind: identity.kind,
        scope: identity.scope,
        content: atRestContent,
    });
}

function parseRecord(
    value: string,
    expiresAt: Date,
    accountId: string,
):
    | Readonly<{
        status: "ok";
        identity: Readonly<{
            kind: ConnectedAccountAttemptTransactionKind;
            attemptId: string;
            scope: ConnectedAccountAttemptTransactionScope;
        }>;
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
            keyPath: transactionStorageKeyPath({ accountId, kind: parsed.data.kind, attemptId: parsed.data.attemptId }),
            value: parsed.data.content,
        });
    } catch {
        return Object.freeze({ status: "unreadable" as const });
    }
    return Object.freeze({
        status: "ok" as const,
        identity: Object.freeze({
            kind: parsed.data.kind,
            attemptId: parsed.data.attemptId,
            scope: parsed.data.scope,
        }),
        record: Object.freeze({
            kind: parsed.data.kind,
            revision: parsed.data.revision,
            content,
            expiresAtMs: expiresAt.getTime(),
            scope: parsed.data.scope,
        }),
    });
}

async function readCurrent(
    tx: Tx,
    accountId: string,
    key: string,
    nowMs: number,
    identity: Readonly<{
        kind?: ConnectedAccountAttemptTransactionKind;
        attemptId: string;
    }>,
): Promise<
    | Readonly<{
        status: "ok";
        row: Readonly<{ value: string; expiresAt: Date }>;
        record: ConnectedAccountAttemptTransactionRecord;
        scope: ConnectedAccountAttemptTransactionScope;
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
    const parsed = parseRecord(row.value, row.expiresAt, accountId);
    if (parsed.status !== "ok") return parsed;
    if ((identity.kind !== undefined && parsed.identity.kind !== identity.kind) || parsed.identity.attemptId !== identity.attemptId) {
        return Object.freeze({ status: "unreadable" as const });
    }
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
        scope: parsed.identity.scope,
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
    scope: ConnectedAccountAttemptTransactionScope;
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
                    }), input),
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
            kind: input.kind,
            revision: 1,
            content: input.content,
            expiresAtMs: input.expiresAtMs,
            scope: input.scope,
        }),
    });
}

/**
 * Reads only the exact authenticated account's opaque attempt transaction.
 */
export async function readConnectedAccountAttemptTransaction(input: Readonly<{
    accountId: string;
    attemptId: string;
    nowMs: number;
}>): Promise<ConnectedAccountAttemptTransactionReadResult> {
    return await inTx(async (tx) => {
        const current = await readCurrent(
            tx,
            input.accountId,
            transactionKey(input),
            input.nowMs,
            input,
        );
        return current.status === "ok"
            ? Object.freeze({ status: "ok" as const, record: current.record })
            : current;
    });
}

/** Finds this Account's current transactions, then projects only non-secret resume facts. */
export async function listPendingConnectedAccountAttemptTransactions(input: Readonly<{
    accountId: string;
    machineId?: string;
    service: Readonly<{ pluginId: string; localId: string }>;
    nowMs: number;
}>): Promise<
    | Readonly<{ status: "ok"; attempts: readonly PendingConnectedAccountAttemptTransaction[] }>
    | Readonly<{ status: "unreadable" | "storage_mode_mismatch" }>
> {
    return await inTx(async (tx) => {
        const admission = await readAccountMode(tx, input.accountId);
        if (admission.status !== "ok") return admission;
        const rows = await tx.repeatKey.findMany({
            where: {
                key: { startsWith: accountTransactionPrefix(input.accountId) },
                expiresAt: { gt: new Date(input.nowMs) },
            },
            select: { key: true, value: true, expiresAt: true },
        });
        const attempts: PendingConnectedAccountAttemptTransaction[] = [];
        for (const row of rows) {
            let outer: unknown;
            try {
                outer = JSON.parse(row.value);
            } catch {
                return Object.freeze({ status: "unreadable" as const });
            }
            const stored = StoredConnectedAccountAttemptTransactionSchema.safeParse(outer);
            if (!stored.success) {
                return Object.freeze({ status: "unreadable" as const });
            }
            const identity = stored.data;
            if (row.key !== transactionKey({
                accountId: input.accountId,
                attemptId: identity.attemptId,
            })) {
                return Object.freeze({ status: "unreadable" as const });
            }
            const parsed = parseRecord(
                row.value,
                row.expiresAt,
                input.accountId,
            );
            if (parsed.status !== "ok") return parsed;
            if (!isStoredJsonContentEnvelopeModeCompatible(admission.accountMode, parsed.record.content)) {
                return Object.freeze({ status: "storage_mode_mismatch" as const });
            }
            const scope = identity.scope;
            if (
                scope.machineId !== input.machineId
                || scope.service.pluginId !== input.service.pluginId
                || scope.service.localId !== input.service.localId
                || scope.phase === "starting"
            ) continue;
            attempts.push(Object.freeze({
                attemptId: identity.attemptId,
                kind: identity.kind,
                modeId: scope.modeId,
                intent: scope.intent,
                phase: scope.phase,
                createdAtMs: scope.createdAtMs,
                expiresAtMs: row.expiresAt.getTime(),
            }));
        }
        return Object.freeze({
            status: "ok" as const,
            attempts: Object.freeze(attempts.sort((a, b) => b.createdAtMs - a.createdAtMs)),
        });
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
    scope: ConnectedAccountAttemptTransactionScope;
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
            input,
        );
        if (current.status !== "ok") {
            return Object.freeze({ status: current.status });
        }
        if (current.record.revision !== input.expectedRevision) {
            return Object.freeze({ status: "conflict" as const });
        }
        if (
            current.scope.machineId !== input.scope.machineId
            || current.scope.service.pluginId !== input.scope.service.pluginId
            || current.scope.service.localId !== input.scope.service.localId
            || current.scope.modeId !== input.scope.modeId
            || current.scope.intent !== input.scope.intent
            || current.scope.createdAtMs !== input.scope.createdAtMs
        ) {
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
            input,
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
                kind: input.kind,
                revision,
                content: input.content,
                expiresAtMs: input.expiresAtMs,
                scope: input.scope,
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
            input,
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
