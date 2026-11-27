import * as privacyKit from "privacy-kit";
import { z } from "zod/mini";
import { omit } from "zod/mini";
import { ReviewCommentPrepareMutationRequestV1Schema, ReviewCommentPrepareMutationResponseV1Schema, ReviewCommentCommitMutationRequestV1Schema, ReviewCommentCommitMutationResponseV1Schema, deriveReviewCommentStructuralMutationV1, applyReviewCommentPreparedSensitiveMutationV1, type ReviewCommentPrepareMutationRequestV1, type ReviewCommentPrepareMutationResponseV1, type ReviewCommentCommitMutationRequestV1, type ReviewCommentStructuralMutationV1, type ReviewCommentStoredSourceV1 } from '@happier-dev/protocol/reviews/comments/mutation';
import { ReviewCommentOperationErrorCodeV1Schema, ReviewCommentPrincipalHeaderV1Schema, stringifyReviewCommentPrincipalCanonicalJsonV1 } from '@happier-dev/protocol/reviews/comments/actions';
import { buildReviewCommentEventRequestBindingV1, sealReviewCommentSensitiveEnvelopeV1, openReviewCommentSensitiveMigrationSourceV1, reviewCommentMutationInputWithoutEventEnvelopeV1 } from '@happier-dev/protocol/reviews/comments/content';
import { StoredJsonContentEnvelopeSchema } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import { REVIEW_COMMENT_CREATE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { isAccountScopedBlobCiphertextForKind } from '@happier-dev/protocol/crypto/accountScopedCipherEnvelope';
import { type ReviewCommentAppearanceV1, type ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import { encryptString, decryptString } from "@/modules/encrypt";
import type { ReviewCommentStore, ReviewCommentCanonicalCommitParams, ReviewCommentCanonicalCreateParams } from "./store";
import { ReviewCommentOperationError } from "./errors";
import { assertReviewCommentCurrentIntent } from "./operations";
import { assertReviewCommentSessionScope,
    assertReviewCommentRedactionActorAllowed, assertReviewCommentTransitionActorAllowed,
    assertReviewCommentUserOrOriginalAuthor,
    assertReviewCommentOrdinarySourceAdmission,
    type ReviewCommentPrincipal } from "./permissions";
import type { ReviewCommentOperationRuntime } from "./operations";

const ReceiptV1Schema = z.strictObject({
    v: z.literal(1), accountId: z.string(), actor: ReviewCommentPrincipalHeaderV1Schema.shape.actor,
    mode: z.enum(["plain", "e2ee"]), accountVersion: z.optional(z.number().check(z.int())),
    contentPublicKeyFingerprint: z.nullable(z.string()),
    reviewAccess: z.optional(z.strictObject({ reviewId: z.string(), ownerAccountId: z.string(),
        level: z.enum(["owner", "view", "edit", "admin"]), encryptionMode: z.nullable(z.enum(["plain", "e2ee"])) })),
    request: ReviewCommentPrepareMutationRequestV1Schema,
    prepared: omit(ReviewCommentPrepareMutationResponseV1Schema, { receipt: true }),
});

export type ReviewCommentPreparationReceipt = z.infer<typeof ReceiptV1Schema>;

export function readReviewCommentPreparationReceipt(accountId: string, receipt: string): ReviewCommentPreparationReceipt {
    try { return ReceiptV1Schema.parse(JSON.parse(decryptString(["review-comment-mutation-preparation", "v1", accountId], privacyKit.decodeBase64(receipt)))); }
    catch { throw new ReviewCommentOperationError("review_comment_invalid_request", "Invalid Review Comment preparation"); }
}

function translateError(error: unknown): never {
    if (error instanceof ReviewCommentOperationError) throw error;
    if (error instanceof Error && "code" in error) {
        const code = ReviewCommentOperationErrorCodeV1Schema.safeParse(error.code);
        if (code.success) throw new ReviewCommentOperationError(code.data, error.message);
    }
    throw error;
}

/** Server admission and persistence for the same structural mutation consumed by plain and E2EE callers. */
export function createReviewCommentCanonicalMutations(store: ReviewCommentStore, runtime: ReviewCommentOperationRuntime) {
    async function readCurrent(principal: ReviewCommentPrincipal, mutation: ReviewCommentStructuralMutationV1) {
        const input = mutation.input;
        const ids = mutation.actionId === "reviews.comments.create" ? []
            : mutation.actionId === "reviews.comments.reply" ? [mutation.input.parentCommentId]
            : mutation.actionId === "reviews.comments.bulkTransition" ? mutation.input.commentIds : [mutation.input.commentId];
        const sources: ReviewCommentStoredSourceV1[] = [];
        const failed: ReviewCommentPrepareMutationResponseV1['failed'] = [];
        const selected = new Map((await store.getSources({ ...principal, commentIds: ids }))
            .map(source => [source.structural.id, source]));
        for (const id of ids) {
            const source = selected.get(id);
            if (source) {
                assertReviewCommentOrdinarySourceAdmission(source, principal.storageMode ?? "plain");
                sources.push(source);
            } else if (mutation.actionId !== "reviews.comments.bulkTransition") {
                throw new ReviewCommentOperationError("review_comment_not_found", "Review comment not found");
            }
        }
        if (mutation.actionId === "reviews.comments.create") {
            if (mutation.input.reviewId !== principal.reviewAccess?.reviewId) throw new ReviewCommentOperationError("review_comment_permission_denied", "Review comment requires its admitted Review capability");
            if (principal.actor.kind === "workflow" && principal.currentIntent?.kind !== "review_findings_materialization") throw new ReviewCommentOperationError("review_comment_permission_denied", "Workflow principals cannot create review comments");
            if (principal.actor.kind === "agent" || (principal.actor.kind === "workflow" && mutation.input.sessionId !== undefined)) {
                assertReviewCommentSessionScope(principal, mutation.input.sessionId);
            }
        }
        for (const source of [...sources]) {
            try {
            const current = source.structural;
            if (current.reviewId !== principal.reviewAccess?.reviewId) throw new ReviewCommentOperationError("review_comment_permission_denied", "Review comment is outside the admitted Review");
            assertReviewCommentSessionScope(principal, current.sessionId);
            switch (mutation.actionId) {
                case "reviews.comments.transition": case "reviews.comments.bulkTransition":
                    assertReviewCommentTransitionActorAllowed({ ...principal, comment: current, fromState: current.state, toState: mutation.input.toState });
                    if (principal.actor.kind !== "user" && current.state === "delegated" && (mutation.input.toState === "resolved" || mutation.input.toState === "pending_review") && !mutation.input.evidenceCount) throw new ReviewCommentOperationError("review_comment_invalid_transition", "Delegated completion requires typed evidence");
                    break;
                case "reviews.comments.edit":
                    if (principal.actor.kind === "workflow" || current.flags.redacted) throw new ReviewCommentOperationError("review_comment_permission_denied", "Review comment edit is not permitted");
                    assertReviewCommentUserOrOriginalAuthor({ ...principal, comment: current }); break;
                case "reviews.comments.reply":
                    if (principal.actor.kind === "workflow") throw new ReviewCommentOperationError("review_comment_permission_denied", "Workflow review authority does not include replies");
                    break;
                case "reviews.comments.redact": assertReviewCommentRedactionActorAllowed(principal.actor, principal.reviewAccess, current.author); break;
                case "reviews.comments.attachEvidence":
                    if (principal.actor.kind === "workflow") throw new ReviewCommentOperationError("review_comment_permission_denied", "Workflow review authority does not include evidence writes");
                    assertReviewCommentUserOrOriginalAuthor({ ...principal, comment: current }); break;
            }
            } catch (error) {
                if (mutation.actionId !== "reviews.comments.bulkTransition" || !(error instanceof ReviewCommentOperationError)) throw error;
                sources.splice(sources.indexOf(source), 1);
                failed.push({ commentId: source.structural.id, errorCode: error.code, error: error.message });
            }
        }
        return { sources, failed };
    }

    async function prepareInternal(principal: ReviewCommentPrincipal, request: ReviewCommentPrepareMutationRequestV1, derivationRuntime: ReviewCommentOperationRuntime) {
        const { sources, failed } = await readCurrent(principal, request.mutation);
        let derived;
        try { derived = deriveReviewCommentStructuralMutationV1({ ...principal,
            accountId: principal.reviewAccess?.ownerAccountId ?? principal.accountId,
            mutation: request.mutation, current: sources.map((item) => item.structural), runtime: derivationRuntime }); }
        catch (error) { translateError(error); }
        const previousById = new Map(sources.map(source => [source.structural.id, source]));
        const records = derived.records.map(record => {
            const previous = previousById.get(request.mutation.actionId === "reviews.comments.reply"
                ? request.mutation.input.parentCommentId : record.structural.id);
            return { ...record, ...(previous ? { previous } : {}) };
        });
        if (request.mutation.actionId === "reviews.comments.create") {
            if (!request.createRequestFingerprint) throw new ReviewCommentOperationError("review_comment_invalid_request", "Create equivalence commitment is required");
            const existing = await store.findCreate({ ...principal,
                createClientMutationId: request.mutation.input.clientMutationId, createRequestFingerprint: request.createRequestFingerprint,
                structural: records[0]!.structural });
            if (existing) {
                assertReviewCommentOrdinarySourceAdmission(existing, principal.storageMode ?? "plain");
                assertReviewCommentSessionScope(principal, existing.structural.sessionId);
                return { v: 1 as const, request, records: [{ previous: existing, structural: existing.structural }], replayed: true, failed: [] };
            }
        }
        return { v: 1 as const, request, records, replayed: false, failed: [...failed, ...derived.failed.filter((item) => !failed.some((denied) => denied.commentId === item.commentId))], ...(derived.bulkActionId ? { bulkActionId: derived.bulkActionId } : {}) };
    }

    async function prepare(principal: ReviewCommentPrincipal, input: ReviewCommentPrepareMutationRequestV1) {
        if (principal.storageMode !== "e2ee" && principal.storageMode !== "plain") throw new ReviewCommentOperationError("review_comment_encryption_mode_mismatch", "Prepared mutations require admitted content mode");
        const request = ReviewCommentPrepareMutationRequestV1Schema.parse(input);
        if (request.mutation.actionId === "reviews.comments.create" && principal.actor.kind !== "user" && (request.mutation.input.authorIntent === "open" || principal.actor.kind === "agent" || principal.actor.kind === "workflow" || principal.actor.kind === "executionRun")) {
            assertReviewCommentCurrentIntent({ ...principal, input: request.mutation.input, contentCommitment: request.contentCommitment });
        }
        const now = runtime.now();
        const prepared = await prepareInternal(principal, request, { now: () => now, createId: (prefix) => runtime.createId(prefix) });
        const receipt = ReceiptV1Schema.parse({ v: 1, accountId: principal.accountId, actor: principal.actor,
            mode: principal.storageMode, accountVersion: principal.accountVersion,
            ...(principal.reviewAccess ? { reviewAccess: principal.reviewAccess } : {}),
            contentPublicKeyFingerprint: principal.accountEncryptionCurrentness?.contentPublicKeyFingerprint ?? null,
            request, prepared });
        return ReviewCommentPrepareMutationResponseV1Schema.parse({ ...prepared,
            receipt: privacyKit.encodeBase64(encryptString(["review-comment-mutation-preparation", "v1", principal.accountId], JSON.stringify(receipt))) });
    }

    function readCommit(currentPrincipal: ReviewCommentPrincipal, input: ReviewCommentCommitMutationRequestV1) {
        const request = ReviewCommentCommitMutationRequestV1Schema.parse(input);
        const receipt = readReviewCommentPreparationReceipt(currentPrincipal.accountId, request.receipt);
        const principal = { ...currentPrincipal, reviewAccess: receipt.reviewAccess };
        if (receipt.accountId !== principal.accountId || stringifyReviewCommentPrincipalCanonicalJsonV1(receipt.actor) !== stringifyReviewCommentPrincipalCanonicalJsonV1(principal.actor)
            || receipt.mode !== principal.storageMode || receipt.contentPublicKeyFingerprint !== (principal.accountEncryptionCurrentness?.contentPublicKeyFingerprint ?? null)) throw new ReviewCommentOperationError("review_comment_encryption_mode_mismatch", "Review Comment preparation is no longer current");
        const prepared = receipt.prepared;
        const submitted = new Map(request.records.map((record) => [record.commentId, record]));
        if (!prepared.replayed && (submitted.size !== request.records.length || submitted.size !== prepared.records.length)) throw new ReviewCommentOperationError("review_comment_invalid_request", "Review Comment prepared records did not match commit");
        const persists: ReviewCommentCanonicalCommitParams[] = [];
        if (!prepared.replayed) for (const record of prepared.records) {
            const candidate = submitted.get(record.structural.id);
            const expectedType = receipt.mode === "plain" ? "plain" : "encrypted";
            if (!candidate || !record.event || !candidate.eventEnvelope || candidate.sensitiveEnvelope.t !== expectedType || candidate.eventEnvelope.t !== expectedType
                || (!record.structural.reviewId && receipt.mode === "e2ee" && (candidate.sensitiveEnvelope.t !== "encrypted" || candidate.eventEnvelope.t !== "encrypted"
                || !isAccountScopedBlobCiphertextForKind({ ciphertext: candidate.sensitiveEnvelope.c, kind: "review_comment_sensitive" })
                || !isAccountScopedBlobCiphertextForKind({ ciphertext: candidate.eventEnvelope.c, kind: "review_comment_event_sensitive" })))) throw new ReviewCommentOperationError("review_comment_encryption_mode_mismatch", "Review Comment record and event must match the admitted content mode");
            persists.push({ ...principal, accountVersion: receipt.accountVersion, comment: record.structural,
                ...(receipt.request.mutation.actionId === "reviews.comments.reply" ? { parentCurrentness: { commentId: receipt.request.mutation.input.parentCommentId, serverRevision: receipt.request.mutation.input.expectedParentServerRevision } } : {}),
                sensitiveEnvelope: candidate.sensitiveEnvelope, event: record.event, eventEnvelope: candidate.eventEnvelope,
                requestBinding: buildReviewCommentEventRequestBindingV1({ accountId: principal.accountId,
                    reviewId: record.structural.reviewId, projectId: record.structural.projectId, workspace: record.structural.workspace, actor: principal.actor,
                    actionId: receipt.request.mutation.actionId, input: receipt.request.mutation.input }),
            });
        }
        return { receipt, principal, persists };
    }

    function replayResponse(receipt: ReviewCommentPreparationReceipt) {
        return ReviewCommentCommitMutationResponseV1Schema.parse({ v: 1, comments: receipt.prepared.records.map(record => record.previous), replayed: true, failed: [] });
    }

    async function replayCommit(receipt: ReviewCommentPreparationReceipt) {
        if (receipt.request.mutation.actionId === "reviews.comments.create" && receipt.request.mutation.input.appearance) {
            const root = receipt.prepared.records[0]!.structural;
            if (root.reviewId) await store.recordAppearance({ ...receipt.request.mutation.input.appearance, reviewId: root.reviewId, commentId: root.id });
        }
        return replayResponse(receipt);
    }

    function createPersist(persist: ReviewCommentCanonicalCommitParams,
        mutation: Extract<ReviewCommentStructuralMutationV1, { actionId: "reviews.comments.create" }>,
        createRequestFingerprint: string): ReviewCommentCanonicalCreateParams {
        return { ...persist, appearance: mutation.input.appearance, createClientMutationId: mutation.input.clientMutationId,
            createRequestFingerprint };
    }

    async function commit(currentPrincipal: ReviewCommentPrincipal, input: ReviewCommentCommitMutationRequestV1) {
        const { receipt, principal, persists } = readCommit(currentPrincipal, input);
        if (receipt.prepared.replayed) return replayCommit(receipt);
        const comments: ReviewCommentStoredSourceV1[] = [];
        const failed = [...receipt.prepared.failed];
        if (receipt.request.mutation.actionId === "reviews.comments.bulkTransition") {
            const results = await store.commitCanonicalBatch(persists);
            results.forEach((result, index) => {
                if ('error' in result) failed.push({ commentId: persists[index]!.comment.id, errorCode: result.error.code, error: result.error.message });
                else comments.push(result.comment);
            });
        } else for (const persist of persists) {
            if (receipt.request.mutation.actionId === "reviews.comments.create") {
                const result = await store.createCanonical(createPersist(persist, receipt.request.mutation, receipt.request.createRequestFingerprint!));
                assertReviewCommentOrdinarySourceAdmission(result.comment, principal.storageMode ?? "plain");
                assertReviewCommentSessionScope(principal, result.comment.structural.sessionId);
                comments.push(result.comment);
                if (result.replayed) return ReviewCommentCommitMutationResponseV1Schema.parse({ v: 1, comments, replayed: true, failed });
            } else {
                await store.commitCanonical(persist);
                comments.push({ structural: persist.comment, source: { v: 1, layout: "canonical_v1", envelope: persist.sensitiveEnvelope } });
            }
        }
        return ReviewCommentCommitMutationResponseV1Schema.parse({ v: 1, comments, replayed: false, failed, ...(receipt.prepared.bulkActionId ? { bulkActionId: receipt.prepared.bulkActionId } : {}) });
    }

    /** Batch scheduling changes only persistence; every item consumes its existing admitted receipt. */
    async function commitCreateBatch(items: readonly Readonly<{ principal: ReviewCommentPrincipal; input: ReviewCommentCommitMutationRequestV1 }>[]) {
        type Result = { ok: true; value: z.infer<typeof ReviewCommentCommitMutationResponseV1Schema> } | { ok: false; errorCode: string; error: string };
        const results: Result[] = [];
        const pending: Array<{ index: number; principal: ReviewCommentPrincipal; persist: ReviewCommentCanonicalCreateParams }> = [];
        const replayAppearances: ReviewCommentAppearanceV1[] = [];
        for (const [index, item] of items.entries()) {
            try {
                const { receipt, principal, persists } = readCommit(item.principal, item.input);
                if (receipt.request.mutation.actionId !== REVIEW_COMMENT_CREATE_ACTION_ID_V1) throw new ReviewCommentOperationError("review_comment_invalid_request", "Create batches accept only creates");
                if (receipt.prepared.replayed) {
                    const root = receipt.prepared.records[0]!.structural;
                    const appearance = receipt.request.mutation.input.appearance;
                    if (appearance && root.reviewId) replayAppearances.push({ ...appearance, reviewId: root.reviewId, commentId: root.id });
                    results[index] = { ok: true, value: replayResponse(receipt) };
                }
                else {
                    pending.push({ index, principal, persist: createPersist(persists[0]!, receipt.request.mutation, receipt.request.createRequestFingerprint!) });
                }
            } catch (error) {
                if (!(error instanceof ReviewCommentOperationError)) throw error;
                results[index] = { ok: false, errorCode: error.code, error: error.message };
            }
        }
        const committed = await store.createCanonicalBatch(pending.map(item => item.persist), replayAppearances);
        committed.forEach((result, ordinal) => {
            const item = pending[ordinal]!;
            if ('error' in result) results[item.index] = { ok: false, errorCode: result.error.code, error: result.error.message };
            else {
                assertReviewCommentOrdinarySourceAdmission(result.comment, item.principal.storageMode ?? "plain");
                assertReviewCommentSessionScope(item.principal, result.comment.structural.sessionId);
                results[item.index] = { ok: true, value: ReviewCommentCommitMutationResponseV1Schema.parse({ v: 1,
                    comments: [result.comment], replayed: result.replayed, failed: [] }) };
            }
        });
        return results;
    }

    async function applyPlain(principal: ReviewCommentPrincipal, mutation: ReviewCommentStructuralMutationV1, input: Record<string, unknown>, createRequestFingerprint?: string) {
        if ((principal.storageMode ?? "plain") !== "plain") throw new ReviewCommentOperationError("review_comment_encryption_mode_mismatch", "Encrypted comments require canonical prepared transport");
        const prepared = await prepareInternal(principal, { v: 1, mutation, contentCommitment: "plain", ...(createRequestFingerprint ? { createRequestFingerprint } : {}) }, runtime);
        const comments: ReviewCommentV1[] = [];
        const failed = [...prepared.failed];
        let parent: ReviewCommentV1 | undefined;
        const bulkPersists: ReviewCommentCanonicalCommitParams[] = [];
        const bulkComments: ReviewCommentV1[] = [];
        for (const record of prepared.records) {
            const opened = record.previous ? await openReviewCommentSensitiveMigrationSourceV1(record.previous) : undefined;
            if (opened && opened.status !== "available") throw new ReviewCommentOperationError("review_comment_encryption_mode_mismatch", "Plain review record could not be opened");
            const previous = opened?.status === "available" ? opened.comment : undefined;
            if (mutation.actionId === "reviews.comments.reply") parent = previous;
            if (prepared.replayed) {
                if (!previous) throw new ReviewCommentOperationError("review_comment_not_found", "Replay comment missing");
                if (mutation.actionId === "reviews.comments.create" && mutation.input.appearance && previous.reviewId) await store.recordAppearance({ ...mutation.input.appearance, reviewId: previous.reviewId, commentId: previous.id });
                comments.push(previous); continue;
            }
            let sensitive;
            try { sensitive = applyReviewCommentPreparedSensitiveMutationV1({ mutation, input, prepared: record, previous }); }
            catch (error) { translateError(error); }
            const envelope = sealReviewCommentSensitiveEnvelopeV1({ structural: record.structural, sensitive, mode: "plain" });
            const openedNew = await openReviewCommentSensitiveMigrationSourceV1({ structural: record.structural, source: { v: 1, layout: "canonical_v1", envelope } });
            if (openedNew.status !== "available") throw new ReviewCommentOperationError("review_comment_invalid_request", "Plain Review Comment binding mismatch");
            const eventEnvelope = input.eventEnvelope === undefined ? undefined : StoredJsonContentEnvelopeSchema.parse(input.eventEnvelope);
            if (eventEnvelope?.t === "encrypted") throw new ReviewCommentOperationError("review_comment_encryption_mode_mismatch", "Plain mutations require plain event envelopes");
            const persist = { ...principal, comment: record.structural, sensitiveEnvelope: envelope,
                event: { ...record.event!, event: { ...reviewCommentMutationInputWithoutEventEnvelopeV1(input), ...(prepared.bulkActionId ? { bulkActionId: prepared.bulkActionId } : {}) } },
                ...(mutation.actionId === "reviews.comments.reply" ? { parentCurrentness: { commentId: mutation.input.parentCommentId, serverRevision: mutation.input.expectedParentServerRevision } } : {}),
                eventEnvelope,
                requestBinding: buildReviewCommentEventRequestBindingV1({ accountId: principal.accountId, reviewId: record.structural.reviewId, projectId: record.structural.projectId, workspace: record.structural.workspace, actor: principal.actor, actionId: mutation.actionId, input }),
            };
            if (mutation.actionId === "reviews.comments.create") {
                const result = await store.createCanonical({ ...persist, appearance: mutation.input.appearance, createClientMutationId: mutation.input.clientMutationId, createRequestFingerprint: createRequestFingerprint! });
                const openedResult = await openReviewCommentSensitiveMigrationSourceV1(result.comment);
                if (openedResult.status !== "available") throw new ReviewCommentOperationError("review_comment_encryption_mode_mismatch", "Create replay mode mismatch");
                comments.push(openedResult.comment);
                if (result.replayed) prepared.replayed = true;
            } else if (mutation.actionId === "reviews.comments.bulkTransition") {
                bulkPersists.push(persist); bulkComments.push(openedNew.comment);
            } else {
                await store.commitCanonical(persist);
                comments.push(openedNew.comment);
            }
        }
        if (bulkPersists.length) {
            const results = await store.commitCanonicalBatch(bulkPersists);
            results.forEach((result, index) => {
                if ('error' in result) failed.push({ commentId: bulkPersists[index]!.comment.id, errorCode: result.error.code, error: result.error.message });
                else comments.push(bulkComments[index]!);
            });
        }
        return { comments, parent, replayed: prepared.replayed, failed, bulkActionId: prepared.bulkActionId };
    }
    return { prepare, commit, commitCreateBatch, applyPlain };
}
