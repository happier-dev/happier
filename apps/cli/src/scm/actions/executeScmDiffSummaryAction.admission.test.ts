import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAgentStaticModels } from '@happier-dev/agents';
import { ExecutionRunStartRequestSchema, ExecutionRunScmDiffSummaryInputV1Schema, ScmComparisonSchema,
    type ActionExecuteResult, type ScmDiffSummaryGenerateInput } from '@happier-dev/protocol';

import { createLocalScmRepositoryFixture } from '@/scm/contracts/scmBackendContractFixtures';
import { gitCheckpointAdapter, resolveGitCheckpointBackendContext } from '@/scm/checkpoints/gitCheckpointAdapter';
import { buildRepositoryCheckpointRefs } from '@/scm/checkpoints/refs';
import { retainRepositoryCheckpointTurnEvidence } from '@/scm/checkpoints/sessionEvidence';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { ScmDiffSummaryProfile } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/ScmDiffSummaryProfile';
import { startExecutionRun } from '@/agent/runtime/bridges/executionRun/startExecutionRun';
import { stopExecutionRun } from '@/agent/runtime/bridges/executionRun/executionRunStop';
import { sendBackendLongLivedRun } from '@/agent/runtime/bridges/executionRun/send/backendLongLivedPrompt';
import { createTestExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/testkit';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { executeScmDiffSummaryAction } from './executeScmDiffSummaryAction';

// Model discovery's installation/filesystem boundary uses the canonical publication fixture.
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
    return createBundledPluginPublicationFsFixture(actual);
});

describe('SCM generation through real host admission', () => {
    const directories: string[] = [];
    beforeEach(() => {
        vi.stubEnv('HAPPIER_CLAUDE_PATH', process.execPath);
        vi.stubEnv('HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED', '0');
    });
    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
    });

    it('joins concurrent clients for one checkpoint and reuses its completed saved output', async () => {
        const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-admission-' });
        directories.push(fixture.rootPath);
        const sessionId = 'same-checkpoint-session';
        const turnId = 'turn-1';
        const scopeId = `${sessionId}:${fixture.rootPath}`;
        const refs = buildRepositoryCheckpointRefs({ scopeId, turnId });
        const context = await resolveGitCheckpointBackendContext({ cwd: fixture.rootPath });
        if (!context || !refs.turnStart || !refs.turnFinal) throw new Error('Checkpoint fixture is unavailable');
        const start = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnStart });
        await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Checkpoint change\n');
        const final = await gitCheckpointAdapter.capture({ context, checkpointRef: refs.turnFinal });
        if (!start.success || !final.success) throw new Error('Checkpoint fixture capture failed');
        await retainRepositoryCheckpointTurnEvidence({ cwd: fixture.rootPath, scopeId, turnChangeSet: {
            sessionId, turnId, provider: 'claude', derivedAt: 1, status: 'completed', files: [],
            seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 },
            repositoryCheckpoint: { version: 1, scopeId, startRef: refs.turnStart.ref, finalRef: refs.turnFinal.ref,
                baseRefSource: 'turn_start', contentConfidence: 'exact', attributionScope: 'shared_worktree',
                receipts: [...start.receipts, ...final.receipts] },
        } });
        const modelId = getAgentStaticModels('claude', { catalogOnly: true })[0]?.id;
        if (!modelId) throw new Error('Native structured model fixture is unavailable');
        const runs = new Map<string, ExecutionRunState>();
        const controllers = new Map<string, ExecutionRunController>();
        const delivered = new Set<string>();
        let failProvision = false;
        let releaseModel = () => {};
        let modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
        const createRuntime: Parameters<typeof startExecutionRun>[0]['createRuntime'] = (options) => {
            const runtime = createTestExecutionRunHostRuntime({
                resumeSupported: true,
                onProvisionRuntime: async () => { if (failProvision) throw new Error('Native model provisioning failed'); },
                onSendPrompt: async () => {
                    delivered.add(options.runId!);
                    await modelGate;
                    const input = ExecutionRunScmDiffSummaryInputV1Schema.parse(options.start?.intentInput);
                    const comparison = ScmComparisonSchema.parse(input.comparison);
                    runtime.emitMessage({ type: 'model-output', fullText: JSON.stringify(input.outputs?.includes('walkthrough')
                        ? { walkthrough: { title: 'Checkpoint', intro: 'Captured change', stops: [{ id: 'stop', title: 'Changed file',
                            explanationMarkdown: 'The captured file changed.', changeRefs: comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.alias)) }],
                            otherChangeRefs: [] } } : { summaryMarkdown: 'Checkpoint summary.' }) });
                },
                onWaitForTurnCompletion: async () => {},
            });
            return runtime;
        };
        const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => { throw new Error('Unused Voice runtime'); } });
        const finishRun: Parameters<typeof startExecutionRun>[0]['finishRun'] = async (runId, next) => {
            const current = runs.get(runId);
            if (current) runs.set(runId, { ...current, ...next });
        };
        const send: Parameters<typeof startExecutionRun>[0]['send'] = (runId, params) => sendBackendLongLivedRun({
            runId, params, runs, controllers, budgetRegistry: null, createRuntime, maxTurns: null,
            getNowMs: Date.now, finishRun, sendAcp: async () => {}, parentProvider: 'claude',
            streamedTranscriptSession: null, writeActivityMarker: async () => {},
        });
        const execute = (client: string) => async (_action: 'execution.run.start', input: unknown): Promise<ActionExecuteResult> => {
            const request = ExecutionRunStartRequestSchema.parse(input);
            const prepared = await ScmDiffSummaryProfile.prepareStartParams!({ request, cwd: fixture.rootPath, sessionId });
            const result = await startExecutionRun({
                params: { ...request, ...prepared, sessionId, cwd: fixture.rootPath,
                    backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, actionRequestId: `client-${client}` },
                parentProvider: 'claude', sendAcp: async () => {}, streamedTranscriptSession: null,
                createRuntime, getNowMs: Date.now, budgetRegistry: null, runs, controllers,
                enqueueMarkerWrite: async (_id, write) => write(), writeActivityMarker: async () => {},
                finishRun, executeBoundedRun: async () => { throw new Error('Unexpected bounded dispatch'); }, send, voiceAgentManager,
            });
            return { ok: true, result };
        };
        const request = { cwd: fixture.rootPath, source: { kind: 'turnCheckpoint' as const }, turnId,
            checkpointReceiptId: 'checkpoint.finalized', modelSelector: { modelId } };
        const generate = (client: string, override: Partial<ScmDiffSummaryGenerateInput> = {}) => executeScmDiffSummaryAction({ request: { ...request, ...override }, sessionId,
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }, executeCanonicalAction: execute(client) });
        try {
            const [left, right] = await Promise.all([generate('a'), generate('b')]);
            expect(right.comparison?.id).toBe(left.comparison?.id);
            await vi.waitFor(() => expect(delivered.size).toBeGreaterThan(0));
            expect({ admittedRuns: runs.size, modelRuns: delivered.size, resultIds: new Set([left.resultId, right.resultId]).size })
                .toEqual({ admittedRuns: 1, modelRuns: 1, resultIds: 1 });
            expect(right.runId).toBe(left.runId);
            releaseModel();
            await vi.waitFor(async () => expect(await scmDiffSummaryResultStore.read({ cwd: fixture.rootPath, sessionId, resultId: left.resultId! }))
                .toMatchObject({ success: true, result: { output: { outputs: { summary: { state: 'complete' } } } } }));
            const cached = await generate('c');
            expect(cached).toMatchObject({ resultId: left.resultId, runId: left.runId, outputs: { summary: { state: 'complete' } } });
            expect(runs.size).toBe(1);
            expect(delivered.size).toBe(1);
            const regenerated = await generate('explicit-regeneration', { cachePolicy: { mode: 'bypass' } });
            expect(regenerated.resultId).not.toBe(left.resultId);
            await vi.waitFor(() => expect(delivered.size).toBe(2));
            const differentModelId = getAgentStaticModels('claude', { catalogOnly: true }).find(model => model.id !== modelId)?.id;
            if (!differentModelId) throw new Error('Second offered structured model fixture is unavailable');
            const differentModel = await generate('new-model', { modelSelector: { modelId: differentModelId } });
            expect(differentModel.resultId).not.toBe(left.resultId);
            await vi.waitFor(() => expect(delivered.size).toBe(3));
            const differentOutput = await generate('new-output', { outputs: ['walkthrough'] });
            expect(differentOutput.resultId).not.toBe(left.resultId);
            await vi.waitFor(() => expect(delivered.size).toBe(4));
            failProvision = true;
            const failed = await generate('failed-provision', { cachePolicy: { mode: 'bypass' } });
            await vi.waitFor(() => expect(runs.get(failed.runId!)?.status).toBe('failed'));
            const retainedFailure = await generate('observe-failure');
            expect(retainedFailure).toMatchObject({ resultId: failed.resultId, runId: failed.runId });
            expect(delivered.size).toBe(4);
            failProvision = false;
            const retried = await generate('explicit-retry', { cachePolicy: { mode: 'bypass' } });
            expect(retried.runId).not.toBe(failed.runId);
            await vi.waitFor(() => expect(delivered.size).toBe(5));
            modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
            const cancelled = await generate('cancelled-run', { cachePolicy: { mode: 'bypass' } });
            await vi.waitFor(() => expect(delivered.size).toBe(6));
            expect(await stopExecutionRun({ runId: cancelled.runId!, runs, controllers, voiceAgentManager,
                getNowMs: Date.now, finishRun })).toEqual({ ok: true });
            expect(runs.get(cancelled.runId!)?.status).toBe('cancelled');
            const retainedCancellation = await generate('observe-cancellation');
            expect(retainedCancellation).toMatchObject({ resultId: cancelled.resultId, runId: cancelled.runId });
            expect(delivered.size).toBe(6);
            releaseModel();
            const cancellationRetry = await generate('explicit-cancellation-retry', { cachePolicy: { mode: 'bypass' } });
            expect(cancellationRetry.runId).not.toBe(cancelled.runId);
            await vi.waitFor(() => expect(delivered.size).toBe(7));
        } finally {
            releaseModel();
            await Promise.all([...controllers.values()].map(async controller => {
                if (controller.kind === 'backend') { await controller.provisioningPromise; await controller.backend.dispose(); }
            }));
            await voiceAgentManager.dispose();
        }
    });
});
