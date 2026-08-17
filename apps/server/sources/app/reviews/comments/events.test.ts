import { describe, expect, it } from "vitest";

import {
    openReviewCommentEventSensitiveEnvelopeV1,
    buildReviewCommentEventRequestBindingV1,
    sealReviewCommentEventSensitiveEnvelopeV1,
    type ReviewCommentEventV1,
} from "@happier-dev/protocol";

import {
    bindReviewCommentEventSensitiveForStorage,
    buildReviewCommentEvent,
    decodeReviewCommentEventSensitiveFromStorage,
} from "./events";

function event(): ReviewCommentEventV1 {
    return buildReviewCommentEvent({
        runtime: {
            now: () => 10_000,
            createId: () => "event-1",
        },
        accountId: "account-1",
        projectId: "project-1",
        commentId: "comment-1",
        actor: { kind: "user", userId: "user-1" },
        serverRevision: 2,
        eventKind: "transitioned",
        clientMutationId: "mutation-1",
        bulkActionId: "bulk-1",
        authorDeviceId: "device-1",
        clientLamport: 3,
        event: {
            reason: "private reason",
        },
    });
}

function requestBinding(source = event()) {
    return buildReviewCommentEventRequestBindingV1({
        accountId: source.accountId,
        projectId: source.projectId,
        actor: source.actor,
        actionId: "reviews.comments.transition",
        input: {
            commentId: source.commentId,
            projectId: source.projectId,
            toState: "resolved",
            expectedState: "open",
            expectedServerRevision: 1,
            clientMutationId: "mutation-1",
        },
    });
}

describe("Review Comment authoritative event owner", () => {
    it("binds every authoritative metadata field around plain sensitive details", () => {
        const source = event();
        const bound = bindReviewCommentEventSensitiveForStorage({
            event: source,
            requestBinding: requestBinding(source),
            storageMode: "plain",
        });

        expect(bound.binding).toEqual({
            v: 1,
            eventId: "event-1",
            commentId: "comment-1",
            accountId: "account-1",
            projectId: "project-1",
            eventKind: "transitioned",
            actor: { kind: "user", userId: "user-1" },
            createdAt: 10_000,
            serverRevision: 2,
            bulkActionId: "bulk-1",
            clientMutationId: "mutation-1",
            authorDeviceId: "device-1",
            clientLamport: 3,
            requestBinding: requestBinding(source),
        });
        expect(openReviewCommentEventSensitiveEnvelopeV1({
            event: source,
            bound,
            mode: "plain",
        })).toEqual({ status: "available", event: source });
    });

    it("binds caller-sealed E2EE details without parsing their content", () => {
        const source = event();
        const sensitive = sealReviewCommentEventSensitiveEnvelopeV1({
            payload: { v: 1, requestBinding: requestBinding(source), details: source.event },
            mode: "e2ee",
            material: { type: "dataKey", machineKey: new Uint8Array(32).fill(7) },
            randomBytes: (length) => new Uint8Array(length).fill(4),
        });
        const bound = bindReviewCommentEventSensitiveForStorage({
            event: source,
            requestBinding: requestBinding(source),
            eventEnvelope: sensitive,
            storageMode: "e2ee",
        });

        expect(bound.sensitive).toEqual(sensitive);
        expect(JSON.stringify(bound)).not.toContain("private reason");
    });

    it("rejects an absent or mode-mismatched sensitive envelope for E2EE", () => {
        for (const run of [
            () => bindReviewCommentEventSensitiveForStorage({
                event: event(),
                requestBinding: requestBinding(),
                storageMode: "e2ee",
            }),
            () => bindReviewCommentEventSensitiveForStorage({
                event: event(),
                requestBinding: requestBinding(),
                storageMode: "e2ee",
                eventEnvelope: { t: "plain", v: { reason: "leak" } },
            }),
        ]) {
            try {
                run();
                throw new Error("expected Review Comment mode mismatch");
            } catch (error) {
                expect(error).toMatchObject({
                    name: "ReviewCommentOperationError",
                    code: "review_comment_encryption_mode_mismatch",
                });
            }
        }
    });

    it("rejects a readable payload whose inner request binding differs from the verified mutation", () => {
        const source = event();
        const otherBinding = buildReviewCommentEventRequestBindingV1({
            accountId: source.accountId,
            projectId: source.projectId,
            actor: source.actor,
            actionId: "reviews.comments.transition",
            input: {
                projectId: source.projectId,
                commentId: source.commentId,
                expectedState: "open",
                expectedServerRevision: 9,
                toState: "resolved",
                clientMutationId: "mutation-1",
            },
        });

        expect(() => bindReviewCommentEventSensitiveForStorage({
            event: source,
            requestBinding: requestBinding(source),
            storageMode: "plain",
            eventEnvelope: sealReviewCommentEventSensitiveEnvelopeV1({
                payload: { v: 1, requestBinding: otherBinding, details: source.event },
                mode: "plain",
            }),
        })).toThrow("Review comment event request binding does not match");
    });

    it("reads bound details and rejects a bound payload transplanted under other event metadata", () => {
        const source = event();
        const bound = bindReviewCommentEventSensitiveForStorage({
            event: source,
            requestBinding: requestBinding(source),
            storageMode: "plain",
        });

        expect(decodeReviewCommentEventSensitiveFromStorage({
            event: { ...source, event: { clientMutationId: "mutation-1" } },
            stored: bound,
        })).toEqual(source);
        expect(() => decodeReviewCommentEventSensitiveFromStorage({
            event: {
                ...source,
                commentId: "comment-other",
                event: { clientMutationId: "mutation-1" },
            },
            stored: bound,
        })).toThrow("review_comment_event_binding_mismatch");
    });
});
