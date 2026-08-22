import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
    ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS,
    computeAccountEncryptionMigrateKeyFingerprintV1,
    decodeBase64,
    encodeBase64,
    type AccountEncryptionMigrateCollectionInventoryItem,
    type AccountEncryptionMigrateCollectionStageItem,
    type AccountEncryptionMigrateTransitionPrepareRequest,
    type AccountEncryptionMigrateTransitionPrepareResponse,
    type PluginCollectionContentEnvelopeV1,
} from "@happier-dev/protocol";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import {
    verifyAccountContentKeyBindingForAccountPublicKey,
} from "@/app/encryption/accountContentKeyAdmission";
import {
    acquireAccountEncryptionTransitionFenceInTx,
    applyAccountEncryptionTransitionInTx,
    type AccountEncryptionTransitionFenceResult,
} from "@/app/encryption/accountEncryptionTransition";
import {
    applyPluginCollectionAccountEncryptionTransitionInTx,
    inspectPluginCollectionAccountEncryptionTransitionInTx,
    measurePluginCollectionAccountEncryptionTransitionContentBytes,
    validatePluginCollectionAccountEncryptionTransitionStageInTx,
} from "@/app/plugins/data/collections/accountEncryptionTransition";
import { retirePluginCollectionCandidatePreparationStagesTx } from "@/app/plugins/data/collections/candidatePreparationLifecycle";
import {
    applyAutomationAccountEncryptionTransitionStageInTx,
    inspectAutomationAccountEncryptionTransitionInTx,
    validateAutomationAccountEncryptionTransitionStageInTx,
    type AutomationAccountEncryptionTransitionInventoryItem,
    type AutomationAccountEncryptionTransitionSourceCursor,
    type AutomationAccountEncryptionTransitionStageItem,
} from "@/app/automations/automationCrudService";
import type {
    VerifiedAccountContentKeyBinding,
} from "@/app/encryption/accountContentKeyAdmission";
import {
    deleteAccountEncryptionTransitionAutomationStageStateInTx,
    deleteAccountEncryptionTransitionAutomationStagesByIdsInTx,
    deleteAccountEncryptionTransitionAutomationStagesInTx,
    listAccountEncryptionTransitionAutomationStageIdsForCleanupInTx,
    measureAccountEncryptionTransitionAutomationSourceItemBytes,
    measureAccountEncryptionTransitionAutomationStageItemBytes,
    readAccountEncryptionTransitionAutomationStagePageInTx,
    readAccountEncryptionTransitionAutomationStageStateInTx,
    readAccountEncryptionTransitionAutomationStagesByIdentityInTx,
    stageAccountEncryptionTransitionAutomationSourceCensusInTx,
    sourceItemFromAccountEncryptionTransitionAutomationStage,
    targetItemFromAccountEncryptionTransitionAutomationStage,
    type AccountEncryptionTransitionAutomationStageCursor,
    writeAccountEncryptionTransitionAutomationStageTargetsInTx,
} from "./accountEncryptionTransitionAutomationStage";
import {
    ACCOUNT_ENCRYPTION_TRANSITION_PEP1_CAPACITY_MEASUREMENT,
    deriveAccountEncryptionTransitionMeasuredCapacity,
    type AccountEncryptionTransitionMeasuredCapacity,
} from "./accountEncryptionTransitionMeasuredCapacity";
import { inTx, type Tx } from "@/storage/inTx";

/**
 * V4 has no Collection transition directive. A zero-sized, assert-empty
 * inventory is therefore a compatibility refusal, not a Collection capacity
 * decision. The V5 path below has its own persisted staged directive and is
 * kept behind the canonical stored-content operation declaration until the
 * source and three-provider serving gates have closed.
 */
const V4_EMPTY_COLLECTION_TRANSITION_LIMITS = {
    participantLimit: 0,
    encodedByteLimit: 0n,
} as const;

/**
 * Lifecycle work is deliberately separate from the V5 wire page/batch limits:
 * neither number is an Account aggregate-capacity decision. The cleanup chunk
 * only bounds one transaction's envelope deletion work. Aggregate capacity is
 * owned separately by `ACCOUNT_ENCRYPTION_TRANSITION_MEASURED_CAPACITY`.
 *
 * The fixed ten-minute lifetime matches the incumbent first-key external-auth
 * pending default. It is deliberately non-renewable: each retry reuses the
 * same bounded transition or starts a fresh one after expiry, so no stage can
 * acquire an unbounded lease merely by uploading batches.
 */
export const ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE = Object.freeze({
    cleanupBatchSize:
        ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS,
    lifetimeMs: 10 * 60 * 1000,
});

/**
 * PEP2's only fixed participant ceiling is the complete all-origin retained
 * Run census. It is distinct from the Account owner's measured aggregate
 * stage capacity, which also reserves the paired Definition/Collection facts.
 *
 * The number is not a nearby capacity guess: the Account-transition owner
 * approved `PLAINTEXT-ACCOUNTS-2026-08-11.PEP2` only for at most 10,000
 * retained participating Automation Runs across all origins, so this bound is
 * the authorization scope itself. The measured aggregate capacity subsumes it
 * whenever `participantLimit` is the tighter of the two, but it must not be
 * removed in favour of that capacity: a measurement above the approved scope
 * would otherwise admit a transition nobody authorized.
 */
const ACCOUNT_ENCRYPTION_TRANSITION_AUTOMATION_RUN_MAX_PARTICIPANTS = 10_000;

type AccountEncryptionTransitionMode = "plain" | "e2ee";

type AccountEncryptionTransitionSourceFacts = Readonly<{
    transitionId: string;
    fromMode: AccountEncryptionTransitionMode;
    toMode: AccountEncryptionTransitionMode;
    expectedAccountVersion: number;
    expectedSigningKeyFingerprint: string | null;
    expectedContentKeyFingerprint: string | null;
}>;

type AccountEncryptionTransitionFirstKeyAuthorization = Readonly<{
    kind: "first_key";
    accountPublicKeyHex: string;
    binding: VerifiedAccountContentKeyBinding;
    signingKeyFingerprint: string;
}>;

type AccountEncryptionTransitionAuthorization =
    | Readonly<{ kind: "present_user_confirmation" }>
    | AccountEncryptionTransitionFirstKeyAuthorization;

type AccountEncryptionTransitionStageSource = Readonly<{
    pluginId: string;
    collectionId: string;
    rowId: string;
    sourceRevision: number;
    sourceEnvelope: unknown;
    schemaVersion: number;
    contractDigest: string;
    sourceEncodedBytes: bigint;
}>;

type AccountEncryptionTransitionStoredStage = AccountEncryptionTransitionStageSource
    & Readonly<{
        id: string;
        targetEnvelope: unknown | null;
        targetEncodedBytes: bigint | null;
    }>;

type AccountEncryptionTransitionStageIdentity = Readonly<{
    pluginId: string;
    collectionId: string;
    rowId: string;
}>;

export type AccountEncryptionTransitionPrepareCoordinatorResult =
    | Readonly<{
        status: "prepared";
        transition: AccountEncryptionTransitionSourceFacts;
        expiresAt: number;
    }>
    | Readonly<{
        status:
            | "account_not_found"
            | "account_inconsistent"
            | "source_mismatch"
            | "transition_in_progress";
    }>;

export type AccountEncryptionTransitionAuthorizeCoordinatorResult =
    | Readonly<{ status: "authorized" }>
    | Readonly<{
        status:
            | "transition_not_found"
            | "transition_not_authorizable"
            | "transition_expired"
            | "source_mismatch"
            | "invalid_authorization"
            | "migration_too_large"
            | "invalid_content"
            | "identity_relocation_unsupported";
    }>;

/**
 * The HTTP/auth boundary uses these immutable facts to verify a first-key
 * proof. They are read under the same Account fence that the subsequent
 * authorization write rechecks, so a proof can never be rebound to a client
 * supplied source snapshot.
 */
export type AccountEncryptionTransitionAuthorizationPreparationResult =
    | Readonly<{
        status: "ready";
        prepared: AccountEncryptionMigrateTransitionPrepareResponse;
    }>
    | Readonly<{ status: "authorized" }>
    | Readonly<{
        status:
            | "transition_not_found"
            | "transition_not_authorizable"
            | "transition_expired"
            | "source_mismatch";
    }>;

export type AccountEncryptionTransitionInventoryCoordinatorResult =
    | Readonly<{
        status: "ready";
        items: readonly AccountEncryptionMigrateCollectionInventoryItem[];
        nextCursor?: string;
    }>
    | Readonly<{
        status:
            | "transition_not_found"
            | "transition_not_ready"
            | "transition_expired"
            | "source_mismatch"
            | "migration_incomplete"
            | "invalid_cursor"
            | "invalid_content"
            | "identity_relocation_unsupported";
    }>;

export type AccountEncryptionTransitionStageCoordinatorResult =
    | Readonly<{
        status: "staged";
        stagedParticipantCount: number;
        stagedSourceBytes: bigint;
        stagedTargetBytes: bigint;
    }>
    | Readonly<{
        status:
            | "transition_not_found"
            | "transition_not_ready"
            | "transition_expired"
            | "source_mismatch"
            | "migration_incomplete"
            | "migration_too_large"
            | "stage_conflict"
            | "invalid_content"
            | "identity_relocation_unsupported";
    }>;

export type AccountEncryptionTransitionAutomationInventoryCoordinatorResult =
    | Readonly<{
        status: "ready";
        items: readonly AutomationAccountEncryptionTransitionInventoryItem[];
        nextCursor?: string;
    }>
    | Readonly<{
        status:
            | "transition_not_found"
            | "transition_not_ready"
            | "transition_expired"
            | "source_mismatch"
            | "migration_incomplete"
            | "invalid_cursor"
            | "invalid_content"
            | "identity_relocation_unsupported";
    }>;

export type AccountEncryptionTransitionAutomationStageCoordinatorResult =
    | Readonly<{
        status: "staged";
        stagedParticipantCount: number;
        stagedSourceBytes: bigint;
        stagedTargetBytes: bigint;
    }>
    | Readonly<{
        status:
            | "transition_not_found"
            | "transition_not_ready"
            | "transition_expired"
            | "source_mismatch"
            | "migration_incomplete"
            | "migration_too_large"
            | "stage_conflict"
            | "invalid_content"
            | "identity_relocation_unsupported";
    }>;

export type AccountEncryptionTransitionActivateCoordinatorResult =
    | Readonly<{
        status: "activated";
        mode: AccountEncryptionTransitionMode;
        version: number;
        updatedAt: number;
        cursor: number;
    }>
    | Readonly<{
        status:
            | "transition_not_found"
            | "transition_not_ready"
            | "transition_expired"
            | "source_mismatch"
            | "migration_incomplete"
            | "migration_too_large"
            | "invalid_content"
            | "identity_relocation_unsupported";
    }>;

export type AccountEncryptionTransitionCoordinatorResult =
    | Readonly<{
        status: "applied";
        mode: "plain" | "e2ee";
        version: number;
        updatedAt: number;
        cursor: number;
    }>
    | Readonly<{ status: "account_not_found" }>
    | Readonly<{ status: "account_inconsistent" }>
    | Readonly<{ status: "source_mode_mismatch" }>
    | Readonly<{ status: "collections_migration_incomplete" }>
    | Readonly<{ status: "collections_invalid_content" }>
    | Readonly<{ status: "collections_identity_relocation_unsupported" }>;

/**
 * Both retained Account transition ingresses enter through this fence. The
 * lower-level primitive remains the Account-row implementation detail; route
 * code must not independently acquire or finalize an Account transition.
 */
export async function acquireAccountEncryptionTransitionCoordinatorFenceInTx(
    tx: Tx,
    accountId: string,
): Promise<AccountEncryptionTransitionFenceResult> {
    return await acquireAccountEncryptionTransitionFenceInTx(tx, accountId);
}

/**
 * Final Account-owned transition boundary. Domain-specific migrations happen
 * before this call under the same transaction; this owner rechecks Account
 * currentness, has Collection enforce its closed V4 participant contract,
 * publishes the sole Account cursor, and flips the persisted mode atomically.
 */
export async function finalizeAccountEncryptionTransitionCoordinatorInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        fromMode: "plain" | "e2ee";
        toMode: "plain" | "e2ee";
        accountPublicKeyHex?: string;
        contentKey:
            | Readonly<{ kind: "preserve" }>
            | Readonly<{
                kind: "migration_replace";
                binding: VerifiedAccountContentKeyBinding;
            }>;
        accountChangeHint: unknown;
    }>,
): Promise<AccountEncryptionTransitionCoordinatorResult> {
    const fence = await acquireAccountEncryptionTransitionCoordinatorFenceInTx(
        params.tx,
        params.accountId,
    );
    if (fence.status === "account_not_found") return fence;
    if (fence.status === "account_inconsistent") {
        return { status: "account_inconsistent" };
    }
    if (fence.account.currentness.encryptionMode !== params.fromMode) {
        return { status: "source_mode_mismatch" };
    }

    const collections =
        await applyPluginCollectionAccountEncryptionTransitionInTx({
            tx: params.tx,
            accountId: params.accountId,
            fromMode: params.fromMode,
            toMode: params.toMode,
            limits: V4_EMPTY_COLLECTION_TRANSITION_LIMITS,
            directive: { action: "assert_empty" },
        });
    if (collections.status === "migration_incomplete") {
        return { status: "collections_migration_incomplete" };
    }
    if (collections.status === "invalid_content") {
        return { status: "collections_invalid_content" };
    }
    if (collections.status === "identity_relocation_unsupported") {
        return { status: "collections_identity_relocation_unsupported" };
    }

    const cursor = await markAccountChanged(params.tx, {
        accountId: params.accountId,
        kind: "account",
        entityId: "self",
        hint: params.accountChangeHint,
    });
    const updated = await applyAccountEncryptionTransitionInTx(params.tx, {
        accountId: params.accountId,
        expectedVersion: cursor,
        toMode: params.toMode,
        ...(params.accountPublicKeyHex
            ? { accountPublicKeyHex: params.accountPublicKeyHex }
            : {}),
        contentKey: params.contentKey,
    });
    return { status: "applied", cursor, ...updated };
}

function isTransitionMode(value: unknown): value is AccountEncryptionTransitionMode {
    return value === "plain" || value === "e2ee";
}

function jsonEqual(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (
        left === null
        || right === null
        || typeof left !== "object"
        || typeof right !== "object"
        || Array.isArray(left)
        || Array.isArray(right)
    ) {
        if (!Array.isArray(left) || !Array.isArray(right)) return false;
        return left.length === right.length
            && left.every((value, index) => jsonEqual(value, right[index]));
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) => (
            key === rightKeys[index] && jsonEqual(leftRecord[key], rightRecord[key])
        ));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) return false;
    return Buffer.from(left).equals(Buffer.from(right));
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new Error("Account encryption transition stage content must be JSON serializable");
    }
    return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function stageIdentityKey(input: Readonly<{
    pluginId: string;
    collectionId: string;
    rowId: string;
}>): string {
    return `${input.pluginId}\u0000${input.collectionId}\u0000${input.rowId}`;
}

function sourceFactsFromTransition(
    transition: Readonly<{
        id: string;
        fromEncryptionMode: string;
        toEncryptionMode: string;
        sourceAccountVersion: number;
        sourceSigningKeyFingerprint: string | null;
        sourceContentKeyFingerprint: string | null;
    }>,
): AccountEncryptionTransitionSourceFacts | null {
    if (
        !isTransitionMode(transition.fromEncryptionMode)
        || !isTransitionMode(transition.toEncryptionMode)
        || transition.fromEncryptionMode === transition.toEncryptionMode
    ) {
        return null;
    }
    return {
        transitionId: transition.id,
        fromMode: transition.fromEncryptionMode,
        toMode: transition.toEncryptionMode,
        expectedAccountVersion: transition.sourceAccountVersion,
        expectedSigningKeyFingerprint:
            transition.sourceSigningKeyFingerprint,
        expectedContentKeyFingerprint:
            transition.sourceContentKeyFingerprint,
    };
}

function transitionMatchesPrepareRequest(
    transition: Readonly<{
        fromEncryptionMode: string;
        toEncryptionMode: string;
        sourceAccountVersion: number;
        sourceSigningKeyFingerprint: string | null;
        sourceContentKeyFingerprint: string | null;
    }>,
    request: AccountEncryptionMigrateTransitionPrepareRequest,
): boolean {
    return transition.toEncryptionMode === request.toMode
        && isTransitionMode(transition.fromEncryptionMode)
        && transition.fromEncryptionMode !== request.toMode
        && transition.sourceAccountVersion === request.expectedAccountVersion
        && transition.sourceSigningKeyFingerprint
            === request.expectedSigningKeyFingerprint
        && transition.sourceContentKeyFingerprint
            === request.expectedContentKeyFingerprint;
}

function transitionSourceMatchesFence(
    fence: AccountEncryptionTransitionFenceResult,
    transition: Readonly<{
        accountId: string;
        fromEncryptionMode: string;
        sourceAccountVersion: number;
        sourceSettingsVersion: number;
        sourceSigningKeyFingerprint: string | null;
        sourceContentKeyFingerprint: string | null;
    }>,
): boolean {
    return fence.status === "ready"
        && fence.account.currentness.encryptionMode
            === transition.fromEncryptionMode
        && fence.account.version === transition.sourceAccountVersion
        && fence.account.settingsVersion === transition.sourceSettingsVersion
        && fence.account.signingKeyFingerprint
            === transition.sourceSigningKeyFingerprint
        && fence.account.contentKeyFingerprint
            === transition.sourceContentKeyFingerprint;
}

function isExpired(transition: Readonly<{ expiresAt: Date }>, now: Date): boolean {
    return transition.expiresAt.getTime() <= now.getTime();
}

function resolveTransitionNow(now?: Date): Date {
    if (now && Number.isFinite(now.getTime())) return now;
    return new Date();
}

const accountEncryptionTransitionSelect = {
    id: true,
    accountId: true,
    fromEncryptionMode: true,
    toEncryptionMode: true,
    sourceAccountVersion: true,
    sourceSettingsVersion: true,
    sourceSigningKeyFingerprint: true,
    sourceContentKeyFingerprint: true,
    targetSigningKeyFingerprint: true,
    targetContentKeyFingerprint: true,
    targetAccountPublicKey: true,
    targetContentPublicKey: true,
    targetContentPublicKeySig: true,
    status: true,
    activeAccountId: true,
    preparedAt: true,
    authorizedAt: true,
    expiresAt: true,
    activatedAt: true,
    activatedAccountVersion: true,
    activatedAccountUpdatedAt: true,
    activatedAccountCursor: true,
    cancelledAt: true,
    expiredAt: true,
    censusParticipantCount: true,
    censusSourceBytes: true,
    censusTargetBytes: true,
    stagedParticipantCount: true,
    stagedSourceBytes: true,
    stagedTargetBytes: true,
    reservedCapacityBytes: true,
    measuredParticipantLimit: true,
    measuredEncodedByteLimit: true,
} as const;

/**
 * The one aggregate capacity every prepared transition is stamped with. It is
 * derived at load from the recorded offline PEP1 measurement and the released
 * census page unit this owner actually walks, so no snapshot of the derived
 * numbers can drift away from the measurement that justifies them.
 *
 * `reservedCapacityBytes` is stamped alongside the two measured limits because
 * `measuredCapacityFromTransition` treats all three as one fact: a transition
 * missing any of them can inspect source facts but must not accept a target
 * envelope or activate one.
 */
export const ACCOUNT_ENCRYPTION_TRANSITION_MEASURED_CAPACITY:
    AccountEncryptionTransitionMeasuredCapacity = Object.freeze(
        deriveAccountEncryptionTransitionMeasuredCapacity({
            measurement: ACCOUNT_ENCRYPTION_TRANSITION_PEP1_CAPACITY_MEASUREMENT,
            censusPageItems:
                ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS,
        }),
    );

/**
 * Aggregate capacity is a measured deployment fact, never a reuse of the public
 * 500-row/8 MiB transport bounds. A transition whose stamped capacity is
 * missing or non-positive may inspect source facts but must not accept a target
 * envelope or activate one.
 */
function measuredCapacityFromTransition(transition: Readonly<{
    measuredParticipantLimit: number | null;
    measuredEncodedByteLimit: bigint | null;
    reservedCapacityBytes: bigint;
}>): AccountEncryptionTransitionMeasuredCapacity | null {
    if (
        transition.measuredParticipantLimit === null
        || !Number.isSafeInteger(transition.measuredParticipantLimit)
        || transition.measuredParticipantLimit < 1
        || transition.measuredEncodedByteLimit === null
        || transition.measuredEncodedByteLimit < 1n
        || transition.reservedCapacityBytes < 1n
    ) {
        return null;
    }
    return {
        participantLimit: transition.measuredParticipantLimit,
        encodedByteLimit: transition.measuredEncodedByteLimit,
        reservedCapacityBytes: transition.reservedCapacityBytes,
    };
}

const accountEncryptionTransitionStageSelect = {
    id: true,
    transitionId: true,
    pluginId: true,
    collectionId: true,
    rowId: true,
    sourceRevision: true,
    sourceEnvelope: true,
    targetEnvelope: true,
    schemaVersion: true,
    contractDigest: true,
    sourceEncodedBytes: true,
    targetEncodedBytes: true,
} as const;

async function readAccountEncryptionTransitionInTx(
    tx: Tx,
    accountId: string,
    transitionId: string,
) {
    return await tx.accountEncryptionTransition.findFirst({
        where: { id: transitionId, accountId },
        select: accountEncryptionTransitionSelect,
    });
}

async function readAccountEncryptionTransitionStagesInTx(
    tx: Tx,
    transitionId: string,
) {
    return await tx.accountEncryptionTransitionCollectionStage.findMany({
        where: { transitionId },
        orderBy: [
            { pluginId: "asc" },
            { collectionId: "asc" },
            { rowId: "asc" },
        ],
        select: accountEncryptionTransitionStageSelect,
    });
}

function stageIdentityFromCursor(value: AccountEncryptionTransitionStageIdentity) {
    return {
        OR: [
            { pluginId: { gt: value.pluginId } },
            {
                pluginId: value.pluginId,
                collectionId: { gt: value.collectionId },
            },
            {
                pluginId: value.pluginId,
                collectionId: value.collectionId,
                rowId: { gt: value.rowId },
            },
        ],
    } satisfies Prisma.AccountEncryptionTransitionCollectionStageWhereInput;
}

type AccountEncryptionTransitionInventoryCursor = Readonly<{
    v: 1;
    transitionId: string;
    after: AccountEncryptionTransitionStageIdentity;
}>;

function encodeAccountEncryptionTransitionInventoryCursor(
    cursor: AccountEncryptionTransitionInventoryCursor,
): string {
    return encodeBase64(
        new TextEncoder().encode(JSON.stringify(cursor)),
        "base64url",
    );
}

function decodeAccountEncryptionTransitionInventoryCursor(
    value: string,
): AccountEncryptionTransitionInventoryCursor | null {
    try {
        const decoded = decodeBase64(value, "base64url");
        // `decodeBase64` is intentionally permissive for its general crypto
        // callers. This cursor is an opaque authorization boundary and must
        // accept only its one canonical encoding.
        if (encodeBase64(decoded, "base64url") !== value) return null;
        const parsed = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(decoded),
        ) as unknown;
        if (
            parsed === null
            || typeof parsed !== "object"
            || Array.isArray(parsed)
        ) return null;
        const record = parsed as Record<string, unknown>;
        if (
            Object.keys(record).length !== 3
            || record.v !== 1
            || typeof record.transitionId !== "string"
            || record.transitionId.length === 0
            || record.after === null
            || typeof record.after !== "object"
            || Array.isArray(record.after)
        ) return null;
        const after = record.after as Record<string, unknown>;
        if (
            Object.keys(after).length !== 3
            || typeof after.pluginId !== "string"
            || after.pluginId.length === 0
            || typeof after.collectionId !== "string"
            || after.collectionId.length === 0
            || typeof after.rowId !== "string"
            || after.rowId.length === 0
        ) return null;
        return {
            v: 1,
            transitionId: record.transitionId,
            after: {
                pluginId: after.pluginId,
                collectionId: after.collectionId,
                rowId: after.rowId,
            },
        };
    } catch {
        return null;
    }
}

type AccountEncryptionTransitionAutomationInventoryCursor = Readonly<{
    v: 1;
    transitionId: string;
    after: AccountEncryptionTransitionAutomationStageCursor;
}>;

function encodeAccountEncryptionTransitionAutomationInventoryCursor(
    cursor: AccountEncryptionTransitionAutomationInventoryCursor,
): string {
    return encodeBase64(
        new TextEncoder().encode(JSON.stringify(cursor)),
        "base64url",
    );
}

function decodeAccountEncryptionTransitionAutomationInventoryCursor(
    value: string,
): AccountEncryptionTransitionAutomationInventoryCursor | null {
    try {
        const decoded = decodeBase64(value, "base64url");
        if (encodeBase64(decoded, "base64url") !== value) return null;
        const parsed = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(decoded),
        ) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }
        const record = parsed as Record<string, unknown>;
        if (
            Object.keys(record).length !== 3
            || record.v !== 1
            || typeof record.transitionId !== "string"
            || record.transitionId.length === 0
            || !record.after
            || typeof record.after !== "object"
            || Array.isArray(record.after)
        ) {
            return null;
        }
        const after = record.after as Record<string, unknown>;
        if (
            Object.keys(after).length !== 2
            || (after.participantKind !== "definition" && after.participantKind !== "run")
            || typeof after.participantId !== "string"
            || after.participantId.length === 0
            || after.participantId.length > 256
        ) {
            return null;
        }
        return {
            v: 1,
            transitionId: record.transitionId,
            after: {
                participantKind: after.participantKind,
                participantId: after.participantId,
            },
        };
    } catch {
        return null;
    }
}

async function readAccountEncryptionTransitionInventoryPageInTx(params: Readonly<{
    tx: Tx;
    transitionId: string;
    cursor?: AccountEncryptionTransitionStageIdentity;
}>): Promise<Readonly<{
    stages: readonly AccountEncryptionTransitionStoredStage[];
    nextCursor?: AccountEncryptionTransitionStageIdentity;
}>> {
    const rows = await params.tx.accountEncryptionTransitionCollectionStage.findMany({
        where: {
            transitionId: params.transitionId,
            ...(params.cursor ? stageIdentityFromCursor(params.cursor) : {}),
        },
        orderBy: [
            { pluginId: "asc" },
            { collectionId: "asc" },
            { rowId: "asc" },
        ],
        take: ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS + 1,
        select: accountEncryptionTransitionStageSelect,
    });
    const stages = rows.slice(
        0,
        ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS,
    );
    const last = stages.at(-1);
    return {
        stages,
        ...(rows.length > stages.length && last
            ? {
                nextCursor: {
                    pluginId: last.pluginId,
                    collectionId: last.collectionId,
                    rowId: last.rowId,
                },
            }
            : {}),
    };
}

type AccountEncryptionTransitionCollectionCensus =
    | Readonly<{
        status: "complete";
        participantCount: number;
        sourceEncodedBytes: bigint;
    }>
    | Readonly<{
        status:
            | "migration_incomplete"
            | "invalid_content"
            | "identity_relocation_unsupported";
    }>;

type AccountEncryptionTransitionSourceCensus =
    | Readonly<{
        status: "complete";
        participantCount: number;
        sourceEncodedBytes: bigint;
    }>
    | Readonly<{ status: "invalid_content" | "identity_relocation_unsupported" }>;

/**
 * Reads the complete Collection source census without retaining payloads.
 * Authorization has already been recorded before this runs, so E2EE → plain
 * confirmation is never followed by an earlier source-content inspection.
 */
async function inspectPluginCollectionSourceCensusInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    sourceMode: AccountEncryptionTransitionMode;
}>): Promise<AccountEncryptionTransitionSourceCensus> {
    let participantCount = 0;
    let sourceEncodedBytes = 0n;
    let cursor: AccountEncryptionTransitionStageIdentity | undefined;
    for (;;) {
        const page = await inspectPluginCollectionAccountEncryptionTransitionInTx({
            tx: params.tx,
            accountId: params.accountId,
            sourceMode: params.sourceMode,
            ...(cursor ? { cursor } : {}),
        });
        if (page.status === "invalid_content") return { status: "invalid_content" };
        if (page.status === "identity_relocation_unsupported") {
            return { status: "identity_relocation_unsupported" };
        }
        if (!Number.isSafeInteger(participantCount + page.items.length)) {
            return { status: "invalid_content" };
        }
        participantCount += page.items.length;
        sourceEncodedBytes += page.sourceContentBytes;
        if (!page.nextCursor) {
            return { status: "complete", participantCount, sourceEncodedBytes };
        }
        cursor = page.nextCursor;
    }
}

/**
 * Persists the already-authorized exact source facts page-by-page. The public
 * 500-row page is a transaction/write bound only: it is never treated as an
 * Account capacity limit and no full source inventory is retained in
 * coordinator memory.
 */
async function stagePluginCollectionSourceCensusInTx(params: Readonly<{
    tx: Tx;
    transitionId: string;
    accountId: string;
    sourceMode: AccountEncryptionTransitionMode;
}>): Promise<AccountEncryptionTransitionSourceCensus> {
    let participantCount = 0;
    let sourceEncodedBytes = 0n;
    let cursor: AccountEncryptionTransitionStageIdentity | undefined;
    for (;;) {
        const page = await inspectPluginCollectionAccountEncryptionTransitionInTx({
            tx: params.tx,
            accountId: params.accountId,
            sourceMode: params.sourceMode,
            ...(cursor ? { cursor } : {}),
        });
        if (page.status === "invalid_content") return { status: "invalid_content" };
        if (page.status === "identity_relocation_unsupported") {
            return { status: "identity_relocation_unsupported" };
        }
        if (!Number.isSafeInteger(participantCount + page.items.length)) {
            return { status: "invalid_content" };
        }
        if (page.items.length > 0) {
            await params.tx.accountEncryptionTransitionCollectionStage.createMany({
                data: page.items.map((item) => ({
                    transitionId: params.transitionId,
                    pluginId: item.pluginId,
                    collectionId: item.collectionId,
                    rowId: item.rowId,
                    sourceRevision: item.revision,
                    sourceEnvelope: toPrismaJson(item.sourceEnvelope),
                    schemaVersion: item.schemaVersion,
                    contractDigest: item.contractDigest,
                    sourceEncodedBytes:
                        measurePluginCollectionAccountEncryptionTransitionContentBytes(
                            item.sourceEnvelope,
                        ),
                })),
            });
        }
        participantCount += page.items.length;
        sourceEncodedBytes += page.sourceContentBytes;
        if (!page.nextCursor) {
            return { status: "complete", participantCount, sourceEncodedBytes };
        }
        cursor = page.nextCursor;
    }
}

function stageMatchesInventoryItem(
    stage: AccountEncryptionTransitionStoredStage,
    item: AccountEncryptionMigrateCollectionInventoryItem,
): boolean {
    return stage.pluginId === item.pluginId
        && stage.collectionId === item.collectionId
        && stage.rowId === item.rowId
        && stage.sourceRevision === item.revision
        && stage.schemaVersion === item.schemaVersion
        && stage.contractDigest === item.contractDigest
        && stage.sourceEncodedBytes
            === measurePluginCollectionAccountEncryptionTransitionContentBytes(
                item.sourceEnvelope,
            )
        && jsonEqual(stage.sourceEnvelope, item.sourceEnvelope);
}

function inventoryItemsFromStages(
    stages: readonly AccountEncryptionTransitionStoredStage[],
): readonly AccountEncryptionMigrateCollectionInventoryItem[] | null {
    const items: AccountEncryptionMigrateCollectionInventoryItem[] = [];
    for (const stage of stages) {
        const source = stage.sourceEnvelope;
        if (
            source === null
            || typeof source !== "object"
            || Array.isArray(source)
        ) {
            return null;
        }
        items.push({
            pluginId: stage.pluginId,
            collectionId: stage.collectionId,
            rowId: stage.rowId,
            revision: stage.sourceRevision,
            sourceEnvelope: source as PluginCollectionContentEnvelopeV1,
            schemaVersion: stage.schemaVersion,
            contractDigest: stage.contractDigest,
        });
    }
    return items;
}

type AccountEncryptionTransitionTerminalStatus = "cancelled" | "expired";

type AccountEncryptionTransitionCloseResult = Readonly<{
    closed: boolean;
    removedStageCount: number;
}>;

/**
 * The Account row serializes every terminal transition path. Cleanup deletes
 * one bounded chunk at a time, but it retains the active lifecycle state until
 * the final staged envelope has gone. A committed cancelled/expired record is
 * therefore always truthful: it has no retained unactivated source or target
 * envelope.
 */
async function closeAccountEncryptionTransitionInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    transitionId: string;
    terminalStatus: AccountEncryptionTransitionTerminalStatus;
    now: Date;
    requireExpired: boolean;
}>): Promise<AccountEncryptionTransitionCloseResult> {
    const fence = await acquireAccountEncryptionTransitionCoordinatorFenceInTx(
        params.tx,
        params.accountId,
    );
    if (fence.status === "account_not_found") {
        return { closed: false, removedStageCount: 0 };
    }
    const stageRows = await params.tx.accountEncryptionTransitionCollectionStage.findMany({
        where: { transitionId: params.transitionId },
        orderBy: { id: "asc" },
        take: ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE.cleanupBatchSize + 1,
        select: { id: true },
    });
    const collectionCleanupIds = stageRows
        .slice(0, ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE.cleanupBatchSize)
        .map((stage) => stage.id);
    let automationCleanupIds: readonly string[] = [];
    let hasMoreStages = stageRows.length > collectionCleanupIds.length;
    if (!hasMoreStages) {
        automationCleanupIds =
            await listAccountEncryptionTransitionAutomationStageIdsForCleanupInTx(
                params.tx,
                params.transitionId,
                ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE.cleanupBatchSize
                    - collectionCleanupIds.length + 1,
            );
        const permitted = Math.max(
            0,
            ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE.cleanupBatchSize
                - collectionCleanupIds.length,
        );
        hasMoreStages = automationCleanupIds.length > permitted;
        automationCleanupIds = automationCleanupIds.slice(0, permitted);
    }
    const removedStageCount =
        collectionCleanupIds.length + automationCleanupIds.length;

    if (hasMoreStages) {
        // This write is the conditional lifecycle claim that makes the
        // following delete safe. It intentionally leaves the record active:
        // callers can make bounded progress on the same expired/cancelled
        // transition until its final content chunk is gone.
        const progress = await params.tx.accountEncryptionTransition.updateMany({
            where: {
                id: params.transitionId,
                accountId: params.accountId,
                status: { in: ["preparing", "authorized"] },
                ...(params.requireExpired
                    ? { expiresAt: { lte: params.now } }
                    : {}),
            },
            data: { updatedAt: params.now },
        });
        if (progress.count !== 1) {
            return { closed: false, removedStageCount: 0 };
        }
        if (collectionCleanupIds.length > 0) {
            await params.tx.accountEncryptionTransitionCollectionStage.deleteMany({
                where: { id: { in: collectionCleanupIds } },
            });
        }
        await deleteAccountEncryptionTransitionAutomationStagesByIdsInTx(
            params.tx,
            automationCleanupIds,
        );
        return { closed: false, removedStageCount };
    }
    const mutation = await params.tx.accountEncryptionTransition.updateMany({
        where: {
            id: params.transitionId,
            accountId: params.accountId,
            status: { in: ["preparing", "authorized"] },
            ...(params.requireExpired
                ? { expiresAt: { lte: params.now } }
                : {}),
        },
        data: {
            status: params.terminalStatus,
            activeAccountId: null,
            ...(params.terminalStatus === "expired"
                ? { expiredAt: params.now }
                : { cancelledAt: params.now }),
        },
    });
    if (mutation.count !== 1) {
        return { closed: false, removedStageCount: 0 };
    }
    if (collectionCleanupIds.length > 0) {
        await params.tx.accountEncryptionTransitionCollectionStage.deleteMany({
            where: { id: { in: collectionCleanupIds } },
        });
    }
    await deleteAccountEncryptionTransitionAutomationStagesByIdsInTx(
        params.tx,
        automationCleanupIds,
    );
    await deleteAccountEncryptionTransitionAutomationStageStateInTx(
        params.tx,
        params.transitionId,
    );
    return { closed: true, removedStageCount };
}

async function expireAccountEncryptionTransitionInTx(
    tx: Tx,
    transitionId: string,
    now: Date,
): Promise<AccountEncryptionTransitionCloseResult> {
    const transition = await tx.accountEncryptionTransition.findUnique({
        where: { id: transitionId },
        select: { accountId: true },
    });
    if (!transition) return { closed: false, removedStageCount: 0 };
    return await closeAccountEncryptionTransitionInTx({
        tx,
        accountId: transition.accountId,
        transitionId,
        now,
        terminalStatus: "expired",
        requireExpired: true,
    });
}

async function abandonAccountEncryptionTransitionInTx(
    tx: Tx,
    transitionId: string,
    now: Date,
): Promise<AccountEncryptionTransitionCloseResult> {
    const transition = await tx.accountEncryptionTransition.findUnique({
        where: { id: transitionId },
        select: { accountId: true },
    });
    if (!transition) return { closed: false, removedStageCount: 0 };
    return await closeAccountEncryptionTransitionInTx({
        tx,
        accountId: transition.accountId,
        transitionId,
        now,
        terminalStatus: "cancelled",
        requireExpired: false,
    });
}

/**
 * Retires expired stages in bounded units. Terminal transition records remain
 * as audit facts; only unactivated target-stage data is removed.
 */
export async function cleanupExpiredAccountEncryptionTransitionsInTx(
    params: Readonly<{ tx: Tx; now?: Date; accountId?: string }>,
): Promise<Readonly<{ expiredTransitionCount: number; removedStageCount: number }>> {
    const now = resolveTransitionNow(params.now);
    // Process the earliest eligible transition only. Repeated cleanup calls
    // make bounded progress on it before a later terminal record is touched.
    const expired = await params.tx.accountEncryptionTransition.findFirst({
        where: {
            status: { in: ["preparing", "authorized"] },
            expiresAt: { lte: now },
            ...(params.accountId ? { accountId: params.accountId } : {}),
        },
        orderBy: { expiresAt: "asc" },
        select: { id: true },
    });
    if (!expired) {
        return { expiredTransitionCount: 0, removedStageCount: 0 };
    }
    const result = await expireAccountEncryptionTransitionInTx(
        params.tx,
        expired.id,
        now,
    );
    return {
        expiredTransitionCount: result.closed ? 1 : 0,
        removedStageCount: result.removedStageCount,
    };
}

/**
 * Process one bounded expiry chunk through the shared server transaction
 * owner. The incumbent worker lifecycle calls this on startup and interval;
 * this function itself owns no timer, cursor, or secondary cleanup state.
 */
export async function cleanupExpiredAccountEncryptionTransitions(): Promise<
    Readonly<{ expiredTransitionCount: number; removedStageCount: number }>
> {
    return await inTx(async (tx) => (
        await cleanupExpiredAccountEncryptionTransitionsInTx({ tx })
    ));
}

/**
 * Starts one Account-owned transition with source and target facts only.
 * E2EE → plain must not inspect or retain source payloads until the user has
 * confirmed that downgrade; authorization owns the later source census and
 * exact staged inventory.
 */
export async function prepareAccountEncryptionTransitionCoordinatorInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        request: AccountEncryptionMigrateTransitionPrepareRequest;
        now?: Date;
    }>,
): Promise<AccountEncryptionTransitionPrepareCoordinatorResult> {
    const now = resolveTransitionNow(params.now);
    await cleanupExpiredAccountEncryptionTransitionsInTx({
        tx: params.tx,
        now,
    });
    const fence = await acquireAccountEncryptionTransitionCoordinatorFenceInTx(
        params.tx,
        params.accountId,
    );
    if (fence.status === "account_not_found") return { status: "account_not_found" };
    if (fence.status === "account_inconsistent") return { status: "account_inconsistent" };
    const fromMode = fence.account.currentness.encryptionMode;
    if (
        params.request.toMode === fromMode
        || params.request.expectedAccountVersion !== fence.account.version
        || params.request.expectedSigningKeyFingerprint
            !== fence.account.signingKeyFingerprint
        || params.request.expectedContentKeyFingerprint
            !== fence.account.contentKeyFingerprint
    ) {
        return { status: "source_mismatch" };
    }
    let active = await params.tx.accountEncryptionTransition.findFirst({
        where: { activeAccountId: params.accountId },
        select: accountEncryptionTransitionSelect,
    });
    // The bounded global cleanup may have spent its one chunk on an older
    // account. Never rejoin an expired active record merely because it was
    // not that chunk: retire this Account's record before deciding whether a
    // retry is an exact prepare replay. If its staged envelope needs another
    // bounded scrub, it remains the one active owner and reports in progress.
    if (active && isExpired(active, now)) {
        const expired = await expireAccountEncryptionTransitionInTx(
            params.tx,
            active.id,
            now,
        );
        if (!expired.closed) return { status: "transition_in_progress" };
        active = null;
    }
    if (active) {
        const source = sourceFactsFromTransition(active);
        if (
            source
            && transitionMatchesPrepareRequest(active, params.request)
        ) {
            return {
                status: "prepared",
                transition: source,
                expiresAt: active.expiresAt.getTime(),
            };
        }
        return { status: "transition_in_progress" };
    }

    const transitionId = randomUUID();
    const expiresAt = new Date(
        now.getTime() + ACCOUNT_ENCRYPTION_TRANSITION_LIFECYCLE.lifetimeMs,
    );
    await params.tx.accountEncryptionTransition.create({
        data: {
            id: transitionId,
            accountId: params.accountId,
            fromEncryptionMode: fromMode,
            toEncryptionMode: params.request.toMode,
            sourceAccountVersion: fence.account.version,
            sourceSettingsVersion: fence.account.settingsVersion,
            sourceSigningKeyFingerprint: fence.account.signingKeyFingerprint,
            sourceContentKeyFingerprint: fence.account.contentKeyFingerprint,
            targetSigningKeyFingerprint: null,
            targetContentKeyFingerprint: null,
            targetAccountPublicKey: null,
            targetContentPublicKey: null,
            targetContentPublicKeySig: null,
            status: "preparing",
            activeAccountId: params.accountId,
            preparedAt: now,
            expiresAt,
            censusParticipantCount: 0,
            censusSourceBytes: 0n,
            censusTargetBytes: 0n,
            stagedParticipantCount: 0,
            stagedSourceBytes: 0n,
            stagedTargetBytes: 0n,
            // No source-controlled transport value is an aggregate capacity.
            // These three come from the recorded offline PEP1 measurement,
            // derived through this owner's single capacity derivation, and are
            // stamped on the transition so every later fence reads the exact
            // bounds this transition was admitted under.
            reservedCapacityBytes:
                ACCOUNT_ENCRYPTION_TRANSITION_MEASURED_CAPACITY.reservedCapacityBytes,
            measuredParticipantLimit:
                ACCOUNT_ENCRYPTION_TRANSITION_MEASURED_CAPACITY.participantLimit,
            measuredEncodedByteLimit:
                ACCOUNT_ENCRYPTION_TRANSITION_MEASURED_CAPACITY.encodedByteLimit,
        },
    });
    return {
        status: "prepared",
        transition: {
            transitionId,
            fromMode,
            toMode: params.request.toMode,
            expectedAccountVersion: fence.account.version,
            expectedSigningKeyFingerprint: fence.account.signingKeyFingerprint,
            expectedContentKeyFingerprint: fence.account.contentKeyFingerprint,
        },
        expiresAt: expiresAt.getTime(),
    };
}

type AccountEncryptionTransitionAutomationSourceCensus =
    | Readonly<{
        status: "complete";
        participantCount: number;
        runCount: number;
        sourceEncodedBytes: bigint;
    }>
    | Readonly<{ status: "invalid_content" }>;

async function inspectAutomationSourceCensusInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    sourceMode: AccountEncryptionTransitionMode;
}>): Promise<AccountEncryptionTransitionAutomationSourceCensus> {
    let cursor: AutomationAccountEncryptionTransitionSourceCursor | undefined;
    let participantCount = 0;
    let runCount = 0;
    let sourceEncodedBytes = 0n;
    for (;;) {
        const inspected = await inspectAutomationAccountEncryptionTransitionInTx({
            tx: params.tx,
            accountId: params.accountId,
            sourceMode: params.sourceMode,
            ...(cursor ? { cursor } : {}),
        });
        if (inspected.status !== "complete") return inspected;
        if (!Number.isSafeInteger(participantCount + inspected.page.items.length)) {
            return { status: "invalid_content" };
        }
        if (!Number.isSafeInteger(runCount + inspected.page.runCount)) {
            return { status: "invalid_content" };
        }
        participantCount += inspected.page.items.length;
        runCount += inspected.page.runCount;
        sourceEncodedBytes += inspected.page.sourceEncodedBytes;
        if (!inspected.page.nextCursor) {
            return {
                status: "complete",
                participantCount,
                runCount,
                sourceEncodedBytes,
            };
        }
        cursor = inspected.page.nextCursor;
    }
}

type AccountEncryptionTransitionCurrentAutomationCensus =
    | Readonly<{
        status: "complete";
        state: NonNullable<Awaited<ReturnType<
            typeof readAccountEncryptionTransitionAutomationStageStateInTx
        >>>;
    }>
    | Readonly<{
        status: "source_mismatch" | "migration_incomplete" | "invalid_content";
    }>;

/**
 * Proves that the durable Automation source stage is still exactly the live
 * closed Definition/Run census. It deliberately walks both inputs in the
 * same 500-item ordering rather than materializing a 10,000-Run array.
 */
async function validateCurrentAutomationTransitionCensusInTx(
    tx: Tx,
    accountId: string,
    transition: Readonly<{
        id: string;
        accountId: string;
        fromEncryptionMode: string;
        sourceAccountVersion: number;
        sourceSettingsVersion: number;
        sourceSigningKeyFingerprint: string | null;
        sourceContentKeyFingerprint: string | null;
    }>,
): Promise<AccountEncryptionTransitionCurrentAutomationCensus> {
    const fence = await acquireAccountEncryptionTransitionCoordinatorFenceInTx(
        tx,
        accountId,
    );
    if (!transitionSourceMatchesFence(fence, transition)) {
        return { status: "source_mismatch" };
    }
    if (!isTransitionMode(transition.fromEncryptionMode)) {
        return { status: "invalid_content" };
    }
    const state = await readAccountEncryptionTransitionAutomationStageStateInTx(
        tx,
        transition.id,
    );
    if (!state) return { status: "migration_incomplete" };
    let sourceCursor: AutomationAccountEncryptionTransitionSourceCursor | undefined;
    let stageCursor: AccountEncryptionTransitionAutomationStageCursor | undefined;
    let participantCount = 0;
    let runCount = 0;
    let sourceEncodedBytes = 0n;
    for (;;) {
        const sourcePage = await inspectAutomationAccountEncryptionTransitionInTx({
            tx,
            accountId,
            sourceMode: transition.fromEncryptionMode,
            ...(sourceCursor ? { cursor: sourceCursor } : {}),
        });
        if (sourcePage.status !== "complete") return sourcePage;
        const stagedPage = await readAccountEncryptionTransitionAutomationStagePageInTx({
            tx,
            transitionId: transition.id,
            ...(stageCursor ? { cursor: stageCursor } : {}),
        });
        if (!stagedPage || sourcePage.page.items.length !== stagedPage.stages.length) {
            return { status: "migration_incomplete" };
        }
        if (!Number.isSafeInteger(participantCount + sourcePage.page.items.length)) {
            return { status: "invalid_content" };
        }
        if (!Number.isSafeInteger(runCount + sourcePage.page.runCount)) {
            return { status: "invalid_content" };
        }
        if (!sourcePage.page.items.every((item, index) => {
            const stage = stagedPage.stages[index];
            const stagedSource = stage
                ? sourceItemFromAccountEncryptionTransitionAutomationStage(stage)
                : null;
            return stage !== undefined
                && stagedSource !== null
                && stage.sourceEncodedBytes
                    === measureAccountEncryptionTransitionAutomationSourceItemBytes(item)
                && jsonEqual(stagedSource, item);
        })) {
            return { status: "migration_incomplete" };
        }
        participantCount += sourcePage.page.items.length;
        runCount += sourcePage.page.runCount;
        sourceEncodedBytes += sourcePage.page.sourceEncodedBytes;
        const sourceHasMore = sourcePage.page.nextCursor !== undefined;
        const stageHasMore = stagedPage.nextCursor !== undefined;
        if (sourceHasMore !== stageHasMore) {
            return { status: "migration_incomplete" };
        }
        if (!sourceHasMore) {
            return (
                state.sourceParticipantCount === participantCount
                && state.sourceRunCount === runCount
                && state.sourceEncodedBytes === sourceEncodedBytes
            )
                ? { status: "complete", state }
                : { status: "migration_incomplete" };
        }
        sourceCursor = sourcePage.page.nextCursor;
        stageCursor = stagedPage.nextCursor;
    }
}

function aggregateTransitionSourceMatches(
    transition: Readonly<{
        censusParticipantCount: number;
        censusSourceBytes: bigint;
    }>,
    collections: Extract<AccountEncryptionTransitionCollectionCensus, { status: "complete" }>,
    automations: NonNullable<Awaited<ReturnType<
        typeof readAccountEncryptionTransitionAutomationStageStateInTx
    >>>,
): boolean {
    const participantCount =
        collections.participantCount + automations.sourceParticipantCount;
    return Number.isSafeInteger(participantCount)
        && transition.censusParticipantCount === participantCount
        && transition.censusSourceBytes
            === collections.sourceEncodedBytes + automations.sourceEncodedBytes;
}

type AccountEncryptionTransitionStagedParticipantStatistics = Readonly<{
    participantCount: number;
    sourceBytes: bigint;
    targetBytes: bigint;
}>;

function stagedCollectionStatistics(
    stages: readonly AccountEncryptionTransitionStoredStage[],
): AccountEncryptionTransitionStagedParticipantStatistics | null {
    let participantCount = 0;
    let sourceBytes = 0n;
    let targetBytes = 0n;
    for (const stage of stages) {
        if (stage.targetEnvelope === null || stage.targetEncodedBytes === null) continue;
        if (stage.targetEncodedBytes < 0n || stage.sourceEncodedBytes < 0n) return null;
        participantCount += 1;
        sourceBytes += stage.sourceEncodedBytes;
        targetBytes += stage.targetEncodedBytes;
    }
    return Number.isSafeInteger(participantCount)
        ? { participantCount, sourceBytes, targetBytes }
        : null;
}

function aggregateStagedStatistics(
    collections: AccountEncryptionTransitionStagedParticipantStatistics,
    automations: NonNullable<Awaited<ReturnType<
        typeof readAccountEncryptionTransitionAutomationStageStateInTx
    >>>,
): AccountEncryptionTransitionStagedParticipantStatistics | null {
    const participantCount =
        collections.participantCount + automations.stagedParticipantCount;
    if (!Number.isSafeInteger(participantCount)) return null;
    return {
        participantCount,
        sourceBytes: collections.sourceBytes + automations.stagedSourceBytes,
        targetBytes: collections.targetBytes + automations.stagedTargetBytes,
    };
}

/**
 * Completes the post-authorization complete closed-participant source census
 * before the first source stage is written. The Account owner—not either
 * participant—combines the exact Collection/Automation totals and applies its
 * measured aggregate reserve. The fixed PEP2 Run ceiling is separately
 * checked before any source content is retained.
 */
async function stageAuthorizedParticipantSourceCensusInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    transition: Readonly<{
        id: string;
        fromEncryptionMode: string;
        measuredParticipantLimit: number | null;
        measuredEncodedByteLimit: bigint | null;
        reservedCapacityBytes: bigint;
    }>;
    now: Date;
}>): Promise<
    | Readonly<{ status: "authorized" }>
    | Readonly<{
        status:
            | "migration_too_large"
            | "invalid_content"
            | "identity_relocation_unsupported";
    }>
> {
    if (!isTransitionMode(params.transition.fromEncryptionMode)) {
        await abandonAccountEncryptionTransitionInTx(
            params.tx,
            params.transition.id,
            params.now,
        );
        return { status: "invalid_content" };
    }
    const sourceCensus = await inspectPluginCollectionSourceCensusInTx({
        tx: params.tx,
        accountId: params.accountId,
        sourceMode: params.transition.fromEncryptionMode,
    });
    if (sourceCensus.status !== "complete") {
        await abandonAccountEncryptionTransitionInTx(
            params.tx,
            params.transition.id,
            params.now,
        );
        return sourceCensus;
    }
    const automationSourceCensus = await inspectAutomationSourceCensusInTx({
        tx: params.tx,
        accountId: params.accountId,
        sourceMode: params.transition.fromEncryptionMode,
    });
    if (automationSourceCensus.status !== "complete") {
        await abandonAccountEncryptionTransitionInTx(
            params.tx,
            params.transition.id,
            params.now,
        );
        return automationSourceCensus;
    }
    const participantCount =
        sourceCensus.participantCount + automationSourceCensus.participantCount;
    const sourceEncodedBytes =
        sourceCensus.sourceEncodedBytes + automationSourceCensus.sourceEncodedBytes;
    if (
        !Number.isSafeInteger(participantCount)
        || automationSourceCensus.runCount
            > ACCOUNT_ENCRYPTION_TRANSITION_AUTOMATION_RUN_MAX_PARTICIPANTS
    ) {
        await abandonAccountEncryptionTransitionInTx(
            params.tx,
            params.transition.id,
            params.now,
        );
        return { status: "migration_too_large" };
    }
    const capacity = measuredCapacityFromTransition(params.transition);
    if (
        participantCount > 0
        && (
            !capacity
            || participantCount > capacity.participantLimit
            || sourceEncodedBytes > capacity.encodedByteLimit
            || sourceEncodedBytes > capacity.reservedCapacityBytes
        )
    ) {
        // This precedes every source-stage write, so an over-capacity census
        // cannot leave a partial source payload reservation behind.
        await abandonAccountEncryptionTransitionInTx(
            params.tx,
            params.transition.id,
            params.now,
        );
        return { status: "migration_too_large" };
    }
    const stagedSource = await stagePluginCollectionSourceCensusInTx({
        tx: params.tx,
        transitionId: params.transition.id,
        accountId: params.accountId,
        sourceMode: params.transition.fromEncryptionMode,
    });
    if (
        stagedSource.status !== "complete"
        || stagedSource.participantCount !== sourceCensus.participantCount
        || stagedSource.sourceEncodedBytes !== sourceCensus.sourceEncodedBytes
    ) {
        await abandonAccountEncryptionTransitionInTx(
            params.tx,
            params.transition.id,
            params.now,
        );
        return { status: "invalid_content" };
    }
    const stagedAutomationSource =
        await stageAccountEncryptionTransitionAutomationSourceCensusInTx({
            tx: params.tx,
            accountId: params.accountId,
            transitionId: params.transition.id,
            sourceMode: params.transition.fromEncryptionMode,
        });
    if (
        stagedAutomationSource.status !== "complete"
        || stagedAutomationSource.state.sourceParticipantCount
            !== automationSourceCensus.participantCount
        || stagedAutomationSource.state.sourceRunCount
            !== automationSourceCensus.runCount
        || stagedAutomationSource.state.sourceEncodedBytes
            !== automationSourceCensus.sourceEncodedBytes
    ) {
        await abandonAccountEncryptionTransitionInTx(
            params.tx,
            params.transition.id,
            params.now,
        );
        return { status: "invalid_content" };
    }
    await params.tx.accountEncryptionTransition.update({
        where: { id: params.transition.id },
        data: {
            censusParticipantCount: participantCount,
            censusSourceBytes: sourceEncodedBytes,
            censusTargetBytes: 0n,
            stagedParticipantCount: 0,
            stagedSourceBytes: 0n,
            stagedTargetBytes: 0n,
        },
    });
    return { status: "authorized" };
}

/**
 * Persists the authorization that permits source inventory and target staging.
 * Routes verify external boundary proofs first, then pass only the verified
 * public key binding here; the coordinator owns the resulting target custody.
 */
export async function authorizeAccountEncryptionTransitionCoordinatorInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        transitionId: string;
        authorization: AccountEncryptionTransitionAuthorization;
        now?: Date;
    }>,
): Promise<AccountEncryptionTransitionAuthorizeCoordinatorResult> {
    const now = resolveTransitionNow(params.now);
    const transition = await readAccountEncryptionTransitionInTx(
        params.tx,
        params.accountId,
        params.transitionId,
    );
    if (!transition) return { status: "transition_not_found" };
    if (isExpired(transition, now)) {
        await expireAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "transition_expired" };
    }
    if (transition.status === "authorized") {
        return { status: "authorized" };
    }
    if (transition.status !== "preparing") {
        return { status: "transition_not_authorizable" };
    }
    const fence = await acquireAccountEncryptionTransitionCoordinatorFenceInTx(
        params.tx,
        params.accountId,
    );
    if (!transitionSourceMatchesFence(fence, transition)) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "source_mismatch" };
    }
    const source = sourceFactsFromTransition(transition);
    if (!source) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "invalid_authorization" };
    }

    if (source.fromMode === "e2ee" && source.toMode === "plain") {
        if (params.authorization.kind !== "present_user_confirmation") {
            return { status: "invalid_authorization" };
        }
        await params.tx.accountEncryptionTransition.update({
            where: { id: transition.id },
            data: { status: "authorized", authorizedAt: now },
        });
        return await stageAuthorizedParticipantSourceCensusInTx({
            tx: params.tx,
            accountId: params.accountId,
            transition,
            now,
        });
    }

    if (
        source.fromMode !== "plain"
        || source.toMode !== "e2ee"
        || params.authorization.kind !== "first_key"
        || fence.status !== "ready"
        || !/^[0-9a-f]{64}$/iu.test(params.authorization.accountPublicKeyHex)
    ) {
        return { status: "invalid_authorization" };
    }
    const signingKey = new Uint8Array(
        Buffer.from(params.authorization.accountPublicKeyHex, "hex"),
    );
    const signingKeyFingerprint =
        computeAccountEncryptionMigrateKeyFingerprintV1(signingKey);
    const verifiedBinding = verifyAccountContentKeyBindingForAccountPublicKey({
        accountPublicKeyHex: params.authorization.accountPublicKeyHex,
        contentPublicKey: params.authorization.binding.contentPublicKey,
        contentPublicKeySignature:
            params.authorization.binding.contentPublicKeySignature,
    });
    const contentKeyFingerprint = verifiedBinding
        ? computeAccountEncryptionMigrateKeyFingerprintV1(
            verifiedBinding.contentPublicKey,
        )
        : null;
    if (
        !verifiedBinding
        || !contentKeyFingerprint
        || signingKeyFingerprint !== params.authorization.signingKeyFingerprint
    ) {
        return { status: "invalid_authorization" };
    }
    const retainedPublicKey = fence.account.publicKey;
    const retainedContentKey = fence.account.currentness.contentPublicKey;
    const retainedContentKeySignature =
        fence.account.currentness.contentPublicKeySignature;
    const isKeyless = retainedPublicKey === null
        && retainedContentKey === null
        && retainedContentKeySignature === null;
    const hasCompleteRetainedBinding = retainedPublicKey !== null
        && retainedContentKey !== null
        && retainedContentKeySignature !== null;
    if (!isKeyless && !hasCompleteRetainedBinding) {
        // Plain Accounts may legitimately be keyless, and a prior e2ee →
        // plain transition may retain one complete public binding. Any
        // partial legacy state is neither and cannot be reinterpreted here.
        return { status: "invalid_authorization" };
    }
    const targetAccountPublicKey = isKeyless
        ? params.authorization.accountPublicKeyHex
        : retainedPublicKey!;
    if (
        hasCompleteRetainedBinding
        && (
            targetAccountPublicKey.toLowerCase()
                !== params.authorization.accountPublicKeyHex.toLowerCase()
            || !bytesEqual(retainedContentKey!, verifiedBinding.contentPublicKey)
            || !bytesEqual(
                retainedContentKeySignature!,
                verifiedBinding.contentPublicKeySignature,
            )
            || fence.account.signingKeyFingerprint !== signingKeyFingerprint
            || fence.account.contentKeyFingerprint !== contentKeyFingerprint
        )
    ) {
        // Rekeying is not an authorization replay. Restoring a pinned plain
        // Account must re-use the exact stored public binding.
        return { status: "invalid_authorization" };
    }
    await params.tx.accountEncryptionTransition.update({
        where: { id: transition.id },
        data: {
            targetSigningKeyFingerprint: signingKeyFingerprint,
            targetContentKeyFingerprint: contentKeyFingerprint,
            targetAccountPublicKey,
            targetContentPublicKey: verifiedBinding.contentPublicKey,
            targetContentPublicKeySig:
                verifiedBinding.contentPublicKeySignature,
            status: "authorized",
            authorizedAt: now,
        },
    });
    return await stageAuthorizedParticipantSourceCensusInTx({
        tx: params.tx,
        accountId: params.accountId,
        transition,
        now,
    });
}

/**
 * Reads the server-created first-key proof binding only while the transition
 * remains authorizable. This is deliberately not a general stage reader: the
 * staged source and target bytes stay private to the Account coordinator.
 */
export async function readAccountEncryptionTransitionAuthorizationPreparationInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        transitionId: string;
        now?: Date;
    }>,
): Promise<AccountEncryptionTransitionAuthorizationPreparationResult> {
    const now = resolveTransitionNow(params.now);
    const transition = await readAccountEncryptionTransitionInTx(
        params.tx,
        params.accountId,
        params.transitionId,
    );
    if (!transition) return { status: "transition_not_found" };
    if (isExpired(transition, now)) {
        await expireAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "transition_expired" };
    }
    if (transition.status === "authorized") return { status: "authorized" };
    if (transition.status !== "preparing") {
        return { status: "transition_not_authorizable" };
    }
    const fence = await acquireAccountEncryptionTransitionCoordinatorFenceInTx(
        params.tx,
        params.accountId,
    );
    if (!transitionSourceMatchesFence(fence, transition)) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "source_mismatch" };
    }
    const source = sourceFactsFromTransition(transition);
    if (!source) return { status: "transition_not_authorizable" };
    return {
        status: "ready",
        prepared: {
            transitionId: source.transitionId,
            fromMode: source.fromMode,
            toMode: source.toMode,
            expectedAccountVersion: source.expectedAccountVersion,
            expectedSigningKeyFingerprint:
                source.expectedSigningKeyFingerprint,
            expectedContentKeyFingerprint:
                source.expectedContentKeyFingerprint,
        },
    };
}

/**
 * Re-census source and persisted stage facts in matching 500-row keyset
 * pages. Inventory itself must remain paged even when no aggregate capacity
 * is available, so this verifier cannot materialize an Account-wide source
 * array merely to prove currentness.
 */
async function validateCurrentTransitionCensusInTx(
    tx: Tx,
    accountId: string,
    transition: Readonly<{
        id: string;
        accountId: string;
        fromEncryptionMode: string;
        sourceAccountVersion: number;
        sourceSettingsVersion: number;
        sourceSigningKeyFingerprint: string | null;
        sourceContentKeyFingerprint: string | null;
        censusParticipantCount: number;
        censusSourceBytes: bigint;
    }>,
): Promise<
    | AccountEncryptionTransitionCollectionCensus
    | Readonly<{ status: "source_mismatch" }>
> {
    const fence = await acquireAccountEncryptionTransitionCoordinatorFenceInTx(
        tx,
        accountId,
    );
    if (!transitionSourceMatchesFence(fence, transition)) {
        return { status: "source_mismatch" };
    }
    if (!isTransitionMode(transition.fromEncryptionMode)) {
        return { status: "invalid_content" };
    }
    let participantCount = 0;
    let sourceEncodedBytes = 0n;
    let sourceCursor: AccountEncryptionTransitionStageIdentity | undefined;
    let stageCursor: AccountEncryptionTransitionStageIdentity | undefined;
    for (;;) {
        const sourcePage = await inspectPluginCollectionAccountEncryptionTransitionInTx({
            tx,
            accountId,
            sourceMode: transition.fromEncryptionMode,
            ...(sourceCursor ? { cursor: sourceCursor } : {}),
        });
        if (sourcePage.status === "invalid_content") {
            return { status: "invalid_content" };
        }
        if (sourcePage.status === "identity_relocation_unsupported") {
            return { status: "identity_relocation_unsupported" };
        }
        const stagedPage = await readAccountEncryptionTransitionInventoryPageInTx({
            tx,
            transitionId: transition.id,
            ...(stageCursor ? { cursor: stageCursor } : {}),
        });
        if (sourcePage.items.length !== stagedPage.stages.length) {
            return { status: "migration_incomplete" };
        }
        if (!Number.isSafeInteger(participantCount + sourcePage.items.length)) {
            return { status: "invalid_content" };
        }
        if (!sourcePage.items.every((item, index) => {
            const stage = stagedPage.stages[index];
            return stage !== undefined && stageMatchesInventoryItem(stage, item);
        })) {
            return { status: "migration_incomplete" };
        }
        participantCount += sourcePage.items.length;
        sourceEncodedBytes += sourcePage.sourceContentBytes;
        const sourceHasMore = sourcePage.nextCursor !== undefined;
        const stageHasMore = stagedPage.nextCursor !== undefined;
        if (sourceHasMore !== stageHasMore) {
            return { status: "migration_incomplete" };
        }
        if (!sourceHasMore) {
            return { status: "complete", participantCount, sourceEncodedBytes };
        }
        sourceCursor = sourcePage.nextCursor;
        stageCursor = stagedPage.nextCursor;
    }
}

async function resolveCurrentTransitionCensusInTx(
    tx: Tx,
    accountId: string,
    transition: Readonly<{
        id: string;
        accountId: string;
        fromEncryptionMode: string;
        sourceAccountVersion: number;
        sourceSettingsVersion: number;
        sourceSigningKeyFingerprint: string | null;
        sourceContentKeyFingerprint: string | null;
        censusParticipantCount: number;
        censusSourceBytes: bigint;
    }>,
): Promise<
    | Readonly<{
        status: "complete";
        stages: readonly AccountEncryptionTransitionStoredStage[];
        census: Extract<AccountEncryptionTransitionCollectionCensus, { status: "complete" }>;
    }>
    | Readonly<{
        status:
            | "source_mismatch"
            | "migration_incomplete"
            | "invalid_content"
            | "identity_relocation_unsupported";
    }>
> {
    const census = await validateCurrentTransitionCensusInTx(tx, accountId, transition);
    if (census.status !== "complete") return census;
    const stages = await readAccountEncryptionTransitionStagesInTx(tx, transition.id);
    return { status: "complete", stages, census };
}

/** Returns the persisted exact source inventory after authorization. */
export async function inventoryAccountEncryptionTransitionCoordinatorInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        transitionId: string;
        cursor?: string;
        now?: Date;
    }>,
): Promise<AccountEncryptionTransitionInventoryCoordinatorResult> {
    const now = resolveTransitionNow(params.now);
    const transition = await readAccountEncryptionTransitionInTx(
        params.tx,
        params.accountId,
        params.transitionId,
    );
    if (!transition) return { status: "transition_not_found" };
    if (isExpired(transition, now)) {
        await expireAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "transition_expired" };
    }
    if (transition.status !== "authorized") return { status: "transition_not_ready" };
    const decodedCursor = params.cursor
        ? decodeAccountEncryptionTransitionInventoryCursor(params.cursor)
        : undefined;
    if (
        (params.cursor && !decodedCursor)
        || (decodedCursor && decodedCursor.transitionId !== transition.id)
    ) {
        return { status: "invalid_cursor" };
    }
    const current = await validateCurrentTransitionCensusInTx(
        params.tx,
        params.accountId,
        transition,
    );
    if (current.status !== "complete") {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return current;
    }
    const automations = await validateCurrentAutomationTransitionCensusInTx(
        params.tx,
        params.accountId,
        transition,
    );
    if (automations.status !== "complete") {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return automations;
    }
    if (!aggregateTransitionSourceMatches(transition, current, automations.state)) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "migration_incomplete" };
    }
    const page = await readAccountEncryptionTransitionInventoryPageInTx({
        tx: params.tx,
        transitionId: transition.id,
        ...(decodedCursor ? { cursor: decodedCursor.after } : {}),
    });
    const items = inventoryItemsFromStages(page.stages);
    if (!items) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "invalid_content" };
    }
    return {
        status: "ready",
        items,
        ...(page.nextCursor
            ? {
                nextCursor: encodeAccountEncryptionTransitionInventoryCursor({
                    v: 1,
                    transitionId: transition.id,
                    after: page.nextCursor,
                }),
            }
            : {}),
    };
}

/**
 * Returns only the persisted, source-bound Automation inventory. The V5 HTTP
 * route remains fail-closed, but this coordinator seam keeps future serving
 * from rebuilding a second Automation census or reading live targets.
 */
export async function inventoryAccountEncryptionTransitionAutomationsCoordinatorInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        transitionId: string;
        cursor?: string;
        now?: Date;
    }>,
): Promise<AccountEncryptionTransitionAutomationInventoryCoordinatorResult> {
    const now = resolveTransitionNow(params.now);
    const transition = await readAccountEncryptionTransitionInTx(
        params.tx,
        params.accountId,
        params.transitionId,
    );
    if (!transition) return { status: "transition_not_found" };
    if (isExpired(transition, now)) {
        await expireAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "transition_expired" };
    }
    if (transition.status !== "authorized") return { status: "transition_not_ready" };
    const decodedCursor = params.cursor
        ? decodeAccountEncryptionTransitionAutomationInventoryCursor(params.cursor)
        : undefined;
    if (
        (params.cursor && !decodedCursor)
        || (decodedCursor && decodedCursor.transitionId !== transition.id)
    ) {
        return { status: "invalid_cursor" };
    }
    const [collections, automations] = await Promise.all([
        resolveCurrentTransitionCensusInTx(params.tx, params.accountId, transition),
        validateCurrentAutomationTransitionCensusInTx(
            params.tx,
            params.accountId,
            transition,
        ),
    ]);
    if (collections.status !== "complete") {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return collections;
    }
    if (automations.status !== "complete") {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return automations;
    }
    if (!aggregateTransitionSourceMatches(transition, collections.census, automations.state)) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "migration_incomplete" };
    }
    const page = await readAccountEncryptionTransitionAutomationStagePageInTx({
        tx: params.tx,
        transitionId: transition.id,
        ...(decodedCursor ? { cursor: decodedCursor.after } : {}),
    });
    if (!page) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "invalid_content" };
    }
    const items: AutomationAccountEncryptionTransitionInventoryItem[] = [];
    for (const stage of page.stages) {
        const item = sourceItemFromAccountEncryptionTransitionAutomationStage(stage);
        if (!item) {
            await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
            return { status: "invalid_content" };
        }
        items.push(item);
    }
    return {
        status: "ready",
        items,
        ...(page.nextCursor
            ? {
                nextCursor: encodeAccountEncryptionTransitionAutomationInventoryCursor({
                    v: 1,
                    transitionId: transition.id,
                    after: page.nextCursor,
                }),
            }
            : {}),
    };
}

/**
 * Saves only validated candidate targets for the complete authorized census.
 * An identical replay is a no-op; a different target for the same source fact
 * is a conflict. Aggregate target/capacity checks happen before any stage
 * write.
 */
export async function stageAccountEncryptionTransitionCollectionsCoordinatorInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        transitionId: string;
        items: readonly AccountEncryptionMigrateCollectionStageItem[];
        now?: Date;
    }>,
): Promise<AccountEncryptionTransitionStageCoordinatorResult> {
    const now = resolveTransitionNow(params.now);
    if (params.items.length === 0) return { status: "invalid_content" };
    const transition = await readAccountEncryptionTransitionInTx(
        params.tx,
        params.accountId,
        params.transitionId,
    );
    if (!transition) return { status: "transition_not_found" };
    if (isExpired(transition, now)) {
        await expireAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "transition_expired" };
    }
    if (transition.status !== "authorized") return { status: "transition_not_ready" };
    const capacity = measuredCapacityFromTransition(transition);
    // Fail before validation or a stage-row mutation when the aggregate
    // provider capacity has not been measured. The protocol's page and batch
    // bounds are deliberately not a substitute for this fact.
    if (!capacity) return { status: "migration_too_large" };
    const current = await resolveCurrentTransitionCensusInTx(
        params.tx,
        params.accountId,
        transition,
    );
    if (current.status !== "complete") {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return current;
    }
    const automations = await validateCurrentAutomationTransitionCensusInTx(
        params.tx,
        params.accountId,
        transition,
    );
    if (automations.status !== "complete") {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return automations;
    }
    if (!aggregateTransitionSourceMatches(transition, current.census, automations.state)) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "migration_incomplete" };
    }
    // A stage request is only one transport batch. Reject the complete source
    // census before accepting its first target when the Account-owned
    // provider measurement cannot ever activate that census.
    if (
        transition.censusParticipantCount > capacity.participantLimit
        || transition.censusSourceBytes > capacity.encodedByteLimit
        || transition.censusSourceBytes > transition.reservedCapacityBytes
        || automations.state.sourceRunCount
            > ACCOUNT_ENCRYPTION_TRANSITION_AUTOMATION_RUN_MAX_PARTICIPANTS
    ) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "migration_too_large" };
    }
    const source = sourceFactsFromTransition(transition);
    if (!source) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "invalid_content" };
    }
    const stagesByIdentity = new Map(
        current.stages.map((stage) => [stageIdentityKey(stage), stage] as const),
    );
    if (new Set(params.items.map(stageIdentityKey)).size !== params.items.length) {
        return { status: "migration_incomplete" };
    }
    for (const item of params.items) {
        const stage = stagesByIdentity.get(stageIdentityKey(item));
        if (
            !stage
            || item.expectedRevision !== stage.sourceRevision
            || item.schemaVersion !== stage.schemaVersion
            || item.contractDigest !== stage.contractDigest
            || !jsonEqual(item.sourceEnvelope, stage.sourceEnvelope)
        ) {
            await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
            return { status: "migration_incomplete" };
        }
    }
    const validated = await validatePluginCollectionAccountEncryptionTransitionStageInTx({
        tx: params.tx,
        accountId: params.accountId,
        fromMode: source.fromMode,
        toMode: source.toMode,
        limits: {
            participantLimit: capacity.participantLimit,
            encodedByteLimit: capacity.encodedByteLimit,
        },
        items: params.items,
    });
    if (validated.status === "migration_incomplete") {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "migration_incomplete" };
    }
    if (validated.status === "invalid_content") return { status: "invalid_content" };
    if (validated.status === "identity_relocation_unsupported") {
        return { status: "identity_relocation_unsupported" };
    }
    const validatedByIdentity = new Map(
        validated.items.map((candidate) => [
            stageIdentityKey(candidate.item),
            candidate,
        ] as const),
    );
    for (const candidate of validated.items) {
        const stage = stagesByIdentity.get(stageIdentityKey(candidate.item));
        if (!stage) return { status: "migration_incomplete" };
        if (stage.targetEnvelope !== null) {
            if (
                stage.targetEncodedBytes !== candidate.targetEncodedBytes
                || !jsonEqual(stage.targetEnvelope, candidate.item.targetEnvelope)
            ) {
                return { status: "stage_conflict" };
            }
        }
    }

    let stagedParticipantCount = 0;
    let stagedSourceBytes = 0n;
    let stagedTargetBytes = 0n;
    for (const stage of current.stages) {
        const replacement = validatedByIdentity.get(stageIdentityKey(stage));
        const targetEnvelope = replacement?.item.targetEnvelope
            ?? stage.targetEnvelope;
        const targetEncodedBytes = replacement?.targetEncodedBytes
            ?? stage.targetEncodedBytes;
        if (targetEnvelope === null || targetEncodedBytes === null) continue;
        if (targetEncodedBytes < 0n) return { status: "invalid_content" };
        stagedParticipantCount += 1;
        stagedSourceBytes += stage.sourceEncodedBytes;
        stagedTargetBytes += targetEncodedBytes;
    }
    const aggregateStaged = aggregateStagedStatistics(
        {
            participantCount: stagedParticipantCount,
            sourceBytes: stagedSourceBytes,
            targetBytes: stagedTargetBytes,
        },
        automations.state,
    );
    if (
        !aggregateStaged
        || aggregateStaged.participantCount > capacity.participantLimit
        || aggregateStaged.targetBytes > capacity.encodedByteLimit
        || aggregateStaged.sourceBytes + aggregateStaged.targetBytes
            > transition.reservedCapacityBytes
    ) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "migration_too_large" };
    }
    for (const candidate of validated.items) {
        const stage = stagesByIdentity.get(stageIdentityKey(candidate.item));
        if (!stage || stage.targetEnvelope !== null) continue;
        await params.tx.accountEncryptionTransitionCollectionStage.update({
            where: { id: stage.id },
            data: {
                targetEnvelope: toPrismaJson(candidate.item.targetEnvelope),
                targetEncodedBytes: candidate.targetEncodedBytes,
            },
        });
    }
    await params.tx.accountEncryptionTransition.update({
        where: { id: transition.id },
        data: {
            censusTargetBytes: aggregateStaged.targetBytes,
            stagedParticipantCount: aggregateStaged.participantCount,
            stagedSourceBytes: aggregateStaged.sourceBytes,
            stagedTargetBytes: aggregateStaged.targetBytes,
        },
    });
    return {
        status: "staged",
        stagedParticipantCount: aggregateStaged.participantCount,
        stagedSourceBytes: aggregateStaged.sourceBytes,
        stagedTargetBytes: aggregateStaged.targetBytes,
    };
}

function automationStageIdentityKey(
    item: AutomationAccountEncryptionTransitionStageItem,
): string {
    return item.kind === "definition"
        ? `definition\u0000${item.automationId}`
        : `run\u0000${item.runId}`;
}

function automationStageMatchesRequestedSource(
    stage: Parameters<typeof sourceItemFromAccountEncryptionTransitionAutomationStage>[0],
    item: AutomationAccountEncryptionTransitionStageItem,
): boolean {
    const source = sourceItemFromAccountEncryptionTransitionAutomationStage(stage);
    if (!source) return false;
    if (item.kind === "definition") {
        return source.kind === "definition"
            && source.automationId === item.automationId
            && source.revision === item.expectedRevision
            && jsonEqual(source.source, item.source);
    }
    return source.kind === "run"
        && source.runId === item.runId
        && source.automationId === item.automationId
        && source.revision === item.expectedRevision
        && source.originKind === item.originKind
        && source.occurrenceKey === item.occurrenceKey
        && jsonEqual(source.source, item.source);
}

/**
 * Validates and durably saves one bounded Automation target page. The Account
 * transition remains the aggregate-capacity and lifecycle owner; Automation
 * validates its own Definition/Run semantics and immutable currentness.
 */
export async function stageAccountEncryptionTransitionAutomationsCoordinatorInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        transitionId: string;
        items: readonly AutomationAccountEncryptionTransitionStageItem[];
        now?: Date;
    }>,
): Promise<AccountEncryptionTransitionAutomationStageCoordinatorResult> {
    const now = resolveTransitionNow(params.now);
    if (
        params.items.length === 0
        || params.items.length
            > ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS
        || new Set(params.items.map(automationStageIdentityKey)).size
            !== params.items.length
    ) {
        return { status: "invalid_content" };
    }
    const transition = await readAccountEncryptionTransitionInTx(
        params.tx,
        params.accountId,
        params.transitionId,
    );
    if (!transition) return { status: "transition_not_found" };
    if (isExpired(transition, now)) {
        await expireAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "transition_expired" };
    }
    if (transition.status !== "authorized") return { status: "transition_not_ready" };
    const capacity = measuredCapacityFromTransition(transition);
    if (!capacity) return { status: "migration_too_large" };
    const source = sourceFactsFromTransition(transition);
    if (!source) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "invalid_content" };
    }
    const collections = await resolveCurrentTransitionCensusInTx(
        params.tx,
        params.accountId,
        transition,
    );
    if (collections.status !== "complete") {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return collections;
    }
    const automations = await validateCurrentAutomationTransitionCensusInTx(
        params.tx,
        params.accountId,
        transition,
    );
    if (automations.status !== "complete") {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return automations;
    }
    if (!aggregateTransitionSourceMatches(transition, collections.census, automations.state)) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "migration_incomplete" };
    }
    if (
        automations.state.sourceRunCount
            > ACCOUNT_ENCRYPTION_TRANSITION_AUTOMATION_RUN_MAX_PARTICIPANTS
        || transition.censusParticipantCount > capacity.participantLimit
        || transition.censusSourceBytes > capacity.encodedByteLimit
        || transition.censusSourceBytes > transition.reservedCapacityBytes
    ) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "migration_too_large" };
    }
    const stages = await readAccountEncryptionTransitionAutomationStagesByIdentityInTx({
        tx: params.tx,
        transitionId: transition.id,
        identities: params.items.map((item) => (
            item.kind === "definition"
                ? { participantKind: "definition" as const, participantId: item.automationId }
                : { participantKind: "run" as const, participantId: item.runId }
        )),
    });
    if (!stages || stages.length !== params.items.length) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "migration_incomplete" };
    }
    const stagesByIdentity = new Map<string, (typeof stages)[number]>(
        stages.map((stage) => [
            `${stage.participantKind}\u0000${stage.participantId}`,
            stage,
        ] as const),
    );
    const candidates: Array<Readonly<{
        stage: (typeof stages)[number];
        item: AutomationAccountEncryptionTransitionStageItem;
    }>> = [];
    for (const item of params.items) {
        const stage = stagesByIdentity.get(automationStageIdentityKey(item));
        if (!stage || !automationStageMatchesRequestedSource(stage, item)) {
            await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
            return { status: "migration_incomplete" };
        }
        const existing = targetItemFromAccountEncryptionTransitionAutomationStage(stage);
        if (existing && !jsonEqual(existing, item)) return { status: "stage_conflict" };
        if (
            !existing
            && (stage.targetContent !== null || stage.targetEncodedBytes !== null)
        ) {
            await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
            return { status: "migration_incomplete" };
        }
        candidates.push({ stage, item });
    }
    const validated = await validateAutomationAccountEncryptionTransitionStageInTx({
        tx: params.tx,
        accountId: params.accountId,
        fromMode: source.fromMode,
        toMode: source.toMode,
        items: params.items,
    });
    if (validated.status === "migration_incomplete") {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return validated;
    }
    if (validated.status === "invalid_content") return validated;
    let nextAutomationParticipantCount = automations.state.stagedParticipantCount;
    let nextAutomationRunCount = automations.state.stagedRunCount;
    let nextAutomationSourceBytes = automations.state.stagedSourceBytes;
    let nextAutomationTargetBytes = automations.state.stagedTargetBytes;
    for (const candidate of candidates) {
        if (targetItemFromAccountEncryptionTransitionAutomationStage(candidate.stage)) {
            continue;
        }
        nextAutomationParticipantCount += 1;
        if (candidate.stage.participantKind === "run") nextAutomationRunCount += 1;
        nextAutomationSourceBytes += candidate.stage.sourceEncodedBytes;
        nextAutomationTargetBytes +=
            measureAccountEncryptionTransitionAutomationStageItemBytes(candidate.item);
    }
    if (
        !Number.isSafeInteger(nextAutomationParticipantCount)
        || !Number.isSafeInteger(nextAutomationRunCount)
        || nextAutomationParticipantCount > automations.state.sourceParticipantCount
        || nextAutomationRunCount > automations.state.sourceRunCount
        || nextAutomationSourceBytes > automations.state.sourceEncodedBytes
    ) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "migration_incomplete" };
    }
    const collectionStatistics = stagedCollectionStatistics(collections.stages);
    const projectedAutomationState = {
        ...automations.state,
        stagedParticipantCount: nextAutomationParticipantCount,
        stagedRunCount: nextAutomationRunCount,
        stagedSourceBytes: nextAutomationSourceBytes,
        stagedTargetBytes: nextAutomationTargetBytes,
    };
    if (!collectionStatistics) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "migration_incomplete" };
    }
    const aggregateStaged = aggregateStagedStatistics(
        collectionStatistics,
        projectedAutomationState,
    );
    if (
        !aggregateStaged
        || aggregateStaged.participantCount > capacity.participantLimit
        || aggregateStaged.targetBytes > capacity.encodedByteLimit
        || aggregateStaged.sourceBytes + aggregateStaged.targetBytes
            > transition.reservedCapacityBytes
    ) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "migration_too_large" };
    }
    const written = await writeAccountEncryptionTransitionAutomationStageTargetsInTx({
        tx: params.tx,
        transitionId: transition.id,
        items: candidates,
    });
    if (written.status !== "staged") {
        if (written.status === "migration_incomplete") {
            await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        }
        return written;
    }
    const committedAggregate = aggregateStagedStatistics(
        collectionStatistics,
        written.state,
    );
    if (!committedAggregate) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "migration_incomplete" };
    }
    await params.tx.accountEncryptionTransition.update({
        where: { id: transition.id },
        data: {
            censusTargetBytes: committedAggregate.targetBytes,
            stagedParticipantCount: committedAggregate.participantCount,
            stagedSourceBytes: committedAggregate.sourceBytes,
            stagedTargetBytes: committedAggregate.targetBytes,
        },
    });
    return {
        status: "staged",
        stagedParticipantCount: committedAggregate.participantCount,
        stagedSourceBytes: committedAggregate.sourceBytes,
        stagedTargetBytes: committedAggregate.targetBytes,
    };
}

function collectionDirectiveItemsFromStages(
    stages: readonly AccountEncryptionTransitionStoredStage[],
): readonly AccountEncryptionMigrateCollectionStageItem[] | null {
    const items: AccountEncryptionMigrateCollectionStageItem[] = [];
    for (const stage of stages) {
        if (
            stage.targetEnvelope === null
            || stage.targetEncodedBytes === null
            || stage.targetEncodedBytes < 0n
            || stage.sourceEnvelope === null
            || typeof stage.sourceEnvelope !== "object"
            || Array.isArray(stage.sourceEnvelope)
            || typeof stage.targetEnvelope !== "object"
            || Array.isArray(stage.targetEnvelope)
        ) {
            return null;
        }
        items.push({
            pluginId: stage.pluginId,
            collectionId: stage.collectionId,
            rowId: stage.rowId,
            expectedRevision: stage.sourceRevision,
            sourceEnvelope: stage.sourceEnvelope as PluginCollectionContentEnvelopeV1,
            targetEnvelope: stage.targetEnvelope as PluginCollectionContentEnvelopeV1,
            schemaVersion: stage.schemaVersion,
            contractDigest: stage.contractDigest,
        });
    }
    return items;
}

async function validateStagedAutomationTargetsForActivationInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    transitionId: string;
    fromMode: "plain" | "e2ee";
    toMode: "plain" | "e2ee";
}>): Promise<
    | Readonly<{ status: "validated" }>
    | Readonly<{ status: "migration_incomplete" | "invalid_content" }>
> {
    let cursor: AccountEncryptionTransitionAutomationStageCursor | undefined;
    for (;;) {
        const page = await readAccountEncryptionTransitionAutomationStagePageInTx({
            tx: params.tx,
            transitionId: params.transitionId,
            ...(cursor ? { cursor } : {}),
        });
        if (!page) return { status: "invalid_content" };
        const items: AutomationAccountEncryptionTransitionStageItem[] = [];
        for (const stage of page.stages) {
            const target = targetItemFromAccountEncryptionTransitionAutomationStage(stage);
            if (!target) return { status: "migration_incomplete" };
            items.push(target);
        }
        if (items.length > 0) {
            const validated = await validateAutomationAccountEncryptionTransitionStageInTx({
                tx: params.tx,
                accountId: params.accountId,
                fromMode: params.fromMode,
                toMode: params.toMode,
                items,
            });
            if (validated.status !== "validated") return validated;
        }
        if (!page.nextCursor) return { status: "validated" };
        cursor = page.nextCursor;
    }
}

async function applyStagedAutomationTargetsForActivationInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    transitionId: string;
    fromMode: "plain" | "e2ee";
    toMode: "plain" | "e2ee";
}>): Promise<
    | Readonly<{ status: "applied" }>
    | Readonly<{ status: "migration_incomplete" | "invalid_content" }>
> {
    let cursor: AccountEncryptionTransitionAutomationStageCursor | undefined;
    for (;;) {
        const page = await readAccountEncryptionTransitionAutomationStagePageInTx({
            tx: params.tx,
            transitionId: params.transitionId,
            ...(cursor ? { cursor } : {}),
        });
        if (!page) return { status: "invalid_content" };
        const items: AutomationAccountEncryptionTransitionStageItem[] = [];
        for (const stage of page.stages) {
            const target = targetItemFromAccountEncryptionTransitionAutomationStage(stage);
            if (!target) return { status: "migration_incomplete" };
            items.push(target);
        }
        if (items.length > 0) {
            const applied = await applyAutomationAccountEncryptionTransitionStageInTx({
                tx: params.tx,
                accountId: params.accountId,
                fromMode: params.fromMode,
                toMode: params.toMode,
                items,
            });
            if (applied.status !== "applied") return applied;
        }
        if (!page.nextCursor) return { status: "applied" };
        cursor = page.nextCursor;
    }
}

function targetAccountKeyMaterialFromTransition(
    transition: Readonly<{
        toEncryptionMode: string;
        targetAccountPublicKey: string | null;
        targetContentPublicKey: Uint8Array | null;
        targetContentPublicKeySig: Uint8Array | null;
        targetSigningKeyFingerprint: string | null;
        targetContentKeyFingerprint: string | null;
    }>,
): Readonly<{
    accountPublicKeyHex: string;
    binding: VerifiedAccountContentKeyBinding;
}> | null {
    if (transition.toEncryptionMode !== "e2ee") return null;
    if (
        !transition.targetAccountPublicKey
        || !transition.targetContentPublicKey
        || !transition.targetContentPublicKeySig
        || !/^[0-9a-f]{64}$/iu.test(transition.targetAccountPublicKey)
    ) {
        return null;
    }
    const binding = verifyAccountContentKeyBindingForAccountPublicKey({
        accountPublicKeyHex: transition.targetAccountPublicKey,
        contentPublicKey: transition.targetContentPublicKey,
        contentPublicKeySignature: transition.targetContentPublicKeySig,
    });
    if (!binding) return null;
    const signingFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(
        new Uint8Array(Buffer.from(transition.targetAccountPublicKey, "hex")),
    );
    const contentFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(
        binding.contentPublicKey,
    );
    if (
        transition.targetSigningKeyFingerprint !== signingFingerprint
        || transition.targetContentKeyFingerprint
            !== contentFingerprint
    ) {
        return null;
    }
    return {
        accountPublicKeyHex: transition.targetAccountPublicKey,
        binding,
    };
}

function activatedTransitionResult(
    transition: Readonly<{
        status: string;
        toEncryptionMode: string;
        activatedAt: Date | null;
        activatedAccountVersion: number | null;
        activatedAccountUpdatedAt: Date | null;
        activatedAccountCursor: number | null;
    }>,
): Extract<AccountEncryptionTransitionActivateCoordinatorResult, { status: "activated" }> | null {
    if (transition.status !== "activated") return null;
    if (
        !isTransitionMode(transition.toEncryptionMode)
        || transition.activatedAt === null
        || transition.activatedAccountVersion === null
        || !Number.isSafeInteger(transition.activatedAccountVersion)
        || transition.activatedAccountVersion < 0
        || transition.activatedAccountUpdatedAt === null
        || !Number.isFinite(transition.activatedAccountUpdatedAt.getTime())
        || transition.activatedAccountCursor === null
        || !Number.isSafeInteger(transition.activatedAccountCursor)
        || transition.activatedAccountCursor < 0
    ) {
        return null;
    }
    return {
        status: "activated",
        mode: transition.toEncryptionMode,
        version: transition.activatedAccountVersion,
        updatedAt: transition.activatedAccountUpdatedAt.getTime(),
        cursor: transition.activatedAccountCursor,
    };
}

/**
 * Re-censuses every closed participant, applies both staged participant
 * directives, advances their witnesses, and flips Account mode/key state in
 * the same transaction. Staged tables are never reader surfaces.
 */
export async function activateAccountEncryptionTransitionCoordinatorInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        transitionId: string;
        now?: Date;
    }>,
): Promise<AccountEncryptionTransitionActivateCoordinatorResult> {
    const now = resolveTransitionNow(params.now);
    const transition = await readAccountEncryptionTransitionInTx(
        params.tx,
        params.accountId,
        params.transitionId,
    );
    if (!transition) return { status: "transition_not_found" };
    if (transition.status === "activated") {
        return activatedTransitionResult(transition) ?? { status: "invalid_content" };
    }
    if (isExpired(transition, now)) {
        await expireAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "transition_expired" };
    }
    if (transition.status !== "authorized") return { status: "transition_not_ready" };
    const capacity = measuredCapacityFromTransition(transition);
    if (!capacity) return { status: "migration_too_large" };
    const current = await resolveCurrentTransitionCensusInTx(
        params.tx,
        params.accountId,
        transition,
    );
    if (current.status !== "complete") {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return current;
    }
    const automations = await validateCurrentAutomationTransitionCensusInTx(
        params.tx,
        params.accountId,
        transition,
    );
    // A missing state row is not a zero census: it is an old/incomplete
    // transition that never staged the closed Automation participant. The
    // explicit zero-source row prevents a future empty Account from silently
    // taking the Collections-only activation path.
    if (
        automations.status !== "complete"
        || automations.state.stagedParticipantCount
            !== automations.state.sourceParticipantCount
        || automations.state.stagedRunCount
            !== automations.state.sourceRunCount
        || automations.state.stagedSourceBytes
            !== automations.state.sourceEncodedBytes
    ) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return automations.status === "complete"
            ? { status: "migration_incomplete" }
            : automations;
    }
    if (!aggregateTransitionSourceMatches(transition, current.census, automations.state)) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "migration_incomplete" };
    }
    const collectionStatistics = stagedCollectionStatistics(current.stages);
    const aggregateStaged = collectionStatistics
        ? aggregateStagedStatistics(collectionStatistics, automations.state)
        : null;
    if (
        !collectionStatistics
        || !aggregateStaged
        || collectionStatistics.participantCount !== current.census.participantCount
        || collectionStatistics.sourceBytes !== current.census.sourceEncodedBytes
        || transition.stagedParticipantCount !== aggregateStaged.participantCount
        || transition.stagedSourceBytes !== aggregateStaged.sourceBytes
        || transition.stagedTargetBytes !== aggregateStaged.targetBytes
        || transition.censusTargetBytes !== aggregateStaged.targetBytes
        || automations.state.sourceRunCount
            > ACCOUNT_ENCRYPTION_TRANSITION_AUTOMATION_RUN_MAX_PARTICIPANTS
        || aggregateStaged.participantCount > capacity.participantLimit
        || aggregateStaged.targetBytes > capacity.encodedByteLimit
        || aggregateStaged.sourceBytes + aggregateStaged.targetBytes
            > transition.reservedCapacityBytes
    ) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "migration_incomplete" };
    }
    const directiveItems = collectionDirectiveItemsFromStages(current.stages);
    if (!directiveItems) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "migration_incomplete" };
    }
    const source = sourceFactsFromTransition(transition);
    if (!source) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "invalid_content" };
    }
    const targetKeyMaterial = source.toMode === "e2ee"
        ? targetAccountKeyMaterialFromTransition(transition)
        : null;
    if (source.toMode === "e2ee" && !targetKeyMaterial) {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "invalid_content" };
    }
    const validatedAutomations = await validateStagedAutomationTargetsForActivationInTx({
        tx: params.tx,
        accountId: params.accountId,
        transitionId: transition.id,
        fromMode: source.fromMode,
        toMode: source.toMode,
    });
    if (validatedAutomations.status !== "validated") {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return validatedAutomations;
    }
    // Revalidate Collection candidates before the first mutation as well. A
    // later post-validation conflict throws, rolling this whole Account
    // transition transaction back rather than committing one participant.
    const validatedCollections = await validatePluginCollectionAccountEncryptionTransitionStageInTx({
        tx: params.tx,
        accountId: params.accountId,
        fromMode: source.fromMode,
        toMode: source.toMode,
        limits: {
            participantLimit: capacity.participantLimit,
            encodedByteLimit: capacity.encodedByteLimit,
        },
        items: directiveItems,
    });
    if (validatedCollections.status !== "validated") {
        await abandonAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        // Every non-validated Collection status is already a member of this
        // result union. Collapsing them here would report an Account that
        // cannot relocate its mode-derived rows as ordinary invalid content.
        return { status: validatedCollections.status };
    }
    const collections = await applyPluginCollectionAccountEncryptionTransitionInTx({
        tx: params.tx,
        accountId: params.accountId,
        fromMode: source.fromMode,
        toMode: source.toMode,
        limits: {
            participantLimit: capacity.participantLimit,
            encodedByteLimit: capacity.encodedByteLimit,
        },
        directive: { action: "migrate", items: directiveItems },
    });
    // Exhaustive by construction: the next statement flips the Account's
    // persisted mode, so an unhandled Collection status must not be able to
    // reach it. Enumerating only the statuses known today let a fourth one —
    // the mode-derived identity refusal — fall through to that flip.
    if (collections.status !== "applied") {
        throw new Error(
            `Collection transition did not apply after activation validation (${collections.status})`,
        );
    }
    const appliedAutomations = await applyStagedAutomationTargetsForActivationInTx({
        tx: params.tx,
        accountId: params.accountId,
        transitionId: transition.id,
        fromMode: source.fromMode,
        toMode: source.toMode,
    });
    if (appliedAutomations.status !== "applied") {
        throw new Error("Automation transition changed after activation validation");
    }
    const cursor = await markAccountChanged(params.tx, {
        accountId: params.accountId,
        kind: "account",
        entityId: "self",
        hint: { accountEncryptionTransitionId: transition.id },
    });
    // Candidate preparation is scoped to the pre-flip Account content mode.
    // It is not an Account-transition participant, so remove every stage in
    // this same activation transaction immediately before the canonical mode
    // transition publishes its new Account state.
    await retirePluginCollectionCandidatePreparationStagesTx({
        tx: params.tx,
        accountId: params.accountId,
    });
    const updated = await applyAccountEncryptionTransitionInTx(params.tx, {
        accountId: params.accountId,
        expectedVersion: cursor,
        toMode: source.toMode,
        ...(targetKeyMaterial
            ? { accountPublicKeyHex: targetKeyMaterial.accountPublicKeyHex }
            : {}),
        contentKey: targetKeyMaterial
            ? { kind: "migration_replace", binding: targetKeyMaterial.binding }
            : { kind: "preserve" },
    });
    await params.tx.accountEncryptionTransition.update({
        where: { id: transition.id },
        data: {
            status: "activated",
            activeAccountId: null,
            activatedAt: now,
            activatedAccountVersion: updated.version,
            activatedAccountUpdatedAt: new Date(updated.updatedAt),
            activatedAccountCursor: cursor,
        },
    });
    await params.tx.accountEncryptionTransitionCollectionStage.deleteMany({
        where: { transitionId: transition.id },
    });
    await deleteAccountEncryptionTransitionAutomationStagesInTx(
        params.tx,
        transition.id,
    );
    await deleteAccountEncryptionTransitionAutomationStageStateInTx(
        params.tx,
        transition.id,
    );
    return { status: "activated", cursor, ...updated };
}

export type AccountEncryptionTransitionCancelCoordinatorResult =
    | Readonly<{ status: "cancelled" }>
    | Readonly<{
        status:
            | "transition_not_found"
            | "transition_not_cancellable"
            | "transition_expired";
    }>;

/** Cancellation removes only bounded unactivated stage rows and never source data. */
export async function cancelAccountEncryptionTransitionCoordinatorInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        transitionId: string;
        now?: Date;
    }>,
): Promise<AccountEncryptionTransitionCancelCoordinatorResult> {
    const now = resolveTransitionNow(params.now);
    const transition = await readAccountEncryptionTransitionInTx(
        params.tx,
        params.accountId,
        params.transitionId,
    );
    if (!transition) return { status: "transition_not_found" };
    if (transition.status === "cancelled") return { status: "cancelled" };
    if (isExpired(transition, now)) {
        await expireAccountEncryptionTransitionInTx(params.tx, transition.id, now);
        return { status: "transition_expired" };
    }
    if (transition.status !== "preparing" && transition.status !== "authorized") {
        return { status: "transition_not_cancellable" };
    }
    const cancelled = await abandonAccountEncryptionTransitionInTx(
        params.tx,
        transition.id,
        now,
    );
    return cancelled.closed
        ? { status: "cancelled" }
        : { status: "transition_not_cancellable" };
}

export type AccountEncryptionTransitionAccountDataEraseAdmissionResult =
    | Readonly<{ status: "ready" }>
    | Readonly<{ status: "transition_cleanup_pending" }>
    | Readonly<{ status: "account_not_found" }>
    | Readonly<{ status: "account_inconsistent" }>;

/**
 * The present-user Account-data erase is a cancellation request, never a
 * competing transition owner. It takes the Account fence first, asks the
 * canonical lifecycle to cancel the one active transition, and makes at most
 * one bounded cleanup chunk of progress. Until that lifecycle has terminally
 * removed every staged envelope, the caller must leave every other Account
 * data destination untouched and report a retryable pending result.
 */
export async function admitAccountDataEraseThroughEncryptionTransitionInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        now?: Date;
    }>,
): Promise<AccountEncryptionTransitionAccountDataEraseAdmissionResult> {
    const fence = await acquireAccountEncryptionTransitionCoordinatorFenceInTx(
        params.tx,
        params.accountId,
    );
    if (fence.status === "account_not_found") return fence;
    if (fence.status === "account_inconsistent") return fence;

    const active = await params.tx.accountEncryptionTransition.findFirst({
        where: { activeAccountId: params.accountId },
        select: { id: true },
    });
    if (!active) return { status: "ready" };

    await cancelAccountEncryptionTransitionCoordinatorInTx({
        tx: params.tx,
        accountId: params.accountId,
        transitionId: active.id,
        ...(params.now ? { now: params.now } : {}),
    });

    const remaining = await params.tx.accountEncryptionTransition.findFirst({
        where: { activeAccountId: params.accountId },
        select: { id: true },
    });
    return remaining
        ? { status: "transition_cleanup_pending" }
        : { status: "ready" };
}
