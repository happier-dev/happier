import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { buildReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';

import { useReviewFindingsModel } from './useReviewFindingsModel';
import type { ReviewFindingsMember } from './useReviewFindingsModel';
import { ReviewFindingBody } from './ReviewFindingBody';
import { ReviewFindingRow } from '@/components/sessions/reviews/findings/ReviewFindingRow';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

afterEach(standardCleanup);

it('links Session findings by saved Review comment identity and leaves unbound development findings without a task target', async () => {
    const finding = { id: 'engine-finding', title: 'A finding', summary: 'Private body', severity: 'high' as const, category: 'correctness' as const };
    const unbound = { ...finding, id: 'development-finding' };
    const root = buildReviewCommentFixture({ id: 'saved-comment', reviewId: 'review-session', findingId: finding.id });
    const development = buildReviewCommentFixture({ id: 'unbound-comment', findingId: unbound.id });
    const member = { runId: 'run', backendId: 'codex', reviewerLabel: 'Codex', findings: [finding, unbound],
        commentByFindingId: new Map([[finding.id, root], [unbound.id, development]]), originalByFindingId: {}, threadsByFindingId: {},
        sessionId: 'session', followUp: { available: true as const }, threadRefsByFindingId: {}, questions: [], assumptions: [] };
    const hook = await renderHook(() => useReviewFindingsModel({ members: [member], reviewerCount: 1,
        scope: null, accountLifetime: null, serverId: null, sessionId: 'session', canAct: true, pending: {}, onDecideComment: async () => true }));
    try {
        expect(hook.getCurrent().rows.map(row => ({ rowId: row.rowId, taskOrigin: row.taskOrigin }))).toEqual([
            { rowId: finding.id, taskOrigin: { reviewId: root.reviewId, findingIds: [root.id] } },
            { rowId: unbound.id, taskOrigin: null },
        ]);
    } finally { await hook.unmount(); }
});

it('uses a durable finding root once across reviewers and rounds, then writes its current decision by comment identity', async () => {
    const round = { reviewId: 'review-1', roundOrdinal: 2, reviewerIds: ['first', 'second'], state: 'completed' as const };
    const root = {
        ...buildReviewCommentFixture({ id: 'durable-root', body: 'An older projection', engineId: 'codex' }),
        reviewId: round.reviewId,
        findingId: 'source-finding',
        findingIdentity: 'f'.repeat(64),
        findingSeverity: 'high' as const,
        scopeAttribution: 'pre_existing' as const,
        finding: { id: 'source-finding', title: 'A defect', summary: 'Preserve the **scope**.',
            category: 'correctness' as const, severity: 'high' as const, scopeAttribution: 'pre_existing' as const,
            patch: '--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-wrong\n+right' },
        reviewTriageStatus: 'defer' as const,
        appearances: [
            { roundOrdinal: 1, reviewerId: 'first', runId: 'run-1' },
            { roundOrdinal: 2, reviewerId: 'first', runId: 'run-2' },
            { roundOrdinal: 2, reviewerId: 'second', runId: 'run-3' },
        ],
    };
    const reply = buildReviewCommentFixture({ id: 'reply', parentCommentId: root.id, threadId: root.id });
    const lower = { ...root, id: 'lower-root', threadId: 'lower-root', findingIdentity: 'e'.repeat(64),
        finding: { ...root.finding, id: 'lower-finding', title: 'A smaller issue', severity: 'low' as const },
        findingSeverity: 'low' as const, appearances: [{ roundOrdinal: 2, reviewerId: 'first', runId: 'run-2' }] };
    const onDecideComment = vi.fn(async () => true);
    const params = {
        members: [],
        reviewerCount: round.reviewerIds.length,
        record: { round, comments: [lower, root, reply] },
        scope: null,
        accountLifetime: null,
        serverId: null,
        sessionId: null,
        canAct: true,
        pending: {},
        onDecideComment,
    };
    const hook = await renderHook(() => useReviewFindingsModel(params));
    try {
        const result = hook.getCurrent();
        expect(result.rows).toEqual([expect.objectContaining({
            rowId: root.id,
            taskOrigin: { reviewId: round.reviewId, findingIds: [root.id] },
            finding: expect.objectContaining({ title: 'A defect', scopeAttribution: 'pre_existing', category: 'correctness', patch: root.finding.patch }),
            decision: 'defer',
            appearance: 'still_there',
            askContext: null,
        }), expect.objectContaining({ rowId: lower.id, appearance: 'new' })]);
        result.onDecide(root.id, 'accept');
        await vi.waitFor(() => expect(onDecideComment).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            comment: expect.objectContaining({ id: root.id, reviewId: round.reviewId }),
        }), 'accept'));
    } finally {
        await hook.unmount();
    }
});

it('shows an edited current comment body beside its original finding evidence and retires redacted content', async () => {
    const comment = buildReviewCommentFixture({ id: 'edited-root', reviewId: 'review-edit', findingIdentity: 'd'.repeat(64),
        bodyVersion: 2, body: 'Current explanation after review.',
        finding: { id: 'original', title: 'Original title', summary: 'Original explanation.', category: 'correctness', severity: 'high',
            filePath: 'src/a.ts', evidence: 'Original verification.', patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new' } });
    function Finding({ comment }: { comment: ReviewCommentV1 }) {
        const model = useReviewFindingsModel({ members: [], reviewerCount: 1,
            record: { round: { reviewId: 'review-edit', roundOrdinal: 1, state: 'completed', reviewerIds: ['first'] }, comments: [comment] },
            scope: null, accountLifetime: null, serverId: null, sessionId: null, canAct: false, pending: {},
            onDecideComment: async () => false });
        return <>{model.rows.map(row => <ReviewFindingBody key={row.rowId} rowId={row.rowId}
            finding={row.finding} currentBodyMarkdown={row.currentBodyMarkdown} reviewers={row.reviewers} conversation={null} />)}</>;
    }
    const screen = await renderScreen(<Finding comment={comment} />);
    try {
        const rendered = JSON.stringify(screen.tree.toJSON());
        expect(rendered).toContain('Current explanation after review.');
        expect(rendered).not.toContain('Original explanation.');
        expect(rendered).toContain('Original verification.');
        expect(screen.findAllByType(ReviewFindingBody)[0]?.props.finding.patch).toBe(comment.finding?.patch);
        await screen.update(<Finding comment={{ ...comment, body: '', finding: undefined }} />);
        expect(screen.findHostByTestId(`review-finding-body:${comment.id}`)).toBeNull();
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('Current explanation after review.');
    } finally { await screen.unmount(); }
});

it('answers the selected reviewer question even when another reviewer cannot take follow-ups', async () => {
    const question = { id: 'session-question', text: 'Which Account?', status: 'open' as const, findingIds: [] };
    const available: ReviewFindingsMember = { runId: 'session-run', backendId: 'claude', reviewerLabel: 'Claude',
        sessionId: 'retained-session', followUp: { available: true }, questions: [question], assumptions: [],
        findings: [], commentByFindingId: new Map(), originalByFindingId: {}, threadsByFindingId: {}, threadRefsByFindingId: {} };
    const unavailable: ReviewFindingsMember = { ...available, runId: 'detached-run', sessionId: null, reviewerLabel: 'Detached reviewer',
        followUp: { available: false, reason: 'No retained Session' }, questions: [] };
    const hook = await renderHook(() => useReviewFindingsModel({ members: [available, unavailable], reviewerCount: 2,
        scope: null, accountLifetime: null, serverId: null, sessionId: null, canAct: true, pending: {},
        onDecideComment: async () => false }));
    try {
        expect(hook.getCurrent().followUp.available).toBe(false);
        await act(async () => { hook.getCurrent().setReplyToQuestion({ member: available, question }); });
        expect(hook.getCurrent().dockRecipient.label).toBe('Claude');
        expect(hook.getCurrent().followUp.available).toBe(true);
        await act(async () => { hook.getCurrent().setReplyToQuestion(null); });
        expect(hook.getCurrent().followUp.available).toBe(false);
    } finally { await hook.unmount(); }
});

it('keeps native finding replies readable from the shared comment window without a Session follow-up target', async () => {
    const root = buildReviewCommentFixture({ id: 'native-thread-root', reviewId: 'review-thread', findingIdentity: 'a'.repeat(64),
        finding: { id: 'engine-local', title: 'Threaded finding', summary: 'Root explanation', category: 'correctness', severity: 'high' } });
    const first = buildReviewCommentFixture({ id: 'native-reply-first', reviewId: root.reviewId, threadId: root.threadId,
        parentCommentId: root.id, body: 'First persisted reply', createdAt: 10 });
    const nested = buildReviewCommentFixture({ id: 'native-reply-nested', reviewId: root.reviewId, threadId: root.threadId,
        parentCommentId: first.id, body: 'Later nested reply', createdAt: 20 });
    const other = buildReviewCommentFixture({ id: 'unrelated-reply', reviewId: root.reviewId, threadId: 'another-root',
        parentCommentId: 'another-root', body: 'Unrelated thread content' });
    function Finding({ comments }: { comments: readonly ReviewCommentV1[] }) {
        const model = useReviewFindingsModel({ members: [], reviewerCount: 1,
            record: { round: { reviewId: 'review-thread', roundOrdinal: 1, state: 'completed', reviewerIds: ['first'] }, comments },
            scope: null, accountLifetime: null, serverId: null, sessionId: null, canAct: false, pending: {},
            onDecideComment: async () => false });
        return <>{model.rows.map(row => <ReviewFindingRow key={row.rowId} {...row} density="page" divided={false}
            decisionDisabled={!row.decidable} decisionNote={null} onDecide={model.onDecide} pendingQuestion={null}
            expanded onToggleExpanded={() => {}} onAsk={model.onAsk} />)}</>;
    }
    const screen = await renderScreen(<Finding comments={[nested, root, other, first]} />);
    try {
        const rendered = JSON.stringify(screen.tree.toJSON());
        expect(rendered).toContain(first.body);
        expect(rendered).toContain(nested.body);
        expect(rendered.indexOf('First persisted reply')).toBeLessThan(rendered.indexOf('Later nested reply'));
        expect(rendered).not.toContain(other.body);
        expect(screen.findHostByTestId(`review-finding-ask-field:${root.id}`)).toBeNull();
        await screen.update(<Finding comments={[root, { ...first, body: 'Edited persisted reply', serverRevision: 2 }, nested]} />);
        expect(JSON.stringify(screen.tree.toJSON())).toContain('Edited persisted reply');
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('First persisted reply');
        await screen.update(<Finding comments={[root, { ...first, flags: { redacted: true }, serverRevision: 3 }, nested]} />);
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('First persisted reply');
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('Edited persisted reply');
        expect(JSON.stringify(screen.tree.toJSON())).toContain('Later nested reply');
    } finally { await screen.unmount(); }
});
