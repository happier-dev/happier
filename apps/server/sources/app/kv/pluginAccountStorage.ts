import {
    assertPluginAccountStorageEnvelopeForModeV1,
    PluginAccountStorageEnvelopeV1Schema,
    type PluginAccountStorageEnvelopeV1,
} from "@happier-dev/protocol";
import {
    buildPluginDomainAccountChangeEntityId,
} from "@happier-dev/protocol/changes";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import {
    deriveAccountEncryptionCurrentnessFromRow,
    type AccountEncryptionInconsistencyReason,
} from "@/app/encryption/accountContentKeyAdmission";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { inTx, type Tx } from "@/storage/inTx";

import {
    buildPluginAccountStoragePhysicalKey,
    decodeAccountScopedKvJson,
    encodeAccountScopedKvJson,
} from "./accountScopedKv";
import {
    applyUserKvMutationsInTx,
    type KVMutation,
    type UserKvMutationApplication,
} from "./kvMutate";

export type PluginAccountStorageReadResult =
    | Readonly<{
        status: "present";
        revision: number;
        envelope: PluginAccountStorageEnvelopeV1;
    }>
    | Readonly<{ status: "absent" }>
    | Readonly<{ status: "deleted"; revision: number }>
    | Readonly<{ status: "account-not-found" }>
    | Readonly<{
        status: "account-inconsistent";
        reason: AccountEncryptionInconsistencyReason;
    }>
    | Readonly<{ status: "account-mode-mismatch" }>
    | Readonly<{ status: "invalid-stored-content" }>;

export type PluginAccountStorageMutation = Readonly<{
    accountId: string;
    pluginId: string;
    /** `absent` names a never-created row; a tombstone needs its revision. */
    expectedRevision: number | "absent";
    /** `null` creates a versioned tombstone without returning old content. */
    envelope: PluginAccountStorageEnvelopeV1 | null;
}>;

export type PluginAccountStorageMutationResult =
    | Readonly<{ status: "updated"; revision: number; cursor: number }>
    | Readonly<{ status: "conflict"; revision: number }>
    | Readonly<{ status: "account-not-found" }>
    | Readonly<{
        status: "account-inconsistent";
        reason: AccountEncryptionInconsistencyReason;
    }>
    | Readonly<{ status: "account-mode-mismatch" }>
    | Readonly<{ status: "invalid-stored-content" }>;

type AccountScope =
    | Readonly<{ status: "ready"; mode: "plain" | "e2ee" }>
    | Readonly<{ status: "account-not-found" }>
    | Readonly<{
        status: "account-inconsistent";
        reason: AccountEncryptionInconsistencyReason;
    }>;

type DecodedEnvelope =
    | Readonly<{ status: "present"; envelope: PluginAccountStorageEnvelopeV1 }>
    | Readonly<{ status: "invalid-stored-content" }>;

function encodeEnvelope(envelope: PluginAccountStorageEnvelopeV1): string | null {
    return encodeAccountScopedKvJson(envelope);
}

function decodeEnvelope(value: Uint8Array): DecodedEnvelope {
    try {
        const parsed = PluginAccountStorageEnvelopeV1Schema.safeParse(
            decodeAccountScopedKvJson(value),
        );
        return parsed.success
            ? { status: "present", envelope: parsed.data }
            : { status: "invalid-stored-content" };
    } catch {
        return { status: "invalid-stored-content" };
    }
}

function envelopeMatchesMode(
    envelope: PluginAccountStorageEnvelopeV1,
    mode: "plain" | "e2ee",
): boolean {
    try {
        assertPluginAccountStorageEnvelopeForModeV1(envelope, mode);
        return true;
    } catch {
        return false;
    }
}

function normalizeExpectedRevision(
    expectedRevision: PluginAccountStorageMutation["expectedRevision"],
): number | null {
    if (expectedRevision === "absent") return -1;
    return Number.isSafeInteger(expectedRevision) && expectedRevision >= 0
        ? expectedRevision
        : null;
}

async function resolveAccountScopeInTx(
    tx: Tx,
    accountId: string,
): Promise<AccountScope> {
    const account = await tx.account.findUnique({
        where: { id: accountId },
        select: {
            encryptionMode: true,
            publicKey: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    if (!account) return { status: "account-not-found" };

    const currentness = deriveAccountEncryptionCurrentnessFromRow(account);
    return currentness.status === "ready"
        ? { status: "ready", mode: currentness.currentness.encryptionMode }
        : {
            status: "account-inconsistent",
            reason: currentness.reason,
        };
}

async function readStoredEnvelopeInTx(
    tx: Tx,
    accountId: string,
    physicalKey: string,
): Promise<Readonly<{ revision: number; value: Uint8Array | null }> | null> {
    const row = await tx.userKVStore.findUnique({
        where: {
            accountId_key: {
                accountId,
                key: physicalKey,
            },
        },
        select: { version: true, value: true },
    });
    return row === null
        ? null
        : { revision: row.version, value: row.value };
}

/**
 * The one server owner for a plugin's Account-KV row. It intentionally moves
 * whole opaque envelopes only; logical-key transactions stay in the bound host
 * adapter, so E2EE never introduces server-visible logical data or a second
 * per-key persistence owner.
 */
export async function readPluginAccountStorageInTx(
    tx: Tx,
    input: Readonly<{ accountId: string; pluginId: string }>,
): Promise<PluginAccountStorageReadResult> {
    const scope = await resolveAccountScopeInTx(tx, input.accountId);
    if (scope.status !== "ready") return scope;

    const row = await readStoredEnvelopeInTx(
        tx,
        input.accountId,
        buildPluginAccountStoragePhysicalKey(input.pluginId),
    );
    if (row === null) return { status: "absent" };
    if (row.value === null) return { status: "deleted", revision: row.revision };

    const decoded = decodeEnvelope(row.value);
    if (decoded.status !== "present") return decoded;
    if (!envelopeMatchesMode(decoded.envelope, scope.mode)) {
        return { status: "account-mode-mismatch" };
    }
    return {
        status: "present",
        revision: row.revision,
        envelope: decoded.envelope,
    };
}

export async function readPluginAccountStorage(
    input: Readonly<{ accountId: string; pluginId: string }>,
): Promise<PluginAccountStorageReadResult> {
    return await inTx(async (tx) => await readPluginAccountStorageInTx(tx, input));
}

export async function mutatePluginAccountStorageInTx(
    tx: Tx,
    input: PluginAccountStorageMutation,
): Promise<PluginAccountStorageMutationResult> {
    const fence = await acquireAccountEncryptionTransitionFenceInTx(
        tx,
        input.accountId,
    );
    if (fence.status === "account_not_found") {
        return { status: "account-not-found" };
    }
    if (fence.status === "account_inconsistent") {
        return {
            status: "account-inconsistent",
            reason: fence.reason,
        };
    }
    const scope: Extract<AccountScope, { status: "ready" }> = {
        status: "ready",
        mode: fence.account.currentness.encryptionMode,
    };

    const expectedRevision = normalizeExpectedRevision(input.expectedRevision);
    if (expectedRevision === null) {
        throw new Error("Plugin Account KV expectedRevision must be a non-negative integer or absent");
    }
    const parsedEnvelope = input.envelope === null
        ? null
        : PluginAccountStorageEnvelopeV1Schema.safeParse(input.envelope);
    if (parsedEnvelope !== null && !parsedEnvelope.success) {
        return { status: "invalid-stored-content" };
    }
    const envelope = parsedEnvelope === null ? null : parsedEnvelope.data;
    if (envelope !== null && !envelopeMatchesMode(envelope, scope.mode)) {
        return { status: "account-mode-mismatch" };
    }

    const physicalKey = buildPluginAccountStoragePhysicalKey(input.pluginId);
    const mutation: KVMutation = {
        key: physicalKey,
        value: envelope === null ? null : encodeEnvelope(envelope),
        version: expectedRevision,
    };
    if (envelope !== null && mutation.value === null) {
        return { status: "invalid-stored-content" };
    }

    let application: UserKvMutationApplication;
    try {
        application = await applyUserKvMutationsInTx(
            tx,
            { uid: input.accountId },
            [mutation],
            (_mutation, existing) => {
                if (existing === null || existing.value === null) return;
                const decoded = decodeEnvelope(existing.value);
                if (decoded.status !== "present") {
                    throw new PluginAccountStorageError("invalid-stored-content");
                }
                if (!envelopeMatchesMode(decoded.envelope, scope.mode)) {
                    throw new PluginAccountStorageError("account-mode-mismatch");
                }
            },
        );
    } catch (error) {
        if (error instanceof PluginAccountStorageError) {
            return { status: error.status };
        }
        throw error;
    }
    if (!application.success) {
        const conflict = application.errors[0];
        if (!conflict) throw new Error("Plugin Account KV conflict missing current revision");
        return { status: "conflict", revision: conflict.version };
    }

    const result = application.results[0];
    if (!result) throw new Error("Plugin Account KV mutation did not return a revision");
    const hint = {
        pluginDomain: "dataKv" as const,
        pluginId: input.pluginId,
        full: true as const,
    };
    const cursor = await markAccountChanged(tx, {
        accountId: input.accountId,
        kind: "pluginDomain",
        entityId: buildPluginDomainAccountChangeEntityId(hint),
        hint,
    });
    return { status: "updated", revision: result.version, cursor };
}

export async function mutatePluginAccountStorage(
    input: PluginAccountStorageMutation,
): Promise<PluginAccountStorageMutationResult> {
    return await inTx(async (tx) => await mutatePluginAccountStorageInTx(tx, input));
}

class PluginAccountStorageError extends Error {
    constructor(readonly status: "account-mode-mismatch" | "invalid-stored-content") {
        super(status);
        this.name = "PluginAccountStorageError";
    }
}
