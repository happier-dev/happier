import * as z from 'zod/mini';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionRunGetResponseSchema, ExecutionRunPublicStateSchema, ExecutionRunWaitResultSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { createAutomationRunLifecycleObservers } from './automationRunLifecycleObservers';
import { AutomationRunLifecycleSourceSchema, AutomationRunLifecycleOccurrenceEvidenceV1Schema,
  type AutomationRunLifecycleOccurrenceEvidenceV1 } from '@happier-dev/protocol/automations/automationRunLifecycle';
import { ScmDiffSummaryGenerateOutputSchema, normalizeScmDiffSummaryModelOutput } from '@happier-dev/protocol/scm/diffSummary';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

type Source = Extract<ReturnType<typeof AutomationRunLifecycleSourceSchema.parse>, { kind: 'execution_run' }>;
function createObservers(deps: Readonly<{
  wait: (source: Source, signal: AbortSignal) => Promise<unknown>;
  report: (occurrence: AutomationRunLifecycleOccurrenceEvidenceV1, signal: AbortSignal) => Promise<void>;
  onError: (error: unknown, source: Source) => void;
}>) {
  const boundarySource = (sessionId: string | null, request: { runId: string; waitForOutput?: Source['observation'] },
    options?: Readonly<{ targetMachineId?: string | null; signal?: AbortSignal }>) => {
    // Attached Run RPCs resolve their Machine through the authenticated Session
    // directory. These fixture Sessions both belong to machine-one.
    const machineId = sessionId === 'session' || sessionId === 'unrelated-session' ? 'machine-one' : options?.targetMachineId;
    if (!machineId || !options?.signal) throw new Error('Run transport scope or cancellation was not bound');
    return { source: AutomationRunLifecycleSourceSchema._zod.def.options[0].parse({ kind: 'execution_run',
      machineId, runId: request.runId,
      ...(sessionId ? { sessionId } : {}), ...(request.waitForOutput ? { observation: request.waitForOutput } : {}),
    }), signal: options.signal };
  };
  const transports: Pick<ActionExecutorDeps, 'executionRunGet' | 'executionRunWait' | 'executionRunCheckProtocolV2'> = {
    executionRunCheckProtocolV2: async () => ({ ok: true }),
    executionRunGet: async (sessionId, request, options) => {
      const boundary = boundarySource(sessionId, request, options);
      const snapshot = ExecutionRunGetResponseSchema.parse(await deps.wait(boundary.source, boundary.signal));
      return request.includeStructured === true ? snapshot : { run: snapshot.run };
    },
    executionRunWait: async (sessionId, request, options) => {
      const boundary = boundarySource(sessionId, request, options);
      return ExecutionRunWaitResultSchema.parse(await deps.wait(boundary.source, boundary.signal));
    },
  };
  // Only the remote Run RPC transport is replaced; Action admission, request/output
  // schemas, source observation and notification occurrence production remain real.
  return createAutomationRunLifecycleObservers({ executor: createActionExecutor({ ...createUnavailableActionTransportDeps(), ...transports }),
    report: deps.report, onError: deps.onError });
}

describe('Automation exact execution source observers', () => {
  it.each(['complete', 'failed'] as const)('reports %s retained output without waiting for the generating Run to exit', async (state) => {
    const source = AutomationRunLifecycleSourceSchema.parse({ kind: 'execution_run', machineId: 'machine-one', runId: 'generator',
      sessionId: 'session', observation: { kind: 'scm_diff_summary', output: 'commitPlan', comparisonId: 'comparison',
        resultId: 'saved', afterRevision: 2 } });
    if (source.kind !== 'execution_run') throw new Error('Expected execution source');
    const comparison = ScmComparisonSchema.parse({ id: 'comparison', source: { kind: 'workingTree' },
      repository: { rootPath: '/repo' }, endpoints: { before: 'a', after: 'b' },
      inventory: { state: 'complete', reasons: [], files: [] } });
    const model = normalizeScmDiffSummaryModelOutput({ commitPlan: { groups: [], leftOutChangeRefs: [] } },
      { comparison, requestedOutputs: ['commitPlan'], requireCompleteCoverage: true });
    const output = ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: comparison.id, comparison,
      metadata: { source: comparison.source, sourceKey: comparison.id }, resultId: 'saved', revision: 3,
      requestedOutputs: ['commitPlan', 'walkthrough'], outputs: { commitPlan: state === 'complete' ? { state, value: model.commitPlan }
        : { state, reason: 'model_refused' }, walkthrough: { state: 'writing' } },
      analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } });
    const run = ExecutionRunPublicStateSchema.parse({ runId: source.runId, callId: 'call', sidechainId: 'sidechain', intent: 'scm_diff_summary',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read-only',
      retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', startedAtMs: 100, status: 'running' });
    const reports: AutomationRunLifecycleOccurrenceEvidenceV1[] = [];
    const errors: unknown[] = [];
    const observers = createObservers({ wait: async (observed) => ({ run,
      // A non-waiting RPC reads the still-writing snapshot. Removing the production
      // waitForOutput binding must fail this composed Action-to-observer test.
      structuredMeta: { kind: 'scm_diff_summary.v1', payload: observed.observation ? output
        : { ...output, outputs: { commitPlan: { state: 'writing' } } } } }),
      report: async occurrence => { reports.push(AutomationRunLifecycleOccurrenceEvidenceV1Schema.parse(occurrence)); },
      onError: error => { errors.push(error); } });
    observers.replace([source]);
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    expect(errors).toEqual([]);
    expect(reports).toEqual([expect.objectContaining({ source, condition: 'terminal', sourceRevision: 3 })]);
    observers.clear();
  });
  it('reports the retained host Workflow origin without deriving it from the watched Session', async () => {
    const reports: unknown[] = [];
    const observers = createObservers({
      wait: async () => ({ ok: true, status: 'succeeded', result: { run: ExecutionRunPublicStateSchema.parse({
        runId: 'execution', callId: 'call', sidechainId: 'sidechain', intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'read-only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
        startedAtMs: 100, finishedAtMs: 200, status: 'succeeded', originWorkflowRunId: 'host-origin',
      }) } }),
      report: async occurrence => { reports.push(occurrence); }, onError: error => { throw error; },
    });
    observers.replace([{ kind: 'execution_run', machineId: 'machine-one', runId: 'execution', sessionId: 'unrelated-session' }]);
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    expect(reports).toEqual([expect.objectContaining({ originRunId: 'host-origin' })]);
    observers.clear();
  });
  it('refuses terminal evidence for a different retained Run', async () => {
    const reports: AutomationRunLifecycleOccurrenceEvidenceV1[] = [];
    const errors: unknown[] = [];
    const observers = createObservers({
      // Deliberately wrong evidence at the machine RPC boundary must never select another source.
      wait: async () => ({ ok: true, status: 'succeeded', result: { run: ExecutionRunPublicStateSchema.parse({
        runId: 'another-run', callId: 'call', sidechainId: 'sidechain', intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'read-only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
        startedAtMs: 100, finishedAtMs: 200, status: 'succeeded',
      }) } }),
      report: async occurrence => { reports.push(occurrence); }, onError: error => { errors.push(error); },
    });
    observers.replace([{ kind: 'execution_run', machineId: 'machine-one', runId: 'selected-run' }]);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(reports).toEqual([]);
    expect(errors).toHaveLength(1);
    observers.clear();
  });
  it.each(['resolve', 'reject'] as const)('consumes retained terminal evidence once and keeps an aborted %s silent', async (settlement) => {
    const completed = { kind: 'execution_run' as const, machineId: 'machine-one', runId: 'retained-terminal' };
    const pending = { ...completed, runId: 'running-source' };
    const occurrences: AutomationRunLifecycleOccurrenceEvidenceV1[] = [];
    const errors: unknown[] = [];
    let pendingSignal: AbortSignal | undefined;
    let releasePending: ((value: unknown) => void) | undefined;
    const terminal = (runId: string) => ({ ok: true, status: 'succeeded', result: { run: ExecutionRunPublicStateSchema.parse({
      runId, callId: runId, sidechainId: runId, intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read-only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
      startedAtMs: 100, finishedAtMs: 200, status: 'succeeded',
    }) } });
    // The only replaced boundary is the actual machine Run-wait RPC transport.
    const observers = createObservers({
      wait: async (source, signal) => {
        if (source.runId === completed.runId) return terminal(source.runId);
        pendingSignal = signal;
        return await new Promise<unknown>((resolve, reject) => {
          releasePending = settlement === 'resolve' ? resolve : reject;
        });
      },
      report: async occurrence => { occurrences.push(occurrence); },
      onError: error => { errors.push(error); },
    });
    observers.replace([completed, pending]);
    await vi.waitFor(() => {
      expect(occurrences).toHaveLength(1);
      expect(pendingSignal).toBeDefined();
    });
    observers.replace([completed]);
    expect(pendingSignal?.aborted).toBe(true);
    releasePending?.(terminal(pending.runId));
    await Promise.resolve();
    await Promise.resolve();
    expect(occurrences).toEqual([{ v: 1, kind: 'runLifecycle', source: completed, condition: 'terminal', sourceRevision: 200, occurredAt: 200 }]);
    expect(errors).toEqual([]);
    observers.clear();
  });
});
