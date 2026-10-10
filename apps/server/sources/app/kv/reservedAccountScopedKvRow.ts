import {
    deriveAccountEncryptionCurrentnessFromRow,
    type AccountEncryptionInconsistencyReason,
} from "@/app/encryption/accountContentKeyAdmission";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import type { Tx } from "@/storage/inTx";
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';

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

export type ReservedAccountScopedKvRowsMutationResult =
    | Readonly<{ status: "updated"; rows: readonly Readonly<{ physicalKey: string; revision: number; cursor: number }>[] }>
    | Readonly<{ status: "conflict"; physicalKey: string; revision: number }>
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
    /** Conversion needs a complete inventory even when the display reader permits partial content. */
    parseMigrationStoredEnvelope?(value: unknown): TEnvelope | null;
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
 * Lists one reserved domain with the same Account and stored-envelope admission.
 * `complete` reports omitted corrupt content in this page; `nextCursor` reports
 * remaining physical rows. Without diagnostics, malformed content fails closed.
 */
export async function listReservedAccountScopedKvRowsInTx<TEnvelope>(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        physicalPrefix: string;
        /** Singleton reserved keys must not admit ordinary keys sharing their prefix. */
        physicalKey?: string;
        domain: ReservedAccountScopedKvRowDomain<TEnvelope>;
        cursor?: string;
        limit?: number;
        diagnostics?: boolean;
    }>,
): Promise<Readonly<{
    status: "listed";
    rows: readonly Readonly<{ physicalKey: string; revision: number; envelope: TEnvelope | null }>[];
    nextCursor: string | null;
    complete: boolean;
    diagnostics: readonly Readonly<{ physicalKey: string; revision: number; reason: "invalid-stored-content" }>[];
}> | ReservedAccountScopedKvRowFailure> {
    if (input.physicalKey !== undefined && !input.physicalKey.startsWith(input.physicalPrefix)) {
        throw new Error(`${input.domain.label} physical key must belong to the physical prefix`);
    }
    if (input.cursor !== undefined && !input.cursor.startsWith(input.physicalPrefix)) {
        throw new Error(`${input.domain.label} cursor must belong to the physical prefix`);
    }
    if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit <= 0)) {
        throw new Error(`${input.domain.label} limit must be a positive integer`);
    }
    const scope = await resolveAccountScopeInTx(tx, input.accountId);
    if (scope.status !== "ready") return scope;
    const keyScope = input.physicalKey !== undefined
        ? { equals: input.physicalKey }
        : { startsWith: input.physicalPrefix };
    const storedRows = await tx.userKVStore.findMany({
        where: { accountId: input.accountId, key: { ...keyScope,
            ...(input.cursor !== undefined ? { gt: input.cursor } : {}) } },
        select: { key: true, version: true, value: true },
        orderBy: { key: "asc" },
        ...(input.limit !== undefined ? { take: input.limit } : {}),
    });
    const rows: Array<{ physicalKey: string; revision: number; envelope: TEnvelope | null }> = [];
    const diagnostics: Array<{ physicalKey: string; revision: number; reason: "invalid-stored-content" }> = [];
    for (const row of storedRows) {
        const envelope = row.value === null ? null : decodeStoredEnvelope(row.value, input.domain);
        if (row.value !== null && envelope === null) {
            diagnostics.push({ physicalKey: row.key, revision: row.version, reason: "invalid-stored-content" });
            continue;
        }
        if (envelope !== null && !envelopeMatchesMode(envelope, scope.mode, input.domain)) {
            return { status: "account-mode-mismatch" };
        }
        rows.push({ physicalKey: row.key, revision: row.version, envelope });
    }
    if (!input.diagnostics && diagnostics.length > 0) return { status: "invalid-stored-content" };
    const lastPhysicalKey = storedRows.at(-1)?.key;
    const remaining = input.limit !== undefined && storedRows.length === input.limit && lastPhysicalKey !== undefined
        ? await tx.userKVStore.findFirst({
            where: { accountId: input.accountId, key: { ...keyScope, gt: lastPhysicalKey } },
            select: { key: true },
            orderBy: { key: "asc" },
        }) : null;
    return { status: "listed", rows, nextCursor: remaining ? lastPhysicalKey! : null,
        complete: diagnostics.length === 0, diagnostics };
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
    const result = await mutateReservedAccountScopedKvRowsInTx(tx, {
        accountId: input.accountId,
        mutations: [{ physicalKey: input.physicalKey, expectedRevision: input.expectedRevision,
            envelope: input.envelope, domain: input.domain }],
        markChanged: input.markChanged,
    });
    if (result.status === "conflict") return { status: "conflict", revision: result.revision };
    if (result.status !== "updated") return result;
    const row = result.rows[0];
    if (!row) throw new Error(`${input.domain.label} mutation did not return a revision`);
    return { status: "updated", revision: row.revision, cursor: row.cursor };
}

/**
 * Domains may differ across rows, but one fenced Account mode and the shared
 * UserKVStore CAS owner validate every candidate and stored row before writes.
 * The supplied domain grammar validates its own unknown candidate at admission.
 */
export async function mutateReservedAccountScopedKvRowsInTx(
    tx: Tx,
    input: Readonly<{
        accountId: string;
        mutations: readonly Readonly<{
            physicalKey: string;
            expectedRevision: number | "absent";
            envelope: unknown;
            domain: ReservedAccountScopedKvRowDomain<unknown>;
        }>[];
        markChanged: (params: Readonly<{ tx: Tx; physicalKey: string; revision: number }>) => Promise<number>;
    }>,
): Promise<ReservedAccountScopedKvRowsMutationResult> {
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
    if (fence.status === "account_not_found") return { status: "account-not-found" };
    if (fence.status === "account_inconsistent") {
        return { status: "account-inconsistent", reason: fence.reason };
    }
    const mode = fence.account.currentness.encryptionMode;

    const mutations: KVMutation[] = [];
    const domains = new Map<string, ReservedAccountScopedKvRowDomain<unknown>>();
    for (const candidate of input.mutations) {
        if (domains.has(candidate.physicalKey)) {
            throw new Error(`${candidate.domain.label} batch contains a duplicate physical key`);
        }
        domains.set(candidate.physicalKey, candidate.domain);
        const expectedRevision = normalizeExpectedRevision(candidate.expectedRevision, candidate.domain.label);
        const envelope = candidate.envelope === null ? null : candidate.domain.parseCandidateEnvelope(candidate.envelope);
        if (candidate.envelope !== null && envelope === null) return { status: "invalid-stored-content" };
        if (envelope !== null && !envelopeMatchesMode(envelope, mode, candidate.domain)) {
            return { status: "account-mode-mismatch" };
        }
        const value = envelope === null ? null : encodeAccountScopedKvJson(envelope);
        if (envelope !== null && value === null) return { status: "invalid-stored-content" };
        mutations.push({ key: candidate.physicalKey, value, version: expectedRevision });
    }

    let application: UserKvMutationApplication;
    try {
        application = await applyUserKvMutationsInTx(
            tx,
            { uid: input.accountId },
            mutations,
            (mutation, existing) => {
                if (existing === null || existing.value === null) return;
                const domain = domains.get(mutation.key);
                if (!domain) throw new Error("Reserved Account row mutation is missing its domain");
                const stored = decodeStoredEnvelope(existing.value, domain);
                if (stored === null) {
                    throw new ReservedAccountScopedKvRowError("invalid-stored-content");
                }
                if (!envelopeMatchesMode(stored, mode, domain)) {
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
            throw new Error("Reserved Account row conflict is missing its current revision");
        }
        return { status: "conflict", physicalKey: conflict.key, revision: conflict.version };
    }

    const rows: Array<{ physicalKey: string; revision: number; cursor: number }> = [];
    for (const result of application.results) {
        const cursor = await input.markChanged({ tx, physicalKey: result.key, revision: result.version });
        rows.push({ physicalKey: result.key, revision: result.version, cursor });
    }
    return { status: "updated", rows };
}

export type ReservedAccountScopedKvRowMigrationItem<TEnvelope> = Readonly<{
    physicalKey: string; revision: number; envelope: TEnvelope;
}>;
type ReservedRowMigrationParams<TEnvelope> = Readonly<{
    accountId: string; physicalPrefix: string; toMode: 'plain' | 'e2ee';
    physicalKey?: string;
    domain: ReservedAccountScopedKvRowDomain<TEnvelope>;
    items: readonly ReservedAccountScopedKvRowMigrationItem<TEnvelope>[];
    isPhysicalKey: (physicalKey: string) => boolean;
}>;

function migrationRowDomain<TEnvelope>(domain: ReservedAccountScopedKvRowDomain<TEnvelope>) {
    return { ...domain, parseStoredEnvelope: domain.parseMigrationStoredEnvelope ?? domain.parseStoredEnvelope };
}

function indexMigrationItems<TEnvelope>(input: ReservedRowMigrationParams<TEnvelope>) {
    const items = new Map<string, ReservedAccountScopedKvRowMigrationItem<TEnvelope>>();
    for (const item of input.items) {
        if (!input.isPhysicalKey(item.physicalKey) || !item.physicalKey.startsWith(input.physicalPrefix)
            || (input.physicalKey !== undefined && item.physicalKey !== input.physicalKey) || items.has(item.physicalKey)
            || !Number.isSafeInteger(item.revision) || item.revision < 0) return null;
        const envelope = input.domain.parseCandidateEnvelope(item.envelope);
        if (envelope === null || !envelopeMatchesMode(envelope, input.toMode, input.domain)) return null;
        items.set(item.physicalKey, { ...item, envelope });
    }
    return items;
}

/** The Account transition caller holds its fence and rolls back every refusal. */
export async function migrateReservedAccountScopedKvRowsForAccountModeInTx<TEnvelope>(
    tx: Tx, input: ReservedRowMigrationParams<TEnvelope> & Readonly<{
        markChanged: (input: Readonly<{ tx: Tx; physicalKey: string; revision: number }>) => Promise<number>;
    }>,
): Promise<Readonly<{ status: 'applied'; rows: readonly ReservedAccountScopedKvRowMigrationItem<TEnvelope>[] }>
    | Readonly<{ status: 'migration_incomplete' | 'invalid_content' }>> {
    const source = await listReservedAccountScopedKvRowsInTx(tx, { ...input, domain: migrationRowDomain(input.domain) });
    if (source.status !== 'listed' || !source.complete || source.nextCursor !== null) return { status: 'invalid_content' };
    if (source.rows.some(row => !input.isPhysicalKey(row.physicalKey))) return { status: 'invalid_content' };
    const rows = source.rows.filter(row => row.envelope !== null);
    const items = indexMigrationItems(input);
    if (!items) return { status: 'invalid_content' };
    if (items.size !== rows.length || rows.some(row => items.get(row.physicalKey)?.revision !== row.revision)) {
        return { status: 'migration_incomplete' };
    }
    if (rows.length === 0) return { status: 'applied', rows: [] };
    const application = await applyUserKvMutationsInTx(tx, { uid: input.accountId }, rows.map(row => {
        const item = items.get(row.physicalKey)!;
        const value = encodeAccountScopedKvJson(item.envelope);
        if (value === null) throw new Error(`${input.domain.label} migration content cannot be encoded`);
        return { key: item.physicalKey, version: item.revision, value };
    }));
    if (!application.success) return { status: 'migration_incomplete' };
    const migrated: ReservedAccountScopedKvRowMigrationItem<TEnvelope>[] = [];
    for (const row of rows) {
        const item = items.get(row.physicalKey)!;
        const revision = item.revision + 1;
        await input.markChanged({ tx, physicalKey: item.physicalKey, revision });
        migrated.push({ ...item, revision });
    }
    return { status: 'applied', rows: migrated };
}

/** Exact lost-response replay checks complete active coverage and never writes. */
export async function matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx<TEnvelope>(
    tx: Tx, input: ReservedRowMigrationParams<TEnvelope>,
): Promise<Readonly<{ status: 'matched'; rows: readonly ReservedAccountScopedKvRowMigrationItem<TEnvelope>[] }>
    | Readonly<{ status: 'mismatch' }>> {
    const state = await listReservedAccountScopedKvRowsInTx(tx, { ...input, domain: migrationRowDomain(input.domain) });
    if (state.status !== 'listed' || !state.complete || state.nextCursor !== null) return { status: 'mismatch' };
    if (state.rows.some(row => !input.isPhysicalKey(row.physicalKey))) return { status: 'mismatch' };
    const rows = state.rows.filter(row => row.envelope !== null);
    const items = indexMigrationItems(input);
    if (!items || items.size !== rows.length || rows.some(row => {
        const item = items.get(row.physicalKey);
        return !item || row.revision !== item.revision + 1 || !pluginJsonValuesEqual(row.envelope, item.envelope);
    })) return { status: 'mismatch' };
    return { status: 'matched', rows: rows.map(row => ({ physicalKey: row.physicalKey, revision: row.revision, envelope: row.envelope! })) };
}

type ReservedSingletonMigrationParams<TEnvelope> = Readonly<{
    accountId: string;
    physicalKey: string;
    toMode: 'plain' | 'e2ee';
    domain: ReservedAccountScopedKvRowDomain<TEnvelope>;
    directive?: Readonly<{ expectedRevision: number; content: TEnvelope | null }>;
}>;

function singletonMigrationParams<TEnvelope>(input: ReservedSingletonMigrationParams<TEnvelope>): ReservedRowMigrationParams<TEnvelope> {
    return { ...input, physicalPrefix: input.physicalKey,
        isPhysicalKey: key => key === input.physicalKey,
        items: input.directive?.content != null ? [{ physicalKey: input.physicalKey,
            revision: input.directive.expectedRevision, envelope: input.directive.content }] : [] };
}

/** Singleton catalogs require explicit coverage of retained tombstones, which conversion leaves unchanged. */
export async function migrateReservedAccountScopedKvSingletonForAccountModeInTx<TEnvelope>(
    tx: Tx, input: ReservedSingletonMigrationParams<TEnvelope> & Readonly<{
        markChanged: (input: Readonly<{ tx: Tx; revision: number }>) => Promise<number>;
    }>,
): Promise<Readonly<{ status: 'applied'; row: Readonly<{ revision: number; content: TEnvelope | null }> | null }>
    | Readonly<{ status: 'migration_incomplete' | 'invalid_content' }>> {
    const source = await readReservedAccountScopedKvRowInTx(tx, { ...input, domain: migrationRowDomain(input.domain) });
    if (source.status === 'absent') return input.directive === undefined
        ? { status: 'applied', row: null } : { status: 'migration_incomplete' };
    if (source.status === 'deleted') return input.directive?.content === null && input.directive.expectedRevision === source.revision
        ? { status: 'applied', row: { revision: source.revision, content: null } } : { status: 'migration_incomplete' };
    if (source.status !== 'present') return { status: 'invalid_content' };
    if (input.directive?.content == null) return { status: 'migration_incomplete' };
    const result = await migrateReservedAccountScopedKvRowsForAccountModeInTx(tx, { ...singletonMigrationParams(input), markChanged: input.markChanged });
    if (result.status !== 'applied') return result;
    const row = result.rows[0];
    if (!row) throw new Error(`${input.domain.label} singleton migration did not return its row`);
    return { status: 'applied', row: { revision: row.revision, content: row.envelope } };
}

/** Exact replay validates live content and revision, or the retained tombstone, without mutation or change hints. */
export async function matchReservedAccountScopedKvSingletonAccountMigrationPostStateInTx<TEnvelope>(
    tx: Tx, input: ReservedSingletonMigrationParams<TEnvelope>,
): Promise<Readonly<{ status: 'matched'; row: Readonly<{ revision: number; content: TEnvelope | null }> | null }>
    | Readonly<{ status: 'mismatch' }>> {
    const state = await readReservedAccountScopedKvRowInTx(tx, { ...input, domain: migrationRowDomain(input.domain) });
    if (state.status === 'absent') return input.directive === undefined
        ? { status: 'matched', row: null } : { status: 'mismatch' };
    if (state.status === 'deleted') return input.directive?.content === null && input.directive.expectedRevision === state.revision
        ? { status: 'matched', row: { revision: state.revision, content: null } } : { status: 'mismatch' };
    if (state.status !== 'present' || input.directive?.content == null) return { status: 'mismatch' };
    const result = await matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx(tx, singletonMigrationParams(input));
    if (result.status !== 'matched') return result;
    const row = result.rows[0];
    if (!row) throw new Error(`${input.domain.label} singleton replay did not return its row`);
    return { status: 'matched', row: { revision: row.revision, content: row.envelope } };
}
