import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reloadConfiguration } from '@/configuration';

import type { ExecutionRunState } from './executionRunTypes';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import type { AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';
import { createNativeAgentSessionInteractionHostRuntime } from './nativeAgentExecutionRun';
import { createVoiceSessionContextLease } from './testkit/nativeSessionContext';
import { captureScmComparison } from '@/scm/comparisons/captureScmComparison';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { buildReviewEngineInventoryItems } from '@/session/actions/inventory/buildReviewEngineInventoryItems';
import type { ExecutionRunAdmittedPendingInputV1, ExecutionRunPendingInputBinding } from '@/api/session/client/transport/sessionClientInteractionApi';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { SessionProviderInputOutcome } from '@/agent/runtime/session/input/providerInputOutcome';
import { ScmComparisonSchema, SessionInputAdmissionResultV1Schema, ScmDiffSummaryRefineInputSchema, ExecutionRunGetResponseSchema,
  type SessionInputAdmissionResultV1, type ScmActionExecute } from '@happier-dev/protocol';
import { getAgentStaticModels } from '@happier-dev/agents';
import { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';

const nativeOpen = vi.hoisted(() => vi.fn<(request: AgentSessionOpenRequest) => Promise<AgentSessionRuntime>>());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

vi.mock('./createExecutionRunBridgeRuntime', () => ({
  // The Agent process/SDK is external. Recovery, native adapter, lifecycle and persistence stay real.
  createExecutionRunBridgeRuntime: (options: CreateCliExecutionRunBackendParams) => createNativeAgentSessionInteractionHostRuntime({
    runtime: { sessions: { open: nativeOpen } }, options,
    lease: { pluginId: 'test.agent', pluginVersion: '1.0.0', agentId: 'test.agent', localAgentId: 'agent',
      occurrenceId: 'native-test-occurrence', isCurrent: () => true },
    sessionCapabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: false },
    createSessionContext: ({ services, signal }) => createVoiceSessionContextLease({ services, signal, async dispose() {} }),
  }),
}));

const TEST_BACKEND_ID = `${'test'}.${'agent'}` as never;
let directory: string;
const bridges: ExecutionRunHostBridge[] = [];
beforeEach(() => {
  nativeOpen.mockReset();
  directory = mkdtempSync(join(tmpdir(), 'happier-pending-target-'));
  vi.stubEnv('HAPPIER_HOME_DIR', directory);
  // Native startup is the mocked boundary; model admission uses the real offered catalog.
  vi.stubEnv('HAPPIER_CLAUDE_PATH', process.execPath);
  vi.stubEnv('HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED', '0');
  reloadConfiguration();
});
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((manager) => manager.dispose()));
  vi.unstubAllEnvs();
  reloadConfiguration();
  rmSync(directory, { recursive: true, force: true });
});

function runState(overrides: Partial<ExecutionRunState> = {}): ExecutionRunState {
  return {
    runId: 'run-1',
    callId: 'call-1',
    sidechainId: 'sidechain-1',
    sessionId: 'session-1',
    depth: 0,
    intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: TEST_BACKEND_ID },
    backendId: TEST_BACKEND_ID,
    instructions: 'Continue.',
    permissionMode: 'read_only',
    retentionPolicy: 'resumable',
    runClass: 'long_lived',
    ioMode: 'streaming',
    status: 'running',
    startedAtMs: 1,
    resumeHandle: {
      kind: 'provider_session.v1',
      backendTarget: { kind: 'backend', backendId: TEST_BACKEND_ID, sourceKind: 'built_in' },
      providerSessionId: 'provider-session-1',
    },
    ...overrides,
  };
}

function createHarness() {
  let consume: ExecutionRunPendingInputBinding['consume'] | undefined;
  const acceptedInputs = new Set<string>();
  const enqueueSessionUserMessageWithDisposition = vi.fn<(input: { text: string; localId: string }) => Promise<SessionInputAdmissionResultV1>>(
    async (input) => ({ status: 'accepted', localId: input.localId }));
  let observeFirstEnqueuedInput: () => void = () => undefined;
  const firstEnqueuedInput = new Promise<void>(resolve => { observeFirstEnqueuedInput = resolve; });
  const listExecutionRunPendingDeliveryStatuses = vi.fn(async () => [
    { localId: 'queued-1', status: 'queued' as const, deliveryStatus: { status: 'queued' as const } },
    { localId: 'blocked-1', status: 'blocked' as const, deliveryStatus: { status: 'blocked' as const, reason: 'session_input_target_unavailable' as const } },
  ]);
  const blockExecutionRunPendingDelivery = vi.fn(async () => true);
  const enqueueAgentMessageCommitted = vi.fn(async () => ({ persisted: true, delivered: false }));
  const manager = new ExecutionRunHostBridge({
    parentProvider: TEST_BACKEND_ID,
    cwd: process.cwd(),
    sendAcp: async () => {},
    sessionInteractionHost: {
      session: {
        sessionId: 'session-1',
        getMetadataSnapshot: () => null,
        updateMetadata: vi.fn(),
        updateAgentState: vi.fn(),
        enqueueAgentMessageCommitted,
        enqueueSessionUserMessageWithDisposition: async input => {
          const disposition = await enqueueSessionUserMessageWithDisposition(input);
          observeFirstEnqueuedInput();
          return disposition;
        },
        bindExecutionRunPendingInput: (binding: ExecutionRunPendingInputBinding) => {
          consume = input => {
            const admitted = binding.consume(input);
            binding.wake?.();
            return admitted;
          };
          return { getMetadataSnapshot: () => null, waitForMetadataUpdate: async () => await new Promise<boolean>(() => undefined),
            shouldAttemptPendingMaterialization: () => false, reconcilePendingProviderInputCustodyBeforeMaterialization: async () => true,
            materializeNextPendingMessageSafely: async () => ({ type: 'no_pending' as const }),
            observeProviderInputSettlement: async (outcome: SessionProviderInputOutcome) => {
              if (outcome.kind === 'accepted') acceptedInputs.add(outcome.localId);
              return true;
            },
            readDurableProviderInputAcceptanceV1: async (localId: string) => acceptedInputs.has(localId) ? 'accepted' as const : 'unknown' as const,
            dispose() {} };
        },
        listExecutionRunPendingDeliveryStatuses,
        blockExecutionRunPendingDelivery,
      },
      machineId: 'machine-1',
      permissionHandler: { handleToolCall: vi.fn() },
    },
  });
  bridges.push(manager);
  const runs = (manager as unknown as { runs: Map<string, ExecutionRunState> }).runs;
  const controllers = (manager as unknown as { controllers: Map<string, unknown> }).controllers;
  return {
    manager,
    runs,
    controllers,
    listExecutionRunPendingDeliveryStatuses,
    blockExecutionRunPendingDelivery,
    enqueueAgentMessageCommitted,
    enqueueSessionUserMessageWithDisposition,
    firstEnqueuedInput,
    consume: (input: ExecutionRunAdmittedPendingInputV1) => consume?.(input),
  };
}

describe('ExecutionRunHostBridge pending target recovery', () => {
  it('explains only exact current host findings in their matching saved stops after narration replaces the projection', async () => {
    const harness = createHarness();
    const comparison = ScmComparisonSchema.parse({ id: 'captured', source: { kind: 'workingTree' }, repository: { rootPath: directory },
      endpoints: {}, inventory: { state: 'complete', reasons: [], files: [{ path: 'new.ts', previousPath: 'old.ts', changeKind: 'renamed',
        binary: false, generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: '@@ -20,2 +10,2 @@' },
        occurrences: [{ id: 'change-1', alias: 'c1', path: 'new.ts', position: 0, before: { startLine: 20, lineCount: 2 }, after: { startLine: 10, lineCount: 2 } },
          { id: 'change-2', alias: 'c2', path: 'new.ts', position: 1, before: { startLine: 40, lineCount: 2 }, after: { startLine: 30, lineCount: 2 } }] }] } });
    const saved = await scmDiffSummaryResultStore.create({ cwd: directory, sessionId: 'session-1', output: { success: true,
      sourceKey: comparison.id, comparison, runId: 'run-1', metadata: { source: comparison.source, sourceKey: comparison.id }, requestedOutputs: ['walkthrough'],
      analysis: { suppliedChangeRefs: ['change-1', 'change-2'], analysedChangeRefs: ['change-1', 'change-2'], remainingChangeRefs: [] },
      outputs: { walkthrough: { state: 'complete', value: { title: 'Changes', intro: '', stops: [
        { id: 'target', title: 'Target', explanationMarkdown: 'Original', changeRefs: ['change-1'], findingRefs: ['run-1:f1'] },
        { id: 'unrelated', title: 'Keep me', explanationMarkdown: 'Unrelated prose', changeRefs: ['change-2'] }], otherChangeRefs: [] } } } } });
    const runRef = { runId: 'run-1', callId: 'call-1', backendId: TEST_BACKEND_ID };
    await scmDiffSummaryResultStore.beginInput({ cwd: directory, sessionId: 'session-1', resultId: saved.resultId,
      inputId: 'published-narration', outputs: ['walkthrough'], reviewFindingCitations: [{ alias: 'F1', runId: 'run-1', findingId: 'f1' }] });
    await scmDiffSummaryResultStore.abandonInput({ cwd: directory, sessionId: 'session-1', resultId: saved.resultId, inputId: 'published-narration' });
    const finding = { id: 'f1', title: 'Issue', category: 'correctness', severity: 'high', summary: 'Old diagnosis', filePath: 'new.ts', startLine: 10 };
    const review = runState({ intent: 'review', structuredMeta: { kind: 'scm_diff_summary.v1', payload: saved.output },
      intentInput: { comparisonId: comparison.id, reviewNarration: { reviewStatus: 'succeeded', reviewFindings: [{ runRef,
        summary: 'Findings', overviewMarkdown: 'Findings', findings: [finding], questions: [], assumptions: [], generatedAtMs: 1 }] } } });
    harness.runs.set('run-1', review);
    harness.runs.set('follow-up', { ...review, runId: 'follow-up', callId: 'follow-up-call', status: 'succeeded', structuredMeta: {
      kind: 'review_follow_up.v1', payload: { parentRunRef: runRef, threadId: 'thread', findingIds: ['f1'], requestMarkdown: 'Clarify',
        answerMarkdown: 'Clarified', generatedAtMs: 2, updatedFindings: [{ ...finding, summary: 'Current diagnosis' }] } } });
    const input = { reviewRunIds: ['run-1'], cwd: directory, resultId: saved.resultId, expectedRevision: saved.revision,
      findingIds: [{ runId: 'run-1', findingId: 'f1' }], instructions: 'Keep this human request unchanged.' };
    const acted = await harness.manager.applyAction('run-1', { actionId: 'review.explain_findings', input });
    expect(acted).toMatchObject({ ok: true, result: { refinement: { actionId: 'scm.diffSummary.refine', input: { output: 'walkthrough', stopIds: ['target'] } } } });
    expect(JSON.stringify(acted)).toContain('Current diagnosis');
    expect(JSON.stringify(acted)).not.toContain('Old diagnosis');
    if (!acted.ok) throw new Error('Finding explanation preparation failed');
    const refinement = ScmDiffSummaryRefineInputSchema.parse((acted.result as { refinement: { input: unknown } }).refinement.input);
    expect(refinement.instructions).toContain('"id":"F1"');
    expect(refinement.instructions).not.toContain('"id":"f1"');
    expect(refinement.instructions).toContain(input.instructions);
    expect(await harness.manager.applyAction('run-1', { actionId: 'review.explain_findings', input: { ...input,
      findingIds: [{ runId: 'foreign-run', findingId: 'f1' }] } })).toMatchObject({ ok: false, errorCode: 'review_finding_unmapped' });
    expect(await scmDiffSummaryResultStore.read({ cwd: directory, sessionId: 'session-1', resultId: saved.resultId })).toMatchObject({ success: true,
      result: { revision: saved.revision, output: { outputs: { walkthrough: { value: { stops: [{ id: 'target', explanationMarkdown: 'Original' },
        { id: 'unrelated', explanationMarkdown: 'Unrelated prose' }] } } } } } });
    let sent: { message: string; localId: string } | undefined;
    // RPC transport is the boundary; the generic Action's prompt, admission and saved writer remain real.
    const executeCanonicalAction: Parameters<ScmActionExecute>[0]['executeCanonicalAction'] = async (actionId, actionInput) => {
      if (actionId === 'execution.run.get') return { ok: true, result: ExecutionRunGetResponseSchema.parse({ run: {
        runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1', intent: 'review', status: 'running', startedAtMs: 1,
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only', retentionPolicy: 'resumable',
        runClass: 'long_lived', ioMode: 'streaming', lifecycle: { v: 1, state: 'current' },
        interaction: { kind: 'retained_agent_session.v1', capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } },
      } }) };
      if (actionId !== 'session.message.send') throw new Error('Explanation must target the saved generator');
      sent = actionInput as NonNullable<typeof sent>;
      return { ok: true, result: { status: 'accepted', localId: sent.localId } };
    };
    expect(await executeScmActionOperation({ actionId: 'scm.diffSummary.refine', input: refinement, workingDirectory: directory,
      sessionId: 'session-1', executeCanonicalAction, actionContext: { surface: 'rpc', authority: 'present_user' } }))
      .toMatchObject({ success: true, runId: 'run-1' });
    expect(sent?.message).toContain('"id":"F1"');
    expect(sent?.message).not.toContain('"id":"f1"');
    expect(await scmDiffSummaryResultStore.publish({ cwd: directory, sessionId: 'session-1', resultId: saved.resultId, inputId: sent!.localId,
      modelOutput: { reviewExplanations: [{ stopId: 'target', markdown: '[current](finding:F1)' }] } }))
      .toMatchObject({ success: true, result: { output: { outputs: { walkthrough: { value: { stops: [
        { explanationMarkdown: 'Original', reviewExplanations: [{ markdown: '[current](finding:run-1:f1)' }] },
        { id: 'unrelated', explanationMarkdown: 'Unrelated prose' },
      ] } } } } } });
  });
  it.each(['collect', 'cancel', 'rejected', 'outcomeUnknown'] as const)('returns one deferred narrator identity immediately and owns %s through its existing lifetime', async (outcome) => {
    nativeOpen.mockImplementation(async () => ({
      watch(next) { next({ kind: 'provider-session-id', providerSessionId: 'narrator-session', sequence: 1, sessionId: 'session-parent', emittedAtMs: 1 }); return { dispose() {} }; },
      async send() { return { status: 'admitted' as const }; }, async dispose() {},
    }));
    const harness = createHarness();
    const narrator = (await buildReviewEngineInventoryItems({})).find(item => item.backendId === 'claude' && item.enabled && item.capabilities.structuredNarration);
    expect(narrator).toBeDefined();
    const modelId = getAgentStaticModels('claude', { catalogOnly: true })[0]?.id;
    expect(modelId).toBeDefined();
    const captured = await captureScmComparison({ cwd: directory, source: { kind: 'workingTree' }, sessionId: 'session-1' });
    const finding = { id: 'finding-1', title: 'Original', severity: 'high', category: 'correctness', summary: 'Original diagnosis' };
    const review = runState({ intent: 'review', status: 'succeeded', runClass: 'bounded', retentionPolicy: 'ephemeral', finishedAtMs: 2,
      backendId: narrator!.backendId, backendTarget: { kind: 'builtInAgent', agentId: narrator!.backendId },
      launch: { cwd: directory, modelId },
      intentInput: { cwd: directory, comparisonId: captured.comparison.id },
      structuredMeta: { kind: 'review_findings.v2', payload: { runRef: { runId: 'run-1', callId: 'call-1', backendId: narrator!.backendId },
        summary: 'One finding', overviewMarkdown: 'Review completed.', findings: [finding], questions: [], assumptions: [], generatedAtMs: 2,
        reviewedFingerprint: 'host-reviewed-basis', commentIds: ['persisted-comment-1'], materialization: { kind: 'complete' } } } });
    harness.runs.set('run-1', review);
    harness.runs.set('run-2', { ...review, runId: 'run-2', callId: 'call-2', sidechainId: 'sidechain-2', status: 'running', structuredMeta: undefined });
    const acted = await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1', 'run-2'], comparisonId: captured.comparison.id, narrator: { engineId: narrator!.engineId },
      launchFailures: [{ engineId: 'failed-engine', errorCode: 'engine_unavailable', error: 'Engine never started' }],
    } });
    expect(acted, JSON.stringify(acted)).toMatchObject({ ok: true, result: { mode: 'seeded_narrator', state: 'collecting' } });
    if (!acted.ok) throw new Error('Narrator admission failed');
    const result = acted.result as { runId: string };
    await vi.waitFor(() => expect(nativeOpen).toHaveBeenCalledOnce());
    expect(harness.enqueueSessionUserMessageWithDisposition).not.toHaveBeenCalled();
    if (outcome === 'cancel') {
      await harness.manager.stop(result.runId);
      await harness.manager.stop('run-2');
      expect(harness.manager.get(result.runId)).toMatchObject({ status: 'cancelled' });
      expect(harness.enqueueSessionUserMessageWithDisposition).not.toHaveBeenCalled();
      expect(harness.manager.get('run-1')?.structuredMeta).toEqual(review.structuredMeta);
      return;
    }
    if (outcome === 'rejected' || outcome === 'outcomeUnknown') harness.enqueueSessionUserMessageWithDisposition.mockImplementation(async ({ localId }) => (
      SessionInputAdmissionResultV1Schema.parse(outcome === 'rejected'
        ? { status: 'rejected', code: 'session_input_target_unavailable' }
        : { status: 'outcomeUnknown', localId, code: 'narrator_transport_failure' })
    ));
    harness.runs.set('follow-up', { ...review, runId: 'follow-up', callId: 'follow-up-call', structuredMeta: {
      kind: 'review_follow_up.v1', payload: { parentRunRef: { runId: 'run-1', callId: 'call-1', backendId: narrator!.backendId }, threadId: 'thread-1',
        findingIds: ['finding-1'], requestMarkdown: 'Clarify', answerMarkdown: 'Latest answer', generatedAtMs: 3,
        updatedFindings: [{ ...finding, title: 'Current', summary: 'Current diagnosis' }] },
    } });
    await harness.manager.stop('run-2');
    await harness.firstEnqueuedInput;
    expect(harness.enqueueSessionUserMessageWithDisposition).toHaveBeenCalledOnce();
    if (outcome === 'rejected' || outcome === 'outcomeUnknown') {
      await vi.waitFor(() => expect(harness.manager.get(result.runId)).toMatchObject({ error: {
        code: outcome === 'outcomeUnknown' ? 'execution_run_send_outcome_unknown' : 'admission_failed' } }));
      if (outcome === 'rejected') await vi.waitFor(() => expect(harness.manager.get(result.runId)?.structuredMeta).toMatchObject({
        kind: 'scm_diff_summary.v1', payload: { outputs: { walkthrough: { state: 'failed' } } } }));
      await harness.manager.waitForOutput(result.runId, { kind: 'review_walkthrough', comparisonId: captured.comparison.id });
      expect(harness.manager.get('run-1')?.structuredMeta).toEqual(review.structuredMeta);
      expect(nativeOpen.mock.calls.map(([request]) => request.kind)).toEqual(['create']);
      return;
    }
    const input = harness.enqueueSessionUserMessageWithDisposition.mock.calls[0]![0];
    expect(input).toMatchObject({ recipient: { kind: 'execution_run', runId: result.runId } });
    expect(input.text).toContain('reading the diffs, not reviewing them');
    expect(input.text).toContain('Current diagnosis');
    expect(input.text).not.toContain('Original diagnosis');
    expect(nativeOpen.mock.calls.map(([request]) => request.kind)).toEqual(['create']);
    expect(harness.manager.get(result.runId)?.intentInput).toMatchObject({ reviewNarration: { provenance: {
      narrationMode: 'seeded_narrator', reviewedRuns: [{ runId: 'run-1', status: 'succeeded',
        reviewedFingerprint: 'host-reviewed-basis', commentIds: ['persisted-comment-1'], materialization: { kind: 'complete' } },
        { runId: 'run-2', status: 'cancelled', hasOutput: false }],
      launchFailures: [{ engineId: 'failed-engine', errorCode: 'engine_unavailable', error: 'Engine never started' }],
    } } });
    expect(acted).toMatchObject({ result: { comparison: captured.comparison } });
  });

  it.each(['succeeded', 'failed'] as const)('continues a finished %s bounded review on its same retained provider session with a structured walkthrough turn', async (reviewStatus) => {
    let emit: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    const sent = vi.fn<AgentSessionRuntime['send']>(async () => ({ status: 'admitted' as const }));
    nativeOpen.mockImplementation(async () => ({
      watch(next) { emit = next; next({ kind: 'provider-session-id', providerSessionId: 'provider-session-1', sequence: 1, sessionId: 'session-parent', emittedAtMs: 1 }); return { dispose() {} }; },
      send: sent, async dispose() {},
    }));
    const harness = createHarness();
    const narrator = (await buildReviewEngineInventoryItems({})).find(item => item.backendId === 'claude' && item.enabled && item.capabilities.structuredNarration);
    expect(narrator).toBeDefined();
    const modelId = getAgentStaticModels('claude', { catalogOnly: true })[0]?.id;
    expect(modelId).toBeDefined();
    const captured = await captureScmComparison({ cwd: directory, source: { kind: 'workingTree' }, sessionId: 'session-1' });
    const review = runState({ intent: 'review', status: reviewStatus, runClass: 'bounded', finishedAtMs: 2,
      ...(reviewStatus === 'failed' ? { error: { code: 'review_comment_materialization_failed', message: 'Finding retained despite materialization failure' } } : {}),
      backendId: narrator!.backendId, backendTarget: { kind: 'builtInAgent', agentId: narrator!.backendId },
      launch: { cwd: directory, modelId },
      resumeHandle: { kind: 'provider_session.v1', backendTarget: { kind: 'backend', backendId: narrator!.backendId, sourceKind: 'built_in' }, providerSessionId: 'provider-session-1' },
      intentInput: { cwd: directory, comparisonId: captured.comparison.id },
      structuredMeta: { kind: 'review_findings.v2', payload: { runRef: { runId: 'run-1', callId: 'call-1', backendId: narrator!.backendId },
        summary: 'One finding', overviewMarkdown: 'Review completed.', findings: [{ id: 'finding-1', title: 'Original finding', severity: 'high', category: 'correctness', summary: 'Original diagnosis' }],
        questions: [], assumptions: [], generatedAtMs: 2, reviewOutcome: reviewStatus === 'failed' ? 'partial' : 'complete',
        reviewedFingerprint: 'host-reviewed-basis', commentIds: ['persisted-comment-1'],
        materialization: reviewStatus === 'failed' ? { kind: 'partial', errorCode: 'review_comment_materialization_failed' } : { kind: 'complete' } } } });
    harness.runs.set('run-1', review);
    harness.runs.set('follow-up', { ...review, runId: 'follow-up', callId: 'follow-up-call', status: 'succeeded', structuredMeta: {
      kind: 'review_follow_up.v1', payload: { parentRunRef: { runId: 'run-1', callId: 'call-1', backendId: narrator!.backendId },
        threadId: 'thread-1', findingIds: ['finding-1'], requestMarkdown: 'Clarify', answerMarkdown: 'Latest answer', generatedAtMs: 3,
        updatedFindings: [{ id: 'finding-1', title: 'Current finding', severity: 'high', category: 'correctness', summary: 'Current diagnosis' }] },
    } });
    const acted = await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1'], comparisonId: captured.comparison.id,
    } });
    expect(acted, JSON.stringify(acted)).toMatchObject({ ok: true, result: { runId: 'run-1', mode: 'continued_review', state: 'writing' } });
    expect(nativeOpen.mock.calls.map(([request]) => request)).toMatchObject([{ kind: 'resume', providerSessionId: 'provider-session-1' }]);
    expect(harness.runs.size).toBe(2);
    expect(harness.runs.get('run-1')).toMatchObject({ runClass: 'long_lived', intent: 'review', intentInput: { reviewNarration: { phase: 'writing' } } });
    const pending = harness.enqueueSessionUserMessageWithDisposition.mock.calls[0]?.[0];
    expect(pending).toMatchObject({ recipient: { kind: 'execution_run', runId: 'run-1' }, requestedAction: { kind: 'enqueue' } });
    expect(pending?.text).toContain('Do not repeat the review');
    expect(pending?.text).toContain('Current diagnosis');
    expect(pending?.text).not.toContain('Original diagnosis');
    expect(pending?.text).toContain('"id":"F1"');
    expect(pending?.text).not.toContain('finding-1');
    const input = harness.runs.get('run-1')?.intentInput as { resultId: string };
    expect(await scmDiffSummaryResultStore.read({ cwd: directory, sessionId: 'session-1', resultId: input.resultId })).toMatchObject({ success: true, result: { output: { runId: 'run-1' } } });
    expect(harness.consume({ role: 'user', content: { type: 'text', text: pending!.text }, localId: pending!.localId,
      authorAccountId: 'account-1', inputAdmissionReceipt: null, pendingProviderAction: 'send' })).toBe(true);
    await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce());
    expect(JSON.stringify(sent.mock.calls)).toContain('Current diagnosis');
    expect(JSON.stringify(sent.mock.calls)).not.toContain('Original diagnosis');
    expect(JSON.stringify(sent.mock.calls)).not.toContain('finding-1');
    expect(harness.runs.get('run-1')?.intentInput).toMatchObject({ reviewNarration: { reviewStatus, provenance: { reviewedRuns: [
      { runId: 'run-1', status: reviewStatus, reviewOutcome: reviewStatus === 'failed' ? 'partial' : 'complete',
        reviewedFingerprint: 'host-reviewed-basis', commentIds: ['persisted-comment-1'],
        materialization: reviewStatus === 'failed' ? { kind: 'partial', errorCode: 'review_comment_materialization_failed' } : { kind: 'complete' } }] } } });
    expect(acted).toMatchObject({ result: { comparison: captured.comparison } });
    const delivery = sent.mock.calls[0]![0].delivery;
    if (delivery.kind !== 'newTurn') throw new Error('The narration was not admitted as a new native turn');
    emit!({ kind: 'input-accepted', sessionId: 'session-parent', sequence: 2, emittedAtMs: 2,
      inputIds: sent.mock.calls[0]![0].inputIds, delivery });
    emit!({ kind: 'turn-start', sessionId: 'session-parent', sequence: 3, emittedAtMs: 3, turnId: delivery.turnId, startedBy: 'host' });
    expect(await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1'], comparisonId: captured.comparison.id } })).toMatchObject({ ok: false, errorCode: 'execution_run_busy' });
    const controller = harness.controllers.get('run-1') as ExecutionRunBackendController;
    emit!({ kind: 'message-delta', sessionId: 'session-parent', sequence: 4, emittedAtMs: 4, turnId: delivery.turnId,
      channel: 'assistant', text: JSON.stringify({ walkthrough: { title: 'Saved narration', intro: 'No captured readable changes', stops: [], otherChangeRefs: [] } }) });
    emit!({ kind: 'turn-complete', sessionId: 'session-parent', sequence: 5, emittedAtMs: 5, turnId: delivery.turnId });
    let publicationBeforeNextDelivery: unknown;
    sent.mockImplementationOnce(async request => {
      publicationBeforeNextDelivery = await scmDiffSummaryResultStore.read({ cwd: directory, sessionId: 'session-1', resultId: input.resultId });
      if (request.delivery.kind !== 'newTurn') throw new Error('The next narration was not a new native turn');
      emit!({ kind: 'input-accepted', sessionId: 'session-parent', sequence: 6, emittedAtMs: 6,
        inputIds: request.inputIds, delivery: request.delivery });
      emit!({ kind: 'turn-start', sessionId: 'session-parent', sequence: 7, emittedAtMs: 7, turnId: request.delivery.turnId, startedBy: 'host' });
      emit!({ kind: 'message-delta', sessionId: 'session-parent', sequence: 8, emittedAtMs: 8, turnId: request.delivery.turnId,
        channel: 'assistant', text: JSON.stringify({ walkthrough: { title: 'Next narration', intro: '', stops: [], otherChangeRefs: [] } }) });
      emit!({ kind: 'turn-complete', sessionId: 'session-parent', sequence: 9, emittedAtMs: 9, turnId: request.delivery.turnId });
      return { status: 'admitted' };
    });
    expect(harness.consume({ role: 'user', content: { type: 'text', text: 'Continue the walkthrough' }, localId: 'next-narration',
      authorAccountId: 'account-1', inputAdmissionReceipt: null, pendingProviderAction: 'send' })).toBe(true);
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(publicationBeforeNextDelivery).toMatchObject({ success: true,
      result: { output: { outputs: { walkthrough: { value: { title: 'Saved narration' } } } } } }));
    await controller.pendingHostBarrier;
    await vi.waitFor(async () => expect(await scmDiffSummaryResultStore.read({ cwd: directory, sessionId: 'session-1', resultId: input.resultId })).toMatchObject({ success: true,
      result: { output: { runId: 'run-1', outputs: { walkthrough: { value: { title: 'Next narration' } } } } } }));
    expect(harness.manager.get('run-1')).toMatchObject({ status: 'running' });
    const again = await harness.manager.applyAction('run-1', { actionId: 'review.walkthrough', input: {
      reviewRunIds: ['run-1'], comparisonId: captured.comparison.id } });
    expect(again, JSON.stringify(again)).toMatchObject({ ok: true, result: { runId: 'run-1', mode: 'continued_review' } });
    expect(nativeOpen).toHaveBeenCalledOnce();
    expect(harness.runs.size).toBe(2);
  });
  it('reopens a terminal recoverable exact target through real ensure and its native provider session', async () => {
    nativeOpen.mockReset();
    nativeOpen.mockImplementation(async () => {
      let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
      return { watch(next) { listener = next; listener({ kind: 'provider-session-id', providerSessionId: 'provider-session-1',
        sequence: 1, sessionId: 'session-parent', emittedAtMs: 1 }); return { dispose() { listener = undefined; } }; },
        async send() { return { status: 'admitted' as const }; }, async dispose() {} };
    });
    const harness = createHarness();
    harness.runs.set('run-1', runState({ status: 'succeeded', finishedAtMs: 2 }));
    try {
      await harness.manager.reconcilePendingExecutionRunTarget('run-1');
      expect(nativeOpen.mock.calls.map(([request]) => request)).toMatchObject([{ kind: 'resume', providerSessionId: 'provider-session-1' }]);
      expect(harness.manager.getPublic('run-1')).toMatchObject({ status: 'running', lifecycle: { state: 'current' } });
      expect(harness.blockExecutionRunPendingDelivery).not.toHaveBeenCalled();
    } finally { await harness.manager.dispose(); }
  });
  it('leaves an unknown target queued without ensure or block', async () => {
    const harness = createHarness();
    const ensure = vi.spyOn(harness.manager, 'ensure');

    await harness.manager.reconcilePendingExecutionRunTarget('run-1');

    expect(ensure).not.toHaveBeenCalled();
    expect(harness.blockExecutionRunPendingDelivery).not.toHaveBeenCalled();
  });

  it.each(['indeterminate', 'permanent'] as const)('classifies a native %s resume failure through real ensure', async (failureKind) => {
    const error = new Error('Native provider cannot currently resume this exact session');
    if (failureKind === 'permanent') Object.assign(error, { code: 'AGENT_RESUME_PROVIDER_STATE_MISSING' });
    nativeOpen.mockRejectedValue(error);
    const harness = createHarness();
    harness.runs.set('run-1', runState({ status: 'succeeded', finishedAtMs: 2 }));

    await harness.manager.reconcilePendingExecutionRunTarget('run-1');

    expect(nativeOpen.mock.calls.map(([request]) => request)).toMatchObject([{ kind: 'resume', providerSessionId: 'provider-session-1' }]);
    expect(harness.enqueueAgentMessageCommitted).not.toHaveBeenCalled();
    if (failureKind === 'permanent') {
      expect(harness.manager.getPublic('run-1')).toMatchObject({ lifecycle: { state: 'unavailable' }, error: { code: 'execution_run_provider_state_missing' } });
      expect(harness.blockExecutionRunPendingDelivery).toHaveBeenCalledOnce();
      expect(harness.blockExecutionRunPendingDelivery).toHaveBeenCalledWith('run-1', 'queued-1');
    } else {
      expect(harness.manager.getPublic('run-1')).toMatchObject({ lifecycle: { state: 'recoverable' } });
      expect(harness.blockExecutionRunPendingDelivery).not.toHaveBeenCalled();
    }
  });

  it('does not block when a concurrent resume installs the target controller', async () => {
    const harness = createHarness();
    harness.runs.set('run-1', runState());
    vi.spyOn(harness.manager, 'ensure').mockImplementation(async () => {
      harness.controllers.set('run-1', {
        kind: 'backend',
        cancelled: false,
        backend: { interaction: {} },
      });
      return {
        ok: false,
        errorCode: 'execution_run_not_allowed',
        error: 'Resume already in progress',
        resumeFailureKind: 'indeterminate',
      };
    });

    await harness.manager.reconcilePendingExecutionRunTarget('run-1');

    expect(harness.blockExecutionRunPendingDelivery).not.toHaveBeenCalled();
    harness.controllers.clear();
    harness.runs.clear();
  });

  it('keeps a superseded resume queued after its provisional controller has retired', async () => {
    const harness = createHarness();
    harness.runs.set('run-1', runState());
    vi.spyOn(harness.manager, 'ensure').mockResolvedValue({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      error: 'Resume was superseded',
      resumeFailureKind: 'indeterminate',
    });

    await harness.manager.reconcilePendingExecutionRunTarget('run-1');

    expect(harness.controllers.has('run-1')).toBe(false);
    expect(harness.blockExecutionRunPendingDelivery).not.toHaveBeenCalled();
    harness.runs.clear();
  });

  it('blocks a Voice target whose canonical lifecycle has no retained Voice configuration', async () => {
    const harness = createHarness();
    harness.runs.set('run-1', runState({ intent: 'voice_agent' }));

    await harness.manager.reconcilePendingExecutionRunTarget('run-1');

    expect(harness.blockExecutionRunPendingDelivery).toHaveBeenCalledWith('run-1', 'queued-1');
    harness.runs.clear();
  });

  it.each([
    ['permanently failed', { status: 'failed' as const, error: { code: 'execution_run_provider_state_missing', message: 'Native provider state is missing' } }],
    ['wrong Session', { sessionId: 'session-2' }],
    ['noninteractive', { runClass: 'bounded' as const, retentionPolicy: 'ephemeral' as const }],
    ['permanently unavailable', { resumeHandle: null }],
  ])('blocks only the queued exact row for a proven %s target', async (_label, overrides) => {
    const harness = createHarness();
    harness.runs.set('run-1', runState(overrides));
    const ensure = vi.spyOn(harness.manager, 'ensure');

    await harness.manager.reconcilePendingExecutionRunTarget('run-1');

    expect(ensure).not.toHaveBeenCalled();
    expect(harness.enqueueAgentMessageCommitted).not.toHaveBeenCalled();
    expect(harness.blockExecutionRunPendingDelivery).toHaveBeenCalledTimes(1);
    expect(harness.blockExecutionRunPendingDelivery).toHaveBeenCalledWith('run-1', 'queued-1');
    harness.runs.clear();
  });
});
