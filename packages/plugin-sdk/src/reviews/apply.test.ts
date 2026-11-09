import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '../../../tests/src/testkit/actionExecutorBoundary.js';
import { ReviewCommentV1Schema } from '@happier-dev/protocol/reviews/comments/v1';
import { getActionSpec, type PluginActionInputById } from '../actions/index.js';
import { ReviewFindingsApplyInputV1Schema, REVIEW_FINDINGS_VERIFY_AND_FIX_INSTRUCTIONS_V1,
    renderReviewFindingsForVerifyV1 } from './index.js';

describe('external review Apply authoring', () => {
    it('publishes the canonical verification builder through the public reviews entrypoint', () => {
        const finding = { id: 'finding', title: 'Unsafe read', summary: 'Verify the guard', severity: 'high' as const, category: 'correctness' as const };
        const input = { sessionId: 'session', reviews: [{ runId: 'review', findings: [finding] }] } satisfies PluginActionInputById['review.apply'];
        expect(ReviewFindingsApplyInputV1Schema.parse(input)).toEqual(input);
        expect(REVIEW_FINDINGS_VERIFY_AND_FIX_INSTRUCTIONS_V1).toContain('Verify every finding');
        expect(renderReviewFindingsForVerifyV1([finding])).toContain(finding.title);
    });

    it('invokes the public review Action with fresh scoped comments and preserves delivery refusals', async () => {
        const finding = { id: 'finding', title: 'Unsafe read', summary: 'Verify the guard', severity: 'high' as const, category: 'correctness' as const };
        const input = { sessionId: 'session', reviews: [{ runId: 'review', findings: [finding] }] } satisfies PluginActionInputById['review.apply'];
        const actionRequestId = 'public-review-apply-request';
        const spec = getActionSpec('review.apply');
        expect(spec.surfaces).toMatchObject({ plugin: true, cli: true, agent: true, mcp: true, ui: true });
        const comment = ReviewCommentV1Schema.parse({ v: 1, id: 'comment', accountId: 'account', workspace: { machineId: 'machine', path: '/repo' },
            sessionId: 'session', runId: 'review', findingId: finding.id, state: 'open', reviewTriageStatus: 'accept',
            body: finding.summary, bodyVersion: 1, edits: [], flags: {}, dispositions: {}, threadId: 'comment', transitions: [],
            anchor: { kind: 'file', filePath: 'reader.ts' }, snapshot: { kind: 'none', capturedAt: 1 },
            author: { kind: 'plugin', pluginId: 'external.reviewer' }, serverRevision: 9, createdAt: 1, updatedAt: 1 });
        const refusal = { ok: false as const, errorCode: 'session_input_target_update_required', error: 'session_input_target_update_required' };
        const sent: string[] = [];
        // Only the Home review transport and Session message transport are replaced.
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ isActionApprovalRequired: () => false,
            reviewCommentAction: async request => {
                expect(request.reviewCommentPrincipal).toEqual({ actor: { kind: 'plugin', pluginId: 'external.consumer' } });
                return { items: [comment], cursor: null };
            },
            sessionSendMessage: async request => {
                expect(request.idempotencyKey).toBe(actionRequestId);
                sent.push(request.message);
                return refusal;
            },
        }));
        const result = await executor.execute(spec.id, input, { surface: 'plugin', serverId: 'home', actionRequestId,
            actionCaller: { kind: 'plugin', pluginId: 'external.consumer', contributionLocalId: 'apply-review' } });
        expect(result, `${actionRequestId}: ${JSON.stringify(result)}`).toEqual(refusal);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toContain('"commentId": "comment"');
        expect(sent[0]).toContain('"expectedServerRevision": 9');
        expect(sent[0]).toContain('Verify every finding');
    });

    it('refuses a plugin invocation without a host-stamped caller before sending', async () => {
        const spec = getActionSpec('review.apply');
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ isActionApprovalRequired: () => false,
            reviewCommentAction: async () => ({ ok: false, errorCode: 'review_comment_permission_denied', error: 'review_comment_permission_denied' }),
            sessionSendMessage: async () => { throw new Error('A refused review must never send'); },
        }));
        expect(await executor.execute(spec.id, { sessionId: 'session', reviews: [{ runId: 'review', findings: [] }] },
            { surface: 'plugin', serverId: 'home' })).toMatchObject({ ok: false, errorCode: 'plugin_action_caller_required' });
    });
});
