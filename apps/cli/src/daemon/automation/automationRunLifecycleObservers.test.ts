import { describe, expect, it } from 'vitest';
import { ExecutionRunPublicStateSchema, type AutomationRunLifecycleOccurrenceEvidenceV1 } from '@happier-dev/protocol';
import { createAutomationRunLifecycleObservers } from './automationRunLifecycleObservers';

describe('Automation exact execution source observers', () => {
  it('reports the retained host Workflow origin without deriving it from the watched Session', async () => {
    const reports: unknown[] = [];
    const observers = createAutomationRunLifecycleObservers({
      wait: async () => ({ ok: true, status: 'succeeded', result: { run: ExecutionRunPublicStateSchema.parse({
        runId: 'execution', callId: 'call', sidechainId: 'sidechain', intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'read-only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
        startedAtMs: 100, finishedAtMs: 200, status: 'succeeded', originWorkflowRunId: 'host-origin',
      }) } }),
      report: async occurrence => { reports.push(occurrence); }, onError: error => { throw error; },
    });
    observers.replace([{ kind: 'execution_run', machineId: 'machine-one', runId: 'execution', sessionId: 'unrelated-session' }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(reports).toEqual([expect.objectContaining({ originRunId: 'host-origin' })]);
    observers.clear();
  });
  it('refuses terminal evidence for a different retained Run', async () => {
    const reports: AutomationRunLifecycleOccurrenceEvidenceV1[] = [];
    const errors: unknown[] = [];
    const observers = createAutomationRunLifecycleObservers({
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
    await Promise.resolve();
    await Promise.resolve();
    expect(reports).toEqual([]);
    expect(errors).toHaveLength(1);
    observers.clear();
  });
  it('consumes retained terminal evidence once, cancels removal, and never reports a removed pending source', async () => {
    const completed = { kind: 'execution_run' as const, machineId: 'machine-one', runId: 'retained-terminal' };
    const pending = { ...completed, runId: 'running-source' };
    const occurrences: AutomationRunLifecycleOccurrenceEvidenceV1[] = [];
    let pendingSignal: AbortSignal | undefined;
    let releasePending: ((value: unknown) => void) | undefined;
    const terminal = (runId: string) => ({ ok: true, status: 'succeeded', result: { run: ExecutionRunPublicStateSchema.parse({
      runId, callId: runId, sidechainId: runId, intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read-only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
      startedAtMs: 100, finishedAtMs: 200, status: 'succeeded',
    }) } });
    // The only replaced boundary is the actual machine Run-wait RPC transport.
    const observers = createAutomationRunLifecycleObservers({
      wait: async (source, signal) => {
        if (source.runId === completed.runId) return terminal(source.runId);
        pendingSignal = signal;
        return await new Promise<unknown>(resolve => { releasePending = resolve; });
      },
      report: async occurrence => { occurrences.push(occurrence); },
      onError: error => { throw error; },
    });
    observers.replace([completed, pending]);
    await Promise.resolve();
    await Promise.resolve();
    observers.replace([completed]);
    expect(pendingSignal?.aborted).toBe(true);
    releasePending?.(terminal(pending.runId));
    await Promise.resolve();
    await Promise.resolve();
    expect(occurrences).toEqual([{ v: 1, kind: 'runLifecycle', source: completed, condition: 'terminal', sourceRevision: 200, occurredAt: 200 }]);
    observers.clear();
  });
});
