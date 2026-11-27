import { type AccountEncryptionMigrateTodosDirective, type AccountEncryptionMigrateWorkspaceDirective } from '@happier-dev/protocol/account/encryptionMigrate';
import { type AccountJsonKvNamespace, ACCOUNT_JSON_KV_PREFIXES } from '@happier-dev/protocol/account/accountJsonKv';
import * as privacyKit from "privacy-kit";

import type { Tx } from "@/storage/inTx";
import { readTaskAccountEncryptionMigrationRowsInTx, validateTaskAccountEncryptionMigrationKeysInTx,
    applyTaskAccountEncryptionMigrationKeysInTx, matchTaskAccountEncryptionMigrationKeysInTx,
    type TaskAccountEncryptionMigrationRow } from '@/app/todos/accountEncryptionMigration';

import {
    kvMutateAccountJsonKvEncryptionTransitionInTx,
    applyUserKvMutationsInTx,
    type KVMutation,
    type KVMutateResult,
} from "./kvMutate";
import {
    assertAccountJsonKvStoredContentMatchesAccountMode,
    classifyAccountJsonKvStoredContent,
} from "./accountJsonKvStoredContent";

type AccountJsonKvMigrationMutationOwner = (
    mutations: KVMutation[],
) => Promise<KVMutateResult>;

export class AccountJsonKvEncryptionMigrationConflictError extends Error {
    constructor() {
        super("Account JSON KV encryption migration lost its version precondition");
        this.name = "AccountJsonKvEncryptionMigrationConflictError";
    }
}

export type AccountJsonKvEncryptionMigrationResult =
    | Readonly<{ status: "applied"; managedTasks?: ReadonlySet<string> }>
    | Readonly<{ status: "not_empty" }>
    | Readonly<{ status: "migration_incomplete" }>
    | Readonly<{ status: "invalid_content" }>;

export type AccountJsonKvEncryptionMigrationPostStateResult =
    | Readonly<{ status: "matched"; managedTasks?: ReadonlySet<string> }>
    | Readonly<{ status: "mismatch" }>;

type AccountJsonKvEncryptionMigrationRow = Readonly<{
    key: string;
    version: number;
    value: Uint8Array;
    task?: TaskAccountEncryptionMigrationRow;
}>;

async function readAccountJsonKvEncryptionMigrationRowsInTx(
    tx: Tx,
    accountId: string,
    namespace: AccountJsonKvNamespace,
): Promise<readonly AccountJsonKvEncryptionMigrationRow[]> {
    if (namespace === 'todo') {
        return (await readTaskAccountEncryptionMigrationRowsInTx(tx, accountId)).map(row => ({ ...row, task: row }));
    }
    const candidateRows = await tx.userKVStore.findMany({
        where: {
            accountId,
            key: { startsWith: ACCOUNT_JSON_KV_PREFIXES[namespace] },
            value: { not: null },
        },
        select: { key: true, version: true, value: true },
    });
    const rows: AccountJsonKvEncryptionMigrationRow[] = [];
    for (const row of candidateRows) {
        if (
            row.value !== null
            && classifyAccountJsonKvStoredContent({
                key: row.key,
                value: row.value,
            }).domain === namespace
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

function bytesEqual(
    left: Uint8Array,
    right: Uint8Array,
): boolean {
    return left.byteLength === right.byteLength
        && left.every((value, index) => value === right[index]);
}

function valueMatchesMode(
    key: string,
    value: string,
    mode: "plain" | "e2ee",
    taskResource = false,
): boolean {
    try {
        const decoded = privacyKit.decodeBase64(value);
        const classification = classifyAccountJsonKvStoredContent({
            key,
            value: decoded,
        });
        if (classification.domain === "generic") return false;
        if (taskResource && (classification.domain !== 'todo' || classification.keyKind !== 'item'
            || classification.representation !== (mode === 'e2ee' ? 'current_resource_encrypted' : 'current_plain'))) return false;
        assertAccountJsonKvStoredContentMatchesAccountMode({
            key,
            value: decoded,
            accountMode: mode,
            ...(taskResource ? { usage: 'task_resource' as const } : {}),
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Read-only exact Account JSON KV post-state matcher for Account-transition replay.
 */
export async function matchAccountJsonKvEncryptionMigrationPostStateInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        namespace: AccountJsonKvNamespace;
        toMode: "plain" | "e2ee";
        directive: AccountEncryptionMigrateTodosDirective | AccountEncryptionMigrateWorkspaceDirective;
    }>,
): Promise<AccountJsonKvEncryptionMigrationPostStateResult> {
    const rows =
        await readAccountJsonKvEncryptionMigrationRowsInTx(
            params.tx,
            params.accountId,
            params.namespace,
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
        const envelopes = 'recipientKeyEnvelopes' in item ? item.recipientKeyEnvelopes : undefined;
        if (row.task?.managed && !envelopes) return { status: 'mismatch' };
        if (envelopes && (!row.task || !await matchTaskAccountEncryptionMigrationKeysInTx(params.tx, row.task, envelopes))) return { status: 'mismatch' };
        let expectedValue: Uint8Array;
        try {
            expectedValue = privacyKit.decodeBase64(item.value);
        } catch {
            return { status: "mismatch" };
        }
        if (
            row.version !== item.expectedVersion + 1
            || !bytesEqual(row.value, expectedValue)
            || !valueMatchesMode(
                row.key,
                item.value,
                params.toMode,
                envelopes !== undefined,
            )
        ) {
            return { status: "mismatch" };
        }
    }
    const managedTasks = new Set(rows.flatMap(row => row.task?.hasDiscussion ? [row.task.id] : []));
    return { status: "matched", ...(managedTasks.size ? { managedTasks } : {}) };
}

export async function migrateAccountJsonKvEncryptionInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    namespace: AccountJsonKvNamespace;
    fromMode: "plain" | "e2ee";
    toMode: "plain" | "e2ee";
    directive: AccountEncryptionMigrateTodosDirective | AccountEncryptionMigrateWorkspaceDirective;
    mutate?: AccountJsonKvMigrationMutationOwner;
    ownerContentPublicKeyFingerprint?: string | null;
}>): Promise<AccountJsonKvEncryptionMigrationResult> {
    const rows =
        await readAccountJsonKvEncryptionMigrationRowsInTx(
            params.tx,
            params.accountId,
            params.namespace,
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
        const managed = row.task?.managed === true;
        const envelopes = 'recipientKeyEnvelopes' in item ? item.recipientKeyEnvelopes : undefined;
        if (!managed && envelopes !== undefined) return { status: 'invalid_content' };
        if (
            !valueMatchesMode(
                row.key,
                privacyKit.encodeBase64(new Uint8Array(row.value)),
                params.fromMode,
                managed,
            )
        ) {
            return { status: "invalid_content" };
        }
        if (!valueMatchesMode(item.key, item.value, params.toMode, managed)) {
            return { status: "invalid_content" };
        }
        if (managed && row.task && !await validateTaskAccountEncryptionMigrationKeysInTx(params.tx, {
            accountId: params.accountId, row: row.task, toMode: params.toMode,
            ownerContentPublicKeyFingerprint: params.ownerContentPublicKeyFingerprint, recipientKeyEnvelopes: envelopes,
        })) return { status: 'migration_incomplete' };
    }

    const managedRows = rows.filter(row => row.task?.managed);
    const managedKeys = new Set(managedRows.map(row => row.key));
    const mutations = params.directive.items.filter(item => !managedKeys.has(item.key)).map((item) => ({
        key: item.key,
        version: item.expectedVersion,
        value: item.value,
    }));
    const result = mutations.length === 0 ? { success: true } : await (
        params.mutate
        ?? (async (values: KVMutation[]) =>
            await kvMutateAccountJsonKvEncryptionTransitionInTx(
                params.tx,
                { uid: params.accountId },
                values,
                params.fromMode,
                params.toMode,
            ))
    )(mutations);
    if (!result.success) {
        throw new AccountJsonKvEncryptionMigrationConflictError();
    }
    if (managedRows.length > 0) {
        const application = await applyUserKvMutationsInTx(params.tx, { uid: params.accountId }, managedRows.map(row => {
            const item = itemsByKey.get(row.key)!;
            return { key: item.key, version: item.expectedVersion, value: item.value };
        }));
        if (!application.success) throw new AccountJsonKvEncryptionMigrationConflictError();
        for (const row of managedRows) {
            const item = itemsByKey.get(row.key)!;
            const envelopes = 'recipientKeyEnvelopes' in item ? item.recipientKeyEnvelopes : undefined;
            await applyTaskAccountEncryptionMigrationKeysInTx(params.tx, row.task!, envelopes!);
        }
    }
    const managedTasks = new Set(managedRows.flatMap(row => row.task?.hasDiscussion ? [row.task.id] : []));
    return { status: "applied", ...(managedTasks.size ? { managedTasks } : {}) };
}
