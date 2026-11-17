import * as privacyKit from "privacy-kit";
import { z } from "zod/mini";
import { omit } from "zod/mini";
import { ReviewCommentPrepareMutationRequestV1Schema, ReviewCommentPrepareMutationResponseV1Schema, ReviewCommentCommitMutationRequestV1Schema, ReviewCommentCommitMutationResponseV1Schema, deriveReviewCommentStructuralMutationV1, applyReviewCommentPreparedSensitiveMutationV1, type ReviewCommentPrepareMutationRequestV1, type ReviewCommentPrepareMutationResponseV1, type ReviewCommentCommitMutationRequestV1, type ReviewCommentStructuralMutationV1, type ReviewCommentStoredSourceV1 } from '@happier-dev/protocol/reviews/comments/mutation';
import { ReviewCommentOperationErrorCodeV1Schema, ReviewCommentPrincipalHeaderV1Schema, stringifyReviewCommentPrincipalCanonicalJsonV1 } from '@happier-dev/protocol/reviews/comments/actions';
import { buildReviewCommentEventRequestBindingV1, sealReviewCommentSensitiveEnvelopeV1, openReviewCommentSensitiveMigrationSourceV1, reviewCommentMutationInputWithoutEventEnvelopeV1 } from '@happier-dev/protocol/reviews/comments/content';
import { StoredJsonContentEnvelopeSchema } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import { isAccountScopedBlobCiphertextForKind } from '@happier-dev/protocol/crypto/accountScopedCipherEnvelope';
import { type ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import { encryptString, decryptString } from "@/modules/encrypt";
import type { ReviewCommentStore } from "./store";
import { ReviewCommentOperationError } from "./errors";
import { assertReviewCommentCurrentIntent } from "./operations";
import { assertReviewCommentSessionScope, assertReviewCommentDirectWriteGrant,
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
        for (const id of ids) {
            const source = await store.getSource({ ...principal, commentId: id });
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
            if (principal.actor.kind !== "user" && (mutation.input.authorIntent === "open" || principal.actor.kind === "agent" || principal.actor.kind === "workflow")) {
                if (principal.currentIntent?.kind !== "review_findings_materialization") assertReviewCommentDirectWriteGrant(principal);
            }
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
        const records = derived.records.map((record) => ({ ...record,
            ...(sources.find((item) => item.structural.id === (request.mutation.actionId === "reviews.comments.reply" ? request.mutation.input.parentCommentId : record.structural.id))
                ? { previous: sources.find((item) => item.structural.id === (request.mutation.actionId === "reviews.comments.reply" ? request.mutation.input.parentCommentId : record.structural.id)) } : {}),
        }));
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
        if (principal.storageMode !== "e2ee" && !principal.reviewAccess) throw new ReviewCommentOperationError("review_comment_encryption_mode_mismatch", "Prepared mutations require admitted resource content or an E2EE Account");
        const request = ReviewCommentPrepareMutationRequestV1Schema.parse(input);
        if (request.mutation.actionId === "reviews.comments.create" && principal.actor.kind !== "user" && (request.mutation.input.authorIntent === "open" || principal.actor.kind === "agent" || principal.actor.kind === "workflow")) {
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

    async function commit(currentPrincipal: ReviewCommentPrincipal, input: ReviewCommentCommitMutationRequestV1) {
        const request = ReviewCommentCommitMutationRequestV1Schema.parse(input);
        const receipt = readReviewCommentPreparationReceipt(currentPrincipal.accountId, request.receipt);
        const principal = { ...currentPrincipal, reviewAccess: receipt.reviewAccess };
        if (receipt.accountId !== principal.accountId || stringifyReviewCommentPrincipalCanonicalJsonV1(receipt.actor) !== stringifyReviewCommentPrincipalCanonicalJsonV1(principal.actor)
            || receipt.mode !== principal.storageMode || receipt.contentPublicKeyFingerprint !== (principal.accountEncryptionCurrentness?.contentPublicKeyFingerprint ?? null)) throw new ReviewCommentOperationError("review_comment_encryption_mode_mismatch", "Review Comment preparation is no longer current");
        const prepared = receipt.prepared;
        if (prepared.replayed) {
            if (receipt.request.mutation.actionId === "reviews.comments.create" && receipt.request.mutation.input.appearance) {
                const root = prepared.records[0]!.structural;
                if (root.reviewId) await store.recordAppearance({ ...receipt.request.mutation.input.appearance, reviewId: root.reviewId, commentId: root.id });
            }
            return ReviewCommentCommitMutationResponseV1Schema.parse({ v: 1, comments: prepared.records.map((record) => record.previous), replayed: true, failed: [] });
        }
        const submitted = new Map(request.records.map((record) => [record.commentId, record]));
        if (submitted.size !== request.records.length || submitted.size !== prepared.records.length) throw new ReviewCommentOperationError("review_comment_invalid_request", "Review Comment prepared records did not match commit");
        const comments: ReviewCommentStoredSourceV1[] = [];
        const failed = [...prepared.failed];
        for (const record of prepared.records) {
            const candidate = submitted.get(record.structural.id);
            const expectedType = receipt.mode === "plain" ? "plain" : "encrypted";
            if (!candidate || candidate.sensitiveEnvelope.t !== expectedType || candidate.eventEnvelope?.t !== expectedType
                || (!record.structural.reviewId && (candidate.sensitiveEnvelope.t !== "encrypted" || candidate.eventEnvelope.t !== "encrypted"
                || !isAccountScopedBlobCiphertextForKind({ ciphertext: candidate.sensitiveEnvelope.c, kind: "review_comment_sensitive" })
                || !isAccountScopedBlobCiphertextForKind({ ciphertext: candidate.eventEnvelope.c, kind: "review_comment_event_sensitive" })))) throw new ReviewCommentOperationError("review_comment_encryption_mode_mismatch", "Review Comment record and event must match the admitted content mode");
        }
        for (const record of prepared.records) {
            const candidate = submitted.get(record.structural.id);
            if (!candidate || !candidate.eventEnvelope || !record.event) throw new ReviewCommentOperationError("review_comment_encryption_mode_mismatch", "Review Comment record and event envelopes are required");
            const persist = { ...principal, accountVersion: receipt.accountVersion, comment: record.structural,
                ...(receipt.request.mutation.actionId === "reviews.comments.reply" ? { parentCurrentness: { commentId: receipt.request.mutation.input.parentCommentId, serverRevision: receipt.request.mutation.input.expectedParentServerRevision } } : {}),
                sensitiveEnvelope: candidate.sensitiveEnvelope, event: record.event, eventEnvelope: candidate.eventEnvelope,
                requestBinding: buildReviewCommentEventRequestBindingV1({ accountId: principal.accountId,
                    reviewId: record.structural.reviewId, projectId: record.structural.projectId, workspace: record.structural.workspace, actor: principal.actor,
                    actionId: receipt.request.mutation.actionId, input: receipt.request.mutation.input }),
            };
            try {
                if (receipt.request.mutation.actionId === "reviews.comments.create") {
                    const result = await store.createCanonical({ ...persist,
                        appearance: receipt.request.mutation.input.appearance,
                        createClientMutationId: receipt.request.mutation.input.clientMutationId,
                        createRequestFingerprint: receipt.request.createRequestFingerprint! });
                    assertReviewCommentOrdinarySourceAdmission(result.comment, principal.storageMode ?? "plain");
                    assertReviewCommentSessionScope(principal, result.comment.structural.sessionId);
                    comments.push(result.comment);
                    if (result.replayed) return ReviewCommentCommitMutationResponseV1Schema.parse({ v: 1, comments, replayed: true, failed });
                } else { await store.commitCanonical(persist); comments.push({ structural: record.structural, source: { v: 1, layout: "canonical_v1", envelope: candidate.sensitiveEnvelope } }); }
            } catch (error) {
                if (receipt.request.mutation.actionId !== "reviews.comments.bulkTransition" || !(error instanceof ReviewCommentOperationError)) throw error;
                failed.push({ commentId: record.structural.id, errorCode: error.code, error: error.message });
            }
        }
        return ReviewCommentCommitMutationResponseV1Schema.parse({ v: 1, comments, replayed: false, failed, ...(prepared.bulkActionId ? { bulkActionId: prepared.bulkActionId } : {}) });
    }

    async function applyPlain(principal: ReviewCommentPrincipal, mutation: ReviewCommentStructuralMutationV1, input: Record<string, unknown>, createRequestFingerprint?: string) {
        if ((principal.storageMode ?? "plain") !== "plain") throw new ReviewCommentOperationError("review_comment_encryption_mode_mismatch", "Encrypted comments require canonical prepared transport");
        const prepared = await prepareInternal(principal, { v: 1, mutation, contentCommitment: "plain", ...(createRequestFingerprint ? { createRequestFingerprint } : {}) }, runtime);
        const comments: ReviewCommentV1[] = [];
        const failed = [...prepared.failed];
        let parent: ReviewCommentV1 | undefined;
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
            } else {
                try { await store.commitCanonical(persist); comments.push(openedNew.comment); }
                catch (error) {
                    if (mutation.actionId !== "reviews.comments.bulkTransition" || !(error instanceof ReviewCommentOperationError)) throw error;
                    failed.push({ commentId: record.structural.id, errorCode: error.code, error: error.message });
                }
            }
        }
        return { comments, parent, replayed: prepared.replayed, failed, bulkActionId: prepared.bulkActionId };
    }
    return { prepare, commit, applyPlain };
}
