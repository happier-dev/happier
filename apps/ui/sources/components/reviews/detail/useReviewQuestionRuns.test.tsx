import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ExecutionRunPublicStateSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ReviewRunReferenceV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { standardCleanup } from '@/dev/testkit';
import { EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE } from '@/dev/testkit/fixtures/executionRunCapabilitiesDescribe';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit }
    from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries({ platformOS: 'web' });
await prepareSessionFilesViewTestkit();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); fixture = undefined; });

it('distinguishes an unreachable reviewer, missing retained output, and a successful read without questions', async () => {
    const runs = [{ kind: 'execution', machineId: 'm1', runId: 'review-run' }] satisfies ReviewRunReferenceV1[];
    const run = ExecutionRunPublicStateSchema.parse({
        runId: 'review-run', callId: 'review-call', sidechainId: 'review-side', intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'default',
        retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'streaming', status: 'succeeded', startedAtMs: 1,
    });
    let reply: unknown = { ok: false, errorCode: 'execution_run_target_unavailable', error: 'Disconnected' };
    fixture = await createSessionFilesViewFixture({ serverUrl: 'https://review-questions.test', rpc: request => {
        if (request.method === RPC_METHODS.CAPABILITIES_DESCRIBE) return EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE;
        if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) return reply;
        return undefined;
    } });
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { useReviewQuestionRuns } = await import('./useReviewQuestionRuns');
    const lifetime = captureActiveServerAccountScopeLifetime();
    expect(lifetime).not.toBeNull();
    const snapshots: ReturnType<typeof useReviewQuestionRuns>[] = [];
    function Reader() {
        const snapshot = useReviewQuestionRuns({ runs, accountLifetime: lifetime, enabled: true });
        React.useEffect(() => { snapshots.push(snapshot); }, [snapshot]);
        return null;
    }
    const screen = await fixture.render(<Reader />);
    const latest = () => snapshots.at(-1)!;
    try {
        await vi.waitFor(() => {
            expect(fixture?.requests.some(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET
                && request.targetId === 'm1')).toBe(true);
            expect(latest()).toMatchObject({ state: { kind: 'unavailable', reason: 'temporarily_unavailable' } });
        });
        reply = { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };
        latest().retry();
        await vi.waitFor(() => expect(latest()).toMatchObject({
            state: { kind: 'unavailable', reason: 'run_missing' },
        }));
        reply = { run };
        latest().retry();
        await vi.waitFor(() => expect(latest()).toMatchObject({ state: { kind: 'no_questions' } }));
        // The same read names who reviewed and how it ended, for the Runs tab (lab `detail-runs`).
        expect(latest().runs.get('review-run')).toMatchObject({ run: { status: 'succeeded', backendTarget: { agentId: 'claude' } } });
    } finally {
        await screen.unmount();
    }
});

it.each(['settled', 'running', 'legacy'] as const)('%s round reads only the required execution runs', async kind => {
    const runs = ['r1', 'r2'].map(runId => ({ kind: 'execution' as const, machineId: 'm1', runId }));
    fixture = await createSessionFilesViewFixture({ serverUrl: 'https://review-summary.test', rpc: request => {
        if (request.method === RPC_METHODS.CAPABILITIES_DESCRIBE) return EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE;
        if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) return { ok: false, errorCode: 'execution_run_not_found' };
        return undefined;
    } });
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { useReviewQuestionRuns } = await import('./useReviewQuestionRuns');
    const lifetime = captureActiveServerAccountScopeLifetime();
    const round = { ordinal: 1, state: kind === 'running' ? 'running' as const : 'completed' as const,
        startedAt: 1, finishedAt: kind === 'running' ? null : 2, reviewerIds: ['first'], runs,
        reviewerDisplayNames: { first: 'Security' },
        ...(kind === 'legacy' ? {} : { reviewerQuestionSummaries: [{ reviewerId: 'first',
            runRef: { runId: 'r1', callId: 'call', backendId: 'claude' },
            overviewMarkdown: 'Generated files could not be inspected.',
            questions: [{ id: 'q', text: 'Which boundary?', status: 'open' as const }],
            assumptions: [{ id: 'a', text: 'Single writer' }] }] }) };
    let latest: ReturnType<typeof useReviewQuestionRuns> | undefined;
    function Reader() { latest = useReviewQuestionRuns({ runs, round, accountLifetime: lifetime, enabled: true }); return null; }
    const screen = await fixture.render(<Reader />);
    try {
        if (kind === 'settled') {
            expect(latest?.state).toEqual({ kind: 'ready' });
            expect(latest?.members).toMatchObject([{ reviewerLabel: 'Security', overviewMarkdown: 'Generated files could not be inspected.', questions: round.reviewerQuestionSummaries![0]!.questions,
                assumptions: round.reviewerQuestionSummaries![0]!.assumptions }]);
        } else {
            await vi.waitFor(() => expect(latest?.state.kind).toBe('unavailable'));
        }
        expect(fixture.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET)).toHaveLength(kind === 'settled' ? 0 : 2);
    } finally { await screen.unmount(); }
});
