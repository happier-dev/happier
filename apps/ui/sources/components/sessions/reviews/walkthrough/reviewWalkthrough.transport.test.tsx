import * as React from 'react';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createMachineReadBatchResponseFixture, createPlainMachineRowFixture, createPlainSessionByIdResponseFixture, createSessionFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { ExecutionRunGetResponseSchema} from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ReviewFindingsV2Schema } from '@happier-dev/protocol/messages/structured/reviewFindingsV2';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import { ReviewWalkthroughResponseSchema } from '@happier-dev/protocol/reviews/reviewNarration';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { CapabilitiesDescribeResponse } from '@happier-dev/protocol/capabilities';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

installSessionFilesViewBoundaries();
await prepareSessionFilesViewTestkit();
const { SessionInteractiveExecutionRunDraftView } = await import('@/components/sessions/runs/launcher/SessionInteractiveExecutionRunDraftView');
const { requestFinishedReviewWalkthrough, requestExplainReviewFindings } = await import('@/sync/ops/reviews/reviewWalkthrough');
const { useWalkthroughReview } = await import('./useWalkthroughReview');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
afterEach(async () => { vi.useRealTimers(); standardCleanup(); await fixture?.dispose(); });

const comparison = ScmComparisonSchema.parse({ id: 'detached-comparison', source: { kind: 'workingTree' },
    repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } });
const anchorDraft: ReviewCommentDraft = {
    id: 'anchor-draft', filePath: 'src/a.ts', source: 'file',
    anchor: { kind: 'line', filePath: 'src/a.ts', line: 4, lineHash: 'lh1:1234567890abcdef' },
    snapshot: { selectedLines: ['const value = true;'], beforeContext: [], afterContext: [] },
    body: 'Check the condition.', createdAt: 1,
};

async function setup(detached = true, actionError?: Error, beforeActionReply?: Promise<void>, options: Readonly<{
    beforeCapabilityReply?: Promise<void>;
    serverIdentityId?: string;
    scmRunAction?: Awaited<ReturnType<typeof import('@/dev/testkit/harness/scmActionTransport').createScmRunActionHttpBoundary>>;
}> = {}) {
    fixture = await createSessionFilesViewFixture({ rootPath: '/repo', serverIdentityId: options.serverIdentityId, rpc: request => {
        if (request.method === RPC_METHODS.CAPABILITIES_DESCRIBE) return (async () => {
            await options.beforeCapabilityReply;
            return { protocolVersion: 1, capabilities: [{ id: 'tool.executionRuns', kind: 'tool', protocol: {
                version: 2, available: true, features: { detachedScope: true, startAndWait: true,
                    runScopedAgentBindings: true, secretReferenceOverlay: true },
            } }], checklists: {} } satisfies CapabilitiesDescribeResponse;
        })();
        if (request.method === SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST || request.method === RPC_METHODS.DAEMON_SESSION_SKILL_CATALOG_LIST) {
            return (async () => { await beforeActionReply; return { skills: [] }; })();
        }
        if (request.method === RPC_METHODS.WORKSPACE_ANCHORS_RESOLVE) {
            return (async () => { await beforeActionReply; return { success: true, resolutions: [] }; })();
        }
        if (request.method === 'capabilities.detect') return { protocolVersion: 1, results: { 'tool.executionRuns': {
            ok: true, checkedAt: 1, data: { protocolVersion: 2, backends: { claude: { available: true, intents: ['review'] } },
                features: { detachedScope: true, startAndWait: true, runScopedAgentBindings: true, secretReferenceOverlay: true } } } } };
        if (request.method === 'execution.run.action') return (async () => {
            await beforeActionReply;
            if (actionError) throw actionError;
            const input = request.payload as { actionId: string };
            return input.actionId === 'review.walkthrough'
                ? { ok: true, result: ReviewWalkthroughResponseSchema.parse({ runId: 'narrator-1', callId: 'call-1', sidechainId: 'call-1',
                    mode: 'seeded_narrator', state: 'collecting', comparisonId: comparison.id, comparison, reviewRunIds: ['review-1'] }) }
                : { ok: true, result: { refinement: { actionId: 'scm.diffSummary.refine', input: { cwd: '/repo', resultId: 'result-1',
                    expectedRevision: 2, output: 'walkthrough', stopIds: ['stop-1'], instructions: 'Explain the finding.' } } } };
        })();
        if (request.method === 'execution.run.get') return ExecutionRunGetResponseSchema.parse({
            run: { runId: 'review-1', callId: 'call-1', sidechainId: 'call-1', intent: 'review',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only', retentionPolicy: 'resumable',
                runClass: 'long_lived', ioMode: 'streaming', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2 },
            structuredMeta: { kind: 'scm_diff_summary.v1', payload: {} },
            reviewFindings: ReviewFindingsV2Schema.parse({ runRef: { runId: 'review-1', callId: 'call-1', backendId: 'claude' },
                comparisonId: comparison.id, reviewOutcome: 'complete', summary: 'Original findings', overviewMarkdown: 'Original findings', generatedAtMs: 2,
                findings: [{ id: 'finding-1', title: 'Reachable defect', severity: 'high', category: 'correctness', summary: 'Check the condition.' }] }),
        });
        if (request.method === 'scm.diffSummary.refine') return { success: false, errorCode: 'revision_conflict', error: 'Saved result changed', latestRevision: 3 };
        return undefined;
    }, request: createSessionReadBatchFetchBoundary(async (url, init) => {
        const admitted = await options.scmRunAction?.handle(new URL(String(url)), init);
        if (admitted) return admitted;
        const path = new URL(String(url)).pathname;
        if (path === '/v1/machines/read-batch' && init?.method === 'POST') {
            return createMachineReadBatchResponseFixture(init.body, id => id === 'm1'
                ? createPlainMachineRowFixture({ id, accountId: 'alice' }) : null);
        }
        if (path === '/v2/sessions/s1') return Response.json(createPlainSessionByIdResponseFixture(createSessionFixture({ id: 's1', active: true })));
        return path === ACP_CATALOG_ROWS_ROUTE_V1
            ? Response.json(AcpCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } } }))
            : Response.json({ error: 'not_found' }, { status: 404 });
    }),
    });
    if (detached) fixture.storage.setState({ sessions: {} });
}

describe('review walkthrough transport', () => {
    it('keeps review drafts when an unanswered Ask-for-changes anchor request is cancelled', async () => {
        const reply = createDeferred<void>();
        await setup(false, undefined, reply.promise);
        const { sendReviewForChanges } = await import('@/components/sessions/reviews/comments/sendReviewForChanges');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        expect(accountLifetime).not.toBeNull();
        if (!accountLifetime) throw new Error('Expected restored Account lifetime');
        vi.useFakeTimers();
        const controller = new AbortController();
        const clearSentDrafts = vi.fn();
        let settled = false;
        const observation = sendReviewForChanges({ sessionId: 's1', accountLifetime, drafts: [anchorDraft],
            reviewScope: { serverId: fixture.home.id, machineId: 'm1', rootPath: '/repo' },
            clearSentDrafts, signal: controller.signal }).then(outcome => { settled = true; return outcome; });
        try {
            await vi.waitFor(() => expect(fixture.requests.some(request => request.method === RPC_METHODS.WORKSPACE_ANCHORS_RESOLVE)).toBe(true));
            controller.abort();
            await vi.advanceTimersByTimeAsync(1);
            expect(settled).toBe(true);
            expect(await observation).toBe('failed');
            expect(clearSentDrafts).not.toHaveBeenCalled();
        } finally {
            reply.resolve();
            void observation.catch(() => undefined);
        }
    });
    it('releases an unanswered draft-anchor read when its modal closes and reopens', async () => {
        const reply = createDeferred<void>();
        await setup(false, undefined, reply.promise);
        const { ReviewCommentsDraftsModal } = await import('@/components/sessions/agentInput/definitions/ReviewCommentsDraftsModal');
        const render = () => fixture.render(<ReviewCommentsDraftsModal
            sessionId="s1" onClose={() => {}} onUpdateDraft={() => {}} onDeleteDraft={() => {}}
            reviewScope={{ serverId: fixture.home.id, machineId: 'm1', rootPath: '/repo' }}
            reviewCommentDrafts={[anchorDraft]} />);
        const screen = await render();
        try {
            await vi.waitFor(() => expect(fixture.requests.filter(request => request.method === RPC_METHODS.WORKSPACE_ANCHORS_RESOLVE)).toHaveLength(1));
            await screen.unmount();
            expect(fixture.emissions.some(item => item.event === 'rpc-cancel')).toBe(true);
            reply.resolve();
            const reopened = await render();
            await vi.waitFor(() => expect(fixture.requests.filter(request => request.method === RPC_METHODS.WORKSPACE_ANCHORS_RESOLVE)).toHaveLength(2));
            await reopened.unmount();
        } finally {
            reply.resolve();
        }
    });
    it('cancels a non-replying capabilities query and permits the next request', async () => {
        const reply = createDeferred<void>();
        await setup(true, undefined, undefined, { beforeCapabilityReply: reply.promise });
        const { machineCapabilitiesDescribe } = await import('@/sync/ops/capabilities');
        vi.useFakeTimers();
        const controller = new AbortController();
        let settled = false;
        const observation = machineCapabilitiesDescribe('m1', { serverId: fixture.home.id, signal: controller.signal })
            .finally(() => { settled = true; });
        try {
            await vi.waitFor(() => expect(fixture.requests.some(request => request.method === RPC_METHODS.CAPABILITIES_DESCRIBE)).toBe(true));
            await vi.advanceTimersByTimeAsync(120_000);
            expect(settled).toBe(false);
            controller.abort();
            await vi.advanceTimersByTimeAsync(1);
            expect(settled).toBe(true);
            expect(await observation).toMatchObject({ supported: false, reason: 'error' });
            expect(fixture.emissions.some(item => item.event === 'rpc-cancel')).toBe(true);
            reply.resolve();
            expect(await machineCapabilitiesDescribe('m1', { serverId: fixture.home.id })).toMatchObject({ supported: true });
        } finally {
            reply.resolve();
            await observation;
        }
    });
    it.each([true, false])('cancels catalog hydration without publishing a retired query, then retries (active %s)', async active => {
        const reply = createDeferred<void>();
        await setup(false, undefined, reply.promise);
        const session = fixture.storage.getState().sessions.s1!;
        fixture.storage.setState({ sessions: { s1: { ...session, active } } });
        const { ensureSessionSuggestionCatalogs } = await import('@/sync/ops/sessionCatalogs');
        vi.useFakeTimers();
        const controller = new AbortController();
        let settled = false;
        const observation = ensureSessionSuggestionCatalogs('s1', { skills: true }, { signal: controller.signal })
            .finally(() => { settled = true; });
        const method = active ? SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST : RPC_METHODS.DAEMON_SESSION_SKILL_CATALOG_LIST;
        try {
            await vi.waitFor(() => expect(fixture.requests.some(request => request.method === method)).toBe(true));
            await vi.advanceTimersByTimeAsync(120_000);
            expect(settled).toBe(false);
            controller.abort();
            await vi.advanceTimersByTimeAsync(1);
            expect(settled).toBe(true);
            await observation;
            expect(fixture.storage.getState().sessions.s1?.metadata?.sessionSkillCatalogV1).toBeUndefined();
            reply.resolve();
            await ensureSessionSuggestionCatalogs('s1', { skills: true });
            expect(fixture.storage.getState().sessions.s1?.metadata?.sessionSkillCatalogV1).toMatchObject({ skills: [] });
            expect(fixture.requests.filter(request => request.method === method)).toHaveLength(2);
        } finally {
            reply.resolve();
            await observation;
        }
    });
    it('cancels Session catalog discovery when the composer query is superseded', async () => {
        const reply = createDeferred<void>();
        await setup(false, undefined, reply.promise);
        const { getSuggestions } = await import('@/components/autocomplete/suggestions');
        vi.useFakeTimers();
        const controller = new AbortController();
        const observation = getSuggestions('s1', '$check', { kinds: ['skill'], signal: controller.signal });
        try {
            await vi.waitFor(() => expect(fixture.requests.some(request => request.method === SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST)).toBe(true));
            controller.abort();
            await vi.advanceTimersByTimeAsync(1);
            expect(await observation).toEqual([]);
            expect(fixture.emissions.some(item => item.event === 'rpc-cancel')).toBe(true);
            expect(fixture.storage.getState().sessions.s1?.metadata?.sessionSkillCatalogV1).toBeUndefined();
        } finally {
            reply.resolve();
            await observation;
        }
    });
    it.each([false, true])('waits for the walkthrough owner beyond 30 seconds (detached %s)', async detached => {
        const reply = createDeferred<void>();
        await setup(detached, undefined, reply.promise);
        vi.useFakeTimers();
        let settled = false;
        const result = requestFinishedReviewWalkthrough({
            ...(detached ? { sessionId: null, machineId: 'm1' } : { sessionId: 's1' }),
            serverId: fixture.home.id, cwd: '/repo', runId: 'review-1', reviewRunIds: ['review-1'],
            comparisonId: comparison.id, fallbackComparison: { kind: 'workingTree' },
        }).finally(() => { settled = true; });
        try {
            await vi.waitFor(() => expect(fixture.requests.some(request => request.method === 'execution.run.action')).toBe(true));
            await vi.advanceTimersByTimeAsync(32_402);
            expect(settled).toBe(false);
            reply.resolve();
            expect(await result).toMatchObject({ ok: true, comparisonId: comparison.id });
            expect(fixture.requests.filter(request => request.method === 'execution.run.action')).toHaveLength(1);
        } finally {
            reply.resolve();
            await result;
        }
    });
    it.each([
        { detached: false, termination: 'cancel' },
        { detached: false, termination: 'disconnect' },
        { detached: true, termination: 'cancel' },
    ] as const)('settles a walkthrough on $termination without resending (detached $detached)', async ({ detached, termination }) => {
        const reply = createDeferred<void>();
        await setup(detached, termination === 'disconnect' ? new Error('socket has been disconnected') : undefined, reply.promise);
        vi.useFakeTimers();
        const controller = new AbortController();
        let settled = false;
        const result = createDefaultActionExecutor({ resolveServerIdForSessionId: () => fixture.home.id }).execute(
            'review.walkthrough',
            { ...(detached ? { target: { kind: 'detached' as const } } : { sessionId: 's1' }),
                runId: 'review-1', reviewRunIds: ['review-1'], comparisonId: comparison.id },
            { serverId: fixture.home.id, signal: controller.signal,
                ...(detached ? { externalActionTarget: { kind: 'machine' as const, machineId: 'm1',
                    project: { machineId: 'm1', directory: '/repo' } }, executionRunTargetMachineId: 'm1' }
                    : { defaultSessionId: 's1' }) },
        ).finally(() => { settled = true; });
        try {
            await vi.waitFor(() => expect(fixture.requests.some(request => request.method === 'execution.run.action')).toBe(true));
            if (termination === 'cancel') controller.abort();
            else reply.resolve();
            await vi.advanceTimersByTimeAsync(1);
            expect(settled).toBe(true);
            expect(await result).toMatchObject({ ok: false,
                errorCode: termination === 'cancel'
                    ? detached ? 'MACHINE_RPC_ABORTED' : 'SOCKET_RPC_ABORTED'
                    : 'RPC_OUTCOME_UNKNOWN' });
            expect(fixture.requests.filter(request => request.method === 'execution.run.action')).toHaveLength(1);
            if (termination === 'cancel') expect(fixture.emissions.some(item => item.event === 'rpc-cancel')).toBe(true);
        } finally {
            reply.resolve();
            await result;
        }
    });
    it('accepts the finished walkthrough acknowledgement through the attached Session transport', async () => {
        await setup(false);
        const result = await requestFinishedReviewWalkthrough({ sessionId: 's1', serverId: fixture.home.id, cwd: '/repo',
            runId: 'review-1', reviewRunIds: ['review-1'], comparisonId: comparison.id, fallbackComparison: { kind: 'workingTree' } });
        expect(result, JSON.stringify({ result, requests: fixture.requests }))
            .toMatchObject({ ok: true, comparisonId: comparison.id });
    });
    it('retains an uncoded transport failure instead of reporting invalid walkthrough output', async () => {
        await setup(false, new Error('operation has timed out'));
        const result = await requestFinishedReviewWalkthrough({ sessionId: 's1', serverId: fixture.home.id,
            cwd: '/repo', runId: 'review-1', reviewRunIds: ['review-1'],
            comparisonId: comparison.id, fallbackComparison: { kind: 'workingTree' } });
        expect(result, JSON.stringify({ result, requests: fixture.requests }))
            .toMatchObject({ ok: false, errorCode: 'execution_run_target_unavailable' });
        expect(fixture.requests.filter(request => request.method === 'execution.run.action')).toHaveLength(1);
    });
    it('reads original findings through the workspace Run even after narration replaces its current structured output', async () => {
        await setup();
        const hook = await renderHook(() => useWalkthroughReview({ host: { machineId: 'm1' }, cwd: '/repo',
            scope: { serverId: fixture.home.id, accountId: 'alice' }, comparison, walkthrough: null,
            producer: { kind: 'review', reviewedRuns: [{ runId: 'review-1', callId: 'call-1', backendId: 'claude',
                status: 'succeeded', hasOutput: true, comparisonId: comparison.id }] } }));
        await vi.waitFor(() => expect(hook.getCurrent()?.overlay.tail.map(finding => finding.findingId)).toEqual(['finding-1']));
        expect(hook.getCurrent()?.overlay.summary.state).toBe('complete');
        expect(fixture.requests.filter(request => request.method === 'execution.run.get')).toEqual([
            expect.objectContaining({ targetId: 'm1', payload: expect.objectContaining({ runId: 'review-1', includeStructured: true, includeLatestToolResult: false }) }),
        ]);
        expect(fixture.requests.some(request => request.targetId === 's1' || request.method === 'review.comments.list')).toBe(false);
    });
    it.each([false, true])('keeps the admitted workspace walkthrough toggle usable with default %s', async defaultWalkthrough => {
        await setup();
        const screen = await fixture.render(<SessionInteractiveExecutionRunDraftView sessionId={null} workspace={{ machineId: 'm1', cwd: '/repo' }}
            serverId={fixture.home.id} intent="review" onRunStarted={vi.fn()}
            comparisonReview={{ cwd: '/repo', comparison: { kind: 'workingTree' }, comparisonId: comparison.id,
                scopeLabel: 'Pending changes', defaultWalkthrough }} />);
        await flushHookEffects({ cycles: 10 });
        // The walkthrough question lives in its composer chip (lab flRun `compare`).
        const walkthroughChoice = async () => {
            const composer = screen.root.findAll(node => Array.isArray(node.props.extraActionChips))[0]!;
            const chip = (composer.props.extraActionChips as readonly { key: string; collapsedContentPopover?: { renderContent: unknown } }[])
                .find(item => item.key === 'execution-run-start-walkthrough')!;
            const renderContent = chip.collapsedContentPopover?.renderContent as (ctx: Readonly<{ requestClose: () => void; maxHeight: number }>) => React.ReactNode;
            return fixture.render(<>{renderContent({ requestClose: vi.fn(), maxHeight: 800 })}</>);
        };
        const choice = await walkthroughChoice();
        expect(choice.findByTestId('start-review-walkthrough')?.props.disabled).not.toBe(true);
        expect(choice.findByTestId('start-review-walkthrough')?.props.accessibilityState?.checked).toBe(defaultWalkthrough);
        await choice.pressByTestIdAsync('start-review-walkthrough');
        await flushHookEffects({ cycles: 5 });
        expect((await walkthroughChoice()).findByTestId('start-review-walkthrough')?.props.accessibilityState?.checked).toBe(!defaultWalkthrough);
        expect(fixture.requests.some(request => request.method === 'execution.run.start')).toBe(false);
    });
    it('requests finished narration and targeted explanation on the original Machine and propagates a saved revision conflict', async () => {
        const { createScmRunActionHttpBoundary } = await import('@/dev/testkit/harness/scmActionTransport');
        const scmRequests: unknown[] = [];
        const serverIdentityId = 'srv_review_walkthrough';
        const scmRunAction = await createScmRunActionHttpBoundary({ serverUrl: 'https://session-file-views.test',
            serverIdentityId, accountId: 'alice', machineId: 'm1', actionIds: ['scm.diffSummary.refine'],
            execute: (_actionId, input) => {
                scmRequests.push(input);
                return { success: false, errorCode: 'revision_conflict', error: 'Saved result changed', latestRevision: 3 };
            } });
        await setup(true, undefined, undefined, { serverIdentityId, scmRunAction });
        const target = { sessionId: null, machineId: 'm1', serverId: fixture.home.id, cwd: '/repo', runId: 'review-1', reviewRunIds: ['review-1'] };
        expect(await requestFinishedReviewWalkthrough({ ...target, comparisonId: comparison.id, fallbackComparison: { kind: 'workingTree' } }))
            .toMatchObject({ ok: true, comparisonId: comparison.id });
        expect(await requestExplainReviewFindings({ ...target, resultId: 'result-1', expectedRevision: 2,
            findingIds: [{ runId: 'review-1', findingId: 'finding-1' }] })).toMatchObject({ ok: false, errorCode: 'revision_conflict' });
        expect(fixture.requests.filter(request => request.method === 'execution.run.action')).toEqual([
            expect.objectContaining({ targetId: 'm1', payload: expect.objectContaining({ runId: 'review-1', actionId: 'review.walkthrough' }) }),
            expect.objectContaining({ targetId: 'm1', payload: expect.objectContaining({ runId: 'review-1', actionId: 'review.explain_findings',
                input: expect.objectContaining({ cwd: '/repo', expectedRevision: 2 }) }) }),
        ]);
        expect(scmRequests).toEqual([expect.objectContaining({ cwd: '/repo', resultId: 'result-1', expectedRevision: 2, output: 'walkthrough' })]);
        expect(fixture.requests.some(request => request.targetId === 's1')).toBe(false);
    });
});
