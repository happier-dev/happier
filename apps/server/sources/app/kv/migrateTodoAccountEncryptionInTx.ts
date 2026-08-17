import {
    type AccountEncryptionMigrateTodosDirective,
} from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";

import type { Tx } from "@/storage/inTx";

import {
    kvMutateTodoAccountEncryptionTransitionInTx,
    type KVMutation,
    type KVMutateResult,
} from "./kvMutate";
import {
    assertTodoKvStoredContentMatchesAccountMode,
    classifyTodoKvStoredContent,
} from "./todoKvStoredContent";

type TodoMigrationMutationOwner = (
    mutations: KVMutation[],
) => Promise<KVMutateResult>;

export class TodoAccountEncryptionMigrationConflictError extends Error {
    constructor() {
        super("Todo account-encryption migration lost its version precondition");
        this.name = "TodoAccountEncryptionMigrationConflictError";
    }
}

export type TodoAccountEncryptionMigrationResult =
    | Readonly<{ status: "applied" }>
    | Readonly<{ status: "not_empty" }>
    | Readonly<{ status: "migration_incomplete" }>
    | Readonly<{ status: "invalid_content" }>;

export type TodoAccountEncryptionMigrationPostStateResult =
    | Readonly<{ status: "matched" }>
    | Readonly<{ status: "mismatch" }>;

type TodoAccountEncryptionMigrationRow = Readonly<{
    key: string;
    version: number;
    value: Uint8Array;
}>;

async function readTodoAccountEncryptionMigrationRowsInTx(
    tx: Tx,
    accountId: string,
): Promise<readonly TodoAccountEncryptionMigrationRow[]> {
    const candidateRows = await tx.userKVStore.findMany({
        where: {
            accountId,
            key: { startsWith: "todo." },
            value: { not: null },
        },
        select: { key: true, version: true, value: true },
    });
    const rows: TodoAccountEncryptionMigrationRow[] = [];
    for (const row of candidateRows) {
        if (
            row.value !== null
            && classifyTodoKvStoredContent({
                key: row.key,
                value: row.value,
            }).domain === "todo"
        ) {
            rows.push({
                key: row.key,
                version: row.version,
                value: row.value,
            });
        }
    }
    return rows;
}

function todoBytesEqual(
    left: Uint8Array,
    right: Uint8Array,
): boolean {
    return left.byteLength === right.byteLength
        && left.every((value, index) => value === right[index]);
}

function todoValueMatchesMode(
    key: string,
    value: string,
    mode: "plain" | "e2ee",
): boolean {
    try {
        const decoded = privacyKit.decodeBase64(value);
        const classification = classifyTodoKvStoredContent({
            key,
            value: decoded,
        });
        if (classification.domain !== "todo") return false;
        assertTodoKvStoredContentMatchesAccountMode({
            key,
            value: decoded,
            accountMode: mode,
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Read-only exact Todo KV post-state matcher for Account-transition replay.
 */
export async function matchTodoAccountEncryptionMigrationPostStateInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        toMode: "plain" | "e2ee";
        directive: AccountEncryptionMigrateTodosDirective;
    }>,
): Promise<TodoAccountEncryptionMigrationPostStateResult> {
    const rows =
        await readTodoAccountEncryptionMigrationRowsInTx(
            params.tx,
            params.accountId,
        );
    if (params.directive.action === "assert_empty") {
        return {
            status: rows.length === 0
                ? "matched"
                : "mismatch",
        };
    }
    const itemsByKey = new Map(
        params.directive.items.map((item) => [
            item.key,
            item,
        ] as const),
    );
    if (
        itemsByKey.size !== params.directive.items.length
        || itemsByKey.size !== rows.length
    ) {
        return { status: "mismatch" };
    }
    for (const row of rows) {
        const item = itemsByKey.get(row.key);
        if (!item) return { status: "mismatch" };
        let expectedValue: Uint8Array;
        try {
            expectedValue = privacyKit.decodeBase64(item.value);
        } catch {
            return { status: "mismatch" };
        }
        if (
            row.version !== item.expectedVersion + 1
            || !todoBytesEqual(row.value, expectedValue)
            || !todoValueMatchesMode(
                row.key,
                item.value,
                params.toMode,
            )
        ) {
            return { status: "mismatch" };
        }
    }
    return { status: "matched" };
}

export async function migrateTodoAccountEncryptionInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    fromMode: "plain" | "e2ee";
    toMode: "plain" | "e2ee";
    directive: AccountEncryptionMigrateTodosDirective;
    mutate?: TodoMigrationMutationOwner;
}>): Promise<TodoAccountEncryptionMigrationResult> {
    const rows =
        await readTodoAccountEncryptionMigrationRowsInTx(
            params.tx,
            params.accountId,
        );
    if (params.directive.action === "assert_empty") {
        return rows.length === 0
            ? { status: "applied" }
            : { status: "not_empty" };
    }

    const itemsByKey = new Map(
        params.directive.items.map((item) => [item.key, item]),
    );
    if (
        itemsByKey.size !== params.directive.items.length
        || itemsByKey.size !== rows.length
    ) {
        return { status: "migration_incomplete" };
    }
    for (const row of rows) {
        const item = itemsByKey.get(row.key);
        if (!item || item.expectedVersion !== row.version) {
            return { status: "migration_incomplete" };
        }
        if (
            !todoValueMatchesMode(
                row.key,
                Buffer.from(row.value).toString("base64"),
                params.fromMode,
            )
        ) {
            return { status: "invalid_content" };
        }
        if (!todoValueMatchesMode(item.key, item.value, params.toMode)) {
            return { status: "invalid_content" };
        }
    }

    const mutations = params.directive.items.map((item) => ({
        key: item.key,
        version: item.expectedVersion,
        value: item.value,
    }));
    const result = await (
        params.mutate
        ?? (async (values: KVMutation[]) =>
            await kvMutateTodoAccountEncryptionTransitionInTx(
                params.tx,
                { uid: params.accountId },
                values,
                params.fromMode,
                params.toMode,
            ))
    )(mutations);
    if (!result.success) {
        throw new TodoAccountEncryptionMigrationConflictError();
    }
    return { status: "applied" };
}
