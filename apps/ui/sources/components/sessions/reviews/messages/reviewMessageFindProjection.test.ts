import { describe, expect, it } from 'vitest';
import type { ReviewFinding, ReviewFindingsV2, ReviewFollowUpV1 } from '@happier-dev/protocol';
import type { Message } from '@happier-dev/session-core/messages';
import { projectReviewFindingsFindText } from './reviewFindingsMessageDisplay';
import { projectReviewFollowUpFindText } from './ReviewFollowUpMessageCard';
import { projectReviewCommentsFindText } from './ReviewCommentsMessageCard';
import { buildReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';

const finding = (id: string): ReviewFinding => ({ id, title: `Title ${id}`, summary: `Hidden summary ${id}`, severity: 'low', category: 'correctness', filePath: `hidden-${id}.ts`, startLine: 2 });
const payload: ReviewFindingsV2 = {
    runRef: { runId: 'hidden-run', callId: 'hidden-call', backendId: 'codex' },
    generatedAtMs: 1, summary: 'Full card summary', overviewMarkdown: '**Hidden overview**',
    findings: ['f1', 'f2', 'f3', 'f4'].map(finding), questions: [], assumptions: [],
};
const textOf = (blocks: readonly { text: string }[]) => blocks.map((block) => block.text).join('\n');

describe('Review message displayed Find corpus', () => {
    it('keeps compact cards limited to rendered rows, using effective finding updates', () => {
        const update: ReviewFollowUpV1 = { parentRunRef: payload.runRef, threadId: 'hidden-thread', findingIds: ['f1'], requestMarkdown: 'Question', answerMarkdown: 'Answer', generatedAtMs: 2, updatedFindings: [{ ...finding('f1'), title: 'Current title' }] };
        const message: Message = { id: 'follow-up', localId: null, createdAt: 2, kind: 'agent-text', text: '', meta: { happier: { kind: 'review_follow_up.v1', payload: update } } };
        const blocks = projectReviewFindingsFindText(payload, { canNavigate: true, canSendMessages: true, hasWorkspacePath: true, sessionMessages: [message] });
        const text = textOf(blocks);
        expect(text).toContain('Current title');
        expect(text).not.toContain('Title f1');
        expect(text).not.toContain('Title f4');
        expect(text).not.toContain('Full card summary');
        expect(text).not.toContain('Hidden overview');
        expect(text).not.toContain('hidden-f1.ts');
        expect(text).not.toContain('hidden-run');
        expect(blocks.some((block) => ['structured-review:more', 'structured-review:open', 'structured-review:walk', 'structured-review:hint'].includes(block.id))).toBe(false);
    });

    it('indexes every expandable full-card finding but excludes never rendered summaries', () => {
        const blocks = projectReviewFindingsFindText(payload, { canNavigate: false, canSendMessages: false });
        const text = textOf(blocks);
        expect(text).toContain('Full card summary');
        expect(text).toContain('Title f4');
        expect(text).toContain('hidden-f4.ts:2');
        expect(text).not.toContain('Hidden summary');
        expect(text).not.toContain('Hidden overview');
        expect(blocks.some((block) => block.id === 'structured-review:more')).toBe(false);
    });

    it('keeps displayed saved-decision status without indexing host-generated decision and apply controls', () => {
        const comment = { ...buildReviewCommentFixture({ id: 'comment-f1', runId: payload.runRef.runId, body: 'hidden comment body' }), findingId: 'f1', reviewTriageStatus: 'accept' as const };
        const blocks = projectReviewFindingsFindText(payload, { canNavigate: false, canSendMessages: true, reviewComments: { status: 'loaded', comments: [comment] } });
        expect(blocks.some((block) => block.id === 'structured-review:implement' || block.id.includes(':decision:') || block.id.endsWith(':thread-toggle'))).toBe(false);
        expect(textOf(blocks)).not.toContain('hidden comment body');
        expect(blocks.some((block) => block.id === 'structured-review-finding:f2:decision-note')).toBe(true);
        const failed = projectReviewFindingsFindText(payload, { canSendMessages: true, reviewComments: { status: 'failed', comments: [] } });
        expect(failed.some((block) => block.id === 'structured-review:decisions-unavailable')).toBe(true);
        expect(failed.some((block) => block.id === 'structured-review:retry')).toBe(false);
    });

    it('indexes review comment content but excludes the host-generated Jump control', () => {
        const blocks = projectReviewCommentsFindText({ sessionId: 's1', comments: [{
            id: 'c1', filePath: 'src/a.ts', source: 'file', anchor: { kind: 'fileLine', startLine: 1 },
            snapshot: { beforeContext: [], selectedLines: ['selected'], afterContext: [] }, body: 'Comment body', createdAt: 1,
        }] }, { canJumpToAnchor: true });
        expect(textOf(blocks)).toContain('Comment body');
        expect(textOf(blocks)).toContain('selected');
        expect(blocks.some((block) => block.id.endsWith(':jump'))).toBe(false);
    });

    it('follow-up projection includes updated titles and summaries, only request and answer as Markdown', () => {
        const followUp: ReviewFollowUpV1 = { parentRunRef: payload.runRef, threadId: 'hidden-thread', findingIds: ['f1'], generatedAtMs: 2, requestMarkdown: '**Question**', answerMarkdown: '**Answer**', updatedFindings: [finding('f1')] };
        const blocks = projectReviewFollowUpFindText(followUp);
        expect(blocks.filter((block) => block.format === 'markdown').map((block) => block.text)).toEqual(['**Question**', '**Answer**']);
        expect(textOf(blocks)).toContain('Hidden summary f1');
        expect(textOf(blocks)).not.toContain('hidden-f1.ts');
        expect(textOf(blocks)).not.toContain('hidden-thread');
    });
});
