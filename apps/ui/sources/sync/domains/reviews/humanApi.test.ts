import { describe, expect, it } from 'vitest';
import { createReviewHumanActionExecutorV1 } from '@happier-dev/protocol/reviews/reviewHumanTransportV1';
import { REVIEW_HUMAN_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/actionIds';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { ReviewVerdictContentV1Schema, type ReviewHumanStateV1 } from '@happier-dev/protocol/reviews/reviewHumanV1';
import { createReviewHumanHttpActionExecutor } from './humanApi';

describe('Review human answering-client transport', () => {
    it('sends a prose-free person verdict through the captured HTTP Account and preserves server refusals', async () => {
        const state: ReviewHumanStateV1 = { reviewId: 'review', roundOrdinal: 1, requests: [], verdicts: [],
            needsYou: { reviewId: 'review', roundOrdinal: 1, reason: 'review_needs_you', requestedVerdict: false,
                pendingDecisions: false, needsYou: false, canSubmitVerdict: true } };
        let refused = false;
        let resourceReads = 0;
        const execute = createReviewHumanHttpActionExecutor({ accountId: 'person', assertCurrent: () => {},
            readArtifactContent: async () => { resourceReads += 1; return null; },
            request: async (path, options) => {
                expect(path).toBe('/v1/reviews/review/verdicts');
                expect(options?.method).toBe('POST');
                expect(JSON.parse(String(options?.body))).toEqual({ roundOrdinal: 1, verdict: 'request_changes' });
                return new Response(JSON.stringify(refused ? { error: 'review_reviewer_not_requested' } : state), { status: refused ? 403 : 200 });
            },
        });
        const args = { actionId: REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict,
            input: { reviewId: 'review', roundOrdinal: 1, verdict: 'request_changes', body: undefined } };
        await expect(execute(args)).resolves.toEqual(state);
        expect(resourceReads).toBe(0);
        refused = true;
        await expect(execute(args)).rejects.toMatchObject({ code: 'review_reviewer_not_requested' });
    });
    it('rejects verdict prose replayed under a different author', async () => {
        const execute = createReviewHumanActionExecutorV1({ accountId: 'person',
            request: async () => ({ reviewId: 'review', roundOrdinal: 1, requests: [],
                verdicts: [{ accountId: 'alice', roundOrdinal: 1, verdict: 'approve', revision: 1, submittedAt: 1,
                    content: { t: 'plain', v: { reviewId: 'review', roundOrdinal: 1, accountId: 'bob', revision: 1, body: 'replayed' } } }],
                needsYou: { reviewId: 'review', roundOrdinal: 1, reason: 'review_needs_you', requestedVerdict: false,
                    pendingDecisions: false, needsYou: false, canSubmitVerdict: false } }),
            resolveResource: async () => ({ mode: 'plain', seal: async value => ({ t: 'plain', v: value }),
                open: async content => content.t === 'plain' ? content.v : null }),
        });
        await expect(execute(REVIEW_HUMAN_ACTION_IDS_V1.get, { reviewId: 'review' }))
            .rejects.toMatchObject({ code: 'review_verdict_content_mismatch' });
    });
    it('opens historical verdicts with one captured Artifact resource read', async () => {
        const key = new ArtifactEncryption(new Uint8Array(32).fill(7));
        const verdicts = await Promise.all(['alice', 'bob'].map(async accountId => ({ accountId, roundOrdinal: 1,
            verdict: 'approve' as const, revision: 1, submittedAt: 1, content: { t: 'encrypted' as const,
                c: await key.encryptHeader({ reviewId: 'review', roundOrdinal: 1, accountId, revision: 1, body: accountId }) },
        })));
        let resourceReads = 0;
        const execute = createReviewHumanActionExecutorV1({ accountId: 'person',
            request: async () => ({ reviewId: 'review', roundOrdinal: 2, requests: [], verdicts,
                needsYou: { reviewId: 'review', roundOrdinal: 2, reason: 'review_needs_you', requestedVerdict: false,
                    pendingDecisions: false, needsYou: false, canSubmitVerdict: false } }),
            resolveResource: async () => {
                resourceReads += 1;
                return { mode: 'e2ee', seal: async value => ({ t: 'encrypted', c: await key.encryptHeader(ReviewVerdictContentV1Schema.parse(value)) }),
                    open: async content => content.t === 'encrypted' ? key.decryptHeaderRaw(content.c) : content.v };
            },
        });
        const result = await execute(REVIEW_HUMAN_ACTION_IDS_V1.get, { reviewId: 'review' });
        expect(result.verdicts.map(verdict => verdict.body)).toEqual(['alice', 'bob']);
        // Cost contract: one Artifact read per admitted operation, independent of verdict history length.
        expect(resourceReads).toBe(1);
    });

    it('seals person-authored prose at the actual HTTP boundary and opens the returned bound verdict', async () => {
        const key = new ArtifactEncryption(new Uint8Array(32).fill(7));
        const state: ReviewHumanStateV1 = { reviewId: 'review', roundOrdinal: 2, requests: [], verdicts: [],
            needsYou: { reviewId: 'review', roundOrdinal: 2, reason: 'review_needs_you', requestedVerdict: true,
                pendingDecisions: false, needsYou: true, canSubmitVerdict: true } };
        let posted: unknown;
        const execute = createReviewHumanActionExecutorV1({ accountId: 'person',
            resolveResource: async () => ({ mode: 'e2ee',
                seal: async value => ({ t: 'encrypted', c: await key.encryptHeader(ReviewVerdictContentV1Schema.parse(value)) }),
                open: async content => content.t === 'encrypted' ? key.decryptHeaderRaw(content.c) : content.v,
            }),
            // The HTTP transport is the system boundary; crypto and the complete domain adapter remain real.
            request: async (method, path, body) => {
                if (method === 'GET' && path === '/v1/reviews/review/human') return state;
                if (method !== 'POST' || path !== '/v1/reviews/review/verdicts') throw new Error('unexpected_request');
                posted = body;
                const value = body as Record<string, unknown>;
                return { ...state, verdicts: [{ accountId: 'person', roundOrdinal: 2,
                    verdict: value.verdict, content: value.content, revision: 1, submittedAt: 1 }] };
            },
        });
        const result = await execute(REVIEW_HUMAN_ACTION_IDS_V1.submitVerdict,
            { reviewId: 'review', roundOrdinal: 2, verdict: 'approve', body: 'Private reviewer prose' });
        expect(posted).toMatchObject({ expectedRevision: 0, verdict: 'approve', content: { t: 'encrypted' } });
        expect(JSON.stringify(posted)).not.toContain('Private reviewer prose');
        expect(posted).not.toHaveProperty('accountId');
        expect(posted).not.toHaveProperty('body');
        expect(result.verdicts).toEqual([{ accountId: 'person', roundOrdinal: 2, verdict: 'approve',
            body: 'Private reviewer prose', revision: 1, submittedAt: 1 }]);
    });
});
