import { describe, expect, it } from "vitest";

import {
    bindReviewCommentEventSensitiveEnvelopeV1,
    buildReviewCommentEventRequestBindingV1,
    sealReviewCommentEventSensitiveEnvelopeV1,
    sealReviewCommentSensitiveEnvelopeV1,
    splitReviewCommentV1,
    type ReviewCommentEventV1,
    type ReviewCommentV1,
} from "@happier-dev/protocol";

import {
    REVIEW_COMMENT_CANONICAL_SENSITIVE_LAYOUT_MARKER_JSON,
    buildReviewCommentAccountEncryptionMigrationInventory,
    buildReviewCommentAccountEncryptionMigrationInventoryResponse,
    buildReviewCommentCanonicalStorageValues,
    buildStoredReviewCommentFromStorageRow,
    readReviewCommentMigrationSourceFromStorageRow,
    type ReviewCommentMigrationStorageCommentRow,
    type ReviewCommentMigrationStorageEventRow,
} from "./accountEncryptionMigrationPersistence";

function sourceComment(): ReviewCommentV1 {
    return {
        v: 1,
        id: "comment-1",
        accountId: "account-1",
        projectId: "project-1",
        workspaceId: "workspace-1",
        anchor: {
            kind: "line",
            filePath: "src/secret.ts",
            line: 7,
            side: "after",
        },
        snapshot: {
            kind: "text",
            selectedLines: ["private snapshot"],
            beforeContext: ["private context before"],
            afterContext: ["private context after"],
            selectedLinesHash: "selected-hash",
            contextWindowHash: "context-hash",
            capturedAt: 1_000,
            fileLength: 3,
            source: "workingTree",
            isUncommitted: true,
            isUntracked: false,
            truncated: false,
            hasBidiControls: false,
            likelyMinified: false,
        },
        body: "private body",
        bodyVersion: 2,
        edits: [{
            editId: "edit-1",
            previousBody: "old private body",
            nextBody: "private body",
            reason: "private edit reason",
            editedAt: 1_100,
            editedBy: { kind: "user", userId: "user-1" },
        }],
        author: { kind: "user", userId: "user-1" },
        state: "resolved",
        flags: {},
        dispositions: {},
        threadId: "comment-1",
        evidence: [{ kind: "reasoning", message: "private evidence" }],
        transitions: [{
            transitionId: "transition-1",
            fromState: "open",
            toState: "resolved",
            transitionedAt: 1_100,
            transitionedBy: { kind: "user", userId: "user-1" },
            reason: "private transition reason",
            serverRevision: 2,
        }],
        fingerprint: {
            normalizedMessageHash: "public-dedupe-hash",
            ruleId: "private-source-hash",
        },
        linkedRefs: [{ kind: "external", url: "https://private.example/review" }],
        suggestedFix: { kind: "replacement", replacementText: "private replacement" },
        metadata: { severity: "error", taxonomyIds: ["private-taxonomy"], tags: ["private-tag"] },
        createdAt: 1_000,
        updatedAt: 1_100,
        serverRevision: 2,
    };
}

function sourceEvent(): ReviewCommentEventV1 {
    return {
        eventId: "event-1",
        commentId: "comment-1",
        accountId: "account-1",
        projectId: "project-1",
        eventKind: "edited",
        actor: { kind: "user", userId: "user-1" },
        bulkActionId: "bulk-1",
        authorDeviceId: "device-1",
        clientLamport: 4,
        serverRevision: 2,
        createdAt: 1_100,
        event: { clientMutationId: "mutation-1", reason: "private event detail" },
    };
}

function requestBinding(event: ReviewCommentEventV1) {
    return buildReviewCommentEventRequestBindingV1({
        accountId: event.accountId,
        projectId: event.projectId,
        actor: event.actor,
        actionId: "reviews.comments.edit",
        input: {
            projectId: event.projectId,
            commentId: event.commentId,
            expectedServerRevision: event.serverRevision,
            expectedBodyVersion: 1,
            clientMutationId: event.event.clientMutationId,
        },
    });
}

function legacyCommentRow(comment: ReviewCommentV1): ReviewCommentMigrationStorageCommentRow {
    return {
        id: comment.id,
        account_id: comment.accountId,
        project_id: comment.projectId,
        workspace_id: comment.workspaceId ?? null,
        session_id: comment.sessionId ?? null,
        run_id: comment.runId ?? null,
        engine_id: comment.engineId ?? null,
        finding_id: comment.findingId ?? null,
        thread_id: comment.threadId,
        parent_comment_id: comment.parentCommentId ?? null,
        state: comment.state,
        flags_json: JSON.stringify(comment.flags),
        anchor_json: JSON.stringify(comment.anchor),
        snapshot_envelope_json: JSON.stringify({ t: "plain", v: comment.snapshot }),
        body_envelope_json: JSON.stringify({ t: "plain", v: comment.body }),
        body_version: comment.bodyVersion,
        author_json: JSON.stringify(comment.author),
        edits_json: JSON.stringify(comment.edits),
        dispositions_json: JSON.stringify(comment.dispositions),
        evidence_json: JSON.stringify(comment.evidence),
        transitions_json: JSON.stringify(comment.transitions),
        fingerprint_json: JSON.stringify(comment.fingerprint),
        linked_refs_json: JSON.stringify(comment.linkedRefs),
        suggested_fix_json: JSON.stringify(comment.suggestedFix),
        metadata_json: JSON.stringify(comment.metadata),
        tombstone_json: null,
        server_revision: comment.serverRevision,
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
    };
}

function legacyEventRow(event: ReviewCommentEventV1): ReviewCommentMigrationStorageEventRow {
    return {
        event_id: event.eventId,
        comment_id: event.commentId,
        account_id: event.accountId,
        project_id: event.projectId,
        event_kind: event.eventKind,
        event_envelope_json: JSON.stringify({ t: "plain", v: event.event }),
        bulk_action_id: event.bulkActionId ?? null,
        client_mutation_id: "mutation-1",
        actor_json: JSON.stringify(event.actor),
        author_device_id: event.authorDeviceId ?? null,
        client_lamport: event.clientLamport ?? null,
        server_revision: event.serverRevision,
        created_at: event.createdAt,
    };
}

describe("Review Comment Account-encryption storage adapter", () => {
    it("reconstructs the exact legacy split source and binds legacy event content to authoritative columns", () => {
        const comment = sourceComment();
        const event = sourceEvent();

        const inventory = buildReviewCommentAccountEncryptionMigrationInventory({
            accountId: comment.accountId,
            commentRows: [legacyCommentRow(comment)],
            eventRows: [legacyEventRow(event)],
        });

        expect(inventory).toHaveLength(1);
        expect(inventory[0]!.sensitiveSource).toMatchObject({
            v: 1,
            layout: "legacy_split_v1",
            sourceMode: "plain",
            anchor: comment.anchor,
            snapshotEnvelope: { t: "plain", v: comment.snapshot },
            bodyEnvelope: { t: "plain", v: comment.body },
            edits: comment.edits,
            evidence: comment.evidence,
            transitions: comment.transitions,
            fingerprint: comment.fingerprint,
            linkedRefs: comment.linkedRefs,
            suggestedFix: comment.suggestedFix,
            metadata: comment.metadata,
        });
        expect(inventory[0]!.events[0]).toEqual({
            event,
            sensitiveEnvelope: bindReviewCommentEventSensitiveEnvelopeV1({
                event,
                requestBinding: inventory[0]!.events[0]!.sensitiveEnvelope.binding.requestBinding,
                sensitive: { t: "plain", v: event.event },
            }),
            sourceLayout: "legacy_split_v1",
        });
        expect(inventory[0]!.events).toHaveLength(1);
        expect(buildReviewCommentAccountEncryptionMigrationInventoryResponse(
            inventory,
        )).toEqual({
            v: 1,
            items: [{
                structural: inventory[0]!.structural,
                sensitiveSource: inventory[0]!.sensitiveSource,
                events: inventory[0]!.events,
            }],
        });
    });

    it("preserves a strict legacy E2EE split source without manufacturing a combined ciphertext", () => {
        const comment = sourceComment();
        const row = {
            ...legacyCommentRow(comment),
            snapshot_envelope_json: JSON.stringify({ t: "encrypted", c: "snapshot-ciphertext" }),
            body_envelope_json: JSON.stringify({ t: "encrypted", c: "body-ciphertext" }),
            edits_json: JSON.stringify(comment.edits.map((edit) => ({
                ...edit,
                previousBody: { t: "encrypted", c: "previous-body-ciphertext" },
                nextBody: { t: "encrypted", c: "next-body-ciphertext" },
            }))),
        };

        expect(readReviewCommentMigrationSourceFromStorageRow(row)).toMatchObject({
            v: 1,
            layout: "legacy_split_v1",
            sourceMode: "e2ee",
            snapshotEnvelope: { t: "encrypted", c: "snapshot-ciphertext" },
            bodyEnvelope: { t: "encrypted", c: "body-ciphertext" },
            anchor: comment.anchor,
        });
    });

    it("writes one current sensitive envelope and scrubs every sensitive legacy side column", () => {
        const comment = sourceComment();
        const row = legacyCommentRow(comment);
        const split = splitReviewCommentV1(comment);
        const target = sealReviewCommentSensitiveEnvelopeV1({
            structural: split.structural,
            sensitive: split.sensitive,
            mode: "plain",
        });

        const values = buildReviewCommentCanonicalStorageValues({ row, targetSensitiveEnvelope: target });
        const { bodyEnvelopeJson: _sensitiveEnvelope, ...structuralColumns } = values;
        const serializedStructuralColumns = JSON.stringify(structuralColumns);

        expect(values.snapshotEnvelopeJson).toBe(REVIEW_COMMENT_CANONICAL_SENSITIVE_LAYOUT_MARKER_JSON);
        expect(JSON.parse(values.bodyEnvelopeJson)).toEqual(target);
        expect(JSON.parse(values.anchorJson)).toEqual(split.structural.anchorIndex);
        expect(JSON.parse(values.editsJson)).toEqual(split.structural.editHistory);
        expect(JSON.parse(values.transitionsJson)).toEqual(split.structural.transitionHistory);
        expect(JSON.parse(values.fingerprintJson!)).toEqual(split.structural.fingerprintIndex);
        expect(values.evidenceJson).toBeNull();
        expect(values.linkedRefsJson).toBeNull();
        expect(values.suggestedFixJson).toBeNull();
        expect(values.metadataJson).toBeNull();
        expect(serializedStructuralColumns).not.toContain("private body");
        expect(serializedStructuralColumns).not.toContain("private snapshot");
        expect(serializedStructuralColumns).not.toContain("private edit reason");
        expect(serializedStructuralColumns).not.toContain("private evidence");
        expect(serializedStructuralColumns).not.toContain("private transition reason");
        expect(serializedStructuralColumns).not.toContain("private-source-hash");
        expect(serializedStructuralColumns).not.toContain("private-taxonomy");
    });

    it("reads the canonical comment envelope only from the body column and rejects transplanted event binding", () => {
        const comment = sourceComment();
        const event = sourceEvent();
        const split = splitReviewCommentV1(comment);
        const target = sealReviewCommentSensitiveEnvelopeV1({
            structural: split.structural,
            sensitive: split.sensitive,
            mode: "plain",
        });
        const row = {
            ...legacyCommentRow(comment),
            ...(() => {
                const values = buildReviewCommentCanonicalStorageValues({
                    row: legacyCommentRow(comment),
                    targetSensitiveEnvelope: target,
                });
                return {
                    anchor_json: values.anchorJson,
                    snapshot_envelope_json: values.snapshotEnvelopeJson,
                    body_envelope_json: values.bodyEnvelopeJson,
                    edits_json: values.editsJson,
                    evidence_json: values.evidenceJson,
                    transitions_json: values.transitionsJson,
                    fingerprint_json: values.fingerprintJson,
                    linked_refs_json: values.linkedRefsJson,
                    suggested_fix_json: values.suggestedFixJson,
                    metadata_json: values.metadataJson,
                    tombstone_json: values.tombstoneJson,
                };
            })(),
        };
        const otherEvent = { ...event, eventId: "event-other" };
        const binding = requestBinding(event);
        const transplanted = bindReviewCommentEventSensitiveEnvelopeV1({
            event: otherEvent,
            requestBinding: binding,
            sensitive: sealReviewCommentEventSensitiveEnvelopeV1({
                payload: { v: 1, requestBinding: binding, details: { secret: "opaque" } },
                mode: "plain",
            }),
        });

        expect(() => buildReviewCommentAccountEncryptionMigrationInventory({
            accountId: comment.accountId,
            commentRows: [row],
            eventRows: [{
                ...legacyEventRow(event),
                event_envelope_json: JSON.stringify(transplanted),
            }],
        })).toThrow("review_comment_migration_event_binding_mismatch");

        const bound = bindReviewCommentEventSensitiveEnvelopeV1({
            event,
            requestBinding: binding,
            sensitive: sealReviewCommentEventSensitiveEnvelopeV1({
                payload: { v: 1, requestBinding: binding, details: { secret: "opaque" } },
                mode: "plain",
            }),
        });
        const inventory = buildReviewCommentAccountEncryptionMigrationInventory({
            accountId: comment.accountId,
            commentRows: [row],
            eventRows: [{
                ...legacyEventRow(event),
                event_envelope_json: JSON.stringify(bound),
            }],
        });
        expect(inventory[0]!.sensitiveSource).toEqual({
            v: 1,
            layout: "canonical_v1",
            envelope: target,
        });
        expect(inventory[0]!.events[0]!.sensitiveEnvelope).toEqual(bound);
        expect(inventory[0]!.events[0]!.sourceLayout).toBe("canonical_v1");
        expect(buildStoredReviewCommentFromStorageRow(row)).toEqual({
            v: 1,
            structural: split.structural,
            sensitiveEnvelope: target,
        });
        expect(readReviewCommentMigrationSourceFromStorageRow(row)).toEqual({
            v: 1,
            layout: "canonical_v1",
            envelope: target,
        });
    });

    it("rejects a plain target comment envelope bound to another structural identity", () => {
        const comment = sourceComment();
        const other = {
            ...comment,
            id: "comment-other",
            threadId: "comment-other",
        };
        const otherSplit = splitReviewCommentV1(other);
        const transplanted = sealReviewCommentSensitiveEnvelopeV1({
            structural: otherSplit.structural,
            sensitive: otherSplit.sensitive,
            mode: "plain",
        });

        expect(() => buildReviewCommentCanonicalStorageValues({
            row: legacyCommentRow(comment),
            targetSensitiveEnvelope: transplanted,
        })).toThrow("review_comment_migration_comment_binding_mismatch");
    });
});
