import { createHash } from "node:crypto";
import { claimReviewCommentPublication } from "@/testkit/reviewCommentPublicationTestkit";
import { describe, expect, it } from "vitest";

import type {
    ReviewCommentActorRefV1,
    ReviewCommentCreateRequestV1,
    ReviewCommentSnapshotV1,
} from "@happier-dev/protocol";

import { REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1, stringifyReviewCommentPrincipalCanonicalJsonV1 } from "@happier-dev/protocol";
import { buildReviewCommentTextSnapshotHashes } from "./snapshots";
import { createInMemoryReviewCommentStore } from "./store";
import { createReviewCommentOperations } from "./operations";

function textSnapshot(lines: readonly string[]): ReviewCommentSnapshotV1 {
    const hashes = buildReviewCommentTextSnapshotHashes({
        selectedLines: lines,
        beforeContext: [],
        afterContext: [],
    });
    return {
        kind: "text",
        selectedLines: [...lines],
        beforeContext: [],
        afterContext: [],
        selectedLinesHash: hashes.selectedLinesHash,
        contextWindowHash: hashes.contextWindowHash,
        capturedAt: 1,
        fileLength: lines.length,
        source: "workingTree",
        isUncommitted: true,
        isUntracked: false,
        truncated: false,
        hasBidiControls: false,
        likelyMinified: false,
    };
}

function createHarness() {
    let now = 1000;
    let id = 0;
    const store = createInMemoryReviewCommentStore();
    const operations = createReviewCommentOperations(store, {
        now: () => now++,
        createId: (prefix) => `${prefix}-${++id}`,
    });
    return { store, operations };
}

const pluginActor: ReviewCommentActorRefV1 = {
    kind: "plugin",
    pluginId: "review-coderabbit",
    engineRunId: "run-1",
};

const reviewAgentActor = { kind: "agent", agentId: "claude", sessionId: "session-1" } as const;

function directWriteCreate(input: ReviewCommentCreateRequestV1 & { projectId: string }) {
    const boundInput: ReviewCommentCreateRequestV1 & { projectId: string } = {
        workspaceId: "workspace-1",
        sessionId: reviewAgentActor.sessionId,
        runId: "run-1",
        engineId: "review-coderabbit",
        ...input,
    };
    return {
        actor: reviewAgentActor,
        grants: [REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1],
        currentIntent: {
            v: 1 as const,
            kind: "execution_run_host_action" as const,
            actionId: "reviews.comments.create" as const,
            subjectFingerprint: "a".repeat(64),
            effectBodySha256Base64Url: createHash("sha256")
                .update(stringifyReviewCommentPrincipalCanonicalJsonV1(boundInput))
                .digest("base64url"),
            sessionId: reviewAgentActor.sessionId,
            runId: "run-1",
            callId: "call-1",
            profileId: "review-coderabbit/review",
            pluginId: "review-coderabbit",
            agentId: reviewAgentActor.agentId,
            projectId: boundInput.projectId,
            workspaceId: "workspace-1",
            sourceCustody: {
                kind: "bundled_first_party" as const,
                packagedRuntime: {
                    kind: "cli_version_root" as const,
                    versionRootId: "review-coderabbit-test-cli-root",
                },
            },
        },
        input: boundInput,
    };
}

describe("review comment operations", () => {
    it("keeps authorized bulk targets reachable when another target is outside the principal Session scope", async () => {
        const { operations } = createHarness();
        const actor = { kind: "user", userId: "user-1" } as const;
        const create = (sessionId: string) => operations.create({ accountId: "account-1", actor,
            input: { projectId: "project-1", sessionId, anchor: { kind: "file", filePath: "src/example.ts" },
                snapshot: textSnapshot(["return value;"]), body: "Check value", authorIntent: "open", clientMutationId: `bulk-scope-${sessionId}` } });
        const own = (await create("session-1")).comment;
        const other = (await create("session-2")).comment;
        const result = await operations.bulkTransition({ accountId: "account-1", actor: reviewAgentActor,
            input: { projectId: "project-1", commentIds: [own.id, other.id], expectedState: "open", toState: "dismissed", reason: "Verified",
                evidence: [], expectedServerRevisions: { [own.id]: 1, [other.id]: 1 }, clientMutationId: "bulk-mixed-scope" } });
        expect(result.updated).toMatchObject([{ id: own.id, state: "dismissed" }]);
        expect(result.failed).toMatchObject([{ commentId: other.id, errorCode: "review_comment_permission_denied" }]);
    });
    it.each([
        [{ kind: "user", userId: "user-1" }, { kind: "user", userId: "user-1" }, false],
        [{ kind: "user", userId: "user-1" }, { kind: "user", userId: "user-2" }, false],
        [{ kind: "user", userId: "user-1" }, reviewAgentActor, true],
        [reviewAgentActor, reviewAgentActor, false],
        [{ kind: "workflow", runId: "workflow-1" }, { kind: "workflow", runId: "workflow-1" }, false],
    ] satisfies Array<[ReviewCommentActorRefV1, ReviewCommentActorRefV1, boolean]>)
    ("decides a re-raise from persisted dismissal actor %j and reopening actor %j", async (dismissActor, reopenActor, disputed) => {
        const { operations } = createHarness();
        const created = await operations.create({ accountId: "account-1", actor: { kind: "user", userId: "user-1" }, input: {
            projectId: "project-1", sessionId: "session-1", anchor: { kind: "file", filePath: "a.ts" },
            snapshot: textSnapshot(["input();"]), body: "Guard input", authorIntent: "open", clientMutationId: "actor-create",
        } });
        const principal = { accountId: "account-1", workflowOriginSessionId: "session-1" };
        const dismissed = await operations.transition({ ...principal, actor: dismissActor, input: {
            projectId: "project-1", commentId: created.comment.id, expectedState: "open", toState: "dismissed",
            expectedServerRevision: 1, reason: "No issue", clientMutationId: "actor-dismiss",
        } });
        // A same-state Decide later annotation must not replace dismissal provenance.
        const deferred = await operations.transition({ ...principal, actor: { kind: "user", userId: "user-3" }, input: {
            projectId: "project-1", commentId: created.comment.id, expectedState: "dismissed", toState: "dismissed",
            expectedServerRevision: 2, reviewTriageStatus: "defer", clientMutationId: "actor-defer",
        } });
        const reopened = await operations.transition({ ...principal, actor: reopenActor, input: {
            projectId: "project-1", commentId: created.comment.id, expectedState: "dismissed", toState: "open",
            expectedServerRevision: deferred.comment.serverRevision, clientMutationId: "actor-reopen",
        } });
        expect(dismissed.comment.transitions.at(-1)?.transitionedBy).toEqual(dismissActor);
        expect(reopened.comment.flags.disputed === true).toBe(disputed);
    });
    it("atomically coalesces semantic findings across engines and rounds without duplicate events", async () => {
        const { operations, store } = createHarness();
        const principal = { accountId: "account-1", actor: { kind: "user", userId: "user-1" } as const };
        const input = { projectId: "project-1", workspace: { machineId: "machine-1", path: "/repo" },
            sessionId: "session-1", findingIdentity: "b".repeat(64),
            anchor: { kind: "file" as const, filePath: "src/example.ts" }, snapshot: textSnapshot(["return value.name;"]),
            body: "Guard this value", authorIntent: "open" as const };
        const results = await Promise.all([
            operations.create({ ...principal, input: { ...input, engineId: "codex", runId: "round-1", clientMutationId: "engine-one" } }),
            operations.create({ ...principal, input: { ...input, engineId: "claude", runId: "round-2", clientMutationId: "engine-two" } }),
        ]);
        expect(results[1]!.comment.id).toBe(results[0]!.comment.id);
        expect(await store.listEvents({ accountId: principal.accountId, commentId: results[0]!.comment.id })).toHaveLength(1);
        const anotherWorkspace = await operations.create({ ...principal, input: { ...input,
            workspace: { machineId: "machine-1", path: "/other" }, clientMutationId: "different-workspace" } });
        expect(anotherWorkspace.comment.id).not.toBe(results[0]!.comment.id);
    });

    it("retains later panel membership on a deduplicated comment through CAS without changing its verdict", async () => {
        const { operations, store } = createHarness();
        const principal = { accountId: "account-1", actor: { kind: "user", userId: "user-1" } as const };
        const created = await operations.create({ ...principal, input: { projectId: "project-1", sessionId: "session-1",
            anchor: { kind: "file", filePath: "a.ts" }, snapshot: textSnapshot(["input();"]), body: "Guard input",
            metadata: { reviewGroupIds: ["panel-1"] }, authorIntent: "open", clientMutationId: "group-create" } });
        const input = { projectId: "project-1", commentId: created.comment.id, expectedState: "open" as const,
            toState: "open" as const, expectedServerRevision: 1, reviewGroupId: "panel-2", clientMutationId: "group-add" };
        const updated = await operations.transition({ accountId: principal.accountId, actor: reviewAgentActor, input });
        expect(updated.comment.metadata?.reviewGroupIds).toEqual(["panel-1", "panel-2"]);
        expect(updated.comment.state).toBe("open");
        expect(updated.comment.reviewTriageStatus).toBeUndefined();
        expect(updated.comment.flags.disputed).toBeUndefined();
        await expect(operations.transition({ accountId: principal.accountId, actor: reviewAgentActor, input }))
            .rejects.toMatchObject({ code: "review_comment_conflict" });
        expect((await store.listEvents({ accountId: principal.accountId, commentId: created.comment.id })).at(-1)?.eventKind).toBe("transitioned");
    });

    it("persists same-state triage annotations under CAS without allowing arbitrary self transitions", async () => {
        const { operations } = createHarness();
        const principal = { accountId: "account-1", actor: { kind: "user", userId: "user-1" } as const };
        const created = await operations.create({ ...principal, input: { projectId: "project-1",
            anchor: { kind: "file", filePath: "src/example.ts" }, snapshot: textSnapshot(["return value.name;"]),
            body: "Guard this value", authorIntent: "open", clientMutationId: "triage-create" } });
        const input = { projectId: "project-1", commentId: created.comment.id, expectedState: "open" as const,
            toState: "open" as const, expectedServerRevision: 1, clientMutationId: "triage-defer" };
        await expect(operations.transition({ ...principal, input })).rejects.toMatchObject({ code: "review_comment_invalid_transition" });
        const deferred = await operations.transition({ ...principal, input: { ...input, reviewTriageStatus: "defer" } });
        expect(deferred.comment.reviewTriageStatus).toBe("defer");
        expect(deferred.comment.transitions.at(-1)?.reviewTriageStatus).toBe("defer");
        await expect(operations.transition({ ...principal, input: { ...input, reviewTriageStatus: "needs_refinement" } }))
            .rejects.toMatchObject({ code: "review_comment_conflict" });
    });

    it("confines agent reads and verdict writes to its session review scope under CAS", async () => {
        const { operations } = createHarness();
        const user = { accountId: "account-1", actor: { kind: "user", userId: "user-1" } as const };
        const own = await operations.create({ ...user, input: {
            projectId: "project-1", sessionId: "session-1", engineId: "codex",
            anchor: { kind: "file", filePath: "src/example.ts" }, snapshot: textSnapshot(["return value.name;"]),
            body: "Guard this value", authorIntent: "open", clientMutationId: "scope-own",
        } });
        const foreign = await operations.create({ ...user, input: {
            projectId: "project-1", sessionId: "session-other",
            anchor: { kind: "file", filePath: "src/example.ts" }, snapshot: textSnapshot(["return value.name;"]),
            body: "Guard this value", authorIntent: "open", clientMutationId: "scope-foreign",
        } });
        const agent = { accountId: "account-1", actor: reviewAgentActor };
        const filters = { states: [], includeHistory: false, limit: 50 };
        expect((await operations.list({ ...agent, input: filters })).items.map((comment) => comment.id)).toEqual([own.comment.id]);
        await expect(operations.list({ ...agent, input: { ...filters, sessionId: "session-other" } }))
            .rejects.toMatchObject({ code: "review_comment_permission_denied" });
        await expect(operations.transition({ ...agent, input: {
            projectId: "project-1", commentId: foreign.comment.id, expectedState: "open", toState: "dismissed",
            expectedServerRevision: 1, reason: "Already guarded", clientMutationId: "scope-denied",
        } })).rejects.toMatchObject({ code: "review_comment_permission_denied" });
        await expect(operations.setDisposition({ ...agent, input: {
            projectId: "project-1", commentId: foreign.comment.id, expectedServerRevision: 1,
            disposition: "blocking", clientMutationId: "scope-disposition-denied",
        } })).rejects.toMatchObject({ code: "review_comment_permission_denied" });
        const dismissed = await operations.transition({ ...agent, input: {
            projectId: "project-1", commentId: own.comment.id, expectedState: "open", toState: "dismissed",
            expectedServerRevision: 1, reason: "Already guarded", clientMutationId: "scope-dismiss",
        } });
        expect(dismissed.comment.state).toBe("dismissed");
        await expect(operations.setDisposition({ ...agent, input: {
            projectId: "project-1", commentId: own.comment.id, expectedServerRevision: 1,
            disposition: "blocking", clientMutationId: "scope-stale",
        } })).rejects.toMatchObject({ code: "review_comment_conflict" });
    });

    it("confines workflow review operations to the server-owned origin Session and fails originless scope closed", async () => {
        const { operations } = createHarness();
        const user = { accountId: "account-1", actor: { kind: "user", userId: "user-1" } as const };
        const created = await operations.create({ ...user, input: { projectId: "project-1", sessionId: "session-1",
            anchor: { kind: "file", filePath: "src/example.ts" }, snapshot: textSnapshot(["return value.name;"]),
            body: "Guard this value", authorIntent: "open", clientMutationId: "workflow-scope-create" } });
        const workflow = { accountId: "account-1", actor: { kind: "workflow", runId: "workflow-1" } as const };
        const input = { states: [], includeHistory: false, limit: 50 };
        await expect(operations.list({ ...workflow, input })).rejects.toMatchObject({ code: "review_comment_permission_denied" });
        const scoped = { ...workflow, workflowOriginSessionId: "session-1" };
        expect((await operations.list({ ...scoped, input })).items.map((comment) => comment.id)).toEqual([created.comment.id]);
        await expect(operations.get({ ...scoped, workflowOriginSessionId: "session-other", input: { commentId: created.comment.id, includeHistory: true } }))
            .rejects.toMatchObject({ code: "review_comment_permission_denied" });
        const disposition = await operations.setDisposition({ ...scoped, input: { projectId: "project-1", commentId: created.comment.id,
            expectedServerRevision: 1, disposition: "blocking", clientMutationId: "workflow-verdict" } });
        expect(disposition.comment.dispositions["workflow:workflow-1"]).toBe("blocking");
    });

    it("keeps workspace-only scope through creation, CAS mutations, replies and events", async () => {
        const { operations, store } = createHarness();
        const workspace = { machineId: "machine-1", path: "/work/repo" };
        const principal = { accountId: "account-1", actor: { kind: "user", userId: "user-1" } as const };
        const created = await operations.create({
            ...principal,
            input: {
                workspace,
                sessionId: "session-1",
                findingIdentity: "a".repeat(64),
                findingSeverity: "high",
                anchor: { kind: "file", filePath: "src/example.ts" },
                snapshot: textSnapshot(["return value.name;"]),
                body: "Null-check this value.",
                authorIntent: "open",
                clientMutationId: "workspace-create",
            },
        });
        expect(created.comment).toMatchObject({ workspace, findingIdentity: "a".repeat(64), findingSeverity: "high" });
        expect(created.comment.projectId).toBeUndefined();
        await expect(operations.transition({
            ...principal,
            input: { commentId: created.comment.id, workspace: { ...workspace, path: "/other" },
                expectedState: "open", toState: "dismissed", expectedServerRevision: 1,
                reason: "Already guarded", clientMutationId: "wrong-workspace" },
        })).rejects.toMatchObject({ code: "review_comment_conflict" });
        const dismissed = await operations.transition({
            ...principal,
            input: { commentId: created.comment.id, workspace, expectedState: "open", toState: "dismissed",
                expectedServerRevision: 1, reason: "Already guarded", clientMutationId: "workspace-dismiss" },
        });
        const disputed = await operations.transition({
            ...principal,
            actor: reviewAgentActor,
            input: { commentId: created.comment.id, workspace, expectedState: "dismissed", toState: "open",
                expectedServerRevision: 2, reason: "Raised in the next round", clientMutationId: "workspace-reraise" },
        });
        expect(dismissed.comment.state).toBe("dismissed");
        expect(disputed.comment.flags.disputed).toBe(true);
        const replied = await operations.reply({
            ...principal,
            input: { parentCommentId: created.comment.id, workspace, body: "Please verify this again.",
                expectedParentServerRevision: 3, clientMutationId: "workspace-reply" },
        });
        expect(replied.comment.workspace).toEqual(workspace);
        const bulkInput = { workspace, commentIds: [created.comment.id], expectedState: "open" as const,
            toState: "dismissed" as const, expectedServerRevisions: { [created.comment.id]: 3 },
            evidence: [], reason: "Verified after re-review", clientMutationId: "workspace-bulk" };
        const wrongWorkspace = await operations.bulkTransition({ ...principal, input: { ...bulkInput, workspace: { ...workspace, path: "/other" } } });
        expect(wrongWorkspace.failed).toMatchObject([{ commentId: created.comment.id, errorCode: "review_comment_conflict" }]);
        const bulk = await operations.bulkTransition({ ...principal, input: bulkInput });
        expect(bulk.updated).toMatchObject([{ id: created.comment.id, state: "dismissed", serverRevision: 4 }]);
        const events = await store.listEvents({ accountId: principal.accountId, commentId: created.comment.id });
        expect(events.length).toBeGreaterThan(0);
        expect(events.every((event) => event.workspace?.machineId === workspace.machineId && event.workspace.path === workspace.path)).toBe(true);
    });

    it("allows only one provider dispatch for simultaneous publication requests of one frozen review plan", async () => {
        const { operations } = createHarness();
        const firstComment = await operations.create({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            grants: [],
            input: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
                snapshot: textSnapshot(["return value.name;"]),
                body: "Null-check this value.",
                authorIntent: "open",
                clientMutationId: "mutation-publication-comment",
            },
        });
        const secondComment = await operations.create({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            grants: [],
            input: {
                projectId: "project-1",
                anchor: { kind: "range", filePath: "src/example.ts", startLine: 8, endLine: 10 },
                snapshot: textSnapshot(["if (!value) return null;"]),
                body: "Preserve the explicit failure instead.",
                authorIntent: "open",
                clientMutationId: "mutation-publication-comment-2",
            },
        });
        const request = {
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" } as const,
            input: {
                target: {
                    providerId: "github",
                    configuredAccountId: "github-account-1",
                    entryRef: {
                        sourceId: "github",
                        kindId: "pull-request",
                        collisionScope: "github:repository-1",
                        entryId: "42",
                    },
                    subtarget: null,
                },
                baseRevision: "base-1",
                headRevision: "head-1",
                entries: [
                    {
                        happierCommentId: firstComment.comment.id,
                        expectedServerRevision: firstComment.comment.serverRevision,
                        anchor: { kind: "line" as const, filePath: "src/example.ts", line: 3 },
                        snapshot: textSnapshot(["return value.name;"]),
                        body: "Null-check this value.",
                    },
                    {
                        happierCommentId: secondComment.comment.id,
                        expectedServerRevision: secondComment.comment.serverRevision,
                        anchor: { kind: "range" as const, filePath: "src/example.ts", startLine: 8, endLine: 10 },
                        snapshot: textSnapshot(["if (!value) return null;"]),
                        body: "Preserve the explicit failure instead.",
                    },
                ],
                verdict: { kind: "requestChanges" as const, body: "Please address both findings." },
            },
        };

        const [first, second] = await Promise.all([
            claimReviewCommentPublication(operations, request),
            claimReviewCommentPublication(operations, request),
        ]);

        expect([first.disposition, second.disposition].sort()).toEqual(["dispatch", "reconcile"]);
        expect(first.publicationPlanId).toBe(second.publicationPlanId);
        expect(first.entries).toEqual(second.entries);
        expect(first.entries.map(({ happierCommentId }) => happierCommentId)).toEqual([
            firstComment.comment.id,
            secondComment.comment.id,
        ]);
        expect(new Set(first.entries.map(({ publicationCorrelationId }) => publicationCorrelationId)).size).toBe(2);
        expect(first.verdict).toEqual(second.verdict);
        expect(first.publicationPlanId).not.toContain("account-1");
        expect(first.publicationPlanId).not.toContain("repository-1");

        await expect(claimReviewCommentPublication(operations, {
            ...request,
            input: {
                ...request.input,
                verdict: { kind: "requestChanges" as const, body: "A different frozen plan." },
            },
        })).rejects.toMatchObject({ code: "review_comment_idempotency_conflict" });

        const threadPlan = {
            ...request,
            input: {
                ...request.input,
                target: {
                    ...request.input.target,
                    subtarget: { kindId: "review-thread" as const, targetId: "thread-a" },
                },
                entries: request.input.entries.slice(0, 1),
                verdict: null,
            },
        };
        const threadA = await claimReviewCommentPublication(operations, threadPlan);
        const threadB = await claimReviewCommentPublication(operations, {
            ...threadPlan,
            input: {
                ...threadPlan.input,
                target: {
                    ...threadPlan.input.target,
                    subtarget: { kindId: "review-thread" as const, targetId: "thread-b" },
                },
            },
        });
        expect(threadA.disposition).toBe("dispatch");
        expect(threadB.disposition).toBe("dispatch");
        expect(threadA.publicationPlanId).not.toBe(threadB.publicationPlanId);
        expect(threadA.entries[0]?.publicationCorrelationId)
            .not.toBe(threadB.entries[0]?.publicationCorrelationId);

        await expect(claimReviewCommentPublication(operations, {
            ...threadPlan,
            input: {
                ...threadPlan.input,
                target: {
                    ...threadPlan.input.target,
                    subtarget: { kindId: "review-thread" as const, targetId: "thread-stale" },
                },
                entries: [{
                    ...threadPlan.input.entries[0]!,
                    expectedServerRevision: threadPlan.input.entries[0]!.expectedServerRevision + 1,
                }],
            },
        })).rejects.toMatchObject({ code: "review_comment_conflict" });
    });

    it("settles and releases a frozen claim after the canonical comment is edited", async () => {
        const { operations } = createHarness();
        const created = await operations.create({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            grants: [],
            input: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
                snapshot: textSnapshot(["return value.name;"]),
                body: "Null-check this value.",
                authorIntent: "open",
                clientMutationId: "mutation-publication-edit-race",
            },
        });
        const request = {
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" } as const,
            input: {
                target: {
                    providerId: "github",
                    configuredAccountId: "github-account-1",
                    entryRef: {
                        sourceId: "github",
                        kindId: "pull-request",
                        collisionScope: "github:repository-1",
                        entryId: "42",
                    },
                    subtarget: null,
                },
                baseRevision: "base-1",
                headRevision: "head-1",
                entries: [{
                    happierCommentId: created.comment.id,
                    expectedServerRevision: created.comment.serverRevision,
                    anchor: created.comment.anchor,
                    snapshot: textSnapshot(["return value.name;"]),
                    body: "Null-check this value.",
                }],
                verdict: null,
            },
        };
        const claim = await claimReviewCommentPublication(operations, request);

        await operations.edit({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                projectId: "project-1",
                commentId: created.comment.id,
                expectedBodyVersion: created.comment.bodyVersion,
                expectedServerRevision: created.comment.serverRevision,
                nextBody: "Updated wording.",
                clientMutationId: "mutation-publication-edit-race-edit",
            },
        });

        await expect(claimReviewCommentPublication(operations, {
            ...request,
            input: {
                ...request.input,
                settlement: {
                    dispatchToken: claim.dispatchToken,
                    result: {
                        publicationPlanId: claim.publicationPlanId,
                        entries: [{
                            ...claim.entries[0]!,
                            outcome: { kind: "failed" as const, code: "provider/rejected" },
                        }],
                        verdict: { kind: "notRequested" as const },
                    },
                },
            },
        })).resolves.toMatchObject({ disposition: "reconcile" });
        await expect(claimReviewCommentPublication(operations, request)).resolves.toMatchObject({
            disposition: "dispatch",
            instructions: { entries: ["dispatch"], verdict: null },
        });
    });

    it("releases an uncertain effect only after tokenless reconciliation proves failure", async () => {
        const { operations } = createHarness();
        const created = await operations.create({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            grants: [],
            input: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
                snapshot: textSnapshot(["return value.name;"]),
                body: "Null-check this value.",
                authorIntent: "open",
                clientMutationId: "mutation-publication-tokenless-reconciliation",
            },
        });
        const request = {
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" } as const,
            input: {
                target: {
                    providerId: "gitlab",
                    configuredAccountId: "gitlab-account-1",
                    entryRef: {
                        sourceId: "gitlab",
                        kindId: "merge-request",
                        collisionScope: "gitlab:project-1",
                        entryId: "42",
                    },
                    subtarget: null,
                },
                baseRevision: "base-1",
                headRevision: "head-1",
                entries: [{
                    happierCommentId: created.comment.id,
                    expectedServerRevision: created.comment.serverRevision,
                    anchor: created.comment.anchor,
                    snapshot: textSnapshot(["return value.name;"]),
                    body: "Null-check this value.",
                }],
                verdict: null,
            },
        };
        const first = await claimReviewCommentPublication(operations, request);
        const entry = first.entries[0]!;

        const activeReconciliation = await claimReviewCommentPublication(operations, {
            ...request,
            input: {
                ...request.input,
                settlement: {
                    dispatchToken: null,
                    result: {
                        publicationPlanId: first.publicationPlanId,
                        entries: [{ ...entry, outcome: { kind: "failed" as const, code: "gitlab-pending-draft" } }],
                        verdict: { kind: "notRequested" as const },
                    },
                },
            },
        });
        expect(activeReconciliation).toMatchObject({
            disposition: "reconcile",
            instructions: { entries: ["reconcile"] },
            priorResult: { entries: [{ outcome: { kind: "uncertain" } }] },
        });
        await expect(claimReviewCommentPublication(operations, request)).resolves.toMatchObject({
            disposition: "reconcile",
            instructions: { entries: ["reconcile"] },
        });

        await claimReviewCommentPublication(operations, {
            ...request,
            input: {
                ...request.input,
                settlement: {
                    dispatchToken: first.dispatchToken,
                    result: {
                        publicationPlanId: first.publicationPlanId,
                        entries: [{ ...entry, outcome: { kind: "uncertain" as const } }],
                        verdict: { kind: "notRequested" as const },
                    },
                },
            },
        });
        const reconciled = await claimReviewCommentPublication(operations, request);
        expect(reconciled).toMatchObject({
            disposition: "reconcile",
            dispatchToken: null,
            instructions: { entries: ["reconcile"] },
        });

        const settled = await claimReviewCommentPublication(operations, {
            ...request,
            input: {
                ...request.input,
                settlement: {
                    dispatchToken: null,
                    result: {
                        publicationPlanId: first.publicationPlanId,
                        entries: [{ ...entry, outcome: { kind: "failed" as const, code: "gitlab-pending-draft" } }],
                        verdict: { kind: "notRequested" as const },
                    },
                },
            },
        });
        expect(settled).toMatchObject({
            priorResult: { entries: [{ outcome: { kind: "failed", code: "gitlab-pending-draft" } }] },
        });
        await expect(claimReviewCommentPublication(operations, request)).resolves.toMatchObject({
            disposition: "dispatch",
            instructions: { entries: ["dispatch"] },
        });
    });

    it("allows only one provider dispatch for simultaneous verdict-only publication requests", async () => {
        const { operations } = createHarness();
        const request = {
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" } as const,
            input: {
                target: {
                    providerId: "github",
                    configuredAccountId: "github-account-1",
                    entryRef: {
                        sourceId: "github",
                        kindId: "pull-request",
                        collisionScope: "github:repository-1",
                        entryId: "42",
                    },
                    subtarget: null,
                },
                baseRevision: "base-1",
                headRevision: "head-1",
                entries: [],
                verdict: { kind: "approve" as const, body: "Looks good." },
            },
        };

        const [first, second] = await Promise.all([
            claimReviewCommentPublication(operations, request),
            claimReviewCommentPublication(operations, request),
        ]);

        expect([first.disposition, second.disposition].sort()).toEqual(["dispatch", "reconcile"]);
        expect(first.publicationPlanId).toBe(second.publicationPlanId);
        expect(first.entries).toEqual([]);
        expect(first.verdict).toEqual(second.verdict);

        const laterVerdict = await claimReviewCommentPublication(operations, {
            ...request,
            input: {
                ...request.input,
                verdict: { kind: "requestChanges" as const, body: "This is a different frozen verdict." },
            },
        });
        expect(laterVerdict.disposition).toBe("dispatch");
        expect(laterVerdict.publicationPlanId).not.toBe(first.publicationPlanId);

        const otherAccount = await claimReviewCommentPublication(operations, {
            ...request,
            accountId: "account-2",
            actor: { kind: "user", userId: "user-2" },
        });
        expect(otherAccount.disposition).toBe("dispatch");
        expect(otherAccount.publicationPlanId).not.toBe(first.publicationPlanId);
        expect(otherAccount.verdict?.publicationCorrelationId)
            .not.toBe(first.verdict?.publicationCorrelationId);
    });

    it("replays an equivalent create exactly once for the same account and client mutation", async () => {
        const { store, operations } = createHarness();
        const params = {
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" } as const,
            grants: [],
            input: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 } as const,
                snapshot: textSnapshot(["return value.name;"]),
                body: "Null-check this value.",
                authorIntent: "open" as const,
                clientMutationId: "mutation-create-once",
            },
        };

        const first = await operations.create(params);
        const replay = await operations.create(params);

        expect(first.replayed).toBe(false);
        expect(replay).toEqual({ comment: first.comment, replayed: true });
        expect(await store.listEvents({ accountId: "account-1", commentId: first.comment.id }))
            .toHaveLength(1);
    });

    it("treats omitted and explicit propose intent as the same create request", async () => {
        const { operations } = createHarness();
        const common = {
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" } as const,
            grants: [],
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/example.ts" } as const,
                snapshot: textSnapshot(["return value.name;"]),
                body: "Proposed comment.",
                clientMutationId: "mutation-create-default-intent",
            },
        };

        const first = await operations.create(common);
        const replay = await operations.create({
            ...common,
            input: { ...common.input, authorIntent: "propose" },
        });

        expect(replay).toEqual({ comment: first.comment, replayed: true });
    });

    it("replays a recaptured equivalent snapshot for the same create mutation", async () => {
        const { operations } = createHarness();
        const common = {
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" } as const,
            grants: [],
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/example.ts" } as const,
                snapshot: textSnapshot(["return value.name;"]),
                body: "Equivalent recaptured comment.",
                clientMutationId: "mutation-recaptured-snapshot",
            },
        };

        const first = await operations.create(common);
        const replay = await operations.create({
            ...common,
            input: {
                ...common.input,
                snapshot: { ...common.input.snapshot, capturedAt: 2 },
            },
        });

        expect(replay).toEqual({ comment: first.comment, replayed: true });
    });

    it("rejects reuse of a create mutation for a different immutable request", async () => {
        const { operations } = createHarness();
        const base = {
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" } as const,
            grants: [],
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/example.ts" } as const,
                snapshot: textSnapshot(["return value.name;"]),
                body: "Original body.",
                authorIntent: "open" as const,
                clientMutationId: "mutation-create-conflict",
            },
        };

        await operations.create(base);

        await expect(operations.create({
            ...base,
            input: { ...base.input, body: "Different body." },
        })).rejects.toMatchObject({ code: "review_comment_idempotency_conflict" });
    });

    it("canonicalizes object key order while binding create replay to the trusted actor", async () => {
        const { operations } = createHarness();
        const common = {
            accountId: "account-1",
            grants: [],
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/example.ts" } as const,
                snapshot: textSnapshot(["return value.name;"]),
                body: "Canonical comment.",
                clientMutationId: "mutation-create-canonical",
            },
        };
        const first = await operations.create({
            ...common,
            actor: { kind: "user", userId: "user-1" },
            input: {
                ...common.input,
                fingerprint: {
                    ruleId: "rule-1",
                    normalizedMessageHash: "message-hash",
                    engineId: "engine-1",
                },
            },
        });
        const replay = await operations.create({
            ...common,
            actor: { kind: "user", userId: "user-1" },
            input: {
                ...common.input,
                fingerprint: {
                    engineId: "engine-1",
                    normalizedMessageHash: "message-hash",
                    ruleId: "rule-1",
                },
            },
        });

        expect(replay).toEqual({ comment: first.comment, replayed: true });
        await expect(operations.create({
            ...common,
            actor: { kind: "user", userId: "user-2" },
            input: {
                ...common.input,
                fingerprint: {
                    ruleId: "rule-1",
                    normalizedMessageHash: "message-hash",
                    engineId: "engine-1",
                },
            },
        })).rejects.toMatchObject({ code: "review_comment_idempotency_conflict" });
    });

    it("isolates create mutation identity by account", async () => {
        const { operations } = createHarness();
        const input = {
            projectId: "project-1",
            anchor: { kind: "file", filePath: "src/example.ts" } as const,
            snapshot: textSnapshot(["return value.name;"]),
            body: "Account-local comment.",
            authorIntent: "open" as const,
            clientMutationId: "shared-account-local-mutation",
        };

        const first = await operations.create({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            grants: [],
            input,
        });
        const second = await operations.create({
            accountId: "account-2",
            actor: { kind: "user", userId: "user-2" },
            grants: [],
            input,
        });

        expect(first.replayed).toBe(false);
        expect(second.replayed).toBe(false);
        expect(second.comment.id).not.toBe(first.comment.id);
    });

    it("admits one durable create under concurrent equivalent requests", async () => {
        const { store, operations } = createHarness();
        const params = {
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" } as const,
            grants: [],
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/example.ts" } as const,
                snapshot: textSnapshot(["return value.name;"]),
                body: "Concurrent comment.",
                authorIntent: "open" as const,
                clientMutationId: "mutation-create-concurrent",
            },
        };

        const results = await Promise.all([
            operations.create(params),
            operations.create(params),
        ]);

        expect(new Set(results.map((result) => result.comment.id))).toEqual(new Set([results[0]!.comment.id]));
        expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
        expect(await store.listEvents({ accountId: "account-1", commentId: results[0]!.comment.id }))
            .toHaveLength(1);
    });

    it("stores current-state rows and append-only events for proposed plugin comments", async () => {
        const { store, operations } = createHarness();

        const result = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            grants: [],
            input: {
                projectId: "project-1",
                runId: "run-1",
                engineId: "review-coderabbit",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
                snapshot: textSnapshot(["return value.name;"]),
                body: "Null-check this value.",
                clientMutationId: "mutation-1",
            },
        });

        expect(result.comment.state).toBe("proposed");
        expect(result.comment.author).toEqual(pluginActor);
        expect(await store.get({ accountId: "account-1", commentId: result.comment.id }))
            .toEqual(result.comment);
        expect(await store.listEvents({ accountId: "account-1", commentId: result.comment.id }))
            .toMatchObject([
                {
                    eventKind: "created",
                    commentId: result.comment.id,
                    accountId: "account-1",
                    projectId: "project-1",
                },
            ]);
    });

    it("requires the direct write grant before creating open comments", async () => {
        const { operations } = createHarness();

        await expect(operations.create({
            accountId: "account-1",
            ...directWriteCreate({
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: textSnapshot(["secret = readEnv();"]),
                body: "Investigate secret handling.",
                authorIntent: "open",
                clientMutationId: "mutation-1",
            }),
            grants: [],
        })).rejects.toMatchObject({ code: "review_comment_direct_write_permission_required" });

        const result = await operations.create({
            accountId: "account-1",
            ...directWriteCreate({
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: textSnapshot(["secret = readEnv();"]),
                body: "Investigate secret handling.",
                authorIntent: "open",
                clientMutationId: "mutation-2",
            }),
        });
        expect(result.comment.state).toBe("open");
    });

    it("requires the durable host-action grant for agent-authored proposed comments", async () => {
        const { operations } = createHarness();
        const create = directWriteCreate({
            projectId: "project-1",
            anchor: { kind: "file", filePath: "src/config.ts" },
            snapshot: textSnapshot(["secret = readEnv();"]),
            body: "Investigate secret handling.",
            authorIntent: "propose",
            clientMutationId: "mutation-agent-proposal",
        });

        await expect(operations.create({
            accountId: "account-1",
            ...create,
            grants: [],
        })).rejects.toMatchObject({ code: "review_comment_direct_write_permission_required" });

        const result = await operations.create({
            accountId: "account-1",
            ...create,
        });
        expect(result.comment).toMatchObject({
            state: "proposed",
            author: reviewAgentActor,
        });
    });

    it("allows user principals to create open comments without plugin direct-write grants", async () => {
        const { operations } = createHarness();

        const result = await operations.create({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            grants: [],
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: textSnapshot(["secret = readEnv();"]),
                body: "Track this issue.",
                authorIntent: "open",
                clientMutationId: "mutation-user-open",
            },
        });

        expect(result.comment).toMatchObject({
            state: "open",
            author: { kind: "user", userId: "user-1" },
        });
    });

    it("returns a stable error code for invalid snapshot metadata", async () => {
        const { operations } = createHarness();
        const lines = {
            selectedLines: ["x".repeat(5000)],
            beforeContext: [],
            afterContext: [],
        };
        const hashes = buildReviewCommentTextSnapshotHashes(lines);

        await expect(operations.create({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            grants: [],
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: {
                    kind: "text",
                    ...lines,
                    ...hashes,
                    capturedAt: 1,
                    fileLength: 1,
                    source: "workingTree",
                    isUncommitted: true,
                    isUntracked: false,
                    truncated: false,
                    hasBidiControls: false,
                    likelyMinified: true,
                },
                body: "Track invalid snapshot metadata.",
                authorIntent: "open",
                clientMutationId: "mutation-invalid-snapshot",
            },
        })).rejects.toMatchObject({ code: "review_comment_snapshot_invalid" });
    });

    it("enforces transition evidence and appends transition events without rewriting prior events", async () => {
        const { store, operations } = createHarness();
        const created = await operations.create({
            accountId: "account-1",
            ...directWriteCreate({
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
                snapshot: textSnapshot(["return value.name;"]),
                body: "Null-check this value.",
                authorIntent: "open",
                clientMutationId: "mutation-1",
            }),
        });

        await expect(operations.transition({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                projectId: "project-1",
                commentId: created.comment.id,
                expectedState: "open",
                expectedServerRevision: 1,
                toState: "resolved",
                clientMutationId: "mutation-2",
            },
        })).rejects.toMatchObject({ code: "review_comment_invalid_transition" });

        const transitioned = await operations.transition({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                projectId: "project-1",
                commentId: created.comment.id,
                expectedState: "open",
                expectedServerRevision: 1,
                toState: "resolved",
                evidence: [{ kind: "test", testResultRef: "test-1", status: "passed" }],
                clientMutationId: "mutation-3",
            },
        });

        expect(transitioned.comment.state).toBe("resolved");
        expect(transitioned.comment.serverRevision).toBe(2);
        expect(await store.listEvents({ accountId: "account-1", commentId: created.comment.id }))
            .toHaveLength(2);
    });

    it("rejects plugin moderation transitions while allowing original author delegated resolution with evidence", async () => {
        const { operations } = createHarness();
        const proposed = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
                snapshot: textSnapshot(["return value.name;"]),
                body: "Null-check this value.",
                clientMutationId: "mutation-1",
            },
        });

        await expect(operations.transition({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                commentId: proposed.comment.id,
                expectedState: "proposed",
                expectedServerRevision: 1,
                toState: "open",
                clientMutationId: "mutation-2",
            },
        })).rejects.toMatchObject({ code: "review_comment_permission_denied" });

        const opened = await operations.transition({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                projectId: "project-1",
                commentId: proposed.comment.id,
                expectedState: "proposed",
                expectedServerRevision: 1,
                toState: "open",
                clientMutationId: "mutation-3",
            },
        });
        const delegated = await operations.transition({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                projectId: "project-1",
                commentId: opened.comment.id,
                expectedState: "open",
                expectedServerRevision: 2,
                toState: "delegated",
                reason: "Please verify the fix.",
                clientMutationId: "mutation-4",
            },
        });
        const resolved = await operations.transition({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                commentId: delegated.comment.id,
                expectedState: "delegated",
                expectedServerRevision: 3,
                toState: "resolved",
                evidence: [{ kind: "test", testResultRef: "test-1", status: "passed" }],
                clientMutationId: "mutation-5",
            },
        });

        expect(resolved.comment.state).toBe("resolved");
    });

    it("requires typed evidence for non-user delegated completion", async () => {
        const { operations } = createHarness();
        const opened = await operations.create({
            accountId: "account-1",
            ...directWriteCreate({
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
                snapshot: textSnapshot(["return value.name;"]),
                body: "Null-check this value.",
                authorIntent: "open",
                clientMutationId: "mutation-1",
            }),
        });
        const delegated = await operations.transition({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                projectId: "project-1",
                commentId: opened.comment.id,
                expectedState: "open",
                expectedServerRevision: 1,
                toState: "delegated",
                reason: "Please verify the fix.",
                clientMutationId: "mutation-2",
            },
        });

        await expect(operations.transition({
            accountId: "account-1",
            actor: reviewAgentActor,
            input: {
                projectId: "project-1",
                commentId: delegated.comment.id,
                expectedState: "delegated",
                expectedServerRevision: 2,
                toState: "resolved",
                reason: "Looks fixed.",
                clientMutationId: "mutation-3",
            },
        })).rejects.toMatchObject({ code: "review_comment_invalid_transition" });
    });

    it("rejects non-user delegated completion by actors that did not author the comment", async () => {
        const { operations } = createHarness();
        const opened = await operations.create({
            accountId: "account-1",
            ...directWriteCreate({
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
                snapshot: textSnapshot(["return value.name;"]),
                body: "Null-check this value.",
                authorIntent: "open",
                clientMutationId: "mutation-1",
            }),
        });
        const delegated = await operations.transition({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                projectId: "project-1",
                commentId: opened.comment.id,
                expectedState: "open",
                expectedServerRevision: 1,
                toState: "delegated",
                reason: "Please verify the fix.",
                clientMutationId: "mutation-2",
            },
        });

        await expect(operations.transition({
            accountId: "account-1",
            actor: { kind: "plugin", pluginId: "review-deepsec" },
            input: {
                projectId: "project-1",
                commentId: delegated.comment.id,
                expectedState: "delegated",
                expectedServerRevision: 2,
                toState: "resolved",
                evidence: [{ kind: "test", testResultRef: "test-1", status: "passed" }],
                clientMutationId: "mutation-3",
            },
        })).rejects.toMatchObject({ code: "review_comment_permission_denied" });
    });

    it("allows only users and original authors to attach evidence", async () => {
        const { operations } = createHarness();
        const created = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: textSnapshot(["secret = readEnv();"]),
                body: "Investigate secret handling.",
                clientMutationId: "mutation-1",
            },
        });

        await expect(operations.attachEvidence({
            accountId: "account-1",
            actor: { kind: "plugin", pluginId: "review-deepsec" },
            input: {
                projectId: "project-1",
                commentId: created.comment.id,
                expectedServerRevision: 1,
                evidence: [{ kind: "reasoning", message: "Forged evidence." }],
                clientMutationId: "mutation-2",
            },
        })).rejects.toMatchObject({ code: "review_comment_permission_denied" });

        await expect(operations.attachEvidence({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                commentId: created.comment.id,
                expectedServerRevision: 1,
                evidence: [{ kind: "reasoning", message: "Author evidence." }],
                clientMutationId: "mutation-3",
            },
        })).resolves.toMatchObject({
            comment: {
                evidence: [{ kind: "reasoning", message: "Author evidence." }],
            },
        });
    });

    it("allows only users and original authors to edit non-redacted comments", async () => {
        const { operations } = createHarness();
        const created = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: textSnapshot(["secret = readEnv();"]),
                body: "Investigate secret handling.",
                clientMutationId: "mutation-1",
            },
        });

        await expect(operations.edit({
            accountId: "account-1",
            actor: { kind: "plugin", pluginId: "review-deepsec" },
            input: {
                projectId: "project-1",
                commentId: created.comment.id,
                expectedBodyVersion: 1,
                expectedServerRevision: 1,
                nextBody: "Rewrite another plugin's comment.",
                clientMutationId: "mutation-2",
            },
        })).rejects.toMatchObject({ code: "review_comment_permission_denied" });

        await expect(operations.edit({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                commentId: created.comment.id,
                expectedBodyVersion: 1,
                expectedServerRevision: 1,
                nextBody: "Updated by the original plugin.",
                clientMutationId: "mutation-3",
            },
        })).resolves.toMatchObject({
            comment: {
                body: "Updated by the original plugin.",
                bodyVersion: 2,
            },
        });
    });

    it("allows redaction only for user principals", async () => {
        const { operations } = createHarness();
        const created = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: textSnapshot(["secret = readEnv();"]),
                body: "Investigate secret handling.",
                clientMutationId: "mutation-1",
            },
        });

        await expect(operations.redact({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                commentId: created.comment.id,
                expectedServerRevision: 1,
                redactBody: true,
                clientMutationId: "mutation-2",
            },
        })).rejects.toMatchObject({ code: "review_comment_permission_denied" });
    });

    it("creates replies directly in the parent thread without a transient root event", async () => {
        const { store, operations } = createHarness();
        const parent = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
                snapshot: textSnapshot(["return value.name;"]),
                body: "Null-check this value.",
                clientMutationId: "mutation-1",
            },
        });

        const reply = await operations.reply({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                projectId: "project-1",
                parentCommentId: parent.comment.id,
                expectedParentServerRevision: 1,
                body: "Fixed in the next patch.",
                clientMutationId: "mutation-2",
            },
        });

        expect(reply.comment.parentCommentId).toBe(parent.comment.id);
        expect(reply.comment.threadId).toBe(parent.comment.threadId);
        expect(await store.listEvents({ accountId: "account-1", commentId: reply.comment.id }))
            .toMatchObject([{ eventKind: "replied", event: { parentCommentId: parent.comment.id } }]);
    });

    it("redacts the durable body while preserving a valid current-state row", async () => {
        const { operations } = createHarness();
        const created = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: textSnapshot(["secret = readEnv();"]),
                body: "Investigate secret handling.",
                clientMutationId: "mutation-1",
            },
        });

        const redacted = await operations.redact({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                projectId: "project-1",
                commentId: created.comment.id,
                expectedServerRevision: 1,
                redactBody: true,
                clientMutationId: "mutation-2",
            },
        });

        expect(redacted.comment.body).toBe("");
        expect(redacted.comment.flags.redacted).toBe(true);
    });

    it("redacts materialized edit history with the body", async () => {
        const { operations } = createHarness();
        const created = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: textSnapshot(["secret = readEnv();"]),
                body: "Investigate secret handling.",
                clientMutationId: "mutation-1",
            },
        });
        const edited = await operations.edit({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                commentId: created.comment.id,
                expectedBodyVersion: 1,
                expectedServerRevision: 1,
                nextBody: "Updated secret handling details.",
                clientMutationId: "mutation-2",
            },
        });

        expect(edited.comment.edits).toHaveLength(1);

        const redacted = await operations.redact({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                projectId: "project-1",
                commentId: created.comment.id,
                expectedServerRevision: 2,
                redactBody: true,
                clientMutationId: "mutation-3",
            },
        });

        expect(redacted.comment.edits).toEqual([]);
    });

    it("rejects already redacted comments", async () => {
        const { operations } = createHarness();
        const created = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: textSnapshot(["secret = readEnv();"]),
                body: "Investigate secret handling.",
                clientMutationId: "mutation-1",
            },
        });

        await operations.redact({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                projectId: "project-1",
                commentId: created.comment.id,
                expectedServerRevision: 1,
                redactBody: true,
                clientMutationId: "mutation-2",
            },
        });

        await expect(operations.redact({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                projectId: "project-1",
                commentId: created.comment.id,
                expectedServerRevision: 2,
                redactBody: true,
                clientMutationId: "mutation-3",
            },
        })).rejects.toMatchObject({ code: "review_comment_already_redacted" });
    });

    it("rejects replies to closed or redacted parent comments", async () => {
        const { operations } = createHarness();
        const open = await operations.create({
            accountId: "account-1",
            ...directWriteCreate({
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
                snapshot: textSnapshot(["return value.name;"]),
                body: "Null-check this value.",
                authorIntent: "open",
                clientMutationId: "mutation-1",
            }),
        });
        const resolved = await operations.transition({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                projectId: "project-1",
                commentId: open.comment.id,
                expectedState: "open",
                expectedServerRevision: 1,
                toState: "resolved",
                evidence: [{ kind: "test", testResultRef: "test-1", status: "passed" }],
                clientMutationId: "mutation-2",
            },
        });

        await expect(operations.reply({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                projectId: "project-1",
                parentCommentId: resolved.comment.id,
                expectedParentServerRevision: 2,
                body: "This thread is closed.",
                clientMutationId: "mutation-3",
            },
        })).rejects.toMatchObject({ code: "review_comment_thread_closed" });

        const redacted = await operations.redact({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                projectId: "project-1",
                commentId: resolved.comment.id,
                expectedServerRevision: 2,
                redactBody: true,
                clientMutationId: "mutation-4",
            },
        });

        await expect(operations.reply({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                projectId: "project-1",
                parentCommentId: redacted.comment.id,
                expectedParentServerRevision: 3,
                body: "This thread is redacted.",
                clientMutationId: "mutation-5",
            },
        })).rejects.toMatchObject({ code: "review_comment_thread_closed" });
    });

    it("bulk-transitions with one bulk action id and reports per-comment failures", async () => {
        const { store, operations } = createHarness();
        const open = await operations.create({
            accountId: "account-1",
            ...directWriteCreate({
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
                snapshot: textSnapshot(["return value.name;"]),
                body: "Null-check this value.",
                authorIntent: "open",
                clientMutationId: "mutation-1",
            }),
        });
        const proposed = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/other.ts", line: 4 },
                snapshot: textSnapshot(["return value.age;"]),
                body: "Check this branch.",
                clientMutationId: "mutation-2",
            },
        });

        const result = await operations.bulkTransition({
            accountId: "account-1",
            actor: { kind: "user", userId: "user-1" },
            input: {
                projectId: "project-1",
                commentIds: [open.comment.id, proposed.comment.id],
                toState: "resolved",
                expectedState: "open",
                expectedServerRevisions: {
                    [open.comment.id]: 1,
                    [proposed.comment.id]: 1,
                },
                evidence: [{ kind: "test", testResultRef: "test-1", status: "passed" }],
                bulkActionId: "bulk-1",
                clientMutationId: "mutation-3",
            },
        });

        expect(result.bulkActionId).toBe("bulk-1");
        expect(result.updated.map((comment) => comment.id)).toEqual([open.comment.id]);
        expect(result.updated[0]?.transitions.at(-1)?.bulkActionId).toBe("bulk-1");
        expect(result.failed).toMatchObject([{
            commentId: proposed.comment.id,
            errorCode: "review_comment_conflict",
        }]);
        expect(await store.listEvents({ accountId: "account-1", commentId: open.comment.id }))
            .toMatchObject([
                {},
                { eventKind: "transitioned", event: { bulkActionId: "bulk-1" } },
            ]);
    });

    it("keys agent dispositions by agent and session identity", async () => {
        const { operations } = createHarness();
        const created = await operations.create({
            accountId: "account-1",
            actor: pluginActor,
            input: {
                projectId: "project-1",
                sessionId: "session-1",
                anchor: { kind: "file", filePath: "src/config.ts" },
                snapshot: textSnapshot(["secret = readEnv();"]),
                body: "Investigate secret handling.",
                clientMutationId: "mutation-1",
            },
        });

        const disposition = await operations.setDisposition({
            accountId: "account-1",
            actor: { kind: "agent", agentId: "agent-1", sessionId: "session-1" },
            input: {
                projectId: "project-1",
                commentId: created.comment.id,
                expectedServerRevision: 1,
                disposition: "working",
                clientMutationId: "mutation-2",
            },
        });

        expect(disposition.comment.dispositions).toEqual({
            "agent:agent-1:session-1": "working",
        });
    });
});
