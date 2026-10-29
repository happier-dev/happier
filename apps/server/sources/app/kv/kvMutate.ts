import { inTx, afterTx, type Tx } from "@/storage/inTx";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { eventRouter, buildKVBatchUpdateUpdate } from "@/app/events/eventRouter";
import * as privacyKit from "privacy-kit";
import { z } from 'zod/mini';
import { acquireAccountChangePublicationLocksInTx, markAccountChanged } from "@/app/changes/markAccountChanged";
import {
    assertAccountJsonKvAccountEncryptionTransitionStoredContent,
    assertAccountJsonKvMutationStoredContent,
    isAccountJsonKvKey,
    AccountJsonKvStoredContentModeMismatchError,
} from "./accountJsonKvStoredContent";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { assertPublicGenericKvKey } from "./accountScopedKv";
import { getDbProviderFromEnv, isPrismaErrorCode } from "@/storage/prisma";
import { db } from "@/storage/db";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import { assertUserKvKeyStorageAdmission } from "./userKvKeyStorage";

export interface KVMutation {
    key: string;
    value: string | null; // null = delete (sets value to null but keeps record)
    version: number; // Always required, use -1 for new keys
}

/** Shared by HTTP validation and delegated native-effect admission. */
export const KvMutationRequestSchema = z.object({
    mutations: z.array(z.object({
        key: z.string(),
        value: z.nullable(z.string()),
        version: z.number(),
    })).check(z.minLength(1), z.maxLength(100)),
});

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

/** A late CAS refusal must escape inTx so an earlier batch write rolls back. */
export class UserKvMutationConflictError extends Error {
    constructor(readonly accountId: string, readonly key: string) {
        super("UserKVStore mutation lost its expected revision");
        this.name = "UserKvMutationConflictError";
    }
}

/** Resolve only after the failed transaction has rolled back, including P2002. */
export async function readUserKvMutationConflict(error: unknown): Promise<NonNullable<KVMutateResult["errors"]>[number] | null> {
    if (!(error instanceof UserKvMutationConflictError)) return null;
    const current = await db.userKVStore.findUnique({ where: { accountId_key: {
        accountId: error.accountId, key: error.key,
    } }, select: { version: true, value: true } });
    return { key: error.key, error: "version-mismatch", version: current?.version ?? -1,
        value: current?.value ? privacyKit.encodeBase64(current.value) : null };
}

/** Domain operations that read before writing an existing KV row share its DB lock. */
export async function acquireUserKvRowLockInTx(tx: Tx, input: Readonly<{ accountId: string; key: string }>): Promise<boolean> {
    const provider = getDbProviderFromEnv(process.env, "postgres");
    if (provider === "sqlite") {
        return await tx.userKVStore.findUnique({ where: { accountId_key: input }, select: { id: true } }) !== null;
    }
    const rows = provider === "postgres"
        ? await tx.$queryRawUnsafe<Array<{ id: string }>>('SELECT "id" FROM "UserKVStore" WHERE "accountId" = $1 AND "key" = $2 FOR NO KEY UPDATE', input.accountId, input.key)
        : await tx.$queryRawUnsafe<Array<{ id: string }>>('SELECT `id` FROM `UserKVStore` WHERE `accountId` = ? AND `key` = ? FOR UPDATE', input.accountId, input.key);
    return rows.length > 0;
}

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
    const provider = getDbProviderFromEnv(process.env, "postgres");
    for (const mutation of mutations) {
        assertUserKvKeyStorageAdmission(mutation.key, provider);
    }
    const errors: NonNullable<KVMutateResult["errors"]> = [];
    const existingByKey = new Map<string, UserKvStoreRow>();

    // Admit the requested rows together; CAS below still arbitrates every write.
    // Internal migration/lifecycle callers can exceed the HTTP batch size.
    for (const keys of portableQueryChunks({
        values: [...new Set(mutations.map(mutation => mutation.key))],
        bindingsPerValue: 1,
        fixedBindings: 2, // Account id and Prisma's offset bind.
    })) {
        const rows = await tx.userKVStore.findMany({
            where: { accountId: ctx.uid, key: { in: [...keys] } },
        });
        for (const row of rows) existingByKey.set(row.key, row);
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
    // Acquire write locks in one stable key order, preserving request order in
    // the result below. Independent Accounts/keys remain independent writers.
    const writeOrder = mutations.map((mutation, index) => ({ mutation, index }))
        .sort(({ mutation: left }, { mutation: right }) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    const appliedVersionsByKey = new Map<string, number>();
    for (const { mutation, index } of writeOrder) {
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
            }).catch((error: unknown) => {
                // Repeating an absent key within one batch retains its existing
                // unique-constraint failure; only a genuine peer is a conflict.
                if (isPrismaErrorCode(error, "P2002") && !appliedVersionsByKey.has(mutation.key)) {
                    throw new UserKvMutationConflictError(ctx.uid, mutation.key);
                }
                throw error;
            });
            appliedVersionsByKey.set(mutation.key, result.version);
            results[index] = { key: mutation.key, version: result.version };
            changes[index] = {
                key: mutation.key,
                value: mutation.value,
                version: result.version,
            };
        } else {
            const result = await tx.userKVStore.updateMany({
                where: {
                    accountId: ctx.uid,
                    key: mutation.key,
                    version: appliedVersionsByKey.get(mutation.key) ?? mutation.version,
                },
                data: {
                    value: mutation.value
                        ? privacyKit.decodeBase64(mutation.value)
                        : null,
                    version: mutation.version + 1,
                },
            });
            if (result.count !== 1) throw new UserKvMutationConflictError(ctx.uid, mutation.key);
            appliedVersionsByKey.set(mutation.key, mutation.version + 1);
            results[index] = { key: mutation.key, version: mutation.version + 1 };
            changes[index] = {
                key: mutation.key,
                value: mutation.value,
                version: mutation.version + 1,
            };
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
        kind: "account-json-kv-mode-transition";
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
    try { return await inTx(
        async (tx) => {
            // Account admission stabilizes mode; row CAS owns key revisions.
            await acquireAccountChangePublicationLocksInTx(tx, [ctx.uid], { includeSingleAccount: true });
            return await kvMutateInTx(
                tx,
                ctx,
                mutations,
                storedContentAdmission,
            );
        },
    ); } catch (error) {
        const conflict = await readUserKvMutationConflict(error);
        if (conflict) return { success: false, errors: [conflict] };
        throw error;
    }
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
 * Narrow Account-transition entry point. It permits only existing, exact Account JSON KV
 * rows to move to the declared target mode; row CAS, writes, AccountChange, and
 * socket publication remain owned by the same KV mutation implementation.
 */
export async function kvMutateAccountJsonKvEncryptionTransitionInTx(
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
            kind: "account-json-kv-mode-transition",
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
            && mutations.some((mutation) => isAccountJsonKvKey(mutation.key));
        const fence = needsAccountCurrentness
            ? await acquireAccountEncryptionTransitionFenceInTx(tx, ctx.uid, "content")
            : null;
        if (fence !== null && fence.status !== "ready") {
            throw new AccountJsonKvStoredContentModeMismatchError();
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
                storedContentPolicy.kind === "account-json-kv-mode-transition"
            ) {
                if (
                    !isAccountJsonKvKey(mutation.key)
                    || existing?.value == null
                    || mutation.value === null
                    || mutation.version < 0
                ) {
                    throw new AccountJsonKvStoredContentModeMismatchError();
                }
                assertAccountJsonKvAccountEncryptionTransitionStoredContent({
                    key: mutation.key,
                    persistedValue: existing.value,
                    nextValue: privacyKit.decodeBase64(mutation.value),
                    fromMode: storedContentPolicy.fromMode,
                    toMode: storedContentPolicy.toMode,
                });
            } else if (isAccountJsonKvKey(mutation.key)) {
                assertAccountJsonKvMutationStoredContent({
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
                payload: buildKVBatchUpdateUpdate(application.changes, cursor.resolveCursor(), randomKeyNaked(12)),
                recipientFilter: { type: 'user-scoped-only' }
            });
        });

        return { success: true, results: application.results };
}
