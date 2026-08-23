import {
    deriveAccountEncryptionCurrentnessFromRow,
    type AccountEncryptionInconsistencyReason,
} from "@/app/encryption/accountContentKeyAdmission";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import type { Tx } from "@/storage/inTx";

import {
    decodeAccountScopedKvJson,
    encodeAccountScopedKvJson,
} from "./accountScopedKv";
import {
    applyUserKvMutationsInTx,
    type KVMutation,
    type UserKvMutationApplication,
} from "./kvMutate";

/**
 * Every reserved Account-scoped KV row answers the same Account questions
 * before its own domain rules apply: does the Account exist, is its encryption
 * state currently consistent, does the stored envelope match the Account mode,
 * and does the caller hold the revision it claims. This module owns exactly
 * those, so a reserved domain contributes only its envelope grammar, its
 * mode rule, and its AccountChange hint instead of restating the Account-row
 * protocol.
 */
export type ReservedAccountScopedKvRowFailure =
    | Readonly<{ status: "account-not-found" }>
    | Readonly<{
        status: "account-inconsistent";
        reason: AccountEncryptionInconsistencyReason;
    }>
    | Readonly<{ status: "account-mode-mismatch" }>
    | Readonly<{ status: "invalid-stored-content" }>;

export type ReservedAccountScopedKvRowReadResult<TEnvelope> =
    | Readonly<{ status: "present"; revision: number; envelope: TEnvelope }>
    | Readonly<{ status: "absent" }>
    | Readonly<{ status: "deleted"; revision: number }>
    | ReservedAccountScopedKvRowFailure;

export type ReservedAccountScopedKvRowMutationResult =
    | Readonly<{ status: "updated"; revision: number; cursor: number }>
    | Readonly<{ status: "conflict"; revision: number }>
    | ReservedAccountScopedKvRowFailure;

/**
 * A reserved domain's own semantics. Both parsers return `null` for a value
 * the domain does not recognize; `assertEnvelopeForMode` throws for a value
 * whose representation does not belong to the Account's current mode.
 *
 * Stored and candidate grammars are separate because a domain may keep reading
 * an envelope it would no longer accept as a new write — an oversized
 * predecessor record stays recoverable while current writers hold the narrower
 * bound.
 */
export type ReservedAccountScopedKvRowDomain<TEnvelope> = Readonly<{
    /** Names the domain in programming-error messages only. */
    label: string;
    parseStoredEnvelope(value: unknown): TEnvelope | null;
    parseCandidateEnvelope(value: unknown): TEnvelope | null;
    assertEnvelopeForMode(envelope: TEnvelope, mode: "plain" | "e2ee"): void;
}>;

type AccountScope =
    | Readonly<{ status: "ready"; mode: "plain" | "e2ee" }>
    | Readonly<{ status: "account-not-found" }>
    | Readonly<{
        status: "account-inconsistent";
        reason: AccountEncryptionInconsistencyReason;
    }>;

class ReservedAccountScopedKvRowError extends Error {
    constructor(readonly status: "account-mode-mismatch" | "invalid-stored-content") {
        super(status);
        this.name = "ReservedAccountScopedKvRowError";
    }
}

function decodeStoredEnvelope<TEnvelope>(
    value: Uint8Array,
    domain: ReservedAccountScopedKvRowDomain<TEnvelope>,
): TEnvelope | null {
    let decoded: unknown;
    try {
        decoded = decodeAccountScopedKvJson(value);
    } catch {
        // Malformed UTF-8 or JSON is stored content this owner cannot read.
        // A throw from the domain grammar itself is a defect, not a verdict,
        // and stays outside this catch so it is not reported as bad content.
        return null;
    }
    return domain.parseStoredEnvelope(decoded);
}

function envelopeMatchesMode<TEnvelope>(
    envelope: TEnvelope,
    mode: "plain" | "e2ee",
    domain: ReservedAccountScopedKvRowDomain<TEnvelope>,
): boolean {
    try {
        domain.assertEnvelopeForMode(envelope, mode);
        return true;
    } catch {
        return false;
    }
}

function normalizeExpectedRevision(
    expectedRevision: number | "absent",
    label: string,
): number {
    if (expectedRevision === "absent") return -1;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error(`${label} expectedRevision must be a non-negative integer or absent`);
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
    return currentness.status === "ready"
        ? { status: "ready", mode: currentness.currentness.encryptionMode }
        : { status: "account-inconsistent", reason: currentness.reason };
}

export async function readReservedAccountScopedKvRowInTx<TEnvelope>(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        physicalKey: string;
        domain: ReservedAccountScopedKvRowDomain<TEnvelope>;
    }>,
): Promise<ReservedAccountScopedKvRowReadResult<TEnvelope>> {
    const scope = await resolveAccountScopeInTx(tx, input.accountId);
    if (scope.status !== "ready") return scope;

    const row = await tx.userKVStore.findUnique({
        where: {
            accountId_key: { accountId: input.accountId, key: input.physicalKey },
        },
        select: { version: true, value: true },
    });
    if (row === null) return { status: "absent" };
    if (row.value === null) return { status: "deleted", revision: row.version };

    const envelope = decodeStoredEnvelope(row.value, input.domain);
    if (envelope === null) return { status: "invalid-stored-content" };
    if (!envelopeMatchesMode(envelope, scope.mode, input.domain)) {
        return { status: "account-mode-mismatch" };
    }
    return { status: "present", revision: row.version, envelope };
}

/**
 * `null` content writes a versioned tombstone without disclosing prior
 * content. The Account encryption transition fence is acquired first so a
 * mutation and a mode flip cannot interleave, and the row already stored is
 * re-validated against the fenced mode inside the same compare-and-set.
 */
export async function mutateReservedAccountScopedKvRowInTx<TEnvelope>(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        physicalKey: string;
        expectedRevision: number | "absent";
        envelope: TEnvelope | null;
        domain: ReservedAccountScopedKvRowDomain<TEnvelope>;
        markChanged: (params: Readonly<{ tx: Tx; revision: number }>) => Promise<number>;
    }>,
): Promise<ReservedAccountScopedKvRowMutationResult> {
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
    if (fence.status === "account_not_found") return { status: "account-not-found" };
    if (fence.status === "account_inconsistent") {
        return { status: "account-inconsistent", reason: fence.reason };
    }
    const mode = fence.account.currentness.encryptionMode;

    const expectedRevision = normalizeExpectedRevision(
        input.expectedRevision,
        input.domain.label,
    );
    const envelope = input.envelope === null
        ? null
        : input.domain.parseCandidateEnvelope(input.envelope);
    if (input.envelope !== null && envelope === null) {
        return { status: "invalid-stored-content" };
    }
    if (envelope !== null && !envelopeMatchesMode(envelope, mode, input.domain)) {
        return { status: "account-mode-mismatch" };
    }

    const mutation: KVMutation = {
        key: input.physicalKey,
        value: envelope === null ? null : encodeAccountScopedKvJson(envelope),
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
                const stored = decodeStoredEnvelope(existing.value, input.domain);
                if (stored === null) {
                    throw new ReservedAccountScopedKvRowError("invalid-stored-content");
                }
                if (!envelopeMatchesMode(stored, mode, input.domain)) {
                    throw new ReservedAccountScopedKvRowError("account-mode-mismatch");
                }
            },
        );
    } catch (error) {
        if (error instanceof ReservedAccountScopedKvRowError) {
            return { status: error.status };
        }
        throw error;
    }
    if (!application.success) {
        const conflict = application.errors[0];
        if (!conflict) {
            throw new Error(`${input.domain.label} conflict missing current revision`);
        }
        return { status: "conflict", revision: conflict.version };
    }

    const result = application.results[0];
    if (!result) {
        throw new Error(`${input.domain.label} mutation did not return a revision`);
    }
    const cursor = await input.markChanged({ tx, revision: result.version });
    return { status: "updated", revision: result.version, cursor };
}
