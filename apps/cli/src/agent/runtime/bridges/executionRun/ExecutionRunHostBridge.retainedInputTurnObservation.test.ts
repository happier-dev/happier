import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentStaticModels } from '@happier-dev/agents';

import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunAdmittedPendingInputV1 } from '@/api/session/client/transport/sessionClientInteractionApi';
import type { ExecutionRunState } from './executionRunTypes';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import { createExactTurnUsageAccumulator } from '@/usage/exactTurnUsage';
import { ScmComparisonSchema, readActionCompletionRunObservationV1, ExecutionRunGetResponseSchema } from '@happier-dev/protocol';
import { startExecutionRun } from './startExecutionRun';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import { createExecutionRunRpcActionDeps } from '@/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction';
import { finishExecutionRun } from './finishExecutionRun';
import { ScmDiffSummaryProfile } from './kinds/scmDiffSummary/ScmDiffSummaryProfile';
import { readOrCreateSavedScmResult } from './kinds/scmDiffSummary/publishSavedScmDiffSummaryTurn';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';

const TEST_BACKEND_ID = `${'test'}.${'agent'}` as never;

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
    return createBundledPluginPublicationFsFixture(actual);
});
beforeEach(() => {
    vi.stubEnv('HAPPIER_CLAUDE_PATH', process.execPath);
    vi.stubEnv('HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED', '0');
});
afterEach(() => vi.unstubAllEnvs());

type RuntimeEvent = Parameters<NonNullable<ExecutionRunBackendController['backend']['subscribeRuntimeEvents']>>[0] extends (
    event: infer E,
) => void ? E : never;

/**
 * A Session-owned retained Run composed through the bridge's real retained
 * attachment: the canonical occurrence witness registration, retained input
 * delivery and public-state projection are all production code. Only the
 * provider runtime (its event stream) and the parent Session's Pending transport
 * are boundaries.
 */
function composeRetainedRun(admissionFailure?: 'rejected' | 'outcomeUnknown') {
    const admittedParts: { text: string; localId: string }[] = [];
    const runtimeLifetime = new AbortController();
    let emit: ((event: RuntimeEvent) => void) | null = null;
    const controller = {
        kind: 'backend',
        controllerOccurrenceId: 'retained-occurrence-1',
        backend: {
            interaction: {
                kind: 'retained_agent_session.v1',
                capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
            },
            deliverInput: async () => ({ status: 'admitted' as const }),
            subscribeRuntimeEvents: (handler: (event: RuntimeEvent) => void) => {
                emit = handler;
                return () => { emit = null; };
            },
            getRuntimeLifetimeSignal: () => runtimeLifetime.signal,
            subscribeMessages: () => () => undefined,
            readResumeSupport: async () => true,
            provisionRuntime: async () => ({ runtimeId: 'provider-session-1' }),
            cancel: async () => undefined,
            dispose: async () => undefined,
        },
        backendSupportsResume: true,
        runtimeId: 'provider-session-1',
        buffer: '',
        sidechainStreamBuffer: '',
        sidechainStreamKey: '',
        streamWriter: null,
        cancelled: false,
        turnCount: 0,
        turnEpoch: 0,
        turnInFlight: false,
        turnCancelReason: null,
        turnCancelEpoch: null,
        admittedLiveInterventions: [],
        admittedLiveInterventionsSignal: null,
        lastMarkerWriteAtMs: 0,
        terminalPromise: Promise.resolve(),
        resolveTerminal: () => undefined,
    } as unknown as ExecutionRunBackendController;
    const manager = new ExecutionRunHostBridge({
        parentProvider: TEST_BACKEND_ID,
        cwd: '/repo',
        sendAcp: async () => undefined,
        sessionInteractionHost: {
            session: {
                sessionId: 'session-1',
                enqueueSessionUserMessageWithDisposition: async (input: { text: string; localId: string }) => {
                    admittedParts.push(input);
                    if (admissionFailure && admittedParts.length > 1) return { status: admissionFailure, code: 'admission_boundary_failure' };
                    return { status: 'accepted' as const, localId: input.localId };
                },
                getMetadataSnapshot: () => null,
                updateMetadata: vi.fn(),
                updateAgentState: vi.fn(),
                enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
                bindExecutionRunPendingInput: (_binding: { consume: (input: ExecutionRunAdmittedPendingInputV1) => boolean }) => ({
                    getMetadataSnapshot: () => null,
                    waitForMetadataUpdate: async () => await new Promise<boolean>(() => undefined),
                    shouldAttemptPendingMaterialization: () => false,
                    reconcilePendingProviderInputCustodyBeforeMaterialization: async () => true,
                    materializeNextPendingMessageSafely: async () => ({ type: 'no_pending' as const }),
                    observeProviderInputSettlement: async () => true,
                    readDurableProviderInputAcceptanceV1: async () => 'unknown' as const,
                    dispose: () => undefined,
                }),
            },
            machineId: 'machine-1',
            permissionHandler: { handleToolCall: vi.fn() },
        },
    } as ConstructorParameters<typeof ExecutionRunHostBridge>[0]);
    const internals = manager as unknown as {
        runs: Map<string, ExecutionRunState>;
        controllers: Map<string, ExecutionRunBackendController>;
        attachRetainedRunSessionInput(input: {
            runId: string; sidechainId: string; controller: ExecutionRunBackendController;
        }): { release(): Promise<void> } | null;
    };
    internals.runs.set('run-1', {
        runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1', sessionId: 'session-1', depth: 0,
        intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
        backendId: TEST_BACKEND_ID, instructions: 'Continue.', permissionMode: 'read_only',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
    } as ExecutionRunState);
    internals.controllers.set('run-1', controller);
    const attachment = internals.attachRetainedRunSessionInput({ runId: 'run-1', sidechainId: 'sidechain-1', controller });
    const emitRuntimeEvent = (event: Record<string, unknown>) => {
        if (!emit) throw new Error('retained delivery did not subscribe to runtime events');
        emit(event as RuntimeEvent);
    };
    const prepareScmInput = async (localId: string) => {
        let run = internals.runs.get('run-1')!;
        const input = run.intentInput && typeof run.intentInput === 'object' ? run.intentInput as Record<string, unknown> : {};
        if (run.intent !== 'scm_diff_summary' || !ScmComparisonSchema.safeParse(input.comparison).success) return;
        // This synthetic runtime event fixture does not run prepareStart or
        // Pending delivery. Exercise their real saved-state admission here.
        if (!input.resultId) {
            const saved = await readOrCreateSavedScmResult(run, run.structuredMeta?.payload);
            run = { ...run, intentInput: { ...input, resultId: saved.result.resultId } };
            const initial = await ScmDiffSummaryProfile.onStarted?.({ start: run, rawText: '', finishedAtMs: 1 });
            run = { ...run, structuredMeta: initial?.structuredMeta, latestToolResult: initial?.toolResultOutput };
            internals.runs.set('run-1', run);
        }
        await ScmDiffSummaryProfile.onBeforeRetainedInput?.({ start: run, localId });
    };
    const acceptInput = async (localId: string, turnId: string) => {
        await prepareScmInput(localId);
        emitRuntimeEvent({ kind: 'input-accepted', sessionId: 'session-1', sequence: 1, emittedAtMs: 1,
            inputIds: [localId], delivery: { kind: 'newTurn', turnId } });
    };
    return { manager, internals, attachment, emitRuntimeEvent, acceptInput, prepareScmInput, runtimeLifetime, admittedParts };
}

describe('ExecutionRunHostBridge retained exact input observation', () => {
    it('uses the admitted initial basis for optional-ID completion and never lets an old controller resurrect a replacement', async () => {
        const { internals, attachment, emitRuntimeEvent, prepareScmInput } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        const comparison = ScmComparisonSchema.parse({ id: 'optional-id-comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [] } });
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'scm_diff_summary', intentInput: {
            source: comparison.source, comparison, outputs: ['walkthrough'], sourceKey: comparison.id,
            metadata: { source: comparison.source, sourceKey: comparison.id },
        } });
        try {
            await prepareScmInput('initial:run-1');
            const scope = { cwd: '/repo', sessionId: 'session-1',
                resultId: (internals.runs.get('run-1')!.intentInput as { resultId: string }).resultId };
            emitRuntimeEvent({ kind: 'turn-start', turnId: 'initial-native', emittedAtMs: 2 });
            controller.buffer = JSON.stringify({ walkthrough: { title: 'Initial reading', intro: '', stops: [], otherChangeRefs: [] } });
            emitRuntimeEvent({ kind: 'turn-complete', turnId: 'initial-native', emittedAtMs: 3 });
            await controller.pendingHostBarrier;
            const first = await scmDiffSummaryResultStore.read(scope);
            if (!first.success) throw new Error(first.error);
            expect(first.result.output.outputs?.walkthrough?.value?.title).toBe('Initial reading');
            const replacement = await scmDiffSummaryResultStore.bindRun({ ...scope, expectedRevision: first.result.revision, runId: 'new-run' });
            if (!replacement.success) throw new Error(replacement.error);
            const manual = await scmDiffSummaryResultStore.edit({ ...scope, expectedRevision: replacement.result.revision,
                edit: { kind: 'renameWalkthrough', title: 'New manual title' } });
            if (!manual.success) throw new Error(manual.error);
            const published = internals.runs.get('run-1')!.structuredMeta;
            emitRuntimeEvent({ kind: 'turn-start', turnId: 'late-old-native', emittedAtMs: 4 });
            controller.buffer = JSON.stringify({ walkthrough: { title: 'Old controller overwrite', intro: '', stops: [], otherChangeRefs: [] } });
            emitRuntimeEvent({ kind: 'turn-complete', turnId: 'late-old-native', emittedAtMs: 5 });
            await controller.pendingHostBarrier;
            expect(internals.runs.get('run-1')!.structuredMeta).toEqual(published);
            expect(await scmDiffSummaryResultStore.read(scope)).toMatchObject({ success: true, result: {
                revision: manual.result.revision, output: { runId: 'new-run', outputs: { walkthrough: { value: { title: 'New manual title' } } } },
            } });
        } finally { await attachment?.release(); }
    });
    it('observes a findings-only completed review through the real raw host result and RPC projection', async () => {
        const { manager, internals, attachment, emitRuntimeEvent, acceptInput } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'review',
            intentInput: { reviewedFingerprint: 'actual-review-basis' } });
        try {
            await acceptInput('review-input', 'review-turn');
            controller.buffer = JSON.stringify({ summary: 'No findings', findings: [] });
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 2, emittedAtMs: 2, turnId: 'review-turn' });
            await controller.pendingHostBarrier;
            const published = internals.runs.get('run-1')!;
            await finishExecutionRun({ runId: 'run-1', next: { status: 'succeeded', finishedAtMs: 3 },
                toolResult: { output: published.latestToolResult }, structuredMeta: published.structuredMeta,
                runs: internals.runs, controllers: internals.controllers, budgetRegistry: null, parentProvider: TEST_BACKEND_ID,
                sendAcp: async () => undefined,
                // Durable filesystem/Session transport are boundaries; terminal materialization remains real.
                enqueueMarkerWrite: async () => undefined, terminalMarkerWritePromises: new Map(),
            });
            const rpc = createExecutionRunRpcActionDeps({ manager, context: { sessionId: 'session-1', cwd: '/repo' },
                isExecutionRunsEnabled: () => true, policy: { maxConcurrentRuns: null, boundedTimeoutMs: null,
                    reviewBoundedTimeoutMs: null, maxTurns: null, allowIoModes: new Set(['streaming', 'request_response']) } });
            const snapshot = ExecutionRunGetResponseSchema.parse(await rpc.executionRunGet!('session-1', { runId: 'run-1', includeStructured: true }));
            expect(snapshot.latestToolResult).toMatchObject({ findings: [], reviewedFingerprint: 'actual-review-basis' });
            expect(readActionCompletionRunObservationV1(snapshot)).toMatchObject({ kind: 'completed',
                reviewedFingerprint: 'actual-review-basis', materialization: { kind: 'complete' }, result: { findings: [] } });
        } finally { await attachment?.release(); }
    });
    it('projects failed comment materialization on retained review findings before any narration', async () => {
        const { internals, attachment, emitRuntimeEvent, acceptInput } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'review',
            intentInput: { reviewedFingerprint: 'captured-review-basis' } });
        try {
            await acceptInput('review-input', 'review-turn');
            controller.buffer = JSON.stringify({ summary: 'One finding', findings: [
                { id: 'f1', title: 'Issue', severity: 'high', category: 'correctness', summary: 'Issue' },
            ] });
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 2, emittedAtMs: 2, turnId: 'review-turn' });
            await controller.pendingHostBarrier;
            expect(internals.runs.get('run-1')).toMatchObject({ status: 'running',
                error: { code: 'review_comment_materialization_failed' }, structuredMeta: { kind: 'review_findings.v2', payload: {
                    reviewedFingerprint: 'captured-review-basis', commentIds: [], materialization: { kind: 'failed' },
                    materializationFailures: [{ findingId: 'f1', errorCode: 'review_comment_materialization_unavailable' }],
                    findings: [{ id: 'f1' }],
                } } });
        } finally { await attachment?.release(); }
    });
    it('observes walkthrough completion through publication while the retained Run stays running', async () => {
        const { manager, internals, attachment, emitRuntimeEvent, acceptInput } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        const comparison = ScmComparisonSchema.parse({ id: 'comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [] } });
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'scm_diff_summary', intentInput: {
            source: comparison.source, comparison, outputs: ['walkthrough'], sourceKey: comparison.id,
            metadata: { source: comparison.source, sourceKey: comparison.id },
        } });
        const rpc = createExecutionRunRpcActionDeps({ manager, context: { sessionId: 'session-1', cwd: '/repo' },
            isExecutionRunsEnabled: () => true, policy: { maxConcurrentRuns: null, boundedTimeoutMs: null,
                reviewBoundedTimeoutMs: null, maxTurns: null, allowIoModes: new Set(['streaming', 'request_response']) } });
        const observed = rpc.executionRunGet!('session-1', { runId: 'run-1', includeStructured: true,
            waitForOutput: { kind: 'review_walkthrough', comparisonId: comparison.id } });
        try {
            await acceptInput('execution-run-initial:run-1', 'walkthrough-turn');
            controller.buffer = JSON.stringify({ walkthrough: { title: 'Explanation', intro: 'Captured comparison', stops: [], otherChangeRefs: [] } });
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 2, emittedAtMs: 2, turnId: 'walkthrough-turn' });
            expect(await observed).toMatchObject({ structuredMeta: { payload: { outputs: { walkthrough: { state: 'complete' } } } } });
            expect(manager.get('run-1')).toMatchObject({ status: 'running', structuredMeta: { payload: { outputs: { walkthrough: { state: 'complete' } } } } });
        } finally { await attachment?.release(); }
    });
    it.each(['native-failure', 'malformed-model'] as const)('settles prior admission uncertainty after current %s publishes failed walkthrough output', async (failure) => {
        const { manager, internals, attachment, emitRuntimeEvent, acceptInput } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        const comparison = ScmComparisonSchema.parse({ id: 'comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [] } });
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'scm_diff_summary',
            error: { code: 'execution_run_send_outcome_unknown', message: 'Admission response was lost' },
            intentInput: { source: comparison.source, comparison, outputs: ['walkthrough'], sourceKey: comparison.id,
                metadata: { source: comparison.source, sourceKey: comparison.id } } });
        const rpc = createExecutionRunRpcActionDeps({ manager, context: { sessionId: 'session-1', cwd: '/repo' },
            isExecutionRunsEnabled: () => true, policy: { maxConcurrentRuns: null, boundedTimeoutMs: null,
                reviewBoundedTimeoutMs: null, maxTurns: null, allowIoModes: new Set(['streaming', 'request_response']) } });
        try {
            await acceptInput('execution-run-initial:run-1', 'settled-turn');
            if (failure === 'native-failure') {
                emitRuntimeEvent({ kind: 'turn-failed', sessionId: 'session-1', sequence: 2, emittedAtMs: 2,
                    turnId: 'settled-turn', diagnostic: { code: 'native_generation_failed', message: 'Native generation failed', severity: 'error' } });
            } else {
                controller.buffer = 'This turn did not return structured output.';
                emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 2, emittedAtMs: 2, turnId: 'settled-turn' });
            }
            await controller.pendingHostBarrier;
            const snapshot = ExecutionRunGetResponseSchema.parse(await rpc.executionRunGet!('session-1', { runId: 'run-1', includeStructured: true }));
            expect(snapshot).toMatchObject({ run: { status: 'running' }, latestToolResult: { outputs: { walkthrough: { state: 'failed' } } },
                structuredMeta: { payload: { outputs: { walkthrough: { state: 'failed' } } } } });
            expect(snapshot.run.error).toBeUndefined();
            expect(readActionCompletionRunObservationV1(snapshot, { kind: 'review_walkthrough', comparisonId: comparison.id }))
                .toMatchObject({ kind: 'completed', result: { outputs: { walkthrough: { state: 'failed' } } } });
            expect(internals.controllers.get('run-1')).toBe(controller);
        } finally { await attachment?.release(); }
    });
    it('provisions a deferred SCM narrator without admitting its prepared initial prompt', async () => {
        const { manager, internals, attachment, admittedParts } = composeRetainedRun();
        const runtime = internals.controllers.get('run-1')!.backend;
        const comparison = ScmComparisonSchema.parse({ id: 'deferred-comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [{
                path: 'a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
                evidence: { state: 'available', unifiedDiff: '@@ -1 +1 @@\n-a\n+b\n' },
                occurrences: [{ id: 'change-1', alias: 'c1', path: 'a.ts', position: 0,
                    before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }],
            }] } });
        const started = await startExecutionRun({ params: { sessionId: 'session-1', intent: 'scm_diff_summary',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, modelId: getAgentStaticModels('claude', { catalogOnly: true })[0]!.id,
            instructions: 'Prepared narration must wait for all review engines.',
            initialInput: { kind: 'deferred_session_pending' },
            intentInput: { comparison, outputs: ['walkthrough'], metadata: { source: comparison.source, sourceKey: comparison.id },
                scmAnalysis: { phase: 'evidence', current: ['change-1'], pending: [], parts: [], supplied: [], analysed: [],
                    failures: [], failedRefs: [], admitted: 0, completed: 0, totalParts: 1 } },
            permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming' },
            parentProvider: 'claude', sendAcp: async () => undefined, streamedTranscriptSession: null, createRuntime: () => runtime,
            getNowMs: () => 1, budgetRegistry: null, runs: internals.runs, controllers: internals.controllers,
            enqueueMarkerWrite: async () => undefined, writeActivityMarker: async () => undefined,
            finishRun: async () => undefined, executeBoundedRun: async () => undefined, send: async () => ({ ok: true }),
            voiceAgentManager: new VoiceAgentManager({ createRuntime: () => runtime }),
            enqueueRetainedRunInitialInput: async ({ text, localId }) => { admittedParts.push({ text, localId }); return { status: 'accepted', localId }; },
            attachRetainedRunSessionInput: () => ({ release: async () => undefined, awaitInputAdmission: async () => 'accepted' }),
        });
        const controller = internals.controllers.get(started.runId)!;
        try {
            await controller.provisioningPromise;
            expect(controller.runtimeId).toBe('provider-session-1');
            expect(admittedParts).toEqual([]);
            expect(internals.runs.get(started.runId)?.structuredMeta?.payload).toMatchObject({ analysis: { parts: { admitted: 0, total: 1 } } });
            expect(internals.runs.get(started.runId)).toMatchObject({ runClass: 'long_lived', status: 'running' });
        } finally { await manager.dispose(); await attachment?.release(); }
    });
    it('publishes failed requested output when initial generation completes with malformed prose and preserves it through later discussion', async () => {
        const { internals, attachment, emitRuntimeEvent, acceptInput } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        const comparison = ScmComparisonSchema.parse({ id: 'comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [] } });
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'scm_diff_summary', intentInput: {
            source: comparison.source, comparison, outputs: ['summary'], metadata: { source: comparison.source, sourceKey: comparison.id },
            sourceKey: comparison.id,
        } });
        try {
            await acceptInput('execution-run-initial:run-1', 'initial-generation');
            controller.buffer = 'I did not provide the requested structured result.';
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 2, emittedAtMs: 2, turnId: 'initial-generation' });
            await controller.pendingHostBarrier;
            expect(internals.runs.get('run-1')).toMatchObject({ status: 'running', structuredMeta: { payload: {
                success: false, comparison, outputs: { summary: { state: 'failed' } },
            } } });
            const saved = internals.runs.get('run-1')?.structuredMeta;
            await acceptInput('discussion', 'later-discussion');
            controller.buffer = 'Ordinary later discussion.';
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 3, emittedAtMs: 3, turnId: 'later-discussion' });
            await controller.pendingHostBarrier;
            expect(internals.runs.get('run-1')?.structuredMeta).toEqual(saved);
        } finally { await attachment?.release(); }
    });
    it.each(['complete', 'malformed-fragment'] as const)('partitions a single rejected occurrence at content boundaries with honest %s coverage', async (outcome) => {
        const { internals, attachment, emitRuntimeEvent, acceptInput, admittedParts } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        const diff = '@@ -1,2 +1,2 @@\n-old-a\n+new-a😀\n-old-b\n+new-b😀\n';
        const comparison = ScmComparisonSchema.parse({ id: 'comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [{
                path: 'a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
                evidence: { state: 'available', unifiedDiff: diff }, occurrences: [{ id: 'change-0', alias: 'c1', path: 'a.ts', position: 0,
                    before: { startLine: 1, lineCount: 2 }, after: { startLine: 1, lineCount: 2 } }],
            }] } });
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'scm_diff_summary', intentInput: {
            source: comparison.source, sourceKey: comparison.id, comparison, outputs: ['summary'],
            metadata: { source: comparison.source, sourceKey: comparison.id },
        } });
        try {
            await acceptInput('full-evidence', 'full-turn');
            emitRuntimeEvent({ kind: 'turn-failed', sessionId: 'session-1', sequence: 2, emittedAtMs: 2,
                turnId: 'full-turn', diagnostic: { code: 'agent_context_window_exceeded', severity: 'error' } });
            await controller.pendingHostBarrier;
            expect(admittedParts).toHaveLength(1);
            for (const index of [0, 1, 2]) {
                await acceptInput(admittedParts[index]!.localId, `fragment-${index}`);
                controller.buffer = outcome === 'malformed-fragment' && index === 0
                    ? 'A malformed completed fragment response.' : JSON.stringify({ summaryMarkdown: `Usable fragment ${index}` });
                emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: index + 3, emittedAtMs: index + 3,
                    turnId: `fragment-${index}` });
                await controller.pendingHostBarrier;
                if (index === 0) expect(internals.runs.get('run-1')?.structuredMeta).toMatchObject({ payload: {
                    analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: ['change-0'] } } });
            }
            expect(admittedParts).toHaveLength(3);
            expect(admittedParts.slice(0, 2).map((part) => part.text).join('')).toContain('+new-a😀');
            expect(admittedParts.slice(0, 2).map((part) => part.text).join('')).toContain('+new-b😀');
            expect(internals.runs.get('run-1')?.structuredMeta).toMatchObject({ payload: {
                outputs: { summary: { state: outcome === 'complete' ? 'complete' : 'partial' } }, analysis: {
                    suppliedChangeRefs: ['change-0'], analysedChangeRefs: outcome === 'complete' ? ['change-0'] : [],
                    remainingChangeRefs: outcome === 'complete' ? [] : ['change-0'],
                } } });
        } finally { await attachment?.release(); }
    });
    it.each(['rejected', 'outcomeUnknown'] as const)('preserves usable parts after %s continuation admission without poisoning lifecycle custody', async (failure) => {
        const { manager, internals, attachment, emitRuntimeEvent, acceptInput, admittedParts } = composeRetainedRun(failure);
        const controller = internals.controllers.get('run-1')!;
        const comparison = ScmComparisonSchema.parse({ id: 'comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [],
                files: ['a.ts', 'b.ts'].map((path, index) => ({ path, changeKind: 'modified', binary: false,
                    generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: `@@ -1 +1 @@\n-old\n+new-${path}\n` },
                    occurrences: [{ id: `change-${index}`, alias: `c${index + 1}`, path, position: 0,
                        before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }],
                })),
            } });
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'scm_diff_summary', intentInput: {
            source: comparison.source, sourceKey: comparison.id, comparison, outputs: ['summary'],
            metadata: { source: comparison.source, sourceKey: comparison.id },
        } });
        try {
            await acceptInput('full-evidence', 'full-turn');
            emitRuntimeEvent({ kind: 'turn-failed', sessionId: 'session-1', sequence: 2, emittedAtMs: 2,
                turnId: 'full-turn', diagnostic: { code: 'agent_context_window_exceeded', severity: 'error' } });
            await controller.pendingHostBarrier;
            await acceptInput(admittedParts[0]!.localId, 'part-a');
            controller.buffer = JSON.stringify({ summaryMarkdown: 'Usable part a' });
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 3, emittedAtMs: 3, turnId: 'part-a' });
            await expect(controller.pendingHostBarrier).resolves.toBeUndefined();
            expect(admittedParts).toHaveLength(2);
            expect(internals.runs.get('run-1')).toMatchObject({ status: 'running',
                error: { code: failure === 'outcomeUnknown' ? 'execution_run_send_outcome_unknown' : 'admission_boundary_failure' },
                structuredMeta: { payload: { summaryMarkdown: 'Usable part a', outputs: { summary: { state: failure === 'outcomeUnknown' ? 'writing' : 'partial' } },
                    analysis: { analysedChangeRefs: ['change-0'], remainingChangeRefs: ['change-1'] } } } });
            expect(internals.controllers.get('run-1')).toBe(controller);
            if (failure === 'outcomeUnknown') await manager.waitForOutput('run-1', { kind: 'review_walkthrough', comparisonId: comparison.id });
        } finally { await attachment?.release(); }
    });
    it.each(['ready', 'stopped-during-publication'] as const)('publishes a validated cache result without an unnecessary initial input and preserves %s attachment lifecycle', async (outcome) => {
        const { manager, internals, attachment, admittedParts } = composeRetainedRun();
        const readyArtifacts: unknown[] = [];
        const runtime = internals.controllers.get('run-1')!.backend;
        const voiceAgentManager = new VoiceAgentManager({ createRuntime: () => runtime });
        const comparison = ScmComparisonSchema.parse({ id: 'cached-comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [] } });
        const cachedOutput = { success: true, sourceKey: comparison.id, comparison, summaryMarkdown: 'Saved explanation.',
            requestedOutputs: ['summary'], outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Saved explanation.' } } },
            analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
            metadata: { source: comparison.source, sourceKey: comparison.id } };
        const started = await startExecutionRun({ params: { sessionId: 'session-1', intent: 'scm_diff_summary',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, modelId: getAgentStaticModels('claude', { catalogOnly: true })[0]!.id, instructions: '',
            intentInput: { cachedOutput, comparison, outputs: ['summary'], metadata: cachedOutput.metadata }, permissionMode: 'read_only', retentionPolicy: 'resumable',
            runClass: 'long_lived', ioMode: 'streaming' }, parentProvider: 'claude', sendAcp: async (_provider, event) => {
                if (event.type === 'message' && outcome === 'stopped-during-publication') {
                    const run = [...internals.runs.values()].find((run) => run.sidechainId === event.sidechainId);
                    if (run) await manager.stop(run.runId);
                }
            },
            streamedTranscriptSession: null, createRuntime: () => runtime, getNowMs: () => 2,
            budgetRegistry: null, runs: internals.runs, controllers: internals.controllers,
            enqueueMarkerWrite: async (_id, write) => { await write(); }, writeActivityMarker: async () => {},
            finishRun: async (id, next) => { const run = internals.runs.get(id); if (run) internals.runs.set(id, { ...run, ...next }); },
            executeBoundedRun: async () => { throw new Error('Unexpected bounded analysis'); },
            send: async () => { throw new Error('Unexpected initial model input'); },
            attachRetainedRunSessionInput: (params) => {
                readyArtifacts.push(internals.runs.get(params.runId)?.structuredMeta);
                const attached = internals.attachRetainedRunSessionInput(params);
                return attached ? { ...attached, awaitInputAdmission: async () => 'accepted' as const } : null;
            }, voiceAgentManager });
        try {
            await internals.controllers.get(started.runId)?.provisioningPromise;
            if (outcome === 'stopped-during-publication') {
                expect(internals.runs.get(started.runId)?.status).toBe('cancelled');
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                expect(readyArtifacts).toEqual([]);
                expect(admittedParts).toEqual([]);
                return;
            }
            expect(internals.runs.get(started.runId)).toMatchObject({ status: 'running',
                structuredMeta: { kind: 'scm_diff_summary.v1', payload: { summaryMarkdown: 'Saved explanation.' } } });
            expect(internals.controllers.get(started.runId)).toMatchObject({ runtimeId: 'provider-session-1', turnCount: 0 });
            expect(admittedParts).toEqual([]);
            expect(readyArtifacts).toMatchObject([{ payload: { summaryMarkdown: 'Saved explanation.' } }]);
        } finally {
            for (const controller of internals.controllers.values()) await controller.releaseSessionInputAttachment?.();
            await attachment?.release();
            await voiceAgentManager.dispose();
        }
    });

    it('never invents a capacity retry from an unclassified failure or a cancelled controller', async () => {
        const { internals, attachment, emitRuntimeEvent, acceptInput, admittedParts } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'scm_diff_summary', intentInput: {
            source: { kind: 'workingTree' }, metadata: { source: { kind: 'workingTree' }, sourceKey: 'test' },
        } });
        try {
            await acceptInput('unknown-input', 'unknown-turn');
            emitRuntimeEvent({ kind: 'turn-failed', sessionId: 'session-1', sequence: 2, emittedAtMs: 2,
                turnId: 'unknown-turn', diagnostic: { code: 'unknown', severity: 'error' } });
            await controller.pendingHostBarrier;
            await acceptInput('cancelled-input', 'cancelled-turn');
            controller.cancelled = true;
            emitRuntimeEvent({ kind: 'turn-failed', sessionId: 'session-1', sequence: 3, emittedAtMs: 3,
                turnId: 'cancelled-turn', diagnostic: { code: 'agent_context_window_exceeded', severity: 'error' } });
            await controller.pendingHostBarrier;
            expect(admittedParts).toEqual([]);
        } finally { await attachment?.release(); }
    });

    it('partitions native-rejected evidence through new admissions on the same retained run and publishes integrated output', async () => {
        const { internals, attachment, emitRuntimeEvent, acceptInput, admittedParts } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        const comparison = ScmComparisonSchema.parse({ id: 'comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [],
                files: ['a.ts', 'b.ts'].map((path, index) => ({ path, changeKind: 'modified', binary: false,
                    generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: `@@ -1 +1 @@\n-old-${path}\n+new-${path}\n` },
                    occurrences: [{ id: `change-${index}`, alias: `c${index + 1}`, path, position: 0,
                        before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }],
                })),
            } });
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'scm_diff_summary', intentInput: {
            source: comparison.source, sourceKey: comparison.id, comparison, outputs: ['summary'],
            metadata: { source: comparison.source, sourceKey: comparison.id },
        } });
        try {
            await acceptInput('full-evidence', 'full-turn');
            emitRuntimeEvent({ kind: 'turn-failed', sessionId: 'session-1', sequence: 2, emittedAtMs: 2,
                turnId: 'full-turn', diagnostic: { code: 'agent_context_window_exceeded', message: 'Context window exceeded', severity: 'error' } });
            await vi.waitFor(() => expect(admittedParts).toHaveLength(1));
            expect(controller.lastInputTurn).toMatchObject({ turnId: 'full-turn', state: 'failed' });
            expect(admittedParts[0]?.text).toContain('+new-a.ts');
            expect(admittedParts[0]?.text).not.toContain('+new-b.ts');
            // Discussion may already be queued ahead of the host-authored next part.
            const pendingPartCount = admittedParts.length;
            await acceptInput('human-discussion', 'discussion-between-parts');
            controller.buffer = 'An ordinary explanation while generation continues.';
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 3, emittedAtMs: 3,
                turnId: 'discussion-between-parts' });
            await controller.pendingHostBarrier;
            expect(admittedParts).toHaveLength(pendingPartCount);
            for (const [index, summary] of ['Part a', 'Part b', 'Integrated result'].entries()) {
                await acceptInput(admittedParts[index]!.localId, `part-${index}`);
                controller.buffer = JSON.stringify({ summaryMarkdown: summary });
                emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: index + 3,
                    emittedAtMs: index + 3, turnId: `part-${index}` });
                await controller.pendingHostBarrier;
                if (index === 0) expect(internals.runs.get('run-1')?.intentInput).toMatchObject({
                    scmAnalysis: { current: ['change-1'], analysed: ['change-0'] },
                });
                if (index < 2) expect(admittedParts).toHaveLength(index + 2);
            }
            expect(admittedParts).toHaveLength(3);
            expect(admittedParts[2]?.text).not.toContain('+new-a.ts');
            expect(internals.runs.get('run-1')).toMatchObject({ status: 'running', structuredMeta: {
                payload: { summaryMarkdown: 'Integrated result', outputs: { summary: { state: 'complete' } },
                    analysis: { suppliedChangeRefs: ['change-0', 'change-1'], analysedChangeRefs: ['change-0', 'change-1'], remainingChangeRefs: [] } },
            } });
            expect(internals.controllers.get('run-1')).toBe(controller);
            expect(controller.runtimeId).toBe('provider-session-1');
        } finally { await attachment?.release(); }
    });

    it('publishes each structured retained turn without finishing the generator or replacing it with ordinary prose', async () => {
        const { internals, attachment, emitRuntimeEvent, acceptInput } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        const run = internals.runs.get('run-1')!;
        const comparison = ScmComparisonSchema.parse({ id: 'turn-comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [] } });
        internals.runs.set('run-1', { ...run, intent: 'scm_diff_summary', intentInput: {
            comparison, outputs: ['summary'], source: comparison.source, sourceKey: comparison.id,
            metadata: { source: comparison.source, sourceKey: comparison.id },
        } });
        try {
            for (const [index, summary] of ['First part.', 'Integrated explanation.'].entries()) {
                const turnId = `summary-turn-${index}`;
                await acceptInput(`summary-input-${index}`, turnId);
                controller.buffer = JSON.stringify({ summaryMarkdown: summary });
                emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: index + 2,
                    emittedAtMs: index + 2, turnId });
                await vi.waitFor(() => expect(internals.runs.get('run-1')?.structuredMeta).toMatchObject({
                    kind: 'scm_diff_summary.v1', payload: { summaryMarkdown: summary },
                }));
                expect(internals.runs.get('run-1')?.status).toBe('running');
            }
            const previous = internals.runs.get('run-1')?.structuredMeta;
            await acceptInput('discussion-input', 'discussion-turn');
            controller.buffer = 'This is an ordinary answer about the code.';
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 5,
                emittedAtMs: 5, turnId: 'discussion-turn' });
            await controller.pendingHostBarrier;
            expect(internals.runs.get('run-1')?.structuredMeta).toEqual(previous);
            expect(internals.runs.get('run-1')?.status).toBe('running');
        } finally { await attachment?.release(); }
    });

    it('projects the exact native acceptance timestamp for a retained Workflow input', async () => {
        const { internals, attachment, emitRuntimeEvent } = composeRetainedRun();
        const controller = internals.controllers.get('run-1')!;
        const observations: unknown[] = [];
        controller.workflowObservation = {
            localInputId: 'workflow-retained', usage: createExactTurnUsageAccumulator(),
            sink: { commit: async (observation) => { observations.push(observation); } },
        };
        try {
            emitRuntimeEvent({ kind: 'input-accepted', sessionId: 'session-1', sequence: 1, emittedAtMs: 100,
                inputIds: ['unrelated-input'], delivery: { kind: 'newTurn', turnId: 'unrelated-turn' } });
            emitRuntimeEvent({ kind: 'input-accepted', sessionId: 'session-1', sequence: 2, emittedAtMs: 2_000,
                inputIds: ['workflow-retained'], delivery: { kind: 'newTurn', turnId: 'workflow-turn' } });
            await controller.pendingHostBarrier;
            expect(observations).toEqual([{ kind: 'input_accepted', runId: 'run-1',
                localInputId: 'workflow-retained', acceptedAtMs: 2_000 }]);
        } finally {
            await attachment?.release();
        }
    });

    it('observes a completed retained input under the same occurrence the public state exposes', async () => {
        const { manager, attachment, emitRuntimeEvent, acceptInput } = composeRetainedRun();
        try {
            await acceptInput('input-1', 'turn-1');
            let observed: unknown = 'pending';
            const waiting = manager.waitForInputTurn('run-1', 'input-1').then((value) => { observed = value; });
            await Promise.resolve();
            expect(observed).toBe('pending');
            emitRuntimeEvent({ kind: 'turn-complete', sessionId: 'session-1', sequence: 2, emittedAtMs: 2, turnId: 'turn-1' });
            await vi.waitFor(() => expect(observed).not.toBe('pending'), { timeout: 1_000 });
            await waiting;
            const publicTurns = manager.getPublic('run-1')?.inputTurns;
            expect(publicTurns).toMatchObject({
                occurrenceId: 'retained-occurrence-1',
                last: { turnId: 'turn-1', inputIds: ['input-1'], state: 'completed' },
            });
            // The blocking exact observation and the public state agree on one occurrence.
            expect(observed).toEqual({ occurrenceId: publicTurns?.occurrenceId, turn: publicTurns?.last });
        } finally {
            await attachment?.release();
        }
    });

    it('retains the cancelled retained input under the canonical occurrence when the Run is stopped', async () => {
        const { manager, internals, attachment, acceptInput } = composeRetainedRun();
        const comparison = ScmComparisonSchema.parse({ id: 'comparison', source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [] } });
        internals.runs.set('run-1', { ...internals.runs.get('run-1')!, intent: 'scm_diff_summary', intentInput: {
            comparison, sourceKey: comparison.id, metadata: { source: comparison.source, sourceKey: comparison.id }, outputs: ['summary', 'walkthrough'],
        }, structuredMeta: { kind: 'scm_diff_summary.v1', payload: { success: true, comparison, sourceKey: comparison.id,
            metadata: { source: comparison.source, sourceKey: comparison.id }, requestedOutputs: ['summary', 'walkthrough'],
            outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Retained completed output' } }, walkthrough: { state: 'writing' } },
            analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
        } } });
        try {
            await acceptInput('input-2', 'turn-2');
            expect(manager.getPublic('run-1')?.inputTurns).toMatchObject({
                occurrenceId: 'retained-occurrence-1',
                current: { turnId: 'turn-2', state: 'active' },
            });
            await manager.stop('run-1');
            expect(internals.controllers.has('run-1')).toBe(false);
            expect(internals.runs.get('run-1')?.structuredMeta).toMatchObject({ payload: { outputs: {
                summary: { state: 'complete', value: { summaryMarkdown: 'Retained completed output' } }, walkthrough: { state: 'cancelled' },
            } } });
            expect(internals.runs.get('run-1')?.inputTurns).toEqual({
                occurrenceId: 'retained-occurrence-1',
                last: { turnId: 'turn-2', inputIds: ['input-2'], state: 'cancelled' },
            });
            await expect(manager.waitForInputTurn('run-1', 'input-2')).resolves.toEqual({
                occurrenceId: 'retained-occurrence-1',
                turn: { turnId: 'turn-2', inputIds: ['input-2'], state: 'cancelled' },
            });
        } finally {
            await attachment?.release();
        }
    });
});
