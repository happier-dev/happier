import { describe, expect, it } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import type { ReviewFinding, ReviewFollowUpV1 } from '@happier-dev/protocol';
import { resolveEffectiveReviewFindings } from './resolveEffectiveReviewFindings';

const runRef = { runId: 'run-1', callId: 'call-1', backendId: 'codex' };
const finding: ReviewFinding = { id: 'f1', title: 'Issue', severity: 'high', category: 'correctness', summary: 'Issue' };
function message(followUp: ReviewFollowUpV1): Message {
    return { id: followUp.threadId, localId: null, kind: 'agent-text', text: '', createdAt: 1, meta: {
        happier: { kind: 'review_follow_up.v1', payload: followUp },
    } };
}
function answer(overrides: Partial<ReviewFollowUpV1> = {}): ReviewFollowUpV1 {
    return { parentRunRef: runRef, threadId: 'question', findingIds: ['f1'], requestMarkdown: 'Why?', answerMarkdown: 'Because.', generatedAtMs: 1, ...overrides };
}

describe('resolveEffectiveReviewFindings', () => {
    it('retains question references even when the answer leaves a finding unchanged', () => {
        const result = resolveEffectiveReviewFindings({ runRef, initialFindings: [finding], messages: [message(answer())] });
        expect(result.findings).toEqual([finding]);
        expect(result.threadRefsByFindingId.f1).toEqual(['question']);
        expect(result.threadsByFindingId.f1?.[0]).toMatchObject({ updatedFinding: null, previousFinding: null });
    });

    it('applies resolution updates only to the exact run and preserves the original finding', () => {
        const updated = { ...finding, summary: 'Resolved', comment: { id: 'comment', state: 'resolved' as const, serverRevision: 2, workspace: { machineId: 'm', path: '/repo' } } };
        const result = resolveEffectiveReviewFindings({ runRef, initialFindings: [finding], messages: [
            message(answer({ parentRunRef: { ...runRef, runId: 'run-2' }, updatedFindings: [{ ...finding, summary: 'Wrong run' }] })),
            message(answer({ parentRunRef: { ...runRef, callId: 'call-2' }, updatedFindings: [{ ...finding, summary: 'Wrong call' }] })),
            message(answer({ parentRunRef: { ...runRef, backendId: 'other' }, updatedFindings: [{ ...finding, summary: 'Wrong engine' }] })),
            message(answer({ updatedFindings: [updated] })),
        ] });
        expect(result.findings).toEqual([updated]);
        expect(result.originalByFindingId.f1).toEqual(finding);
        expect(result.threadsByFindingId.f1).toHaveLength(1);
    });
    it('keeps persisted comment references when a follow-up revises finding content without changing its comment', () => {
        const persisted = { ...finding, comment: { id: 'comment', state: 'proposed' as const, serverRevision: 2, workspace: { machineId: 'm', path: '/repo' } } };
        const result = resolveEffectiveReviewFindings({ runRef, initialFindings: [persisted],
            messages: [message(answer({ updatedFindings: [{ ...finding, summary: 'Clarified' }] }))] });
        expect(result.findings).toEqual([{ ...persisted, summary: 'Clarified' }]);
    });
});
