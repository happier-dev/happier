import { createHash } from "node:crypto";
import type { Prisma as PrismaTypes } from "@prisma/client";
import type { ReviewCommentAppearanceInputV1, ReviewCommentAppearanceV1, ReviewCommentEventV1, ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import type { ReviewCommentEventRequestBindingV1 } from '@happier-dev/protocol/reviews/comments/content';
import type { ReviewCommentListRequestV1, ReviewCommentPublicationDispatchInstructionV1 } from '@happier-dev/protocol/reviews/comments/actions';
import type { ReviewCommentPublicationTransportResultV1 } from '@happier-dev/protocol/reviews/comments/publicationTransport';
import type { StoredJsonContentEnvelope } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import { BoundReviewCommentEventSensitiveEnvelopeV1Schema, ReviewCommentStructuralV1Schema, splitReviewCommentV1, sealReviewCommentSensitiveEnvelopeV1, openReviewCommentSensitiveMigrationSourceV1, openStoredReviewCommentV1, type ReviewCommentStructuralV1 } from '@happier-dev/protocol/reviews/comments/content';
import { ReviewCommentEventV1Schema, ReviewCommentV1Schema, type ReviewCommentChangesHintV1 } from '@happier-dev/protocol/reviews/comments/v1';
import { ReviewCommentPublicationTransportResultV1Schema } from '@happier-dev/protocol/reviews/comments/publicationTransport';
import { StoredJsonContentEnvelopeSchema } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import { type ReviewCommentStoredSourceV1 } from '@happier-dev/protocol/reviews/comments/mutation';
import { reviewCommentFindingScopeV1 } from '@happier-dev/protocol/reviews/comments/findingIdentity';
import { buildReviewCommentCanonicalStorageValues, buildReviewCommentStructuralFromStorageRow,
    readReviewCommentMigrationSourceFromStorageRow } from "./accountEncryptionMigrationPersistence";

import {
    type AccountEncryptionCurrentness,
} from "@/app/encryption/accountContentKeyAdmission";
import {
    acquireAccountEncryptionTransitionFenceInTx,
} from "@/app/encryption/accountEncryptionTransition";
import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import {
    getDbProviderFromEnv,
    isPrismaErrorCode,
    isPrismaUniqueConstraintError,
    prismaRuntime as Prisma,
} from "@/storage/prisma";
import { ReviewCommentOperationError } from "./errors";
import type { ReviewAccessCapability } from "./permissions";
import { acquireArtifactPublicationLocksInTx, resolveArtifactAudienceInTx } from "@/app/artifacts/artifactAccessService";
import { markAccountsChanged } from "@/app/changes/markAccountChanged";
import { REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import {
    bindReviewCommentEventSensitiveForStorage,
    decodeReviewCommentEventSensitiveFromStorage,
} from "./events";
import {
    applyReviewCommentListQuery,
    matchesReviewCommentListFilters,
    normalizeReviewCommentListFilters,
    pageReviewCommentListCandidates,
    readReviewCommentListCursorPosition,
    type ReviewCommentListResult,
} from "./queries";

export type ReviewCommentStoreListParams = Readonly<{
    reviewAccess?: ReviewAccessCapability;
    accountId: string;
    filters: ReviewCommentListRequestV1;
}>;

export type ReviewCommentStoreCommentParams = Readonly<{
    reviewAccess?: ReviewAccessCapability;
    accountId: string;
    commentId: string;
}>;

export type ReviewCommentStoreCommitParams = Readonly<{
    reviewAccess?: ReviewAccessCapability;
    accountId: string;
    comment: ReviewCommentV1;
    event: ReviewCommentEventV1;
    storageMode?: "plain" | "e2ee";
    accountVersion?: number;
    accountEncryptionCurrentness?: AccountEncryptionCurrentness;
    eventEnvelope?: StoredJsonContentEnvelope;
    requestBinding: ReviewCommentEventRequestBindingV1;
}>;

export type ReviewCommentStoreCreateParams = ReviewCommentStoreCommitParams & Readonly<{
    appearance?: ReviewCommentAppearanceInputV1;
    createClientMutationId: string;
    createRequestFingerprint: string;
}>;

export type ReviewCommentStoreCreateResult = Readonly<{
    comment: ReviewCommentV1;
    replayed: boolean;
}>;

export type ReviewCommentCanonicalCommitParams = Omit<ReviewCommentStoreCommitParams, "comment"> & Readonly<{
    comment: ReviewCommentStructuralV1;
    sensitiveEnvelope: StoredJsonContentEnvelope;
    parentCurrentness?: Readonly<{ commentId: string; serverRevision: number }>;
}>;
export type ReviewCommentCanonicalCreateParams = ReviewCommentCanonicalCommitParams & Pick<ReviewCommentStoreCreateParams, "createClientMutationId" | "createRequestFingerprint" | "appearance">;
export type ReviewCommentCanonicalCreateResult = Readonly<{ comment: ReviewCommentStoredSourceV1; replayed: boolean }>;

export type ReviewCommentStorePublicationClaimParams = Readonly<{
    reviewAccess?: ReviewAccessCapability;
    accountId: string;
    entries: readonly Readonly<{
        commentId: string;
        serverRevision: number;
        publicationCorrelationId: string;
    }>[];
    verdictPublicationCorrelationId: string | null;
    targetKey: string;
    storageMode: "plain" | "e2ee";
    contentPublicKeyFingerprint: string | null;
    publicationPlanId: string;
    dispatchToken: string;
    settlement?: Readonly<{
        dispatchToken: string | null;
        result: ReviewCommentPublicationTransportResultV1;
    }>;
    createdAt: number;
}>;

export type ReviewCommentStorePublicationClaimResult = Readonly<{
    disposition: "dispatch" | "reconcile";
    dispatchToken: string | null;
    publicationPlanId: string;
    instructions: Readonly<{
        entries: readonly ReviewCommentPublicationDispatchInstructionV1[];
        verdict: ReviewCommentPublicationDispatchInstructionV1 | null;
    }>;
    priorResult: ReviewCommentPublicationTransportResultV1 | null;
}>;

export interface ReviewCommentStore {
    recordAppearance(appearance: ReviewCommentAppearanceV1): Promise<void>;
    listAppearances(params: Readonly<{ reviewId: string; roundOrdinal?: number }>): Promise<readonly ReviewCommentAppearanceV1[]>;
    getSource(params: ReviewCommentStoreCommentParams): Promise<ReviewCommentStoredSourceV1 | null>;
    listSources(params: ReviewCommentStoreListParams): Promise<ReviewCommentListResult<ReviewCommentStoredSourceV1>>;
    findCreate(params: Readonly<{ reviewAccess?: ReviewAccessCapability; accountId: string; createClientMutationId: string; createRequestFingerprint: string; structural?: ReviewCommentStructuralV1 }>): Promise<ReviewCommentStoredSourceV1 | null>;
    createCanonical(params: ReviewCommentCanonicalCreateParams): Promise<ReviewCommentCanonicalCreateResult>;
    commitCanonical(params: ReviewCommentCanonicalCommitParams): Promise<void>;
    get(params: ReviewCommentStoreCommentParams): Promise<ReviewCommentV1 | null>;
    list(params: ReviewCommentStoreListParams): Promise<ReviewCommentListResult>;
    listEvents(params: ReviewCommentStoreCommentParams): Promise<readonly ReviewCommentEventV1[]>;
    create(params: ReviewCommentStoreCreateParams): Promise<ReviewCommentStoreCreateResult>;
    commit(params: ReviewCommentStoreCommitParams): Promise<void>;
    claimPublicationDispatch(
        params: ReviewCommentStorePublicationClaimParams,
    ): Promise<ReviewCommentStorePublicationClaimResult>;
}

type ReviewCommentRow = {
    id: string;
    account_id: string;
    review_id: string | null;
    round_ordinal: number | bigint | null;
    project_id: string | null;
    workspace_json: string | null;
    workspace_id: string | null;
    session_id: string | null;
    run_id: string | null;
    engine_id: string | null;
    finding_id: string | null;
    finding_identity: string | null;
    finding_severity: string | null;
    reviewed_fingerprint: string | null;
    review_triage_status: string | null;
    finding_scope_key: string | null;
    create_client_mutation_id: string | null;
    create_request_fingerprint: string | null;
    thread_id: string;
    parent_comment_id: string | null;
    state: string;
    flags_json: string;
    anchor_json: string;
    snapshot_envelope_json: string;
    body_envelope_json: string;
    body_version: number | bigint;
    author_json: string;
    edits_json: string;
    dispositions_json: string;
    evidence_json: string | null;
    transitions_json: string;
    fingerprint_json: string | null;
    linked_refs_json: string | null;
    suggested_fix_json: string | null;
    metadata_json: string | null;
    tombstone_json: string | null;
    server_revision: number | bigint;
    created_at: number | bigint;
    updated_at: number | bigint;
};

type ReviewCommentEventRow = {
    review_id?: string | null;
    event_id: string;
    comment_id: string;
    account_id: string;
    project_id: string | null;
    workspace_json: string | null;
    event_kind: string;
    event_envelope_json: string;
    bulk_action_id: string | null;
    client_mutation_id: string | null;
    actor_json: string;
    author_device_id: string | null;
    client_lamport: number | bigint | null;
    server_revision: number | bigint;
    created_at: number | bigint;
};

const COMMENT_SELECT_COLUMNS = [
    "id",
    "account_id",
    "review_id",
    "round_ordinal",
    "project_id",
    "workspace_id",
    "workspace_json",
    "session_id",
    "run_id",
    "engine_id",
    "finding_id",
    "finding_identity",
    "finding_severity",
    "reviewed_fingerprint",
    "review_triage_status",
    "finding_scope_key",
    "create_client_mutation_id",
    "create_request_fingerprint",
    "thread_id",
    "parent_comment_id",
    "state",
    "flags_json",
    "anchor_json",
    "snapshot_envelope_json",
    "body_envelope_json",
    "body_version",
    "author_json",
    "edits_json",
    "dispositions_json",
    "evidence_json",
    "transitions_json",
    "fingerprint_json",
    "linked_refs_json",
    "suggested_fix_json",
    "metadata_json",
    "tombstone_json",
    "server_revision",
    "created_at",
    "updated_at",
].join(", ");

function parseJson(value: string): unknown {
    return JSON.parse(value);
}

function stringifyJson(value: unknown): string {
    return JSON.stringify(value);
}

function stringifyOptionalJson(value: unknown): string | null {
    return typeof value === "undefined" ? null : stringifyJson(value);
}

type ReviewCommentStoredPublicationLifecycle = Readonly<{
    dispatchToken: string | null;
    result: ReviewCommentPublicationTransportResultV1 | null;
}>;

type ReviewCommentStoredPublicationClaim = Readonly<{
    publicationPlanId: string;
    lifecycle: ReviewCommentStoredPublicationLifecycle | null;
}>;

type ReviewCommentPublicationVerdictOutcome = Extract<
    ReviewCommentPublicationTransportResultV1["verdict"],
    { publicationCorrelationId: string }
>["outcome"];

function parseStoredPublicationClaim(value: string): ReviewCommentStoredPublicationClaim | null {
    const parsed = parseJson(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const publicationPlanId = (parsed as { publicationPlanId?: unknown }).publicationPlanId;
    if (typeof publicationPlanId !== "string") return null;
    const lifecycle = (parsed as { lifecycle?: unknown }).lifecycle;
    if (lifecycle === undefined) {
        // Claims written by the unreleased predecessor had no completion state. They remain
        // conservative answer-lost claims rather than becoming retryable by assumption.
        return { publicationPlanId, lifecycle: null };
    }
    if (lifecycle === null || typeof lifecycle !== "object" || Array.isArray(lifecycle)) return null;
    const dispatchToken = (lifecycle as { dispatchToken?: unknown }).dispatchToken;
    const result = (lifecycle as { result?: unknown }).result;
    if ((dispatchToken !== null && typeof dispatchToken !== "string")
        || (result !== null && !ReviewCommentPublicationTransportResultV1Schema.safeParse(result).success)) {
        return null;
    }
    return {
        publicationPlanId,
        lifecycle: {
            dispatchToken,
            result: result === null ? null : ReviewCommentPublicationTransportResultV1Schema.parse(result),
        },
    };
}

function publicationResultOutcomes(result: ReviewCommentPublicationTransportResultV1 | null): Readonly<{
    entries: readonly (ReviewCommentPublicationTransportResultV1["entries"][number]["outcome"] | null)[];
    verdict: ReviewCommentPublicationVerdictOutcome | null;
}> {
    return {
        entries: result?.entries.map((entry) => entry.outcome) ?? [],
        verdict: result === null || "kind" in result.verdict ? null : result.verdict.outcome,
    };
}

function publicationClaimInstructions(params: Readonly<{
    entryCount: number;
    hasVerdict: boolean;
    lifecycle: ReviewCommentStoredPublicationLifecycle | null;
    allowDispatch: boolean;
}>): ReviewCommentStorePublicationClaimResult["instructions"] {
    const outcomes = publicationResultOutcomes(params.lifecycle?.result ?? null);
    const activeOrUnknown = params.lifecycle === null || params.lifecycle.dispatchToken !== null;
    const hasUncertain = outcomes.entries.some((outcome) => outcome?.kind === "uncertain")
        || outcomes.verdict?.kind === "uncertain";
    const entryInstruction = (index: number): ReviewCommentPublicationDispatchInstructionV1 => {
        const outcome = outcomes.entries[index] ?? null;
        if (outcome?.kind === "published") return "confirmed";
        if (activeOrUnknown) return "reconcile";
        if (hasUncertain) return outcome?.kind === "uncertain" ? "reconcile" : "held";
        return params.allowDispatch ? "dispatch" : "held";
    };
    const verdictInstruction = (): ReviewCommentPublicationDispatchInstructionV1 | null => {
        if (!params.hasVerdict) return null;
        const outcome = outcomes.verdict;
        if (outcome?.kind === "published") return "confirmed";
        if (activeOrUnknown) return "reconcile";
        if (hasUncertain) return outcome?.kind === "uncertain" ? "reconcile" : "held";
        return params.allowDispatch ? "dispatch" : "held";
    };
    return {
        entries: Array.from({ length: params.entryCount }, (_, index) => entryInstruction(index)),
        verdict: verdictInstruction(),
    };
}

function publicationClaimResult(params: Readonly<{
    publicationPlanId: string;
    entryCount: number;
    hasVerdict: boolean;
    lifecycle: ReviewCommentStoredPublicationLifecycle | null;
    allowDispatch: boolean;
}>): ReviewCommentStorePublicationClaimResult {
    const instructions = publicationClaimInstructions(params);
    const hasDispatch = instructions.entries.includes("dispatch") || instructions.verdict === "dispatch";
    return {
        disposition: hasDispatch ? "dispatch" : "reconcile",
        dispatchToken: hasDispatch ? params.lifecycle?.dispatchToken ?? null : null,
        publicationPlanId: params.publicationPlanId,
        instructions,
        priorResult: params.lifecycle?.result ?? null,
    };
}

function initialPublicationClaimResult(params: Readonly<{
    publicationPlanId: string;
    dispatchToken: string;
    entryCount: number;
    hasVerdict: boolean;
}>): ReviewCommentStorePublicationClaimResult {
    return {
        disposition: "dispatch",
        dispatchToken: params.dispatchToken,
        publicationPlanId: params.publicationPlanId,
        instructions: {
            entries: Array.from({ length: params.entryCount }, () => "dispatch" as const),
            verdict: params.hasVerdict ? "dispatch" : null,
        },
        priorResult: null,
    };
}

function samePublishedOutcome(
    previous: ReviewCommentPublicationTransportResultV1["entries"][number]["outcome"],
    candidate: ReviewCommentPublicationTransportResultV1["entries"][number]["outcome"],
): boolean {
    return previous.kind === "published"
        && candidate.kind === "published"
        && previous.externalRefTag === candidate.externalRefTag;
}

function mergePublicationResult(params: Readonly<{
    previous: ReviewCommentPublicationTransportResultV1 | null;
    candidate: ReviewCommentPublicationTransportResultV1;
    mayRelease: boolean;
    mayResolveUncertainFailure: boolean;
}>): ReviewCommentPublicationTransportResultV1 {
    const previous = params.previous;
    const entries = params.candidate.entries.map((candidate, index) => {
        const prior = previous?.entries[index];
        if (prior?.outcome.kind === "published") {
            if (!samePublishedOutcome(prior.outcome, candidate.outcome)) {
                throw new ReviewCommentOperationError(
                    "review_comment_idempotency_conflict",
                    "A confirmed publication effect cannot be changed",
                );
            }
            return prior;
        }
        if (params.mayRelease || candidate.outcome.kind === "published") return candidate;
        if (params.mayResolveUncertainFailure
            && prior?.outcome.kind === "uncertain"
            && candidate.outcome.kind === "failed") {
            return candidate;
        }
        if (prior !== undefined) return prior;
        return { ...candidate, outcome: { kind: "uncertain" as const } };
    });
    let verdict: ReviewCommentPublicationTransportResultV1["verdict"];
    if ("kind" in params.candidate.verdict) {
        verdict = params.candidate.verdict;
    } else {
        const prior = previous !== null && !("kind" in previous.verdict)
            ? previous.verdict
            : null;
        if (prior?.outcome.kind === "published") {
            const candidate = params.candidate.verdict.outcome;
            const priorRef = prior.outcome.externalRefTag;
            const candidateRef = candidate.kind === "published" ? candidate.externalRefTag : undefined;
            if (candidate.kind !== "published" || priorRef !== candidateRef) {
                throw new ReviewCommentOperationError(
                    "review_comment_idempotency_conflict",
                    "A confirmed publication verdict cannot be changed",
                );
            }
            verdict = prior;
        } else if (params.mayRelease || params.candidate.verdict.outcome.kind === "published") {
            verdict = params.candidate.verdict;
        } else if (params.mayResolveUncertainFailure
            && prior?.outcome.kind === "uncertain"
            && params.candidate.verdict.outcome.kind === "failed") {
            verdict = params.candidate.verdict;
        } else if (prior !== null) {
            verdict = prior;
        } else {
            verdict = {
                ...params.candidate.verdict,
                outcome: {
                    kind: "uncertain",
                    ...(params.candidate.verdict.outcome.kind === "uncertain"
                        ? params.candidate.verdict.outcome
                        : {}),
                },
            };
        }
    }
    return ReviewCommentPublicationTransportResultV1Schema.parse({
        publicationPlanId: params.candidate.publicationPlanId,
        entries,
        verdict,
    });
}

function storageMode(params: { storageMode?: "plain" | "e2ee" }): "plain" | "e2ee" {
    return params.storageMode ?? "plain";
}

function bytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
    if (left === null || right === null) return left === right;
    if (left.byteLength !== right.byteLength) return false;
    return Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(
        Buffer.from(right.buffer, right.byteOffset, right.byteLength),
    );
}

function accountEncryptionCurrentnessMatches(
    expected: AccountEncryptionCurrentness,
    actual: AccountEncryptionCurrentness,
): boolean {
    return expected.encryptionMode === actual.encryptionMode
        && bytesEqual(expected.contentPublicKey, actual.contentPublicKey)
        && bytesEqual(
            expected.contentPublicKeySignature,
            actual.contentPublicKeySignature,
        )
        && expected.contentPublicKeyFingerprint
            === actual.contentPublicKeyFingerprint;
}

async function assertReviewCommentAccountWriteCurrentnessInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        storageMode: "plain" | "e2ee";
        accountVersion?: number;
        accountEncryptionCurrentness?: AccountEncryptionCurrentness;
    }>,
): Promise<void> {
    const fence = await acquireAccountEncryptionTransitionFenceInTx(
        tx,
        params.accountId, "content",
    );
    // Account.seq tracks all Account changes, including unrelated Session
    // activity. The locked persisted mode and key binding own this admission.
    if (
        fence.status !== "ready"
        || fence.account.currentness.encryptionMode !== params.storageMode
        || (
            params.accountEncryptionCurrentness
            && !accountEncryptionCurrentnessMatches(
                params.accountEncryptionCurrentness,
                fence.account.currentness,
            )
        )
    ) {
        throw new ReviewCommentOperationError(
            "review_comment_encryption_mode_mismatch",
            "Review-comment Account encryption state changed before persistence",
        );
    }
}

function parseStoredEnvelope(value: unknown, fieldName: string): StoredJsonContentEnvelope {
    const parsed = StoredJsonContentEnvelopeSchema.safeParse(value);
    if (!parsed.success) {
        throw new Error(`Invalid review-comment ${fieldName} envelope`);
    }
    return parsed.data;
}


function assertEnvelopeStorageMode(params: Readonly<{
    envelope: StoredJsonContentEnvelope;
    fieldName: string;
    storageMode: "plain" | "e2ee";
}>): void {
    const envelopeMode = params.envelope.t === "encrypted" ? "e2ee" : "plain";
    if (envelopeMode === params.storageMode) return;
    throw new ReviewCommentOperationError(
        "review_comment_encryption_mode_mismatch",
        `Review comment ${params.fieldName} envelope does not match ${params.storageMode} storage mode`,
    );
}


function decodeStoredEnvelope(value: string, fieldName: string): unknown {
    const envelope = parseStoredEnvelope(parseJson(value), fieldName);
    return envelope.t === "plain" ? envelope.v : envelope;
}

function toNumber(value: number | bigint): number {
    return typeof value === "bigint" ? Number(value) : value;
}


function rowToComment(row: ReviewCommentRow): ReviewCommentV1 {
    const source = rowToSource(row);
    if (source.source.layout === "canonical_v1") {
        const opened = openStoredReviewCommentV1({ stored: { v: 1, structural: source.structural,
            sensitiveEnvelope: source.source.envelope }, mode: "plain" });
        if (opened.status !== "available") throw new ReviewCommentOperationError("review_comment_encryption_mode_mismatch", "Review comment requires canonical client opening");
        return opened.comment;
    }
    if (source.source.sourceMode !== "plain") throw new ReviewCommentOperationError("review_comment_encryption_mode_mismatch", "Review comment requires canonical client opening");
    return ReviewCommentV1Schema.parse({
        v: 1,
        id: row.id,
        accountId: row.account_id,
        reviewId: row.review_id ?? undefined,
        roundOrdinal: row.round_ordinal == null ? undefined : toNumber(row.round_ordinal),
        projectId: row.project_id ?? undefined,
        workspace: row.workspace_json ? parseJson(row.workspace_json) : undefined,
        workspaceId: row.workspace_id ?? undefined,
        sessionId: row.session_id ?? undefined,
        runId: row.run_id ?? undefined,
        engineId: row.engine_id ?? undefined,
        findingId: row.finding_id ?? undefined,
        findingIdentity: row.finding_identity ?? undefined,
        findingSeverity: row.finding_severity ?? undefined,
        reviewedFingerprint: row.reviewed_fingerprint ?? undefined,
        reviewTriageStatus: row.review_triage_status ?? undefined,
        anchor: parseJson(row.anchor_json),
        snapshot: decodeStoredEnvelope(row.snapshot_envelope_json, "snapshot"),
        body: decodeStoredEnvelope(row.body_envelope_json, "body"),
        bodyVersion: toNumber(row.body_version),
        edits: parseJson(row.edits_json),
        author: parseJson(row.author_json),
        state: row.state,
        flags: parseJson(row.flags_json),
        dispositions: parseJson(row.dispositions_json),
        parentCommentId: row.parent_comment_id ?? undefined,
        threadId: row.thread_id,
        evidence: row.evidence_json ? parseJson(row.evidence_json) : undefined,
        transitions: parseJson(row.transitions_json),
        tombstone: row.tombstone_json ? parseJson(row.tombstone_json) : undefined,
        fingerprint: row.fingerprint_json ? parseJson(row.fingerprint_json) : undefined,
        linkedRefs: row.linked_refs_json ? parseJson(row.linked_refs_json) : undefined,
        suggestedFix: row.suggested_fix_json ? parseJson(row.suggested_fix_json) : undefined,
        metadata: row.metadata_json ? parseJson(row.metadata_json) : undefined,
        createdAt: toNumber(row.created_at),
        updatedAt: toNumber(row.updated_at),
        serverRevision: toNumber(row.server_revision),
    });
}

function rowToEvent(row: ReviewCommentEventRow): ReviewCommentEventV1 {
    const structuralEvent = ReviewCommentEventV1Schema.parse({
        eventId: row.event_id,
        commentId: row.comment_id,
        accountId: row.account_id,
        reviewId: row.review_id ?? undefined,
        projectId: row.project_id ?? undefined,
        workspace: row.workspace_json ? parseJson(row.workspace_json) : undefined,
        eventKind: row.event_kind,
        actor: parseJson(row.actor_json),
        createdAt: toNumber(row.created_at),
        serverRevision: toNumber(row.server_revision),
        bulkActionId: row.bulk_action_id ?? undefined,
        authorDeviceId: row.author_device_id ?? undefined,
        clientLamport: row.client_lamport == null ? undefined : toNumber(row.client_lamport),
        event: row.client_mutation_id
            ? { clientMutationId: row.client_mutation_id }
            : {},
    });
    const rawEnvelope = parseJson(row.event_envelope_json);
    const bound = BoundReviewCommentEventSensitiveEnvelopeV1Schema.safeParse(rawEnvelope);
    if (!bound.success) {
        return ReviewCommentEventV1Schema.parse({
            ...structuralEvent,
            event: decodeStoredEnvelope(row.event_envelope_json, "event"),
        });
    }
    return decodeReviewCommentEventSensitiveFromStorage({
        event: structuralEvent,
        stored: bound.data,
    });
}


function canonicalCommentValues(comment: ReviewCommentStructuralV1, envelope: StoredJsonContentEnvelope, mode: "plain" | "e2ee") {
    assertEnvelopeStorageMode({ envelope, fieldName: "sensitive", storageMode: mode });
    const canonical = buildReviewCommentCanonicalStorageValues({ structural: comment, targetSensitiveEnvelope: envelope });
    return {
        ...canonical,
        flagsJson: stringifyJson(comment.flags),
        anchorFilePath: null,
        anchorFolderPath: null,
        authorJson: stringifyJson(comment.author),
        dispositionsJson: stringifyJson(comment.dispositions),
    };
}

function rowToSource(row: ReviewCommentRow): ReviewCommentStoredSourceV1 {
    return { structural: buildReviewCommentStructuralFromStorageRow(row), source: readReviewCommentMigrationSourceFromStorageRow(row) };
}

function canonicalSource(params: Pick<ReviewCommentCanonicalCommitParams, "comment" | "sensitiveEnvelope">): ReviewCommentStoredSourceV1 {
    return { structural: params.comment, source: { v: 1, layout: "canonical_v1", envelope: params.sensitiveEnvelope } };
}

async function openPlainSource(source: ReviewCommentStoredSourceV1): Promise<ReviewCommentV1> {
    const opened = await openReviewCommentSensitiveMigrationSourceV1(source);
    if (opened.status !== "available") throw new ReviewCommentOperationError("review_comment_encryption_mode_mismatch", "Review comment requires canonical client opening");
    return opened.comment;
}

function canonicalizePlainCommit(params: ReviewCommentStoreCommitParams): ReviewCommentCanonicalCommitParams {
    if (storageMode(params) !== "plain") throw new ReviewCommentOperationError("review_comment_encryption_mode_mismatch", "Encrypted comments require the canonical record transport");
    const split = splitReviewCommentV1(params.comment);
    return { ...params, comment: split.structural, sensitiveEnvelope: sealReviewCommentSensitiveEnvelopeV1({ ...split, mode: "plain" }) };
}

function resolveCanonicalCreateReplay(
    row: ReviewCommentRow,
    expectedRequestFingerprint: string,
): ReviewCommentCanonicalCreateResult {
    if (row.create_request_fingerprint !== expectedRequestFingerprint) {
        throw new ReviewCommentOperationError(
            "review_comment_idempotency_conflict",
            "Review comment create mutation was already used for a different request",
        );
    }
    return { comment: rowToSource(row), replayed: true };
}

function findingScopeKey(comment: Pick<ReviewCommentStructuralV1, "reviewId" | "findingIdentity" | "parentCommentId" | "workspace" | "projectId" | "sessionId">): string | null {
    if (!comment.findingIdentity || comment.parentCommentId) return null;
    return createHash("sha256").update(JSON.stringify(reviewCommentFindingScopeV1(comment))).digest("hex");
}

function findingLookupQuery(accountId: string, key: string, comment?: ReviewCommentStructuralV1): PrismaTypes.Sql {
    if (comment?.reviewId) return Prisma.sql`SELECT ${Prisma.raw(COMMENT_SELECT_COLUMNS)} FROM review_comments WHERE review_id = ${comment.reviewId} AND finding_identity = ${comment.findingIdentity} AND parent_comment_id IS NULL LIMIT 1`;
    return Prisma.sql`SELECT ${Prisma.raw(COMMENT_SELECT_COLUMNS)} FROM review_comments WHERE account_id = ${accountId} AND finding_scope_key = ${key} LIMIT 1`;
}

function commentAccessPredicate(params: Readonly<{ accountId: string; reviewAccess?: ReviewAccessCapability }>): PrismaTypes.Sql {
    return params.reviewAccess ? Prisma.sql`review_id = ${params.reviewAccess.reviewId}`
        : Prisma.sql`account_id = ${params.accountId} AND review_id IS NULL`;
}

function createMutationLookupQuery(accountId: string, createClientMutationId: string): PrismaTypes.Sql {
    return Prisma.sql`
        SELECT ${Prisma.raw(COMMENT_SELECT_COLUMNS)}
        FROM review_comments
        WHERE account_id = ${accountId} AND create_client_mutation_id = ${createClientMutationId}
        LIMIT 1
    `;
}

function appearanceSourceKey(appearance: ReviewCommentAppearanceInputV1): string {
    return createHash("sha256").update(JSON.stringify([appearance.runId, appearance.reviewerId, appearance.machineId ?? null, appearance.sessionId ?? null])).digest("hex");
}

async function recordAppearanceInTx(tx: Tx, appearance: ReviewCommentAppearanceV1, publish = true): Promise<void> {
    const insert = Prisma.sql`INSERT INTO review_comment_appearances (review_id, comment_id, round_ordinal, source_key, run_id, reviewer_id, machine_id, session_id)
        VALUES (${appearance.reviewId}, ${appearance.commentId}, ${appearance.roundOrdinal}, ${appearanceSourceKey(appearance)}, ${appearance.runId}, ${appearance.reviewerId}, ${appearance.machineId ?? null}, ${appearance.sessionId ?? null})`;
    const inserted = await tx.$executeRaw(getDbProviderFromEnv(process.env, "postgres") === "mysql"
        ? Prisma.sql`${insert} ON DUPLICATE KEY UPDATE source_key = source_key`
        : Prisma.sql`${insert} ON CONFLICT (comment_id, round_ordinal, source_key) DO NOTHING`);
    if (inserted > 0 && publish) {
        const rows = await tx.$queryRaw<ReviewCommentRow[]>(Prisma.sql`SELECT ${Prisma.raw(COMMENT_SELECT_COLUMNS)} FROM review_comments WHERE id = ${appearance.commentId} LIMIT 1`);
        if (rows[0]) await publishReviewCommentChangeInTx(tx, rowToSource(rows[0]).structural);
    }
}

/** Changed Review facts use the Artifact audience and its typed Review-kind invalidation. */
export async function publishReviewChangeInTx(tx: Tx, input: Readonly<{
    reviewId: string;
    commentChanges?: ReviewCommentChangesHintV1['changes'];
}>): Promise<void> {
    const accountIds = await resolveArtifactAudienceInTx(tx, input.reviewId);
    await markAccountsChanged(tx, { accountIds, kind: 'artifact', entityId: input.reviewId,
        hint: { artifactKinds: [deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 })],
            ...(input.commentChanges ? { reviewComments: { v: 1, changes: input.commentChanges } } : {}) } });
}

async function publishReviewCommentChangeInTx(tx: Tx, comment: ReviewCommentStructuralV1): Promise<void> {
    if (!comment.reviewId) return;
    await publishReviewChangeInTx(tx, { reviewId: comment.reviewId, commentChanges: [{
        commentId: comment.id, serverRevision: comment.serverRevision, state: comment.state,
        ...(comment.reviewTriageStatus ? { reviewTriageStatus: comment.reviewTriageStatus } : {}),
    }] });
}

/** Structural membership lookup for the Artifact admission owner; this grants no access. */
export async function readReviewCommentReviewIds(commentIds: readonly string[]): Promise<ReadonlyMap<string, string | null>> {
    if (commentIds.length === 0) return new Map();
    const rows = await db.$queryRaw<Array<{ id: string; review_id: string | null }>>(Prisma.sql`SELECT id, review_id FROM review_comments WHERE id IN (${Prisma.join(commentIds)})`);
    return new Map(rows.map((row) => [row.id, row.review_id]));
}

export async function readReviewCommentReviewId(commentId: string): Promise<string | null> {
    return (await readReviewCommentReviewIds([commentId])).get(commentId) ?? null;
}

export function createInMemoryReviewCommentStore(): ReviewCommentStore {
    const appearances = new Map<string, ReviewCommentAppearanceV1>();
    const recordAppearance = async (appearance: ReviewCommentAppearanceV1) => {
        appearances.set(JSON.stringify([appearance.reviewId, appearance.commentId, appearance.roundOrdinal, appearanceSourceKey(appearance)]), appearance);
    };
    const comments = new Map<string, ReviewCommentStructuralV1>();
    const sources = new Map<string, ReviewCommentStoredSourceV1>();
    const events = new Map<string, ReviewCommentEventV1[]>();
    const creates = new Map<string, Readonly<{ commentId: string; requestFingerprint: string }>>();
    const publicationClaims = new Map<string, ReviewCommentStoredPublicationClaim>();
    const projectAppearances = (items: readonly ReviewCommentStoredSourceV1[]) => {
        const grouped = new Map<string, ReviewCommentAppearanceInputV1[]>();
        for (const { reviewId: _reviewId, commentId, ...appearance } of appearances.values()) {
            const group = grouped.get(commentId) ?? [];
            group.push(appearance);
            grouped.set(commentId, group);
        }
        return items.map(item => item.structural.reviewId ? { ...item, structural: { ...item.structural, appearances: grouped.get(item.structural.id) ?? [] } } : item);
    };
    const readSource = (params: ReviewCommentStoreCommentParams) => params.reviewAccess
        ? [...sources.values()].find((item) => item.structural.id === params.commentId && item.structural.reviewId === params.reviewAccess!.reviewId) ?? null
        : sources.get(`${params.accountId}:${params.commentId}`)?.structural.reviewId ? null : sources.get(`${params.accountId}:${params.commentId}`) ?? null;
    const getSource = async (params: ReviewCommentStoreCommentParams) => {
        const item = readSource(params);
        return item ? projectAppearances([item])[0]! : null;
    };
    function findCreate(params: Readonly<{ reviewAccess?: ReviewAccessCapability; accountId: string; createClientMutationId: string; createRequestFingerprint: string; structural?: ReviewCommentStructuralV1 }>) {
        const existing = creates.get(`${params.reviewAccess?.ownerAccountId ?? params.accountId}:${params.createClientMutationId}`);
        if (existing) {
            if (existing.requestFingerprint !== params.createRequestFingerprint) throw new ReviewCommentOperationError("review_comment_idempotency_conflict", "Create mutation was already used for another request");
            return sources.get(`${params.reviewAccess?.ownerAccountId ?? params.accountId}:${existing.commentId}`) ?? null;
        }
        const key = params.structural ? findingScopeKey(params.structural) : null;
        return key ? [...sources.values()].find((item) => (params.structural?.reviewId || item.structural.accountId === params.accountId) && findingScopeKey(item.structural) === key) ?? null : null;
    }
    function persistCommit(params: ReviewCommentCanonicalCommitParams) {
        if (params.parentCurrentness && [...sources.values()].find((item) => item.structural.id === params.parentCurrentness!.commentId)?.structural.serverRevision !== params.parentCurrentness.serverRevision) throw new ReviewCommentOperationError("review_comment_conflict", "Review comment parent revision is stale");
        const key = `${params.comment.accountId}:${params.comment.id}`;
        const existing = sources.get(key);
        if ((existing && existing.structural.serverRevision !== params.comment.serverRevision - 1) || (!existing && params.comment.serverRevision !== 1)) throw new ReviewCommentOperationError("review_comment_conflict", "Review comment revision is stale");
        canonicalCommentValues(params.comment, params.sensitiveEnvelope, storageMode(params));
        const storedEvent = bindReviewCommentEventSensitiveForStorage({ event: params.event, requestBinding: params.requestBinding, eventEnvelope: params.eventEnvelope, storageMode: storageMode(params) });
        comments.set(key, params.comment);
        sources.set(key, canonicalSource(params));
        events.set(key, [...(events.get(key) ?? []), decodeReviewCommentEventSensitiveFromStorage({ event: params.event, stored: storedEvent })]);
    }
    async function persistCreate(params: ReviewCommentCanonicalCreateParams): Promise<ReviewCommentCanonicalCreateResult> {
        const replay = findCreate({ ...params, structural: params.comment });
        if (replay) {
            if (params.appearance && replay.structural.reviewId) await recordAppearance({ ...params.appearance, reviewId: replay.structural.reviewId, commentId: replay.structural.id });
            return { comment: replay, replayed: true };
        }
        persistCommit(params);
        creates.set(`${params.reviewAccess?.ownerAccountId ?? params.accountId}:${params.createClientMutationId}`, { commentId: params.comment.id, requestFingerprint: params.createRequestFingerprint });
        if (params.appearance && params.comment.reviewId) await recordAppearance({ ...params.appearance, reviewId: params.comment.reviewId, commentId: params.comment.id });
        return { comment: canonicalSource(params), replayed: false };
    }
    return {
        recordAppearance,
        async listAppearances(params) { return [...appearances.values()].filter((item) => item.reviewId === params.reviewId && (params.roundOrdinal === undefined || item.roundOrdinal === params.roundOrdinal)); },
        getSource,
        findCreate: async (params) => findCreate(params),
        createCanonical: persistCreate,
        commitCanonical: async (params) => persistCommit(params),
        async listSources(params) {
            if (params.filters.filePath || params.filters.folderPath || params.filters.severity || params.filters.taxonomyIds?.length) throw new ReviewCommentOperationError("review_comment_invalid_filter", "Sensitive filters require client-side opening");
            const visible = projectAppearances([...sources.values()].filter((item) => params.reviewAccess ? item.structural.reviewId === params.reviewAccess.reviewId : !item.structural.reviewId && item.structural.accountId === params.accountId));
            const result = applyReviewCommentListQuery(visible.map((item) => ({ ...item.structural, anchor: {} })), params.filters);
            const byId = new Map(visible.map(item => [item.structural.id, item]));
            return { items: result.items.map((item) => byId.get(item.id)!), cursor: result.cursor };
        },
        async get(params) { const item = await getSource(params); return item ? await openPlainSource(item) : null; },
        async list(params) {
            const opened = await Promise.all(projectAppearances([...sources.values()].filter((item) => params.reviewAccess ? item.structural.reviewId === params.reviewAccess.reviewId : !item.structural.reviewId && item.structural.accountId === params.accountId)).map(openPlainSource));
            return applyReviewCommentListQuery(opened, params.filters);
        },
        async listEvents(params) {
            const source = await getSource(params);
            return source ? events.get(`${source.structural.accountId}:${params.commentId}`) ?? [] : [];
        },
        async create(params) {
            const result = await persistCreate({ ...canonicalizePlainCommit(params), createClientMutationId: params.createClientMutationId, createRequestFingerprint: params.createRequestFingerprint });
            return { comment: await openPlainSource(result.comment), replayed: result.replayed };
        },
        async commit(params) { await persistCommit(canonicalizePlainCommit(params)); },
        async claimPublicationDispatch(params) {
            const claimKeys = [
                ...params.entries.map((entry) => `${params.accountId}:${entry.commentId}:${params.targetKey}`),
                ...(params.verdictPublicationCorrelationId === null
                    ? []
                    : [`${params.accountId}:verdict:${params.verdictPublicationCorrelationId}`]),
            ];
            const existingClaims = claimKeys
                .map((claimKey) => publicationClaims.get(claimKey))
                .filter((value): value is ReviewCommentStoredPublicationClaim => value !== undefined);
            if (existingClaims.length > 0) {
                const first = existingClaims[0]!;
                const sameLifecycle = existingClaims.every((claim) => (
                    claim.publicationPlanId === first.publicationPlanId
                    && stringifyJson(claim.lifecycle) === stringifyJson(first.lifecycle)
                ));
                if (existingClaims.length !== claimKeys.length
                    || !sameLifecycle
                    || first.publicationPlanId !== params.publicationPlanId) {
                    throw new ReviewCommentOperationError(
                        "review_comment_idempotency_conflict",
                        "A review comment is already claimed by a different publication plan",
                    );
                }
                if (params.settlement !== undefined) {
                    const lifecycle = first.lifecycle;
                    const mayRelease = params.settlement.dispatchToken !== null;
                    const mayResolveUncertainFailure = !mayRelease && lifecycle?.dispatchToken === null;
                    if (mayRelease && lifecycle?.dispatchToken !== params.settlement.dispatchToken) {
                        throw new ReviewCommentOperationError(
                            "review_comment_idempotency_conflict",
                            "The publication completion belongs to a stale dispatch",
                        );
                    }
                    const merged: ReviewCommentStoredPublicationLifecycle = {
                        dispatchToken: mayRelease
                            ? null
                            : lifecycle?.dispatchToken ?? null,
                        result: mergePublicationResult({
                            previous: lifecycle?.result ?? null,
                            candidate: params.settlement.result,
                            mayRelease,
                            mayResolveUncertainFailure,
                        }),
                    };
                    const settled = { publicationPlanId: params.publicationPlanId, lifecycle: merged };
                    claimKeys.forEach((claimKey) => publicationClaims.set(claimKey, settled));
                    return publicationClaimResult({
                        publicationPlanId: params.publicationPlanId,
                        entryCount: params.entries.length,
                        hasVerdict: params.verdictPublicationCorrelationId !== null,
                        lifecycle: merged,
                        allowDispatch: false,
                    });
                }
                const current = publicationClaimResult({
                    publicationPlanId: params.publicationPlanId,
                    entryCount: params.entries.length,
                    hasVerdict: params.verdictPublicationCorrelationId !== null,
                    lifecycle: first.lifecycle,
                    allowDispatch: true,
                });
                if (current.disposition === "dispatch") {
                    const retried: ReviewCommentStoredPublicationClaim = {
                        publicationPlanId: params.publicationPlanId,
                        lifecycle: {
                            dispatchToken: params.dispatchToken,
                            result: first.lifecycle?.result ?? null,
                        },
                    };
                    claimKeys.forEach((claimKey) => publicationClaims.set(claimKey, retried));
                    return { ...current, dispatchToken: params.dispatchToken };
                }
                return current;
            }
            if (params.settlement !== undefined) {
                throw new ReviewCommentOperationError(
                    "review_comment_idempotency_conflict",
                    "Publication completion has no matching dispatch claim",
                );
            }
            for (const expected of params.entries) {
                const comment = params.reviewAccess
                    ? [...comments.values()].find(item => item.id === expected.commentId && item.reviewId === params.reviewAccess!.reviewId)
                    : comments.get(`${params.accountId}:${expected.commentId}`);
                if (!comment || comment.serverRevision !== expected.serverRevision) {
                    throw new ReviewCommentOperationError(
                        "review_comment_conflict",
                        `Review comment changed before publication: ${expected.commentId}`,
                    );
                }
            }
            const claimed: ReviewCommentStoredPublicationClaim = {
                publicationPlanId: params.publicationPlanId,
                lifecycle: { dispatchToken: params.dispatchToken, result: null },
            };
            claimKeys.forEach((claimKey) => publicationClaims.set(claimKey, claimed));
            return initialPublicationClaimResult({
                publicationPlanId: params.publicationPlanId,
                dispatchToken: params.dispatchToken,
                entryCount: params.entries.length,
                hasVerdict: params.verdictPublicationCorrelationId !== null,
            });
        },
    };
}

function eventClientMutationId(event: ReviewCommentEventV1): string | null {
    const value = event.event.clientMutationId;
    return typeof value === "string" ? value : null;
}

function structuralJsonText(column: "author_json" | "flags_json", key: string): PrismaTypes.Sql {
    const provider = getDbProviderFromEnv(process.env, "postgres");
    const field = Prisma.raw(column);
    if (provider === "sqlite") return Prisma.sql`json_extract(${field}, ${`$.${key}`})`;
    if (provider === "mysql") return Prisma.sql`JSON_UNQUOTE(JSON_EXTRACT(${field}, ${`$.${key}`}))`;
    return Prisma.sql`CAST(${field} AS jsonb)->>${key}`;
}

function buildWhere(params: ReviewCommentStoreListParams): PrismaTypes.Sql[] {
    const filters = normalizeReviewCommentListFilters(params.filters);
    const where = [commentAccessPredicate(params)];
    if (filters.reviewId) where.push(Prisma.sql`review_id = ${filters.reviewId}`);
    if (filters.commentIds !== undefined) where.push(filters.commentIds.length > 0
        ? Prisma.sql`id IN (${Prisma.join(filters.commentIds)})` : Prisma.sql`1 = 0`);
    const byAppearance = Boolean(params.reviewAccess && (filters.roundOrdinal || filters.runId || filters.sessionId || filters.engineId));
    if (filters.roundOrdinal && !params.reviewAccess) where.push(Prisma.sql`1 = 0`);
    if (!byAppearance && filters.projectId) where.push(Prisma.sql`project_id = ${filters.projectId}`);
    if (!byAppearance && filters.workspace) where.push(Prisma.sql`workspace_json = ${stringifyJson({ machineId: filters.workspace.machineId, path: filters.workspace.path })}`);
    if (filters.workspaceId) where.push(Prisma.sql`workspace_id = ${filters.workspaceId}`);
    if (byAppearance) {
        const appearanceWhere = [Prisma.sql`appearance.review_id = ${params.reviewAccess!.reviewId}`];
        const attachedWhere = [Prisma.sql`review_id = ${params.reviewAccess!.reviewId} AND round_ordinal IS NOT NULL`];
        if (filters.roundOrdinal) attachedWhere.push(Prisma.sql`round_ordinal = ${filters.roundOrdinal}`);
        if (filters.runId) attachedWhere.push(Prisma.sql`run_id = ${filters.runId}`);
        if (filters.sessionId) attachedWhere.push(Prisma.sql`session_id = ${filters.sessionId}`);
        if (filters.engineId) attachedWhere.push(Prisma.sql`engine_id = ${filters.engineId}`);
        if (filters.workspace) attachedWhere.push(Prisma.sql`workspace_json = ${stringifyJson({ machineId: filters.workspace.machineId, path: filters.workspace.path })}`);
        if (filters.roundOrdinal) appearanceWhere.push(Prisma.sql`appearance.round_ordinal = ${filters.roundOrdinal}`);
        if (filters.runId) appearanceWhere.push(Prisma.sql`appearance.run_id = ${filters.runId}`);
        if (filters.sessionId) appearanceWhere.push(Prisma.sql`appearance.session_id = ${filters.sessionId}`);
        if (filters.engineId) appearanceWhere.push(Prisma.sql`appearance.reviewer_id = ${filters.engineId}`);
        if (filters.workspace) appearanceWhere.push(Prisma.sql`appearance.machine_id = ${filters.workspace.machineId}`);
        where.push(Prisma.sql`id IN (SELECT id FROM review_comments WHERE ${Prisma.join(attachedWhere, ' AND ')}
            UNION SELECT appearance.comment_id FROM review_comment_appearances appearance WHERE ${Prisma.join(appearanceWhere, ' AND ')})`);
    } else {
        if (filters.sessionId) where.push(Prisma.sql`session_id = ${filters.sessionId}`);
        if (filters.runId) where.push(Prisma.sql`run_id = ${filters.runId}`);
        if (filters.engineId) where.push(Prisma.sql`engine_id = ${filters.engineId}`);
    }
    if (filters.states.length === 1) {
        where.push(Prisma.sql`state = ${filters.states[0]}`);
    } else if (filters.states.length > 1) {
        where.push(Prisma.sql`state IN (${Prisma.join(filters.states)})`);
    }
    if (!filters.includeHistory) {
        where.push(Prisma.sql`state NOT IN ('resolved', 'dismissed') AND tombstone_json IS NULL`);
        const redacted = structuralJsonText("flags_json", "redacted");
        where.push(getDbProviderFromEnv(process.env, "postgres") === "sqlite"
            ? Prisma.sql`COALESCE(${redacted}, 0) <> 1`
            : Prisma.sql`COALESCE(${redacted}, 'false') <> 'true'`);
    }
    if (filters.authorKind) where.push(Prisma.sql`${structuralJsonText("author_json", "kind")} = ${filters.authorKind}`);
    if (filters.authorId) where.push(Prisma.sql`COALESCE(${structuralJsonText("author_json", "userId")}, ${structuralJsonText("author_json", "pluginId")}, ${structuralJsonText("author_json", "agentId")}, ${structuralJsonText("author_json", "runId")}) = ${filters.authorId}`);
    return where;
}

async function readCommentRows(params: ReviewCommentStoreListParams): Promise<ReviewCommentRow[]> {
    const filters = normalizeReviewCommentListFilters(params.filters);
    const position = readReviewCommentListCursorPosition(filters);
    const where = buildWhere(params);
    if (position) where.push(Prisma.sql`(updated_at < ${position.updatedAt}
        OR (updated_at = ${position.updatedAt} AND server_revision < ${position.serverRevision})
        OR (updated_at = ${position.updatedAt} AND server_revision = ${position.serverRevision} AND id < ${position.id}))`);
    return await db.$queryRaw<ReviewCommentRow[]>(Prisma.sql`
        SELECT ${Prisma.raw(COMMENT_SELECT_COLUMNS)}
        FROM review_comments
        WHERE ${Prisma.join(where, " AND ")}
        ORDER BY updated_at DESC, server_revision DESC, id DESC
        LIMIT ${filters.limit + 1}
    `);
}

async function sourcesWithAppearances(rows: readonly ReviewCommentRow[]): Promise<ReviewCommentStoredSourceV1[]> {
    const sources = rows.map(rowToSource);
    const ids = sources.filter(source => source.structural.reviewId).map(source => source.structural.id);
    if (ids.length === 0) return sources;
    const appearances = await db.reviewCommentAppearance.findMany({ where: { commentId: { in: ids } },
        select: { commentId: true, roundOrdinal: true, runId: true, reviewerId: true, machineId: true, sessionId: true },
        orderBy: [{ roundOrdinal: 'asc' }, { sourceKey: 'asc' }] });
    const byComment = new Map<string, ReviewCommentAppearanceInputV1[]>();
    for (const appearance of appearances) {
        const entries = byComment.get(appearance.commentId) ?? [];
        entries.push({ roundOrdinal: appearance.roundOrdinal, runId: appearance.runId, reviewerId: appearance.reviewerId,
            ...(appearance.machineId ? { machineId: appearance.machineId } : {}), ...(appearance.sessionId ? { sessionId: appearance.sessionId } : {}) });
        byComment.set(appearance.commentId, entries);
    }
    return sources.map(source => source.structural.reviewId
        ? { ...source, structural: { ...source.structural, appearances: byComment.get(source.structural.id) ?? [] } } : source);
}

export function createSqlReviewCommentStore(): ReviewCommentStore {
    async function persistAppearance(appearance: ReviewCommentAppearanceV1): Promise<void> {
        await inTx(async (tx) => {
            await acquireArtifactPublicationLocksInTx(tx, appearance.reviewId);
            await recordAppearanceInTx(tx, appearance);
        });
    }

    async function persistCreate(params: ReviewCommentCanonicalCreateParams): Promise<ReviewCommentCanonicalCreateResult> {
            const comment = ReviewCommentStructuralV1Schema.parse(params.comment);
            const event = ReviewCommentEventV1Schema.parse(params.event);
            const mode = storageMode(params);
            const values = canonicalCommentValues(comment, params.sensitiveEnvelope, mode);
            const eventEnvelopeJson = stringifyJson(bindReviewCommentEventSensitiveForStorage({
                event,
                requestBinding: params.requestBinding,
                eventEnvelope: params.eventEnvelope,
                storageMode: mode,
            }));
            try {
                return await inTx(async (tx) => {
                    if (comment.reviewId) await acquireArtifactPublicationLocksInTx(tx, comment.reviewId);
                    await assertReviewCommentAccountWriteCurrentnessInTx(tx, {
                        accountId: params.reviewAccess?.ownerAccountId ?? params.accountId,
                        storageMode: mode,
                        accountVersion: params.accountVersion,
                        accountEncryptionCurrentness:
                            params.reviewAccess ? undefined : params.accountEncryptionCurrentness,
                    });
                    const existingRows = await tx.$queryRaw<ReviewCommentRow[]>(
                        createMutationLookupQuery(params.reviewAccess?.ownerAccountId ?? params.accountId, params.createClientMutationId),
                    );
                    const existing = existingRows[0];
                    if (existing) {
                        const replay = resolveCanonicalCreateReplay(existing, params.createRequestFingerprint);
                        if (params.appearance && replay.comment.structural.reviewId) await recordAppearanceInTx(tx, { ...params.appearance, reviewId: replay.comment.structural.reviewId, commentId: replay.comment.structural.id });
                        return replay;
                    }

                    const key = findingScopeKey(comment);
                    if (key) {
                        const rows = await tx.$queryRaw<ReviewCommentRow[]>(findingLookupQuery(params.accountId, key, comment));
                        if (rows[0]) {
                            const found = rowToSource(rows[0]);
                            if (params.appearance && found.structural.reviewId) await recordAppearanceInTx(tx, { ...params.appearance, reviewId: found.structural.reviewId, commentId: found.structural.id });
                            return { comment: found, replayed: true };
                        }
                    }
                    await tx.reviewComment.create({
                        data: {
                            id: comment.id,
                            accountId: comment.accountId,
                            reviewId: comment.reviewId,
                            roundOrdinal: comment.roundOrdinal,
                            projectId: comment.projectId ?? null,
                            workspaceJson: stringifyOptionalJson(comment.workspace),
                            findingIdentity: comment.findingIdentity,
                            findingSeverity: comment.findingSeverity,
                            reviewedFingerprint: comment.reviewedFingerprint,
                            reviewTriageStatus: comment.reviewTriageStatus,
                            findingScopeKey: comment.reviewId ? null : key,
                            workspaceId: comment.workspaceId,
                            sessionId: comment.sessionId,
                            runId: comment.runId,
                            engineId: comment.engineId,
                            findingId: comment.findingId,
                            createClientMutationId: params.createClientMutationId,
                            createRequestFingerprint: params.createRequestFingerprint,
                            threadId: comment.threadId,
                            parentCommentId: comment.parentCommentId,
                            state: comment.state,
                            flagsJson: values.flagsJson,
                            anchorJson: values.anchorJson,
                            anchorFilePath: values.anchorFilePath,
                            anchorFolderPath: values.anchorFolderPath,
                            snapshotEnvelopeJson: values.snapshotEnvelopeJson,
                            bodyEnvelopeJson: values.bodyEnvelopeJson,
                            bodyVersion: comment.bodyVersion,
                            authorJson: values.authorJson,
                            editsJson: values.editsJson,
                            dispositionsJson: values.dispositionsJson,
                            evidenceJson: values.evidenceJson,
                            transitionsJson: values.transitionsJson,
                            fingerprintJson: values.fingerprintJson,
                            linkedRefsJson: values.linkedRefsJson,
                            suggestedFixJson: values.suggestedFixJson,
                            metadataJson: values.metadataJson,
                            tombstoneJson: values.tombstoneJson,
                            serverRevision: comment.serverRevision,
                            createdAt: BigInt(comment.createdAt),
                            updatedAt: BigInt(comment.updatedAt),
                        },
                    });
                    await tx.$executeRaw(Prisma.sql`
                        INSERT INTO review_comment_events (
                            event_id, comment_id, account_id, project_id, workspace_json, event_kind, event_envelope_json,
                            bulk_action_id, client_mutation_id, actor_json, author_device_id, client_lamport,
                            server_revision, created_at
                        ) VALUES (
                            ${event.eventId}, ${event.commentId}, ${event.accountId}, ${event.projectId ?? null}, ${stringifyOptionalJson(event.workspace)},
                            ${event.eventKind}, ${eventEnvelopeJson}, ${event.bulkActionId ?? null},
                            ${eventClientMutationId(event)}, ${stringifyJson(event.actor)},
                            ${event.authorDeviceId ?? null}, ${event.clientLamport ?? null},
                            ${event.serverRevision}, ${event.createdAt}
                        )
                    `);
                    if (params.appearance && comment.reviewId) await recordAppearanceInTx(tx, { ...params.appearance, reviewId: comment.reviewId, commentId: comment.id }, false);
                    await publishReviewCommentChangeInTx(tx, comment);
                    return { comment: canonicalSource(params), replayed: false };
                });
            } catch (error) {
                if (!isPrismaErrorCode(error, "P2002")) throw error;
                const racedRows = await db.$queryRaw<ReviewCommentRow[]>(
                    createMutationLookupQuery(params.reviewAccess?.ownerAccountId ?? params.accountId, params.createClientMutationId),
                );
                const raced = racedRows[0];
                if (!raced) {
                    const key = findingScopeKey(comment);
                    const rows = key ? await db.$queryRaw<ReviewCommentRow[]>(findingLookupQuery(params.accountId, key, comment)) : [];
                    if (rows[0]) {
                        const found = rowToSource(rows[0]);
                        if (params.appearance && found.structural.reviewId) await persistAppearance({ ...params.appearance, reviewId: found.structural.reviewId, commentId: found.structural.id });
                        return { comment: found, replayed: true };
                    }
                    throw error;
                }
                const replay = resolveCanonicalCreateReplay(raced, params.createRequestFingerprint);
                if (params.appearance && replay.comment.structural.reviewId) await persistAppearance({ ...params.appearance, reviewId: replay.comment.structural.reviewId, commentId: replay.comment.structural.id });
                return replay;
            }
    }

    async function persistCommit(params: ReviewCommentCanonicalCommitParams): Promise<void> {
            const comment = ReviewCommentStructuralV1Schema.parse(params.comment);
            const event = ReviewCommentEventV1Schema.parse(params.event);
            await inTx(async (tx) => {
                if (comment.reviewId) await acquireArtifactPublicationLocksInTx(tx, comment.reviewId);
                const mode = storageMode(params);
                await assertReviewCommentAccountWriteCurrentnessInTx(tx, {
                    accountId: params.reviewAccess?.ownerAccountId ?? params.accountId,
                    storageMode: mode,
                    accountVersion: params.accountVersion,
                    accountEncryptionCurrentness:
                        params.reviewAccess ? undefined : params.accountEncryptionCurrentness,
                });
                if (params.parentCurrentness) {
                    const parents = await tx.$queryRaw<Array<{ server_revision: number | bigint }>>(Prisma.sql`SELECT server_revision FROM review_comments WHERE ${commentAccessPredicate(params)} AND id = ${params.parentCurrentness.commentId} LIMIT 1`);
                    if (!parents[0] || toNumber(parents[0].server_revision) !== params.parentCurrentness.serverRevision) throw new ReviewCommentOperationError("review_comment_conflict", "Review comment parent revision is stale");
                }
                const existingRows = await tx.$queryRaw<Array<{ server_revision: number | bigint }>>(Prisma.sql`
                    SELECT server_revision
                    FROM review_comments
                    WHERE ${commentAccessPredicate(params)} AND id = ${comment.id}
                    LIMIT 1
                `);
                const existing = existingRows[0];
                if (!existing && comment.serverRevision !== 1) {
                    throw new ReviewCommentOperationError(
                        "review_comment_conflict",
                        "Cannot create a review comment at a non-initial serverRevision",
                    );
                }
                if (existing && toNumber(existing.server_revision) !== comment.serverRevision - 1) {
                    throw new ReviewCommentOperationError(
                        "review_comment_conflict",
                        "Review comment serverRevision is stale",
                    );
                }

                const values = canonicalCommentValues(comment, params.sensitiveEnvelope, mode);

                if (existing) {
                    const updated = await tx.$executeRaw(Prisma.sql`
                        UPDATE review_comments
                        SET review_id = ${comment.reviewId ?? null},
                            round_ordinal = ${comment.roundOrdinal ?? null},
                            project_id = ${comment.projectId ?? null},
                            workspace_json = ${stringifyOptionalJson(comment.workspace)},
                            finding_identity = ${comment.findingIdentity ?? null},
                            finding_severity = ${comment.findingSeverity ?? null},
                            reviewed_fingerprint = ${comment.reviewedFingerprint ?? null},
                            review_triage_status = ${comment.reviewTriageStatus ?? null},
                            workspace_id = ${comment.workspaceId ?? null},
                            session_id = ${comment.sessionId ?? null},
                            run_id = ${comment.runId ?? null},
                            engine_id = ${comment.engineId ?? null},
                            finding_id = ${comment.findingId ?? null},
                            thread_id = ${comment.threadId},
                            parent_comment_id = ${comment.parentCommentId ?? null},
                            state = ${comment.state},
                            flags_json = ${values.flagsJson},
                            anchor_json = ${values.anchorJson},
                            anchor_file_path = ${values.anchorFilePath},
                            anchor_folder_path = ${values.anchorFolderPath},
                            snapshot_envelope_json = ${values.snapshotEnvelopeJson},
                            body_envelope_json = ${values.bodyEnvelopeJson},
                            body_version = ${comment.bodyVersion},
                            author_json = ${values.authorJson},
                            edits_json = ${values.editsJson},
                            dispositions_json = ${values.dispositionsJson},
                            evidence_json = ${values.evidenceJson},
                            transitions_json = ${values.transitionsJson},
                            fingerprint_json = ${values.fingerprintJson},
                            linked_refs_json = ${values.linkedRefsJson},
                            suggested_fix_json = ${values.suggestedFixJson},
                            metadata_json = ${values.metadataJson},
                            tombstone_json = ${values.tombstoneJson},
                            server_revision = ${comment.serverRevision},
                            updated_at = ${comment.updatedAt}
                        WHERE ${commentAccessPredicate(params)} AND id = ${comment.id} AND server_revision = ${comment.serverRevision - 1}
                    `);
                    if (updated !== 1) throw new ReviewCommentOperationError("review_comment_conflict", "Review comment serverRevision changed before persistence");
                } else {
                    await tx.$executeRaw(Prisma.sql`
                        INSERT INTO review_comments (
                            id, account_id, review_id, round_ordinal, project_id, workspace_json, finding_identity, finding_severity, reviewed_fingerprint, review_triage_status, workspace_id, session_id, run_id, engine_id,
                            finding_id, thread_id, parent_comment_id, state, flags_json, anchor_json,
                            anchor_file_path, anchor_folder_path, snapshot_envelope_json, body_envelope_json,
                            body_version, author_json, edits_json, dispositions_json, evidence_json,
                            transitions_json, fingerprint_json, linked_refs_json, suggested_fix_json,
                            metadata_json, tombstone_json, server_revision, created_at, updated_at
                        ) VALUES (
                            ${comment.id}, ${comment.accountId}, ${comment.reviewId ?? null}, ${comment.roundOrdinal ?? null}, ${comment.projectId ?? null}, ${stringifyOptionalJson(comment.workspace)},
                            ${comment.findingIdentity ?? null}, ${comment.findingSeverity ?? null}, ${comment.reviewedFingerprint ?? null}, ${comment.reviewTriageStatus ?? null}, ${comment.workspaceId ?? null},
                            ${comment.sessionId ?? null}, ${comment.runId ?? null}, ${comment.engineId ?? null},
                            ${comment.findingId ?? null}, ${comment.threadId}, ${comment.parentCommentId ?? null},
                            ${comment.state}, ${values.flagsJson}, ${values.anchorJson}, ${values.anchorFilePath},
                            ${values.anchorFolderPath}, ${values.snapshotEnvelopeJson}, ${values.bodyEnvelopeJson},
                            ${comment.bodyVersion}, ${values.authorJson}, ${values.editsJson},
                            ${values.dispositionsJson}, ${values.evidenceJson}, ${values.transitionsJson},
                            ${values.fingerprintJson}, ${values.linkedRefsJson}, ${values.suggestedFixJson},
                            ${values.metadataJson}, ${values.tombstoneJson}, ${comment.serverRevision},
                            ${comment.createdAt}, ${comment.updatedAt}
                        )
                    `);
                }

                await tx.$executeRaw(Prisma.sql`
                    INSERT INTO review_comment_events (
                        event_id, comment_id, account_id, project_id, workspace_json, event_kind, event_envelope_json,
                        bulk_action_id, client_mutation_id, actor_json, author_device_id, client_lamport,
                        server_revision, created_at
                    ) VALUES (
                        ${event.eventId}, ${event.commentId}, ${event.accountId}, ${event.projectId ?? null}, ${stringifyOptionalJson(event.workspace)},
                        ${event.eventKind}, ${stringifyJson(bindReviewCommentEventSensitiveForStorage({
                            event,
                            requestBinding: params.requestBinding,
                            eventEnvelope: params.eventEnvelope,
                            storageMode: mode,
                        }))}, ${event.bulkActionId ?? null},
                        ${eventClientMutationId(event)}, ${stringifyJson(event.actor)}, ${event.authorDeviceId ?? null},
                        ${event.clientLamport ?? null}, ${event.serverRevision}, ${event.createdAt}
                    )
                `);
                await publishReviewCommentChangeInTx(tx, comment);
            });
    }

    return {
        recordAppearance: persistAppearance,
        async listAppearances(params) {
            const rows = await db.$queryRaw<Array<{ review_id: string; comment_id: string; round_ordinal: number; run_id: string; reviewer_id: string; machine_id: string | null; session_id: string | null }>>(Prisma.sql`
                SELECT review_id, comment_id, round_ordinal, run_id, reviewer_id, machine_id, session_id FROM review_comment_appearances
                WHERE review_id = ${params.reviewId} ${params.roundOrdinal === undefined ? Prisma.empty : Prisma.sql`AND round_ordinal = ${params.roundOrdinal}`}
                ORDER BY round_ordinal, comment_id, source_key`);
            return rows.map((row) => ({ reviewId: row.review_id, commentId: row.comment_id, roundOrdinal: row.round_ordinal,
                runId: row.run_id, reviewerId: row.reviewer_id, ...(row.machine_id ? { machineId: row.machine_id } : {}), ...(row.session_id ? { sessionId: row.session_id } : {}) }));
        },
        async getSource(params) {
            const rows = await db.$queryRaw<ReviewCommentRow[]>(Prisma.sql`SELECT ${Prisma.raw(COMMENT_SELECT_COLUMNS)} FROM review_comments WHERE ${commentAccessPredicate(params)} AND id = ${params.commentId} LIMIT 1`);
            return (await sourcesWithAppearances(rows))[0] ?? null;
        },
        async listSources(params) {
            if (params.filters.filePath || params.filters.folderPath || params.filters.severity || params.filters.taxonomyIds?.length) throw new ReviewCommentOperationError("review_comment_invalid_filter", "Sensitive filters require client-side opening");
            const sources = await sourcesWithAppearances(await readCommentRows(params));
            const views = sources.map((item) => ({ ...item.structural, anchor: {} }));
            const result = pageReviewCommentListCandidates(views, params.filters);
            const byId = new Map(sources.map((item) => [item.structural.id, item]));
            return { items: result.items.map((item) => byId.get(item.id)!), cursor: result.cursor };
        },
        async findCreate(params) {
            const rows = await db.$queryRaw<ReviewCommentRow[]>(createMutationLookupQuery(params.reviewAccess?.ownerAccountId ?? params.accountId, params.createClientMutationId));
            if (rows[0]) return resolveCanonicalCreateReplay(rows[0], params.createRequestFingerprint).comment;
            const key = params.structural ? findingScopeKey(params.structural) : null;
            const findings = key ? await db.$queryRaw<ReviewCommentRow[]>(findingLookupQuery(params.accountId, key, params.structural)) : [];
            return findings[0] ? rowToSource(findings[0]) : null;
        },
        async get(params) {
            const rows = await db.$queryRaw<ReviewCommentRow[]>(Prisma.sql`
                SELECT ${Prisma.raw(COMMENT_SELECT_COLUMNS)}
                FROM review_comments
                WHERE ${commentAccessPredicate(params)} AND id = ${params.commentId}
                LIMIT 1
            `);
            const row = rows[0];
            return row ? openPlainSource((await sourcesWithAppearances([row]))[0]!) : null;
        },
        async list(params) {
            const rows = await readCommentRows(params);
            const page = pageReviewCommentListCandidates(await Promise.all((await sourcesWithAppearances(rows)).map(openPlainSource)), params.filters);
            return { items: page.items.filter((comment) => matchesReviewCommentListFilters(comment, params.filters)), cursor: page.cursor };
        },
        async listEvents(params) {
            // SQLite stores int64 values even in an INTEGER-declared column, but Prisma
            // decodes that declaration as int32. Project epoch milliseconds as a JS number.
            const createdAt = getDbProviderFromEnv(process.env, "postgres") === "sqlite"
                ? Prisma.sql`CAST(created_at AS REAL) AS created_at`
                : Prisma.sql`created_at`;
            const rows = await db.$queryRaw<ReviewCommentEventRow[]>(Prisma.sql`
                SELECT event_id, comment_id, account_id, (SELECT review_id FROM review_comments WHERE id = comment_id) AS review_id, project_id, workspace_json, event_kind, event_envelope_json,
                    bulk_action_id, client_mutation_id, actor_json, author_device_id, client_lamport,
                    server_revision, ${createdAt}
                FROM review_comment_events
                WHERE comment_id = ${params.commentId} AND comment_id IN (SELECT id FROM review_comments WHERE ${commentAccessPredicate(params)})
                ORDER BY server_revision ASC
            `);
            return rows.map(rowToEvent);
        },
        async create(params) {
            const result = await persistCreate({ ...canonicalizePlainCommit(params), createClientMutationId: params.createClientMutationId, createRequestFingerprint: params.createRequestFingerprint });
            return { comment: await openPlainSource(result.comment), replayed: result.replayed };
        },
        async commit(params) { await persistCommit(canonicalizePlainCommit(params)); },
        createCanonical: persistCreate,
        commitCanonical: persistCommit,
        async claimPublicationDispatch(params) {
            const expectedCorrelations = [
                ...params.entries.map((entry) => entry.publicationCorrelationId),
                ...(params.verdictPublicationCorrelationId === null ? [] : [params.verdictPublicationCorrelationId]),
            ];
            const provider = getDbProviderFromEnv(process.env, "postgres");
            const lockClause = provider === "sqlite" ? Prisma.empty : Prisma.sql`FOR UPDATE`;
            const assertPublicationAccountCurrent = async (tx: Tx) => {
                const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, params.accountId, "content");
                if (fence.status !== "ready"
                    || fence.account.currentness.encryptionMode !== params.storageMode
                    || (params.storageMode === "e2ee"
                        && fence.account.currentness.contentPublicKeyFingerprint !== params.contentPublicKeyFingerprint)) {
                    throw new ReviewCommentOperationError("review_comment_encryption_mode_mismatch",
                        "Publication Account encryption state changed before persistence");
                }
            };
            const resolveExistingInTx = async (tx: Tx, options: Readonly<{
                settlement: ReviewCommentStorePublicationClaimParams["settlement"];
                allowAbsent?: boolean;
            }>): Promise<ReviewCommentStorePublicationClaimResult | null> => {
                await assertPublicationAccountCurrent(tx);
                const rows = await tx.$queryRaw<Array<{
                    publication_correlation_id: string;
                    target_json: string;
                }>>(Prisma.sql`
                    SELECT publication_correlation_id, target_json
                    FROM review_comment_publication_correlations
                    WHERE account_id = ${params.accountId}
                        AND publication_correlation_id IN (${Prisma.join(expectedCorrelations)})
                    ${lockClause}
                `);
                if (rows.length === 0 && options.allowAbsent) return null;
                const parsed = rows.map((row) => parseStoredPublicationClaim(row.target_json));
                const first = parsed[0] ?? null;
                const sameLifecycle = first !== null && parsed.every((claim) => (
                    claim !== null
                    && claim.publicationPlanId === first.publicationPlanId
                    && stringifyJson(claim.lifecycle) === stringifyJson(first.lifecycle)
                ));
                if (first === null
                    || rows.length !== expectedCorrelations.length
                    || !sameLifecycle
                    || first.publicationPlanId !== params.publicationPlanId) {
                    throw new ReviewCommentOperationError(
                        "review_comment_idempotency_conflict",
                        "A review comment is already claimed by a different publication plan",
                    );
                }
                if (options.settlement !== undefined) {
                    const mayRelease = options.settlement.dispatchToken !== null;
                    const mayResolveUncertainFailure = !mayRelease && first.lifecycle?.dispatchToken === null;
                    if (mayRelease && first.lifecycle?.dispatchToken !== options.settlement.dispatchToken) {
                        throw new ReviewCommentOperationError(
                            "review_comment_idempotency_conflict",
                            "The publication completion belongs to a stale dispatch",
                        );
                    }
                    const lifecycle: ReviewCommentStoredPublicationLifecycle = {
                        dispatchToken: mayRelease
                            ? null
                            : first.lifecycle?.dispatchToken ?? null,
                        result: mergePublicationResult({
                            previous: first.lifecycle?.result ?? null,
                            candidate: options.settlement.result,
                            mayRelease,
                            mayResolveUncertainFailure,
                        }),
                    };
                    const storedClaim = stringifyJson({
                        v: 1,
                        publicationPlanId: params.publicationPlanId,
                        lifecycle,
                    });
                    await tx.$executeRaw(Prisma.sql`
                        UPDATE review_comment_publication_correlations
                        SET target_json = ${storedClaim}
                        WHERE account_id = ${params.accountId}
                            AND publication_correlation_id IN (${Prisma.join(expectedCorrelations)})
                    `);
                    return publicationClaimResult({
                        publicationPlanId: params.publicationPlanId,
                        entryCount: params.entries.length,
                        hasVerdict: params.verdictPublicationCorrelationId !== null,
                        lifecycle,
                        allowDispatch: false,
                    });
                }
                const current = publicationClaimResult({
                    publicationPlanId: params.publicationPlanId,
                    entryCount: params.entries.length,
                    hasVerdict: params.verdictPublicationCorrelationId !== null,
                    lifecycle: first.lifecycle,
                    allowDispatch: true,
                });
                if (current.disposition !== "dispatch") return current;
                const lifecycle: ReviewCommentStoredPublicationLifecycle = {
                    dispatchToken: params.dispatchToken,
                    result: first.lifecycle?.result ?? null,
                };
                const storedClaim = stringifyJson({
                    v: 1,
                    publicationPlanId: params.publicationPlanId,
                    lifecycle,
                });
                await tx.$executeRaw(Prisma.sql`
                    UPDATE review_comment_publication_correlations
                    SET target_json = ${storedClaim}
                    WHERE account_id = ${params.accountId}
                        AND publication_correlation_id IN (${Prisma.join(expectedCorrelations)})
                `);
                return { ...current, dispatchToken: params.dispatchToken };
            };
            try {
                return await inTx(async (tx) => {
                    // Account-first fencing keeps lookup and first admission atomic
                    // with other claimants and encryption transitions.
                    const existing = await resolveExistingInTx(tx, {
                        settlement: params.settlement,
                        allowAbsent: params.settlement === undefined,
                    });
                    if (existing !== null) return existing;
                    if (params.entries.length > 0) {
                        const expectedRows = Prisma.join(params.entries.map((entry) => Prisma.sql`
                            (id = ${entry.commentId} AND server_revision = ${entry.serverRevision})
                        `), " OR ");
                        const matched = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
                            SELECT id
                            FROM review_comments
                            WHERE ${commentAccessPredicate(params)}
                                AND (${expectedRows})
                            ${lockClause}
                        `);
                        if (matched.length !== params.entries.length) {
                            throw new ReviewCommentOperationError(
                                "review_comment_conflict",
                                "One or more review comments changed before publication",
                            );
                        }
                    }
                    const storedClaim = stringifyJson({
                        v: 1,
                        publicationPlanId: params.publicationPlanId,
                        lifecycle: {
                            dispatchToken: params.dispatchToken,
                            result: null,
                        },
                    });
                    const claimRows = Prisma.join([
                        ...params.entries.map((entry) => Prisma.sql`
                            (
                                ${entry.publicationCorrelationId}, ${params.accountId}, ${entry.commentId},
                                ${params.targetKey}, ${storedClaim}, ${params.createdAt}
                            )
                        `),
                        ...(params.verdictPublicationCorrelationId === null
                            ? []
                            : [Prisma.sql`
                                (
                                    ${params.verdictPublicationCorrelationId}, ${params.accountId}, ${null},
                                    ${params.targetKey}, ${storedClaim}, ${params.createdAt}
                                )
                            `]),
                    ]);
                    await tx.$executeRaw(Prisma.sql`
                        INSERT INTO review_comment_publication_correlations (
                            publication_correlation_id, account_id, comment_id, target_key,
                            target_json, created_at
                        ) VALUES ${claimRows}
                    `);
                    return initialPublicationClaimResult({
                        publicationPlanId: params.publicationPlanId,
                        dispatchToken: params.dispatchToken,
                        entryCount: params.entries.length,
                        hasVerdict: params.verdictPublicationCorrelationId !== null,
                    });
                });
            } catch (error) {
                if (!isPrismaUniqueConstraintError(error)) throw error;
                return (await inTx(async (tx) => await resolveExistingInTx(tx, { settlement: undefined })))!;
            }
        },
    };
}
