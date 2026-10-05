import { describe, expect, it } from 'vitest';
import type { ExecutionRunPublicState, ScmDiffSummaryResult } from '@happier-dev/protocol';
import { resolveScmDiffSummaryDiscussionTarget, selectScmDiffSummaryStopDiscussionContext } from './discussion';

const run = {
    runId: 'writer', callId: 'call', sidechainId: 'sidechain', intent: 'scm_diff_summary',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
    retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
    interaction: { kind: 'retained_agent_session.v1', capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } },
} satisfies ExecutionRunPublicState;

function target(overrides: Partial<Parameters<typeof resolveScmDiffSummaryDiscussionTarget>[0]> = {}) {
    return resolveScmDiffSummaryDiscussionTarget({ sessionId: 'session-1', serverId: 'home-1',
        runId: run.runId, run, source: 'session_rpc', canControlExecutionRuns: true, ...overrides });
}

describe('SCM discussion target', () => {
    it('captures result-local stop context at the displayed revision and rejects unrelated stops', () => {
        const result = { resultId: 'result-1', revision: 3, canUndo: false, output: {
            success: true, sourceKey: 'comparison-1', metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison-1' },
            resultId: 'result-1', revision: 3, outputs: { walkthrough: { state: 'complete', value: {
                title: 'Changes', intro: '', stops: [{ id: 'stop-1', title: 'Current edited title',
                    explanationMarkdown: 'Current explanation', changeRefs: ['change-1'] }], otherChangeRefs: [],
            } } },
        } } satisfies ScmDiffSummaryResult;
        expect(selectScmDiffSummaryStopDiscussionContext(result, ['stop-1'])).toEqual({
            resultId: result.resultId, revision: 3, stopIds: ['stop-1'],
        });
        expect(selectScmDiffSummaryStopDiscussionContext(result, ['unrelated'])).toBeNull();
        expect(selectScmDiffSummaryStopDiscussionContext(result, ['stop-1', 'stop-1'])).toBeNull();
        expect(selectScmDiffSummaryStopDiscussionContext(result, [])).toBeNull();
    });
    it('opens the actual retained writer through the existing scoped Run details route', () => {
        expect(target()).toMatchObject({ kind: 'continue', recipient: { kind: 'execution_run', runId: 'writer' }, needsResume: false });
        expect(target()).toHaveProperty('href', expect.stringContaining('/runs/writer'));
    });

    it('requires actual interaction and current exact target evidence', () => {
        for (const overrides of [
            { run: { ...run, interaction: undefined } },
            { run: { ...run, status: 'succeeded' as const } },
            { runId: 'different-writer' },
            { source: 'transcript_fallback' as const },
            { source: 'daemon_fallback' as const },
            { canControlExecutionRuns: false },
            { run: null },
        ]) expect(target(overrides)).toEqual({ kind: 'unavailable' });
    });

    it('uses the lifecycle owner to offer Resume for a lost recoverable writer', () => {
        expect(target({ run: { ...run, status: 'failed', interaction: undefined,
            lifecycle: { v: 1, state: 'recoverable' } } })).toMatchObject({ kind: 'continue', needsResume: true });
    });
});
