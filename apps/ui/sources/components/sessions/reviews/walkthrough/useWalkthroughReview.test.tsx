import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { ExecutionRunGetRequestSchema, ExecutionRunGetResponseSchema} from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ReviewFindingsV2Schema} from '@happier-dev/protocol/messages/structured/reviewFindingsV2';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ScmDiffSummaryResultSchema } from '@happier-dev/protocol/scm';
import { createDeferred, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import type { ToolCallMessage } from '@happier-dev/session-core/messages';
import { createReducer } from '@happier-dev/session-core/reducer';
import { buildReviewCommentFixture, storePlainReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionFixture, installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';

const boundary = vi.hoisted(() => ({ read: async (_runId: string): Promise<unknown> => null }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// Leave scoped authority, Session transport, schemas, effective findings and
// overlays real; install only the canonical Home HTTP and Socket.IO boundaries.
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const sessionRequests = installSessionActionRpcBoundary((request) => {
    // A wrong Session, operation or read selector must not receive a valid
    // review payload merely because the network fixture can supply one.
    expect(request.method).toBe(`${params.host.sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_GET}`);
    const selector = ExecutionRunGetRequestSchema.parse(request.params);
    expect(selector).toMatchObject({ includeStructured: true });
    return boundary.read(selector.runId);
});

const { storage } = await import('@/sync/domains/state/storageStore');
// The mounted app publishes its sync runtime before any presentation subscribes to it.
await import('@/sync/syncEngine');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { useWalkthroughReview } = await import('./useWalkthroughReview');
const { useSessionWalkthroughReviewPresentation } = await import('./SessionWalkthroughReview');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { notifyExecutionRunActivity } = await import('@/sync/runtime/executionRuns/executionRunActivityBus');
const { resetReviewRunCommentsForTests } = await import('@/sync/domains/reviews/comments/reviewRunComments');
const { getScmDiffSummaryState, loadSavedScmDiffSummaryResult, retireScmDiffSummaryScope } = await import('@/sync/ops/scmDiffSummary/generate');
afterEach(() => {
    standardCleanup();
    storage.getState().evictSessionMessages(params.host.sessionId);
    resetReviewRunCommentsForTests();
    retireScmDiffSummaryScope(scope);
});

const scope = { serverId: 'review-home', accountId: 'review-account' };
const comparison = ScmComparisonSchema.parse({ id: 'comparison', source: { kind: 'commit', commit: 'oid' },
    repository: { rootPath: '/repo' }, endpoints: { before: 'before', after: 'after' },
    inventory: { state: 'complete', files: [], reasons: [] } });
const params = { host: { sessionId: 'review-session' }, cwd: '/repo', scope, comparison, walkthrough: null,
    producer: { kind: 'review' as const, reviewedRuns: [{ runId: 'review-run', callId: 'review-call', backendId: 'codex',
        status: 'succeeded' as const, hasOutput: true, comparisonId: comparison.id, reviewOutcome: 'complete' as const }] } };
beforeEach(async () => {
    await harness.reset();
    scope.serverId = await harness.addHome({ name: 'Review Home', serverUrl: 'https://review-home.test',
        accountId: scope.accountId, serverIdentityId: 'srv-review-home', currentAccount: true });
    // Scoped Socket acquisition probes Home readiness through runtimeFetch,
    // separately from the Session HTTP reader. Both use the same network leaf.
    harness.answer(scope.serverId, '/v1/auth/ping', { body: {} });
    harness.answer(scope.serverId, '/v1/reviews/comments', { body: { items: [], cursor: null } });
    setRuntimeFetch(harness.request);
    sessionRequests.length = 0;
    installSessionActionFixture({ homes: harness, storage, serverId: scope.serverId, session: { id: params.host.sessionId } });
    boundary.read = async () => null;
});
function response(withFinding: boolean, runId = 'review-run') {
    const callId = runId === 'review-run' ? 'review-call' : `${runId}-call`;
    return ExecutionRunGetResponseSchema.parse({ run: { runId, callId, sidechainId: 'sidechain',
        intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
        retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'streaming', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2 },
        structuredMeta: { kind: 'review_findings.v2', payload: ReviewFindingsV2Schema.parse({
            runRef: { runId, callId, backendId: 'codex' }, comparisonId: comparison.id,
            reviewOutcome: 'complete', summary: 'Review', overviewMarkdown: 'Review details', generatedAtMs: 2,
            findings: withFinding ? [{ id: 'finding', severity: 'high', category: 'correctness', title: 'A reachable defect', summary: 'Fix this defect.' }] : [],
        }) } });
}
async function refresh() {
    await act(async () => notifyExecutionRunActivity({ serverId: scope.serverId, sessionId: params.host.sessionId }, { runId: 'review-run' }));
}

describe('a walkthrough reads findings before declaring a review complete', () => {
    it('waits for the run payload to supply comment scope before reading comments', async () => {
        const pending = createDeferred<unknown>();
        boundary.read = () => pending.promise;
        const hook = await renderHook(() => useWalkthroughReview(params));
        await waitForHomeGovernance(() => expect(sessionRequests).toHaveLength(1));
        await flushHookEffects();
        const commentReads = () => harness.requests.filter(request => new URL(request.path, request.serverUrl).pathname === '/v1/reviews/comments');
        expect(commentReads()).toHaveLength(0);
        await act(async () => pending.resolve(response(true)));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.comments[0]?.status).toBe('loaded'));
        expect(commentReads()).toHaveLength(1);
    });
    it('reads only an exactly hinted reviewer, omits the unused tool result, and refreshes all on an unscoped hint', async () => {
        const runIds = Array.from({ length: 24 }, (_, index) => `review-${index}`);
        boundary.read = async runId => response(false, runId);
        const hook = await renderHook(() => useWalkthroughReview({ ...params, producer: null, startedReviewRunIds: runIds }));
        await waitForHomeGovernance(() => expect(Object.values(hook.getCurrent()?.readStateByRunId ?? {})).toEqual(runIds.map(() => 'readable')));
        expect(sessionRequests).toHaveLength(runIds.length);
        sessionRequests.length = 0;
        boundary.read = async runId => response(runId === runIds[5], runId);
        await act(async () => notifyExecutionRunActivity({ serverId: scope.serverId, sessionId: params.host.sessionId }, { runId: runIds[5]! }));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.overlay.summary.total).toBe(1));
        expect(sessionRequests.map(request => ExecutionRunGetRequestSchema.parse(request.params))).toEqual([
            expect.objectContaining({ runId: runIds[5], includeStructured: true, includeLatestToolResult: false }),
        ]);
        sessionRequests.length = 0;
        await act(async () => notifyExecutionRunActivity({ serverId: scope.serverId, sessionId: params.host.sessionId }, { runId: null }));
        await flushHookEffects();
        expect(sessionRequests.map(request => ExecutionRunGetRequestSchema.parse(request.params).runId)).toEqual(runIds);
    });

    it('publishes no new review identity for equal reads while changed findings, failure and recovery still reach its consumer', async () => {
        boundary.read = async () => response(true);
        const publications: unknown[] = [];
        const hook = await renderHook(() => {
            const review = useWalkthroughReview(params);
            React.useEffect(() => { publications.push(review); }, [review]);
            return review;
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('readable'));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.comments[0]?.status).toBe('loaded'));
        await flushHookEffects();
        const initial = hook.getCurrent();
        publications.length = 0;
        for (let index = 0; index < 3; index += 1) await refresh();
        await flushHookEffects();
        expect(hook.getCurrent()).toBe(initial);
        expect(publications).toHaveLength(0);
        boundary.read = async () => response(false);
        await refresh();
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.overlay.summary.total).toBe(0));
        expect(hook.getCurrent()).not.toBe(initial);
        const changed = hook.getCurrent();
        boundary.read = async () => { throw new Error('Disconnected'); };
        await refresh();
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('failed'));
        expect(hook.getCurrent()).not.toBe(changed);
        const failed = hook.getCurrent();
        boundary.read = async () => response(false);
        await refresh();
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('readable'));
        expect(hook.getCurrent()).not.toBe(failed);
        expect(hook.getCurrent()?.overlay.summary.total).toBe(0);
    });

    it('publishes a changed Run finish fact even when its findings remain unread', async () => {
        boundary.read = async () => ({ run: { ...response(false).run, status: 'running', finishedAtMs: undefined } });
        const hook = await renderHook(() => useWalkthroughReview({ ...params, producer: null, startedReviewRunIds: ['review-run'] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('unread'));
        expect(hook.getCurrent()?.reviewedAtMs).toBeNull();
        boundary.read = async () => ({ run: { ...response(false).run, status: 'running', finishedAtMs: 7 } });
        await refresh();
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.reviewedAtMs).toBe(7));
        expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('unread');
    });

    it('catches up every distinct hint received during a pending read without rereading other reviewers', async () => {
        const runIds = ['review-a', 'review-b', 'review-c', 'review-d'];
        boundary.read = async runId => response(false, runId);
        const hook = await renderHook(() => useWalkthroughReview({ ...params, producer: null, startedReviewRunIds: runIds }));
        await waitForHomeGovernance(() => expect(Object.values(hook.getCurrent()?.readStateByRunId ?? {})).toEqual(runIds.map(() => 'readable')));
        const pending = createDeferred<unknown>();
        boundary.read = runId => runId === 'review-a' ? pending.promise : Promise.resolve(response(runId === 'review-c', runId));
        sessionRequests.length = 0;
        await act(async () => {
            notifyExecutionRunActivity({ serverId: scope.serverId, sessionId: params.host.sessionId }, { runId: 'review-a' });
        });
        await waitForHomeGovernance(() => expect(sessionRequests).toHaveLength(1));
        await act(async () => {
            for (const runId of ['review-b', 'review-c', 'review-a', 'review-b', 'unselected-review']) {
                notifyExecutionRunActivity({ serverId: scope.serverId, sessionId: params.host.sessionId }, { runId });
            }
        });
        expect(sessionRequests).toHaveLength(1);
        await act(async () => pending.resolve(response(false, 'review-a')));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.overlay.summary.total).toBe(1));
        expect(sessionRequests.map(request => ExecutionRunGetRequestSchema.parse(request.params).runId)).toEqual(['review-a', 'review-b', 'review-c', 'review-a']);
        const pendingAll = createDeferred<unknown>();
        boundary.read = runId => runId === 'review-b' ? pendingAll.promise : Promise.resolve(response(false, runId));
        sessionRequests.length = 0;
        await act(async () => notifyExecutionRunActivity({ serverId: scope.serverId, sessionId: params.host.sessionId }, { runId: 'review-b' }));
        await waitForHomeGovernance(() => expect(sessionRequests).toHaveLength(1));
        await act(async () => notifyExecutionRunActivity({ serverId: scope.serverId, sessionId: params.host.sessionId }, { runId: null }));
        expect(sessionRequests).toHaveLength(1);
        await act(async () => pendingAll.resolve(response(false, 'review-b')));
        await waitForHomeGovernance(() => expect(sessionRequests).toHaveLength(1 + runIds.length));
        expect(sessionRequests.map(request => ExecutionRunGetRequestSchema.parse(request.params).runId)).toEqual(['review-b', ...runIds]);
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.overlay.summary.total).toBe(0));
    });

    it('retires pending reads and hints when the selection or Account scope leaves', async () => {
        const pending = createDeferred<unknown>();
        boundary.read = runId => runId === 'review-a' ? pending.promise : Promise.resolve(response(false, runId));
        let selected = ['review-a'];
        let activeScope: typeof scope | null = scope;
        const hook = await renderHook(() => useWalkthroughReview({ ...params, scope: activeScope, producer: null, startedReviewRunIds: selected }));
        await waitForHomeGovernance(() => expect(sessionRequests).toHaveLength(1));
        await act(async () => notifyExecutionRunActivity({ serverId: scope.serverId, sessionId: params.host.sessionId }, { runId: 'review-a' }));
        selected = ['review-b'];
        await hook.rerender();
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.readStateByRunId['review-b']).toBe('readable'));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.comments[0]?.status).toBe('loaded'));
        const current = hook.getCurrent();
        await act(async () => pending.resolve(response(true, 'review-a')));
        await flushHookEffects();
        expect(hook.getCurrent()).toBe(current);
        expect(sessionRequests.map(request => ExecutionRunGetRequestSchema.parse(request.params).runId)).toEqual(['review-a', 'review-b']);
        const retired = createDeferred<unknown>();
        boundary.read = () => retired.promise;
        await act(async () => notifyExecutionRunActivity({ serverId: scope.serverId, sessionId: params.host.sessionId }, { runId: 'review-b' }));
        await waitForHomeGovernance(() => expect(sessionRequests).toHaveLength(3));
        activeScope = null;
        await hook.rerender();
        sessionRequests.length = 0;
        await act(async () => notifyExecutionRunActivity({ serverId: scope.serverId, sessionId: params.host.sessionId }, { runId: null }));
        await act(async () => retired.resolve(response(true, 'review-b')));
        await flushHookEffects();
        expect(sessionRequests).toHaveLength(0);
        expect(hook.getCurrent()?.readStateByRunId['review-b']).toBe('loading');
        expect(hook.getCurrent()?.overlay.summary.total).toBe(0);
    });

    it('opens a Review child startup question from its needs-you notice and clears it after an answer', async () => {
        const requestId = 'execution-run:review-run:occurrence:folder%3Aquestion';
        const request = { tool: 'AskUserQuestion', kind: 'user_action' as const, createdAt: 1,
            arguments: { questions: [{ header: 'Folder trust', question: 'Trust the selected workspace?', multiSelect: false,
                options: [{ label: 'Trust', description: 'Use this workspace' }, { label: 'Reject', description: 'Stop here' }] }] } };
        const sessionId = params.host.sessionId;
        const session = installSessionActionFixture({ homes: harness, storage, serverId: scope.serverId,
            session: { id: sessionId, agentState: { requests: { [requestId]: request } } } });
        const message: ToolCallMessage = { kind: 'tool-call', id: 'review-launch', localId: null, createdAt: 1,
            tool: { id: 'review-tool', name: 'SubAgentRun', state: 'running', createdAt: 1, startedAt: 1, completedAt: null,
                description: null, input: { runId: 'review-run', intent: 'review', backendId: 'codex' } }, children: [] };
        const reducerState = createReducer();
        reducerState.permissions.set(requestId, { ...request, status: 'pending' });
        storage.setState(state => ({ sessionMessages: { ...state.sessionMessages, [sessionId]: {
            messageIdsOldestFirst: [message.id], messagesById: { [message.id]: message }, messagesMap: { [message.id]: message },
            reducerState, latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null, messagesVersion: 1, isLoaded: true,
        } } }));
        boundary.read = async () => ({ run: { ...response(false).run, status: 'running' } });
        function Review() {
            const review = useWalkthroughReview(params);
            const presentation = useSessionWalkthroughReviewPresentation({ review, phase: 'inventory', phone: true, scope, sessionId });
            return <>{presentation?.slots.notice}</>;
        }
        const screen = await renderScreen(<AppPaneProvider><Review /></AppPaneProvider>);
        expect(screen.findAll(node => node.props.testID === 'walkthrough-review-needs-you:review-run').length).toBeGreaterThan(0);
        expect(screen.findAll(node => node.props.testID === 'user-action-prompt-card')).toHaveLength(0);
        const open = screen.findAll(node => node.props.testID === 'walkthrough-review-open-question:review-run' && typeof node.props.onPress === 'function')[0];
        await act(async () => { open!.props.onPress(); });
        expect(screen.findAll(node => node.props.testID === 'user-action-prompt-card').length).toBeGreaterThan(0);
        const strings = screen.findAll(node => typeof node.type === 'string').flatMap(node => node.children.filter(child => typeof child === 'string'));
        expect(strings).toContain('Trust the selected workspace?');
        const settled = createReducer();
        await act(async () => storage.setState(state => ({ sessions: { ...state.sessions,
            [sessionId]: { ...session, agentState: { requests: {} } } }, sessionMessages: { ...state.sessionMessages,
            [sessionId]: { ...state.sessionMessages[sessionId]!, reducerState: settled, messagesVersion: 2 } } })));
        expect(screen.findAll(node => node.props.testID === 'walkthrough-review-needs-you:review-run')).toHaveLength(0);
        storage.getState().evictSessionMessages(sessionId);
    });

    it.each([
        { commentIds: [], state: 'complete', finishedEngines: 1, total: 0, readFails: false },
        { commentIds: ['saved-finding'], state: 'complete', finishedEngines: 1, total: 1, readFails: false },
        { commentIds: ['saved-finding'], state: 'unavailable', finishedEngines: 0, total: 0, readFails: true },
    ] as const)('retains saved review truth when the public Run read is unavailable ($state, $total)', async ({ commentIds, state, finishedEngines, total, readFails }) => {
        const comments = commentIds.map(id => ({ ...buildReviewCommentFixture({ id, accountId: scope.accountId,
            sessionId: params.host.sessionId, runId: 'review-run', body: 'Saved finding\n\nA durable finding body.' }),
            findingId: 'saved-finding-id', findingSeverity: 'high' as const }));
        harness.answer(scope.serverId, '/v1/reviews/comments', readFails ? { status: 503, body: { error: 'unavailable' } }
            : { body: { items: comments.map(storePlainReviewCommentFixture), cursor: null } });
        // Same saved publication shape as a completed review whose retained host was lost.
        const result = ScmDiffSummaryResultSchema.parse({ resultId: 'saved-review', revision: 4, canUndo: true,
            output: { success: true, resultId: 'saved-review', revision: 4, sourceKey: comparison.id,
                metadata: { sourceKey: comparison.id, source: comparison.source }, comparison,
                requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'complete',
                    value: { title: 'Saved review', intro: '', stops: [], otherChangeRefs: [] } } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
                producer: { ...params.producer, reviewedRuns: [{ ...params.producer.reviewedRuns[0],
                    reviewedFingerprint: 'saved-fingerprint', commentIds, materialization: { kind: 'complete' } }] },
            } });
        const key = loadSavedScmDiffSummaryResult({ sessionId: params.host.sessionId, scope, result });
        const saved = key ? getScmDiffSummaryState().entriesByKey[key]?.latestOutput : null;
        if (!saved?.success) throw new Error('Saved review was not restored');
        boundary.read = async () => ({ ok: false, error: 'RPC method not available', errorCode: 'RPC_METHOD_NOT_AVAILABLE' });
        const hook = await renderHook(() => useWalkthroughReview({ ...params, comparison: saved.comparison ?? null,
            walkthrough: saved.outputs?.walkthrough ?? null, producer: saved.producer }));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('failed'));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.overlay.summary).toMatchObject({ state, total, finishedEngines, runningEngines: 0 }));
        expect(hook.getCurrent()?.progress.review.state).toBe(state === 'complete' ? 'done' : 'waiting');
        if (total) expect(hook.getCurrent()?.overlay.tail[0]?.finding).toMatchObject({ title: 'Saved finding', summary: 'A durable finding body.' });
        if (readFails) {
            harness.answer(scope.serverId, '/v1/reviews/comments', { body: { items: comments.map(storePlainReviewCommentFixture), cursor: null } });
            await act(async () => { await hook.getCurrent()?.retry(); });
            await waitForHomeGovernance(() => expect(hook.getCurrent()?.overlay.summary).toMatchObject({ state: 'complete', total: 1 }));
        }
    });

    it('keeps a complete zero-finding review clean after its retained Run publishes narration', async () => {
        const got = response(false);
        boundary.read = async () => ({ ...got,
            run: { ...got.run, status: 'running', runClass: 'long_lived', retentionPolicy: 'resumable', turnInFlight: false },
            structuredMeta: { kind: 'scm_diff_summary.v1', payload: {} },
            reviewFindings: got.structuredMeta?.payload,
        });
        const hook = await renderHook(() => useWalkthroughReview(params));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.readStateByRunId['review-run']).toMatch(/^(readable|unread|failed)$/));
        expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('readable');
        expect(hook.getCurrent()?.overlay.summary).toMatchObject({ state: 'complete', total: 0,
            finishedEngines: 1, runningEngines: 0, failedEngineLabels: [] });
    });

    it.each(['complete', 'partial'] as const)('finishes a retained reviewer from %s findings while its Run remains available for narration', async (reviewOutcome) => {
        const got = response(true);
        const payload = ReviewFindingsV2Schema.parse(got.structuredMeta?.payload);
        boundary.read = async () => ({ ...got, run: { ...got.run, status: 'running', runClass: 'long_lived',
            retentionPolicy: 'resumable', turnInFlight: true, finishedAtMs: undefined },
            structuredMeta: { kind: 'review_findings.v2', payload: { ...payload, reviewOutcome } } });
        const hook = await renderHook(() => useWalkthroughReview({ ...params, producer: null, startedReviewRunIds: ['review-run'] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('readable'));
        expect(hook.getCurrent()?.overlay.summary).toMatchObject({ state: reviewOutcome === 'complete' ? 'complete' : 'partial',
            runningEngines: 0, finishedEngines: reviewOutcome === 'complete' ? 1 : 0 });
        expect(hook.getCurrent()?.reviewedAtMs).toBe(2);
    });

    it('shows a recorded failed findings turn as partial even though its retained Run stays running', async () => {
        const got = response(false);
        boundary.read = async () => ({ run: { ...got.run, status: 'running', runClass: 'long_lived',
            retentionPolicy: 'resumable', turnInFlight: false,
            inputTurns: { occurrenceId: 'occurrence', last: { turnId: 'turn-1', inputIds: ['input-1'], state: 'completed' } } } });
        const hook = await renderHook(() => useWalkthroughReview({ ...params, producer: { kind: 'review', reviewedRuns: [
            { ...params.producer.reviewedRuns[0]!, status: 'failed', hasOutput: false, reviewOutcome: 'unavailable' },
        ] } }));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('unread'));
        expect(hook.getCurrent()?.overlay.summary).toMatchObject({ state: 'partial', runningEngines: 0, failedEngineIds: ['codex'] });
    });

    it('uses idle turn completion for a retained reviewer without a recorded producer and keeps active work running', async () => {
        const got = response(false);
        boundary.read = async () => ({ run: { ...got.run, status: 'running', runClass: 'long_lived', retentionPolicy: 'resumable',
            turnInFlight: false, inputTurns: { occurrenceId: 'occurrence', last: { turnId: 'turn-1', inputIds: ['input-1'], state: 'completed' } } } });
        const hook = await renderHook(() => useWalkthroughReview({ ...params, producer: null, startedReviewRunIds: ['review-run'] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('unread'));
        expect(hook.getCurrent()?.overlay.summary).toMatchObject({ state: 'partial', runningEngines: 0 });
        boundary.read = async () => ({ run: { ...got.run, status: 'running', runClass: 'long_lived', turnInFlight: true } });
        await refresh();
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.overlay.summary.runningEngines).toBe(1));
    });

    it('shows an admitted review before narration publishes its captured comparison and retains findings until capture arrives', async () => {
        const got = response(true);
        const pending = createDeferred<unknown>();
        boundary.read = () => pending.promise;
        let captured: typeof comparison | null = null;
        const hook = await renderHook(() => useWalkthroughReview({ ...params, comparison: captured,
            producer: null, startedReviewRunIds: ['review-run'] }));
        expect(hook.getCurrent()?.progress.review).toEqual({ state: 'running', kind: 'reviewing' });
        expect(hook.getCurrent()?.reviewRunIds).toEqual(['review-run']);
        await act(async () => pending.resolve(got));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('readable'));
        expect(hook.getCurrent()?.overlay.tail.map((entry) => entry.findingId)).toEqual(['finding']);
        expect(hook.getCurrent()?.overlay.summary.runningEngines).toBe(0);
        captured = comparison;
        await hook.rerender();
        expect(hook.getCurrent()?.overlay.summary).toMatchObject({ state: 'complete', total: 1 });
    });

    it('does not rerender a walkthrough without reviews when its session transcript streams', async () => {
        const sessionId = 'walkthrough-without-review';
        storage.setState((state) => ({ sessionMessages: { ...state.sessionMessages, [sessionId]: {
            messageIdsOldestFirst: [], messagesById: {}, messagesMap: {}, reducerState: createReducer(),
            latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null, messagesVersion: 0, isLoaded: true,
        } } }));
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useWalkthroughReview({ ...params, host: { sessionId }, producer: null }); });
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
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.readStateByRunId['review-run'],
            JSON.stringify({ http: harness.requests.map(({ path }) => path), rpc: sessionRequests.map(({ method }) => method) })).toBe('readable'));
        const pending = createDeferred<unknown>();
        boundary.read = () => pending.promise;
        await refresh();
        expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('readable');
        expect(hook.getCurrent()?.overlay.summary.state).toBe('complete');
        await act(async () => pending.resolve(response(false)));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.overlay.summary.total).toBe(0));
    });

    it('keeps recorded completion unread during loading, a missing payload and a failed read', async () => {
        const pending = createDeferred<unknown>();
        boundary.read = () => pending.promise;
        const hook = await renderHook(() => useWalkthroughReview(params));
        expect(hook.getCurrent()?.overlay.summary.state).not.toBe('complete');
        expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('loading');
        await act(async () => pending.resolve({ run: response(false).run }));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('unread'));
        expect(hook.getCurrent()?.overlay.summary.state).toBe('partial');
        expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('unread');
        boundary.read = async () => { throw new Error('Disconnected'); };
        await refresh();
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('failed'));
        expect(hook.getCurrent()?.overlay.summary.state).toBe('partial');
        expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('failed');
        boundary.read = async () => response(false);
        await refresh();
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.overlay.summary.state).toBe('complete'));
        expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('readable');
    });

    it('retains the last readable findings after failure and recovers to the next readable result', async () => {
        const readable = response(true);
        boundary.read = async () => readable;
        const hook = await renderHook(() => useWalkthroughReview(params));
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.overlay.tail.map((entry) => entry.findingId)).toEqual(['finding']));
        boundary.read = async () => { throw new Error('Disconnected'); };
        await refresh();
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.readStateByRunId['review-run']).toBe('failed'));
        expect(hook.getCurrent()?.overlay.tail.map((entry) => entry.findingId)).toEqual(['finding']);
        expect(hook.getCurrent()?.overlay.summary.state).toBe('complete');
        boundary.read = async () => response(false);
        await refresh();
        await waitForHomeGovernance(() => expect(hook.getCurrent()?.overlay.summary).toMatchObject({ state: 'complete', total: 0 }));
    });
});
