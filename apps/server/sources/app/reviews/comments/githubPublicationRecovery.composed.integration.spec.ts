import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewCommentPublicationPlanV1 } from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { claimReviewCommentPublication } from "@/testkit/reviewCommentPublicationTestkit";
import { createReviewCommentOperations } from "./operations";
import { createSqlReviewCommentStore } from "./store";
import { publishGithubPullRequestReview } from '../../../../../../packages/plugins/scm-github/src/triage/mutations/pullRequest';
import { createStubGithubTransport, createTestGithubApiClient, readRecordedJsonBody } from '../../../../../../packages/plugins/scm-github/src/triage/testkit/githubTriage.test-support';
import { GITHUB_FIXTURE_OWNER, GITHUB_FIXTURE_REPOSITORY, GITHUB_PULL_REQUEST_RESPONSE } from '../../../../../../packages/plugins/scm-github/src/triage/__fixtures__/githubResponses';

describe("GitHub publication recovery through the real provider adapter and SQL claim owner", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-github-publication-recovery-", initAuth: false, sqliteConnectionLimit: 2 });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("reuses the first round's GitHub thread when the same finding appears at a later head", async () => {
        const account = await db.account.create({ data: {
            id: "account-publication-successive-rounds", publicKey: "pk-publication-successive-rounds", encryptionMode: "plain",
        } });
        const review = await db.artifact.create({ data: { id: "review-publication-successive-rounds", accountId: account.id,
            header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array(),
        } });
        let sequence = 0;
        const operations = createReviewCommentOperations(createSqlReviewCommentStore(), {
            now: () => 1234, createId: prefix => `${prefix}-successive-${++sequence}`,
        });
        const principal = { accountId: account.id, actor: { kind: "user" as const, userId: account.id },
            reviewAccess: { reviewId: review.id, ownerAccountId: account.id, level: "admin" as const, encryptionMode: "plain" as const } };
        const route = { owner: GITHUB_FIXTURE_OWNER, name: GITHUB_FIXTURE_REPOSITORY };
        const pull = `/repos/${route.owner}/${route.name}/pulls/1284`;
        const localRef = { kindId: "pull-request", collisionScope: "github:4210", entryId: "1284" } as const;
        const baseRevision = "b".repeat(40);
        let headRevision = "a".repeat(40);

        const createFinding = async (identity: string, roundOrdinal: number) => {
            const { comment } = await operations.create({ ...principal, input: {
                reviewId: review.id, findingIdentity: identity.repeat(64),
                appearance: { roundOrdinal, runId: `run-${roundOrdinal}`, reviewerId: "model" },
                clientMutationId: `finding-${identity}-round-${roundOrdinal}`, authorIntent: "propose",
                anchor: { kind: "file", filePath: `${identity}.ts` },
                snapshot: { kind: "none", capturedAt: 1 }, body: `Finding ${identity}`,
            } });
            if (typeof comment.body !== "string") throw new Error("Expected an opened review finding");
            return { happierCommentId: comment.id, expectedServerRevision: comment.serverRevision,
                anchor: comment.anchor, body: comment.body,
                snapshot: { kind: "text" as const, selectedLines: [], beforeContext: [], afterContext: [],
                    selectedLinesHash: "selected", contextWindowHash: "context", capturedAt: 1, fileLength: 1,
                    source: "diffSide" as const, isUncommitted: false, isUntracked: false, truncated: false,
                    hasBidiControls: false, likelyMinified: false,
                    diffContext: { side: "after" as const, baseSha: baseRevision, headSha: headRevision } },
            };
        };
        const reviews: Array<{ id: number; body: string }> = [];
        const comments: Array<{ id: number; body: string; path: string }> = [];
        const transport = createStubGithubTransport({ respond: request => {
            const path = new URL(request.url).pathname;
            if (request.method === "GET" && path === pull) return { status: 200, body: {
                ...GITHUB_PULL_REQUEST_RESPONSE, state: "open", merged: false,
                head: { ...(GITHUB_PULL_REQUEST_RESPONSE.head as object), sha: headRevision },
                base: { ...(GITHUB_PULL_REQUEST_RESPONSE.base as object), sha: baseRevision },
            } };
            if (request.method === "GET" && path === `${pull}/reviews`) return { status: 200, body: reviews };
            if (request.method === "GET" && path === `${pull}/comments`) return { status: 200, body: comments };
            if (request.method === "POST" && path === `${pull}/reviews`) {
                const payload = readRecordedJsonBody(request) as { body: string; comments: Array<{ body: string; path: string }> };
                reviews.push({ id: 200 + reviews.length, body: payload.body });
                for (const comment of payload.comments) comments.push({ id: 400 + comments.length, ...comment });
                return { status: 201, body: reviews.at(-1) };
            }
            return undefined;
        } });
        const client = await createTestGithubApiClient(transport);
        const publish = (entries: ReviewCommentPublicationPlanV1["entries"], body: string) => {
            const publicationPlan: ReviewCommentPublicationPlanV1 = {
                target: { providerId: "github", configuredAccountId: "account-under-test", subtarget: null,
                    entryRef: { sourceId: "happier.scm.forge.github/github-forge", ...localRef } },
                baseRevision, headRevision, entries, verdict: { kind: "comment", body },
            };
            return publishGithubPullRequestReview({ localRef, route, publicationPlan,
                claimPublicationDispatch: () => claimReviewCommentPublication(operations, { ...principal, input: publicationPlan }),
                settlePublicationDispatch: async (claim, result) => {
                    await claimReviewCommentPublication(operations, { ...principal,
                        input: { ...publicationPlan, settlement: { dispatchToken: claim.dispatchToken, result } } });
                },
            }, { client, now: () => 1234, signal: transport.context.signal });
        };
        const original = await createFinding("a", 1);
        expect(await publish([original], "Initial review")).toMatchObject({ kind: "settled",
            publication: { entries: [{ outcome: { kind: "published", externalRef: "400" } }] },
        });
        headRevision = "c".repeat(40);
        const repeated = await createFinding("a", 2);
        expect(repeated.happierCommentId).toBe(original.happierCommentId);
        const fresh = await createFinding("b", 2);
        expect(await publish([{ ...repeated, snapshot: original.snapshot }, fresh], "Follow-up review")).toMatchObject({ kind: "settled",
            publication: { entries: [
                { happierCommentId: original.happierCommentId, outcome: { kind: "published", externalRef: "400" } },
                { happierCommentId: fresh.happierCommentId, outcome: { kind: "published", externalRef: "401" } },
            ] },
        });
        expect(comments.map(comment => comment.path)).toEqual(["a.ts", "b.ts"]);
        expect(reviews).toHaveLength(2);
    });

    it("reconciles a GitHub review after settlement transport timeout without a second provider POST", async () => {
        const account = await db.account.create({ data: {
            id: "account-publication-settlement-timeout", publicKey: "pk-publication-settlement-timeout", encryptionMode: "plain",
        }, select: { id: true } });
        const operations = createReviewCommentOperations(createSqlReviewCommentStore(), {
            now: () => 1234, createId: (prefix) => `${prefix}-unused`,
        });
        const headRevision = "a".repeat(40);
        const baseRevision = "b".repeat(40);
        const localRef = { kindId: "pull-request", collisionScope: "github:4210", entryId: "1284" } as const;
        const plan: ReviewCommentPublicationPlanV1 = {
            target: { providerId: "github", configuredAccountId: "account-under-test", subtarget: null,
                entryRef: { sourceId: "happier.scm.forge.github/github-forge", ...localRef } },
            baseRevision, headRevision, entries: [], verdict: { kind: "requestChanges", body: "Review after settlement timeout." },
        };
        const reviews: Array<{ id: number; commit_id: string; state: string; body: string }> = [];
        const transport = createStubGithubTransport({ respond: request => {
            const path = new URL(request.url).pathname;
            const pull = `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`;
            if (request.method === "GET" && path === pull) return { status: 200, body: {
                ...GITHUB_PULL_REQUEST_RESPONSE, state: "open", merged: false,
                head: { ...(GITHUB_PULL_REQUEST_RESPONSE.head as object), sha: headRevision },
                base: { ...(GITHUB_PULL_REQUEST_RESPONSE.base as object), sha: baseRevision },
            } };
            if (request.method === "GET" && path === `${pull}/reviews`) return { status: 200, body: reviews };
            if (request.method === "POST" && path === `${pull}/reviews`) {
                const body = readRecordedJsonBody(request) as { body: string; commit_id: string; event: string };
                reviews.push({ id: 5579420454, body: body.body, commit_id: body.commit_id, state: "CHANGES_REQUESTED" });
                return { status: 201, body: reviews.at(-1) };
            }
            return undefined;
        } });
        const client = await createTestGithubApiClient(transport);
        let loseFirstSettlement = true;
        const dispositions: string[] = [];
        const publish = () => publishGithubPullRequestReview({
            localRef, route: { owner: GITHUB_FIXTURE_OWNER, name: GITHUB_FIXTURE_REPOSITORY }, publicationPlan: plan,
            claimPublicationDispatch: async () => {
                const claim = await claimReviewCommentPublication(operations, {
                    accountId: account.id, actor: { kind: "user", userId: account.id }, input: plan,
                });
                dispositions.push(claim.disposition);
                return claim;
            },
            settlePublicationDispatch: async (claim, result) => {
                // The host transport can fail before the canonical settlement is attempted,
                // as an approval currentness read did in QA33. Keep the real SQL owner below it.
                if (loseFirstSettlement) {
                    loseFirstSettlement = false;
                    throw Object.assign(new Error("Machine RPC setup timed out"), { code: "MACHINE_RPC_TIMEOUT" });
                }
                await claimReviewCommentPublication(operations, { accountId: account.id,
                    actor: { kind: "user", userId: account.id }, input: {
                        ...plan, settlement: { dispatchToken: claim.dispatchToken, result },
                    } });
            },
        }, { client, now: () => 1234, signal: transport.context.signal });
        expect(await publish()).toMatchObject({ kind: "settled",
            failure: { code: "github_publication_settlement_unrecorded" },
            publication: { verdict: { outcome: { kind: "published", externalRef: "5579420454" } } },
        });
        const recovered = await publish();
        expect(recovered).not.toHaveProperty("failure");
        expect(recovered).toMatchObject({ kind: "settled",
            publication: { verdict: { outcome: { kind: "published", externalRef: "5579420454" } } },
        });
        expect(dispositions).toEqual(["dispatch", "reconcile"]);
        expect(reviews).toHaveLength(1);
        expect(transport.requests.filter(request => request.method === "POST")).toHaveLength(1);
        expect(await claimReviewCommentPublication(operations, { accountId: account.id,
            actor: { kind: "user", userId: account.id }, input: plan,
        })).toMatchObject({ disposition: "reconcile", instructions: { entries: [], verdict: "confirmed" },
            priorResult: { verdict: { outcome: { kind: "published", externalRef: "5579420454" } } },
        });
    });
});
