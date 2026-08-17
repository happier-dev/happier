import {
    assertPluginAccountSettingsContentForModeV1,
    PluginAccountSettingsContentV1Schema,
    PluginAccountSettingsMutationRequestV1Schema,
    type PluginAccountSettingsContentV1,
} from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";

import {
    deriveAccountEncryptionCurrentnessFromRow,
    type AccountEncryptionInconsistencyReason,
} from "@/app/encryption/accountContentKeyAdmission";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { inTx, type Tx } from "@/storage/inTx";

import {
    buildPluginDeclarativeSettingsPhysicalKey,
} from "./accountScopedKv";
import {
    applyUserKvMutationsInTx,
    type KVMutation,
    type UserKvMutationApplication,
} from "./kvMutate";

const PluginDeclarativeSettingsEnvelopeSchema = PluginAccountSettingsContentV1Schema;

export type PluginDeclarativeSettingsEnvelope = PluginAccountSettingsContentV1;

export type PluginDeclarativeSettingsReadResult =
    | Readonly<{ status: "present"; revision: number; envelope: PluginDeclarativeSettingsEnvelope }>
    | Readonly<{ status: "absent" }>
    | Readonly<{ status: "deleted"; revision: number }>
    | Readonly<{ status: "account-not-found" }>
    | Readonly<{ status: "account-inconsistent"; reason: AccountEncryptionInconsistencyReason }>
    | Readonly<{ status: "account-mode-mismatch" }>
    | Readonly<{ status: "invalid-stored-content" }>;

export type PluginDeclarativeSettingsMutation = Readonly<{
    accountId: string;
    pluginId: string;
    /** `absent` names a never-created row; a tombstone must use its revision. */
    expectedRevision: number | "absent";
    /** `null` creates a versioned tombstone without exposing prior content. */
    envelope: PluginDeclarativeSettingsEnvelope | null;
}>;

export type PluginDeclarativeSettingsMutationResult =
    | Readonly<{ status: "updated"; revision: number; cursor: number }>
    | Readonly<{ status: "conflict"; revision: number }>
    | Readonly<{ status: "account-not-found" }>
    | Readonly<{ status: "account-inconsistent"; reason: AccountEncryptionInconsistencyReason }>
    | Readonly<{ status: "account-mode-mismatch" }>
    | Readonly<{ status: "invalid-stored-content" }>;

type AccountScope =
    | Readonly<{ status: "ready"; mode: "plain" | "e2ee" }>
    | Readonly<{ status: "account-not-found" }>
    | Readonly<{ status: "account-inconsistent"; reason: AccountEncryptionInconsistencyReason }>;

type DecodedEnvelope =
    | Readonly<{ status: "present"; envelope: PluginDeclarativeSettingsEnvelope }>
    | Readonly<{ status: "invalid-stored-content" }>;

function encodeEnvelope(envelope: PluginDeclarativeSettingsEnvelope): string | null {
    try {
        const serialized = JSON.stringify(envelope);
        if (typeof serialized !== "string") return null;
        return privacyKit.encodeBase64(new TextEncoder().encode(serialized));
    } catch {
        return null;
    }
}

function decodeEnvelope(value: Uint8Array): DecodedEnvelope {
    try {
        const parsed = PluginDeclarativeSettingsEnvelopeSchema.safeParse(
            JSON.parse(new TextDecoder().decode(value)),
        );
        return parsed.success
            ? { status: "present", envelope: parsed.data }
            : { status: "invalid-stored-content" };
    } catch {
        return { status: "invalid-stored-content" };
    }
}

function envelopeMatchesMode(
    envelope: PluginDeclarativeSettingsEnvelope,
    mode: "plain" | "e2ee",
): boolean {
    try {
        assertPluginAccountSettingsContentForModeV1(envelope, mode);
        return true;
    } catch {
        return false;
    }
}

function normalizeExpectedRevision(
    expectedRevision: PluginDeclarativeSettingsMutation["expectedRevision"],
): number | null {
    if (expectedRevision === "absent") return -1;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        return null;
    }
    return expectedRevision;
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
    if (currentness.status === "inconsistent") {
        return {
            status: "account-inconsistent",
            reason: currentness.reason,
        };
    }
    return { status: "ready", mode: currentness.currentness.encryptionMode };
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
 * Reserved, server-internal Settings record port. It intentionally exposes a
 * mode-checked envelope and CAS revision only: field/default/secret semantics
 * remain with the Settings owner, and AccountChange never carries the envelope.
 */
export async function readPluginDeclarativeSettingsInTx(
    tx: Tx,
    input: Readonly<{ accountId: string; pluginId: string }>,
): Promise<PluginDeclarativeSettingsReadResult> {
    const scope = await resolveAccountScopeInTx(tx, input.accountId);
    if (scope.status !== "ready") return scope;

    const row = await readStoredEnvelopeInTx(
        tx,
        input.accountId,
        buildPluginDeclarativeSettingsPhysicalKey(input.pluginId),
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

export async function readPluginDeclarativeSettings(
    input: Readonly<{ accountId: string; pluginId: string }>,
): Promise<PluginDeclarativeSettingsReadResult> {
    return await inTx(async (tx) =>
        await readPluginDeclarativeSettingsInTx(tx, input));
}

export async function mutatePluginDeclarativeSettingsInTx(
    tx: Tx,
    input: PluginDeclarativeSettingsMutation,
): Promise<PluginDeclarativeSettingsMutationResult> {
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

    const parsedMutation = PluginAccountSettingsMutationRequestV1Schema.safeParse({
        expectedRevision: input.expectedRevision,
        content: input.envelope,
    });
    if (!parsedMutation.success) {
        return { status: "invalid-stored-content" };
    }
    const expectedRevision = normalizeExpectedRevision(parsedMutation.data.expectedRevision);
    if (expectedRevision === null) {
        throw new Error("Plugin declarative Settings expectedRevision must be a non-negative integer or absent");
    }
    const envelope = parsedMutation.data.content;
    if (envelope !== null && !envelopeMatchesMode(envelope, scope.mode)) {
        return { status: "account-mode-mismatch" };
    }

    const physicalKey = buildPluginDeclarativeSettingsPhysicalKey(input.pluginId);
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
                if (existing?.value === null || existing === null) return;
                const decoded = decodeEnvelope(existing.value);
                if (decoded.status !== "present") {
                    throw new PluginDeclarativeSettingsStorageError("invalid-stored-content");
                }
                if (!envelopeMatchesMode(decoded.envelope, scope.mode)) {
                    throw new PluginDeclarativeSettingsStorageError("account-mode-mismatch");
                }
            },
        );
    } catch (error) {
        if (error instanceof PluginDeclarativeSettingsStorageError) {
            return { status: error.status };
        }
        throw error;
    }
    if (!application.success) {
        const conflict = application.errors[0];
        if (!conflict) throw new Error("Plugin declarative Settings conflict missing current revision");
        return { status: "conflict", revision: conflict.version };
    }

    const result = application.results[0];
    if (!result) throw new Error("Plugin declarative Settings mutation did not return a revision");
    const hint = {
        pluginDomain: "settings" as const,
        pluginId: input.pluginId,
        scope: "account" as const,
        revision: result.version,
    };
    const cursor = await markAccountChanged(tx, {
        accountId: input.accountId,
        kind: "pluginDomain",
        entityId: `pluginDomain/${input.pluginId}/settings`,
        hint,
    });
    return { status: "updated", revision: result.version, cursor };
}

export async function mutatePluginDeclarativeSettings(
    input: PluginDeclarativeSettingsMutation,
): Promise<PluginDeclarativeSettingsMutationResult> {
    return await inTx(async (tx) =>
        await mutatePluginDeclarativeSettingsInTx(tx, input));
}

class PluginDeclarativeSettingsStorageError extends Error {
    constructor(readonly status: "account-mode-mismatch" | "invalid-stored-content") {
        super(status);
        this.name = "PluginDeclarativeSettingsStorageError";
    }
}
