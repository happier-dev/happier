import { describe, expect, it, vi } from 'vitest';
import type { WorkflowProgressEnvelopeV1 } from '@happier-dev/protocol/workflows';
import { createWorkflowInvocationRecoveryObserver } from './invocationRecoveryObserver';
import { freezeActionCompletionContractV1, getActionSpec } from '@happier-dev/protocol/actions';

const progress: WorkflowProgressEnvelopeV1 = {
  kind: 'happier.workflow-progress.v1', blockKind: 'step',
  invocationPath: { blockId: 'step', scope: [] }, attempt: '0',
  logicalInvocationRecordId: '2aaf1a39-4c48-4904-83a4-7eae318dfc2c',
  execution: { kind: 'detached_run', runId: 'native-run', localInputId: 'input-1', runtimeSelection: {} },
};

describe('exact Workflow recovery observation', () => {
  it.each(['writing', 'complete', 'failed', 'admission_unknown'] as const)('reattaches %s narration without waiting for the retained process to terminate', async (scenario) => {
    const state = scenario === 'admission_unknown' ? 'writing' : scenario;
    const descriptor = { kind: 'review_walkthrough' as const, comparisonId: 'comparison-1' };
    const contract = freezeActionCompletionContractV1(getActionSpec('review.start').completion!);
    const narration = { runId: 'native-run', comparisonId: 'comparison-1', mode: 'continued_review', state: 'collecting' };
    const output = { success: true, sourceKey: 'comparison-1', metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison-1' },
      comparison: { id: 'comparison-1', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' }, endpoints: { before: 'a', after: 'b' },
        inventory: { state: 'complete', files: [], reasons: [] } }, requestedOutputs: ['walkthrough'],
      outputs: { walkthrough: { state, ...(state === 'complete' ? { value: { title: 'Changes', intro: '', stops: [], otherChangeRefs: [] } } : {}) } },
      analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
    };
    const snapshot = { run: { runId: 'native-run', callId: 'call', sidechainId: 'side', intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'default', retentionPolicy: 'resumable',
      runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
      ...(scenario === 'admission_unknown' ? { error: { code: 'execution_run_send_outcome_unknown' } } : {}) },
      structuredMeta: { kind: 'scm_diff_summary.v1', payload: output } };
    let outputWaits = 0;
    const observe = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
      actionExecutor: { execute: async () => { throw new Error('No effect during recovery'); } },
      nativeActionRuns: { get: async () => snapshot, stop: async () => { throw new Error('No stop'); },
        wait: async (_runId, _signal, selected) => { expect(selected).toEqual(descriptor); outputWaits++;
          return { ...snapshot, structuredMeta: { ...snapshot.structuredMeta,
            payload: { ...output, outputs: { walkthrough: { state: 'failed' } } } } }; },
      },
    });
    const result = await observe({ progress: { ...progress, blockKind: 'action', execution: {
      kind: 'action', actionId: 'review.start', actionRequestId: 'request', localInputId: 'request', input: {},
      output: { intent: 'review', sessionId: 's1', results: [{ key: 'codex', ok: true, result: { runId: 'native-run' } }], narration },
      awaitedRuns: [{ key: 'codex', runId: 'native-run', observation: descriptor }],
    } }, frozenActionContract: { inputSchema: {}, outputSchema: contract.terminalOutputSchema, completion: contract },
    terminalParent: false, cancellationRequested: false });
    if (scenario === 'admission_unknown') {
      expect(result).toMatchObject({ kind: 'outcome_uncertain' });
      expect(outputWaits).toBe(0);
    } else if (state === 'writing') {
      expect(result.kind).toBe('unresolved');
      if (result.kind !== 'unresolved' || !result.waitForCompletion) throw new Error('Expected output observation');
      await result.waitForCompletion();
      expect(outputWaits).toBe(1);
    } else expect(result).toMatchObject({ kind: 'completed', result: { narration: { outcome: 'completed', runId: 'native-run' } } });
  });
  it('preserves an observed cancelled Session terminal without requesting cancellation again', async () => {
    const cancelSession = vi.fn(async () => ({ kind: 'turn_cancel_requested' as const }));
    const observe = createWorkflowInvocationRecoveryObserver({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
      actionExecutor: { execute: async () => { throw new Error('Session observation cannot invoke an Action'); } },
      observeSession: async () => ({ ok: true, sessionId: 'session-1', localId: 'input-1',
        result: { kind: 'cancelled', message: 'stopped', usage: { inputTokens: 2, outputTokens: 3 } } }),
      cancelSession,
    });
    await expect(observe({
      progress: { ...progress, execution: { kind: 'session', sessionId: 'session-1', localInputId: 'input-1' } },
      terminalParent: false, cancellationRequested: true,
    })).resolves.toEqual({ kind: 'cancelled', code: 'session_input_cancelled', usage: { inputTokens: 2, outputTokens: 3 } });
    expect(cancelSession).not.toHaveBeenCalled();
  });
  it('keeps a refused exact Session cancellation unresolved during recovery', async () => {
    const observe = createWorkflowInvocationRecoveryObserver({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
      actionExecutor: { execute: async () => { throw new Error('Session observation cannot invoke an Action'); } },
      observeSession: async () => ({ ok: true, sessionId: 'session-1', localId: 'input-1', result: { kind: 'pending' } }),
      cancelSession: async () => ({ kind: 'turn_cancel_refused', status: 'notRunning', code: 'notRunning' }),
    });
    await expect(observe({
      progress: { ...progress, execution: { kind: 'session', sessionId: 'session-1', localInputId: 'input-1' } },
      terminalParent: false, cancellationRequested: true,
    })).resolves.toEqual({ kind: 'unresolved', code: 'notRunning' });
  });
  it.each(['running', 'succeeded'] as const)('reattaches a %s Action through exact native runs without effects or a retained wait', async (status) => {
    const contract = freezeActionCompletionContractV1(getActionSpec('review.start').completion!);
    let reads = 0;
    const execution = { kind: 'action' as const, actionId: 'review.start', actionRequestId: 'request', localInputId: 'request', input: {},
      output: { intent: 'review', sessionId: null, results: [{ key: 'codex', ok: true, result: { runId: 'native-run' } }] },
      awaitedRuns: [{ key: 'codex', runId: 'native-run' }] };
    const observe = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
      actionExecutor: { execute: async () => { throw new Error('Action observation bypass'); } },
      nativeActionRuns: { get: async (runId) => { reads++; return { run: {
        runId, callId: 'call', sidechainId: 'side', intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'default', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response', status, startedAtMs: 1,
      }, latestToolResult: { findings: [], reviewedFingerprint: 'fingerprint', commentIds: ['comment'], materialization: { kind: 'complete' } } }; },
      stop: async () => { throw new Error('Observation-only stop'); },
      wait: async () => { throw new Error('Observation-only wait'); } },
    });
    const observed = await observe({ progress: { ...progress, blockKind: 'action', execution }, frozenActionContract: {
      inputSchema: {}, outputSchema: contract.terminalOutputSchema, completion: contract },
      terminalParent: false, cancellationRequested: false, observationOnly: true });
    if (status === 'running') expect(observed).toEqual({ kind: 'unresolved', code: 'execution_run_input_pending' });
    else expect(observed).toMatchObject({ kind: 'completed', result: { reviewedFingerprint: 'fingerprint', commentIds: ['comment'],
      perEngineOutcome: [{ key: 'codex', runId: 'native-run', outcome: 'completed' }] } });
    expect(reads).toBe(1);
  });
  it('never settles an invocation from another native execution run', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, result: { run: {
      runId: 'another-native-run', callId: 'call', sidechainId: 'sidechain', intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'default',
      retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
      status: 'running', startedAtMs: 1,
      inputTurns: { occurrenceId: 'occurrence', current: { turnId: 'turn', inputIds: ['input-1'], state: 'completed', result: { kind: 'text', value: 'wrong result' } } },
    } } }));
    const observe = createWorkflowInvocationRecoveryObserver({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
      actionExecutor: { execute } as Parameters<typeof createWorkflowInvocationRecoveryObserver>[0]['actionExecutor'],
    });
    expect(await observe({ progress, terminalParent: false, cancellationRequested: false }))
      .toEqual({ kind: 'outcome_uncertain', code: 'execution_run_correspondence_mismatch' });
  });
  it('reattaches a stop-pending input by observation without requesting another effect', async () => {
    // The native transport is the boundary; exact-turn classification remains real.
    const execute = vi.fn(async (_actionId: string, _input: unknown, _context: unknown) => ({ ok: true as const, result: { run: {
      runId: 'native-run', callId: 'call', sidechainId: 'sidechain', intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'default',
      retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
      status: 'running', startedAtMs: 1,
      inputTurns: { occurrenceId: 'occurrence', current: { turnId: 'turn', inputIds: ['input-1'], state: 'active' } },
    } } }));
    const observe = createWorkflowInvocationRecoveryObserver({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
      actionExecutor: { execute } as Parameters<typeof createWorkflowInvocationRecoveryObserver>[0]['actionExecutor'],
    });
    const result = await observe({ progress, terminalParent: false, cancellationRequested: true,
      ...{ observationOnly: true } });
    expect(result).toEqual({ kind: 'unresolved', code: 'execution_run_input_pending' });
    expect(execute.mock.calls.map((call) => call[0])).toEqual(['execution.run.get']);
  });
});
