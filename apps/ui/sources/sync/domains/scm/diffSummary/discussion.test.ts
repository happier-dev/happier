import { describe, expect, it } from 'vitest';
import type { ExecutionRunPublicState} from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ScmDiffSummaryResult } from '@happier-dev/protocol/scm/diffSummaryResult';
import { resolveScmDiffSummaryDiscussionTarget, selectScmDiffSummaryDiscussionReply, selectScmDiffSummaryDiscussionSavedResult, selectScmDiffSummaryStopDiscussionContext } from './discussion';
import { createInitialScmDiffSummaryState, type ScmDiffSummaryEntry } from './state';

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
    it('projects the restored initial native input only as narration while keeping genuine replies, including JSON prose', () => {
        // Captured Q07 shape: the native initial JSON is reported as a completed text turn.
        const initial = { turnId: 'generation-turn', inputIds: ['generation-input'], state: 'completed' as const,
            result: { kind: 'text' as const, value: '{"walkthrough":{"title":"Total calculation inverted"}}' } };
        const restored = { inputId: 'generation-input', latestRun: { ...run,
            inputTurns: { occurrenceId: 'native-occurrence', last: initial } } };
        expect(selectScmDiffSummaryDiscussionReply(restored)).toBeNull();
        const reply = { ...initial, turnId: 'discussion-turn', inputIds: ['discussion-input'] };
        expect(selectScmDiffSummaryDiscussionReply({ ...restored, latestRun: { ...run,
            inputTurns: { occurrenceId: 'native-occurrence', last: initial, current: reply } } })).toBe(reply.result.value);
        expect(selectScmDiffSummaryDiscussionReply({ ...restored, inputId: null })).toBeNull();
    });
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
    it('reads the asked-about stop only from the exact saved revision the question addresses', () => {
        const stop = (id: string) => ({ id, title: id, explanationMarkdown: 'Why.', changeRefs: ['change-1'] });
        const savedResult = { resultId: 'result-1', revision: 4, canUndo: false, output: {
            success: true, sourceKey: 'comparison-1', metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison-1' },
            resultId: 'result-1', revision: 4, outputs: { walkthrough: { state: 'complete', value: {
                title: 'Changes', intro: '', stops: [stop('stop-a'), stop('stop-b'), stop('stop-c')], otherChangeRefs: [],
            } } },
        } } satisfies ScmDiffSummaryResult;
        const state = { ...createInitialScmDiffSummaryState(), entriesByKey: { k: { key: 'k', savedResult } as unknown as ScmDiffSummaryEntry } };
        const ask = { cwd: '/repo', resultId: 'result-1', expectedRevision: 4, stopIds: ['stop-b'] };
        expect(selectScmDiffSummaryDiscussionSavedResult(state, ask)).toBe(savedResult);
        expect(selectScmDiffSummaryDiscussionSavedResult(state, { ...ask, expectedRevision: 5 })).toBeNull();
        expect(selectScmDiffSummaryDiscussionSavedResult(state, { ...ask, stopIds: ['gone'] })).toBeNull();
        expect(selectScmDiffSummaryDiscussionSavedResult(state, { ...ask, stopIds: undefined })).toBeNull();
    });
    it('opens the actual retained writer through the existing scoped Run details route', () => {
        expect(target()).toMatchObject({ kind: 'continue', recipient: { kind: 'execution_run', runId: 'writer' }, needsResume: false });
        expect(target()).toHaveProperty('href', expect.stringContaining('/runs/writer'));
    });

    it('requires actual interaction and current exact target evidence', () => {
        for (const overrides of [
            { run: { ...run, interaction: undefined } },
            { run: { ...run, status: 'succeeded' as const } },
            { canControlExecutionRuns: false },
        ]) expect(target(overrides)).toEqual({ kind: 'unavailable' });
    });

    it('keeps restored conversation availability unknown until the exact live Run is observed', () => {
        for (const overrides of [
            { runId: null },
            { run: null },
            { run: null, canControlExecutionRuns: false },
            { run: undefined },
            { runId: 'different-writer' },
            { source: 'transcript_fallback' as const },
            { source: 'daemon_fallback' as const },
        ]) expect(target(overrides)).toEqual({ kind: 'unknown' });
    });

    it('waits for the admitted current Run to publish its retained interaction without declaring it ended', () => {
        expect(target({ run: { ...run, interaction: undefined, lifecycle: { v: 1, state: 'current' } } }))
            .toEqual({ kind: 'unknown' });
        expect(target({ run: { ...run, lifecycle: { v: 1, state: 'current' } } }))
            .toMatchObject({ kind: 'continue', needsResume: false });
        expect(target({ run: { ...run, interaction: undefined, lifecycle: { v: 1, state: 'unavailable' } } }))
            .toEqual({ kind: 'unavailable' });
    });

    it('uses the lifecycle owner to offer Resume for a lost recoverable writer', () => {
        expect(target({ run: { ...run, status: 'failed', interaction: undefined,
            lifecycle: { v: 1, state: 'recoverable' } } })).toMatchObject({ kind: 'continue', needsResume: true });
    });
});
