import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { ExecutionRunGetResponseSchema, ReviewFindingsV2Schema, ScmComparisonSchema } from '@happier-dev/protocol';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { createReducer } from '@happier-dev/session-core/reducer';
import { storage } from '@/sync/domains/state/storageStore';

const boundary = vi.hoisted(() => ({ read: async (): Promise<unknown> => null }));
// The scoped Session RPC is the network boundary. Decoding, effective findings, comments and overlays stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: () => boundary.read(),
    sessionRpcWithServerAccountScope: () => boundary.read(),
}));

const { useWalkthroughReview } = await import('./useWalkthroughReview');
const { notifyExecutionRunActivity } = await import('@/sync/runtime/executionRuns/executionRunActivityBus');
const { resetReviewRunCommentsForTests } = await import('@/sync/domains/reviews/comments/reviewRunComments');
afterEach(() => { standardCleanup(); resetReviewRunCommentsForTests(); });

const scope = { serverId: 'review-home', accountId: 'review-account' };
const comparison = ScmComparisonSchema.parse({ id: 'comparison', source: { kind: 'commit', commit: 'oid' },
    repository: { rootPath: '/repo' }, endpoints: { before: 'before', after: 'after' },
    inventory: { state: 'complete', files: [], reasons: [] } });
const params = { sessionId: 'review-session', scope, comparison, walkthrough: null,
    producer: { kind: 'review' as const, reviewedRuns: [{ runId: 'review-run', callId: 'review-call', backendId: 'codex',
        status: 'succeeded' as const, hasOutput: true, comparisonId: comparison.id, reviewOutcome: 'complete' as const }] } };
function response(withFinding: boolean) {
    return ExecutionRunGetResponseSchema.parse({ run: { runId: 'review-run', callId: 'review-call', sidechainId: 'sidechain',
        intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
        retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'streaming', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2 },
        structuredMeta: { kind: 'review_findings.v2', payload: ReviewFindingsV2Schema.parse({
            runRef: { runId: 'review-run', callId: 'review-call', backendId: 'codex' }, comparisonId: comparison.id,
            reviewOutcome: 'complete', summary: 'Review', overviewMarkdown: 'Review details', generatedAtMs: 2,
            findings: withFinding ? [{ id: 'finding', severity: 'high', category: 'correctness', title: 'A reachable defect', summary: 'Fix this defect.' }] : [],
        }) } });
}
async function refresh() {
    await act(async () => notifyExecutionRunActivity({ serverId: scope.serverId, sessionId: params.sessionId }, { runId: 'review-run' }));
}

describe('a walkthrough reads findings before declaring a review complete', () => {
    it('does not rerender a walkthrough without reviews when its session transcript streams', async () => {
        const sessionId = 'walkthrough-without-review';
        storage.setState((state) => ({ sessionMessages: { ...state.sessionMessages, [sessionId]: {
            messageIdsOldestFirst: [], messagesById: {}, messagesMap: {}, reducerState: createReducer(),
            latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null, messagesVersion: 0, isLoaded: true,
        } } }));
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useWalkthroughReview({ ...params, sessionId, producer: null }); });
        const before = renders;
        for (let index = 0; index < 10; index += 1) {
            await act(async () => storage.setState((state) => ({ sessionMessages: { ...state.sessionMessages,
                [sessionId]: { ...state.sessionMessages[sessionId]!, messagesVersion: index + 1 },
            } })));
        }
        expect(hook.getCurrent()).toBeNull();
        expect(renders - before).toBe(0);
        storage.getState().evictSessionMessages(sessionId);
    });

    it('keeps readable findings and completion steady during a background refresh', async () => {
        boundary.read = async () => response(true);
        const hook = await renderHook(() => useWalkthroughReview(params));
        await vi.waitFor(() => expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('readable'));
        const pending = createDeferred<unknown>();
        boundary.read = () => pending.promise;
        await refresh();
        expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('readable');
        expect(hook.getCurrent()?.overlay.summary.state).toBe('complete');
        await act(async () => pending.resolve(response(false)));
        await vi.waitFor(() => expect(hook.getCurrent()?.overlay.summary.total).toBe(0));
    });

    it('keeps recorded completion unread during loading, a missing payload and a failed read', async () => {
        const pending = createDeferred<unknown>();
        boundary.read = () => pending.promise;
        const hook = await renderHook(() => useWalkthroughReview(params));
        expect(hook.getCurrent()?.overlay.summary.state).not.toBe('complete');
        expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('loading');
        await act(async () => pending.resolve({ run: response(false).run }));
        await vi.waitFor(() => expect(hook.getCurrent()?.overlay.summary.state).toBe('partial'));
        expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('unread');
        boundary.read = async () => { throw new Error('Disconnected'); };
        await refresh();
        await vi.waitFor(() => expect(hook.getCurrent()?.overlay.summary.state).toBe('partial'));
        expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('failed');
        boundary.read = async () => response(false);
        await refresh();
        await vi.waitFor(() => expect(hook.getCurrent()?.overlay.summary.state).toBe('complete'));
        expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('readable');
    });

    it('retains the last readable findings after failure and recovers to the next readable result', async () => {
        const readable = response(true);
        boundary.read = async () => readable;
        const hook = await renderHook(() => useWalkthroughReview(params));
        await vi.waitFor(() => expect(hook.getCurrent()?.overlay.tail.map((entry) => entry.findingId)).toEqual(['finding']));
        boundary.read = async () => { throw new Error('Disconnected'); };
        await refresh();
        expect(hook.getCurrent()?.overlay.tail.map((entry) => entry.findingId)).toEqual(['finding']);
        expect(hook.getCurrent()?.overlay.summary.state).toBe('partial');
        boundary.read = async () => response(false);
        await refresh();
        await vi.waitFor(() => expect(hook.getCurrent()?.overlay.summary).toMatchObject({ state: 'complete', total: 0 }));
    });
});
