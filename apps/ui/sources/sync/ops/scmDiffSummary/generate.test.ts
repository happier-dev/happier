import { describe, expect, it, vi } from 'vitest';

import type { ExecutionRunPublicState, ScmDiffSummaryGenerateInput, TurnChangeSet } from '@happier-dev/protocol';

import {
    createScmDiffSummaryOperations,
    getScmDiffSummaryOperationState,
} from './generate';

const turnChangeSet = {
    sessionId: 'session_1',
    turnId: 'turn_1',
    seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 },
    status: 'completed',
    files: [
        {
            filePath: 'src/a.ts',
            changeKind: 'modified',
            source: 'scm_checkpoint',
            confidence: 'exact',
            provider: 'checkpoint',
            unifiedDiff: '@@ changed',
        },
    ],
    provider: 'checkpoint',
    derivedAt: 100,
} satisfies TurnChangeSet;

const input = {
    cwd: '/repo',
    source: { kind: 'turnCheckpoint' },
    turnId: 'turn_1',
    checkpointReceiptId: 'receipt_1',
} satisfies ScmDiffSummaryGenerateInput;

function succeededRun(): ExecutionRunPublicState {
    return {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'sidechain_1',
        intent: 'scm_diff_summary',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'streaming',
        status: 'succeeded',
        startedAtMs: 100,
        finishedAtMs: 200,
    };
}

describe('SCM diff summary operations', () => {
    it('starts an explicit user-action execution run for scm.diffSummary.generate', async () => {
        const start = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'sidechain_1' }));
        const ops = createScmDiffSummaryOperations({
            startExecutionRun: start,
            getExecutionRun: vi.fn(),
            nowMs: () => 100,
        });

        const result = await ops.generateFromUserAction({
            key: 'summary-key',
            sessionId: 'session_1',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            input,
            turnChangeSet,
        });

        expect(result.ok).toBe(true);
        expect(start).toHaveBeenCalledWith('session_1', {
            kind: 'scm_diff_summary.v1',
            intent: 'scm_diff_summary',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'streaming',
            intentInput: {
                ...input,
                summarySchemaVersion: 1,
                resolvedSelector: { catalogId: 'backend:claude' },
                turnChangeSet,
            },
        });
        expect(getScmDiffSummaryOperationState(ops.getState(), 'summary-key')).toMatchObject({
            status: 'starting',
            executionRunId: 'run_1',
            pendingIntent: 'generate',
        });
    });

    it('does not echo raw modelSelector fields into the resolved cache selector', async () => {
        const start = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'sidechain_1' }));
        const ops = createScmDiffSummaryOperations({
            startExecutionRun: start,
            getExecutionRun: vi.fn(),
            nowMs: () => 100,
        });

        await ops.generateFromUserAction({
            key: 'summary-key',
            sessionId: 'session_1',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            input: {
                ...input,
                modelSelector: { profileId: 'raw-user-profile' },
            },
            turnChangeSet,
        });

        expect(start).toHaveBeenCalledWith(
            'session_1',
            expect.objectContaining({
                intentInput: expect.objectContaining({
                    resolvedSelector: { catalogId: 'backend:claude' },
                }),
            }),
        );
    });

    it('refreshes execution-run structured output into the view model', async () => {
        const get = vi.fn(async () => ({
            run: succeededRun(),
            structuredMeta: {
                kind: 'scm_diff_summary.v1',
                payload: {
                    success: true,
                    summaryMarkdown: '## Summary\n\nChanged src/a.ts.',
                    sourceKey: 'turn:turn_1:receipt_1',
                    checkpointReceiptId: 'receipt_1',
                    metadata: {
                        source: { kind: 'turnCheckpoint' },
                        sourceKey: 'turn:turn_1:receipt_1',
                        turnId: 'turn_1',
                        checkpointReceiptId: 'receipt_1',
                    },
                    risks: ['No tests were run.'],
                    testImpact: 'Run UI tests.',
                    suggestedPrBody: 'Changed src/a.ts.',
                },
            },
        }));
        const ops = createScmDiffSummaryOperations({
            startExecutionRun: vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'sidechain_1' })),
            getExecutionRun: get,
            nowMs: () => 100,
        });
        await ops.generateFromUserAction({
            key: 'summary-key',
            sessionId: 'session_1',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            input,
            turnChangeSet,
        });

        await ops.refreshRun({ key: 'summary-key', sessionId: 'session_1', runId: 'run_1' });

        expect(get).toHaveBeenCalledWith('session_1', { runId: 'run_1', includeStructured: true });
        expect(getScmDiffSummaryOperationState(ops.getState(), 'summary-key')).toMatchObject({
            status: 'succeeded',
            summaryMarkdown: '## Summary\n\nChanged src/a.ts.',
            risks: ['No tests were run.'],
            testImpact: 'Run UI tests.',
            suggestedPrBody: 'Changed src/a.ts.',
        });
    });

    it('reuses cached checkpoint summaries without starting another execution run', async () => {
        const start = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'sidechain_1' }));
        const get = vi.fn(async () => ({
            run: succeededRun(),
            structuredMeta: {
                kind: 'scm_diff_summary.v1',
                payload: {
                    success: true,
                    summaryMarkdown: '## Summary\n\nCached from run.',
                    sourceKey: 'turn:turn_1:receipt_1',
                    checkpointReceiptId: 'receipt_1',
                    metadata: {
                        source: { kind: 'turnCheckpoint' },
                        sourceKey: 'turn:turn_1:receipt_1',
                        turnId: 'turn_1',
                        checkpointReceiptId: 'receipt_1',
                    },
                },
            },
        }));
        const ops = createScmDiffSummaryOperations({
            startExecutionRun: start,
            getExecutionRun: get,
            nowMs: () => 100,
        });

        const first = await ops.generateFromUserAction({
            key: 'summary-key',
            sessionId: 'session_1',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            input,
            turnChangeSet: {
                ...turnChangeSet,
                repositoryCheckpoint: {
                    version: 1,
                    scopeId: 'scope-1',
                    baseRefSource: 'turn_start',
                    contentConfidence: 'exact',
                    attributionScope: 'shared_worktree',
                    receipts: [{ id: 'checkpoint.diff_computed', ref: 'refs/happier/checkpoints/1' }],
                },
            },
            settings: { 'scm.diffSummary.enabled': true },
            catalogProfiles: [{ catalogId: 'profile:fast-summary', title: 'Fast summary' }],
            resolvedSelector: { catalogId: 'profile:fast-summary' },
        });
        await ops.refreshRun({ key: first.key, sessionId: 'session_1', runId: 'run_1' });

        const second = await ops.generateFromUserAction({
            key: 'summary-key-2',
            sessionId: 'session_1',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            input,
            turnChangeSet: {
                ...turnChangeSet,
                repositoryCheckpoint: {
                    version: 1,
                    scopeId: 'scope-1',
                    baseRefSource: 'turn_start',
                    contentConfidence: 'exact',
                    attributionScope: 'shared_worktree',
                    receipts: [{ id: 'checkpoint.diff_computed', ref: 'refs/happier/checkpoints/1' }],
                },
            },
            settings: { 'scm.diffSummary.enabled': true },
            catalogProfiles: [{ catalogId: 'profile:fast-summary', title: 'Fast summary' }],
            resolvedSelector: { catalogId: 'profile:fast-summary' },
        });

        expect(second.ok).toBe(true);
        expect(start).toHaveBeenCalledTimes(1);
        expect(second.viewModel).toMatchObject({
            status: 'succeeded',
            summaryMarkdown: '## Summary\n\nCached from run.',
        });
    });

    it('keeps durable checkpoint summaries separated when cleanup receipt ids repeat across checkpoint refs', async () => {
        const start = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'sidechain_1' }));
        const get = vi.fn(async () => ({
            run: succeededRun(),
            structuredMeta: {
                kind: 'scm_diff_summary.v1',
                payload: {
                    success: true,
                    summaryMarkdown: '## Summary\n\nCached from run.',
                    sourceKey: 'turn:turn_1:receipt_1',
                    checkpointReceiptId: 'receipt_1',
                    metadata: {
                        source: { kind: 'turnCheckpoint' },
                        sourceKey: 'turn:turn_1:receipt_1',
                        turnId: 'turn_1',
                        checkpointReceiptId: 'receipt_1',
                    },
                },
            },
        }));
        const ops = createScmDiffSummaryOperations({
            startExecutionRun: start,
            getExecutionRun: get,
            nowMs: () => 100,
        });
        const withCheckpointRef = (ref: string) => ({
            ...turnChangeSet,
            repositoryCheckpoint: {
                version: 1,
                scopeId: 'scope-1',
                baseRefSource: 'turn_start',
                contentConfidence: 'exact',
                attributionScope: 'shared_worktree',
                receipts: [{ id: 'checkpoint.diff_computed', ref }],
            },
        }) satisfies TurnChangeSet;

        const first = await ops.generateFromUserAction({
            key: 'summary-key-a',
            sessionId: 'session_1',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            input,
            turnChangeSet: withCheckpointRef('refs/happier/checkpoints/turn-a'),
            resolvedSelector: { catalogId: 'profile:fast-summary' },
        });
        await ops.refreshRun({ key: first.key, sessionId: 'session_1', runId: 'run_1' });

        await ops.generateFromUserAction({
            key: 'summary-key-b',
            sessionId: 'session_1',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            input,
            turnChangeSet: withCheckpointRef('refs/happier/checkpoints/turn-b'),
            resolvedSelector: { catalogId: 'profile:fast-summary' },
        });

        expect(start).toHaveBeenCalledTimes(2);
    });

    it('passes durable cache bypass policy for explicit regenerate requests', async () => {
        const start = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'sidechain_1' }));
        const get = vi.fn(async () => ({
            run: succeededRun(),
            structuredMeta: {
                kind: 'scm_diff_summary.v1',
                payload: {
                    success: true,
                    summaryMarkdown: '## Summary\n\nCached from run.',
                    sourceKey: 'turn:turn_1:receipt_1',
                    checkpointReceiptId: 'receipt_1',
                    metadata: {
                        source: { kind: 'turnCheckpoint' },
                        sourceKey: 'turn:turn_1:receipt_1',
                        turnId: 'turn_1',
                        checkpointReceiptId: 'receipt_1',
                    },
                },
            },
        }));
        const ops = createScmDiffSummaryOperations({
            startExecutionRun: start,
            getExecutionRun: get,
            nowMs: () => 100,
        });
        const checkpointTurnChangeSet = {
            ...turnChangeSet,
            repositoryCheckpoint: {
                version: 1,
                scopeId: 'scope-1',
                baseRefSource: 'turn_start',
                contentConfidence: 'exact',
                attributionScope: 'shared_worktree',
                receipts: [{ id: 'checkpoint.diff_computed', ref: 'refs/happier/checkpoints/1' }],
            },
        } satisfies TurnChangeSet;

        const first = await ops.generateFromUserAction({
            key: 'summary-key',
            sessionId: 'session_1',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            input,
            turnChangeSet: checkpointTurnChangeSet,
            resolvedSelector: { catalogId: 'profile:fast-summary' },
        });
        await ops.refreshRun({ key: first.key, sessionId: 'session_1', runId: 'run_1' });

        await ops.generateFromUserAction({
            key: 'summary-key-regenerate',
            sessionId: 'session_1',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            input,
            turnChangeSet: checkpointTurnChangeSet,
            intent: 'regenerate',
            resolvedSelector: { catalogId: 'profile:fast-summary' },
        });

        expect(start).toHaveBeenCalledTimes(2);
        const startCalls = start.mock.calls as unknown as Array<readonly [
            string,
            Readonly<{ intentInput?: Readonly<Record<string, unknown>> }>,
        ]>;
        const secondRequest = startCalls[1]?.[1];
        expect(secondRequest?.intentInput).toMatchObject({
            cachePolicy: { mode: 'bypass' },
        });
    });

    it('does not reuse last-known checkpoint summaries across resolved selectors', async () => {
        let runSequence = 0;
        const start = vi.fn(async () => {
            runSequence += 1;
            return { runId: `run_${runSequence}`, callId: `call_${runSequence}`, sidechainId: `sidechain_${runSequence}` };
        });
        const get = vi.fn(async () => ({
            run: succeededRun(),
            structuredMeta: {
                kind: 'scm_diff_summary.v1',
                payload: {
                    success: true,
                    summaryMarkdown: '## Summary\n\nFast profile summary.',
                    sourceKey: 'turn:turn_1:receipt_1',
                    checkpointReceiptId: 'receipt_1',
                    metadata: {
                        source: { kind: 'turnCheckpoint' },
                        sourceKey: 'turn:turn_1:receipt_1',
                        turnId: 'turn_1',
                        checkpointReceiptId: 'receipt_1',
                    },
                },
            },
        }));
        const ops = createScmDiffSummaryOperations({ startExecutionRun: start, getExecutionRun: get, nowMs: () => 100 });
        const checkpointTurnChangeSet = {
            ...turnChangeSet,
            repositoryCheckpoint: {
                version: 1,
                scopeId: 'scope-1',
                baseRefSource: 'turn_start',
                contentConfidence: 'exact',
                attributionScope: 'shared_worktree',
                receipts: [{ id: 'checkpoint.diff_computed', ref: 'refs/happier/checkpoints/1' }],
            },
        } satisfies TurnChangeSet;

        const first = await ops.generateFromUserAction({
            sessionId: 'session_1',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            input,
            turnChangeSet: checkpointTurnChangeSet,
            resolvedSelector: { catalogId: 'profile:fast-summary' },
        });
        await ops.refreshRun({ key: first.key, sessionId: 'session_1', runId: 'run_1' });

        const second = await ops.generateFromUserAction({
            sessionId: 'session_1',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            input,
            turnChangeSet: checkpointTurnChangeSet,
            resolvedSelector: { catalogId: 'profile:thorough-summary' },
        });

        expect(start).toHaveBeenCalledTimes(2);
        expect(second.key).not.toBe(first.key);
        expect(second.viewModel).toMatchObject({
            status: 'starting',
            summaryMarkdown: null,
            isShowingLastKnownSummary: false,
        });
    });

    it('prunes UI operation cache when production turn-change cleanup receipts are delivered', async () => {
        const start = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'sidechain_1' }));
        const get = vi.fn(async () => ({
            run: succeededRun(),
            structuredMeta: {
                kind: 'scm_diff_summary.v1',
                payload: {
                    success: true,
                    summaryMarkdown: '## Summary\n\nPrunable summary.',
                    sourceKey: 'turn:turn_1:receipt_1',
                    checkpointReceiptId: 'receipt_1',
                    metadata: {
                        source: { kind: 'turnCheckpoint' },
                        sourceKey: 'turn:turn_1:receipt_1',
                        turnId: 'turn_1',
                        checkpointReceiptId: 'receipt_1',
                    },
                },
            },
        }));
        const ops = createScmDiffSummaryOperations({ startExecutionRun: start, getExecutionRun: get, nowMs: () => 100 });
        const checkpointTurnChangeSet = {
            ...turnChangeSet,
            repositoryCheckpoint: {
                version: 1,
                scopeId: 'scope-1',
                baseRefSource: 'turn_start',
                contentConfidence: 'exact',
                attributionScope: 'shared_worktree',
                receipts: [{ id: 'checkpoint.diff_computed', ref: 'refs/happier/checkpoints/1' }],
            },
        } satisfies TurnChangeSet;

        const first = await ops.generateFromUserAction({
            key: 'summary-key',
            sessionId: 'session_1',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            input,
            turnChangeSet: checkpointTurnChangeSet,
            resolvedSelector: { catalogId: 'profile:fast-summary' },
        });
        await ops.refreshRun({ key: first.key, sessionId: 'session_1', runId: 'run_1' });

        await ops.generateFromUserAction({
            key: 'summary-key-after-cleanup',
            sessionId: 'session_1',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            input,
            turnChangeSet: {
                ...checkpointTurnChangeSet,
                repositoryCheckpoint: {
                    ...checkpointTurnChangeSet.repositoryCheckpoint,
                    receipts: [{
                        id: 'checkpoint.cleanup_pruned',
                        refs: ['refs/happier/checkpoints/1'],
                        prunedCount: 1,
                    }],
                },
            },
            resolvedSelector: { catalogId: 'profile:fast-summary' },
        });

        expect(start).toHaveBeenCalledTimes(2);
    });

    it('respects disabled and prefetch settings before starting generation', async () => {
        const start = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'sidechain_1' }));
        const ops = createScmDiffSummaryOperations({
            startExecutionRun: start,
            getExecutionRun: vi.fn(),
            nowMs: () => 100,
        });

        const disabled = await ops.generateFromUserAction({
            key: 'summary-key',
            sessionId: 'session_1',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            input,
            turnChangeSet,
            settings: { 'scm.diffSummary.enabled': false },
        });
        const skippedPrefetch = await ops.prefetch({
            key: 'summary-prefetch',
            sessionId: 'session_1',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            input,
            turnChangeSet,
            settings: { 'scm.diffSummary.enabled': true, 'scm.diffSummary.prefetch': false },
        });

        expect(disabled).toMatchObject({ ok: false, errorCode: 'SCM_DIFF_SUMMARY_DISABLED' });
        expect(skippedPrefetch).toMatchObject({ ok: false, errorCode: 'SCM_DIFF_SUMMARY_PREFETCH_DISABLED' });
        expect(start).not.toHaveBeenCalled();
    });

    it('applies checkpoint cleanup receipts to the UI operation cache', async () => {
        const start = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'sidechain_1' }));
        const get = vi.fn(async () => ({
            run: succeededRun(),
            structuredMeta: {
                kind: 'scm_diff_summary.v1',
                payload: {
                    success: true,
                    summaryMarkdown: '## Summary\n\nPrunable summary.',
                    sourceKey: 'turn:turn_1:receipt_1',
                    checkpointReceiptId: 'receipt_1',
                    metadata: {
                        source: { kind: 'turnCheckpoint' },
                        sourceKey: 'turn:turn_1:receipt_1',
                        turnId: 'turn_1',
                        checkpointReceiptId: 'receipt_1',
                    },
                },
            },
        }));
        const ops = createScmDiffSummaryOperations({ startExecutionRun: start, getExecutionRun: get, nowMs: () => 100 });
        const checkpointTurnChangeSet = {
            ...turnChangeSet,
            repositoryCheckpoint: {
                version: 1,
                scopeId: 'scope-1',
                baseRefSource: 'turn_start',
                contentConfidence: 'exact',
                attributionScope: 'shared_worktree',
                receipts: [{ id: 'checkpoint.diff_computed', ref: 'refs/happier/checkpoints/1' }],
            },
        } satisfies TurnChangeSet;

        const first = await ops.generateFromUserAction({
            key: 'summary-key',
            sessionId: 'session_1',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            input,
            turnChangeSet: checkpointTurnChangeSet,
            resolvedSelector: { catalogId: 'profile:fast-summary' },
        });
        await ops.refreshRun({ key: first.key, sessionId: 'session_1', runId: 'run_1' });

        expect(ops.applyCheckpointCleanupReceipt({
            id: 'checkpoint.cleanup_pruned',
            refs: ['refs/happier/checkpoints/1'],
            prunedCount: 1,
        })).toEqual({ prunedEntries: 1 });

        await ops.generateFromUserAction({
            key: 'summary-key-2',
            sessionId: 'session_1',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            input,
            turnChangeSet: checkpointTurnChangeSet,
            resolvedSelector: { catalogId: 'profile:fast-summary' },
        });

        expect(start).toHaveBeenCalledTimes(2);
    });
});
