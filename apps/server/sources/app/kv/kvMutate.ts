import { inTx, afterTx, type Tx } from "@/storage/inTx";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { eventRouter, buildKVBatchUpdateUpdate } from "@/app/events/eventRouter";
import * as privacyKit from "privacy-kit";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import {
    assertTodoKvAccountEncryptionTransitionStoredContent,
    assertTodoKvMutationStoredContent,
    isTodoKvKey,
    TodoKvStoredContentModeMismatchError,
} from "./todoKvStoredContent";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { assertPublicGenericKvKey } from "./accountScopedKv";

export interface KVMutation {
    key: string;
    value: string | null; // null = delete (sets value to null but keeps record)
    version: number; // Always required, use -1 for new keys
}

export interface KVMutateResult {
    success: boolean;
    results?: Array<{
        key: string;
        version: number;
    }>;
    errors?: Array<{
        key: string;
        error: 'version-mismatch';
        version: number;
        value: string | null;  // Current value (null if deleted)
    }>;
}

export type UserKvMutationApplication = Readonly<{
    success: true;
    results: Array<{ key: string; version: number }>;
    changes: Array<{ key: string; value: string | null; version: number }>;
}> | Readonly<{
    success: false;
    errors: NonNullable<KVMutateResult["errors"]>;
}>;

type UserKvStoreRow = Awaited<ReturnType<Tx["userKVStore"]["findUnique"]>>;

/**
 * The single UserKVStore CAS primitive. Domain owners may supply validation
 * and publish their own content-free AccountChange after this succeeds, but
 * no owner gets a second row/version/tombstone implementation.
 */
export async function applyUserKvMutationsInTx(
    tx: Tx,
    ctx: { uid: string },
    mutations: readonly KVMutation[],
    validate?: (
        mutation: KVMutation,
        existing: UserKvStoreRow,
    ) => Promise<void> | void,
): Promise<UserKvMutationApplication> {
    const errors: NonNullable<KVMutateResult["errors"]> = [];
    const existingByKey = new Map<string, UserKvStoreRow>();

    for (const mutation of mutations) {
        const existing = await tx.userKVStore.findUnique({
            where: {
                accountId_key: {
                    accountId: ctx.uid,
                    key: mutation.key,
                },
            },
        });
        existingByKey.set(mutation.key, existing);
    }

    for (const mutation of mutations) {
        const existing = existingByKey.get(mutation.key) ?? null;
        await validate?.(mutation, existing);

        const currentVersion = existing?.version ?? -1;
        if (currentVersion !== mutation.version) {
            errors.push({
                key: mutation.key,
                error: "version-mismatch",
                version: currentVersion,
                value: existing?.value
                    ? privacyKit.encodeBase64(existing.value)
                    : null,
            });
        }
    }

    if (errors.length > 0) {
        return { success: false, errors };
    }

    const results: Array<{ key: string; version: number }> = [];
    const changes: Array<{ key: string; value: string | null; version: number }> = [];
    for (const mutation of mutations) {
        if (mutation.version === -1) {
            const result = await tx.userKVStore.create({
                data: {
                    accountId: ctx.uid,
                    key: mutation.key,
                    value: mutation.value
                        ? privacyKit.decodeBase64(mutation.value)
                        : null,
                    version: 0,
                },
            });
            results.push({ key: mutation.key, version: result.version });
            changes.push({
                key: mutation.key,
                value: mutation.value,
                version: result.version,
            });
        } else {
            const result = await tx.userKVStore.update({
                where: {
                    accountId_key: {
                        accountId: ctx.uid,
                        key: mutation.key,
                    },
                },
                data: {
                    value: mutation.value
                        ? privacyKit.decodeBase64(mutation.value)
                        : null,
                    version: mutation.version + 1,
                },
            });
            results.push({ key: mutation.key, version: result.version });
            changes.push({
                key: mutation.key,
                value: mutation.value,
                version: result.version,
            });
        }
    }

    return { success: true, results, changes };
}

export interface KVMutationStoredContentAdmission {
    readonly supportsCurrentProtocol: boolean;
}

const LEGACY_STORED_CONTENT_ADMISSION: KVMutationStoredContentAdmission = {
    supportsCurrentProtocol: false,
};

type KVMutationStoredContentPolicy =
    | Readonly<{
        kind: "regular";
        admission: KVMutationStoredContentAdmission;
    }>
    | Readonly<{
        kind: "todo-account-mode-transition";
        fromMode: "plain" | "e2ee";
        toMode: "plain" | "e2ee";
    }>;

/**
 * Atomically mutate multiple key-value pairs.
 * All mutations succeed or all fail.
 * Version is always required for all operations (use -1 for new keys).
 * Delete operations set value to null but keep the record with incremented version.
 * Sends a single bundled update notification for all changes.
 */
export async function kvMutate(
    ctx: { uid: string },
    mutations: KVMutation[],
    storedContentAdmission: KVMutationStoredContentAdmission =
        LEGACY_STORED_CONTENT_ADMISSION,
): Promise<KVMutateResult> {
    return await inTx(
        async (tx) => await kvMutateInTx(
            tx,
            ctx,
            mutations,
            storedContentAdmission,
        ),
    );
}

export async function kvMutateInTx(
    tx: Tx,
    ctx: { uid: string },
    mutations: KVMutation[],
    storedContentAdmission: KVMutationStoredContentAdmission =
        LEGACY_STORED_CONTENT_ADMISSION,
): Promise<KVMutateResult> {
    return await kvMutateWithStoredContentPolicyInTx(
        tx,
        ctx,
        mutations,
        {
            kind: "regular",
            admission: storedContentAdmission,
        },
    );
}

/**
 * Narrow Account-transition entry point. It permits only existing, exact Todo
 * rows to move to the declared target mode; row CAS, writes, AccountChange, and
 * socket publication remain owned by the same KV mutation implementation.
 */
export async function kvMutateTodoAccountEncryptionTransitionInTx(
    tx: Tx,
    ctx: { uid: string },
    mutations: KVMutation[],
    fromMode: "plain" | "e2ee",
    toMode: "plain" | "e2ee",
): Promise<KVMutateResult> {
    return await kvMutateWithStoredContentPolicyInTx(
        tx,
        ctx,
        mutations,
        {
            kind: "todo-account-mode-transition",
            fromMode,
            toMode,
        },
    );
}

async function kvMutateWithStoredContentPolicyInTx(
    tx: Tx,
    ctx: { uid: string },
    mutations: KVMutation[],
    storedContentPolicy: KVMutationStoredContentPolicy,
): Promise<KVMutateResult> {
        if (storedContentPolicy.kind === "regular") {
            for (const mutation of mutations) {
                assertPublicGenericKvKey(mutation.key);
            }
        }

        const needsAccountCurrentness =
            storedContentPolicy.kind === "regular"
            && mutations.some((mutation) => isTodoKvKey(mutation.key));
        const fence = needsAccountCurrentness
            ? await acquireAccountEncryptionTransitionFenceInTx(tx, ctx.uid)
            : null;
        if (fence !== null && fence.status !== "ready") {
            throw new TodoKvStoredContentModeMismatchError();
        }
        const accountMode = fence?.status === "ready"
            ? fence.account.currentness.encryptionMode
            : null;

        const application = await applyUserKvMutationsInTx(
            tx,
            ctx,
            mutations,
            async (mutation, existing) => {
            if (
                storedContentPolicy.kind === "todo-account-mode-transition"
            ) {
                if (
                    !isTodoKvKey(mutation.key)
                    || existing?.value == null
                    || mutation.value === null
                    || mutation.version < 0
                ) {
                    throw new TodoKvStoredContentModeMismatchError();
                }
                assertTodoKvAccountEncryptionTransitionStoredContent({
                    key: mutation.key,
                    persistedValue: existing.value,
                    nextValue: privacyKit.decodeBase64(mutation.value),
                    fromMode: storedContentPolicy.fromMode,
                    toMode: storedContentPolicy.toMode,
                });
            } else if (isTodoKvKey(mutation.key)) {
                assertTodoKvMutationStoredContent({
                    key: mutation.key,
                    persistedValue: existing?.value ?? null,
                    nextValue: mutation.value === null
                        ? null
                        : privacyKit.decodeBase64(mutation.value),
                    accountMode,
                    ...storedContentPolicy.admission,
                });
            }
            },
        );

        if (!application.success) {
            return { success: false, errors: application.errors };
        }

        const uniqueKeys = Array.from(new Set(mutations.map((m) => m.key)));
        const hint = uniqueKeys.length <= 50 ? { keys: uniqueKeys } : { full: true };
        const cursor = await markAccountChanged(tx, { accountId: ctx.uid, kind: 'kv', entityId: 'self', hint });

        // Send single bundled notification for all changes
        afterTx(tx, async () => {
            eventRouter.emitUpdate({
                userId: ctx.uid,
                payload: buildKVBatchUpdateUpdate(application.changes, cursor, randomKeyNaked(12)),
                recipientFilter: { type: 'user-scoped-only' }
            });
        });

        return { success: true, results: application.results };
}
