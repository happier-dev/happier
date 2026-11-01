import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentBackend, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import { removeExecutionRunMarker } from '@/daemon/executionRunRegistry';
import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';
import type { ExecutionRunConnectedServiceRegistrationV1 } from '@/daemon/connectedServices/runsBridge/contract';
import { ExecutionRunManager } from './ExecutionRunManager';

const { notifyFailure } = vi.hoisted(() => ({ notifyFailure: vi.fn() }));
// Local daemon HTTP transport is a genuine system boundary; reporter/outbox/policy stay real.
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  notifyDaemonConnectedServiceRuntimeAuthFailure: notifyFailure,
}));

const capacity: ConnectedServiceRuntimeFailureClassification = {
  kind: 'capacity', serviceId: 'openai-codex', profileId: null, groupId: null,
  resetsAtMs: null, planType: null, rateLimits: null, source: 'structured_provider_error',
};

function providerHarness(partial: boolean, failDuringSend = false, classification = capacity, failurePrompt = 1, holdFirst = false) {
  const prompts: Array<{ sessionId: SessionId; text: string }> = [];
  let handler: AgentMessageHandler = () => {};
  let failurePending = false;
  const dispose = vi.fn(async () => {});
  const failure = Object.assign(new Error('Provider busy'), { runtimeAuthClassification: classification });
  // The backend is the external provider boundary; all host lifecycle and policy code stays real.
  const backend: AgentBackend = {
    startSession: async () => ({ sessionId: 'same-conversation' as SessionId }),
    async sendPrompt(sessionId, text) {
      prompts.push({ sessionId, text });
      if (prompts.length === failurePrompt) {
        if (partial) handler({ type: 'tool-call', toolName: 'write', callId: 'completed-work', args: { path: 'done.txt' } });
        failurePending = true;
        if (failDuringSend) { failurePending = false; throw failure; }
      } else if (prompts.length > failurePrompt) {
        handler({ type: 'model-output', fullText: '{"summary":"Recovered","deliverables":[]}' });
      }
    },
    async waitForResponseComplete() {
      if (failurePending) { failurePending = false; throw failure; }
      if (holdFirst && prompts.length === 1) await new Promise<void>(() => {});
    },
    cancel: async () => {},
    onMessage: (next) => { handler = next; },
    dispose,
  };
  return { backend, prompts, dispose };
}

const active: Array<{ manager: ExecutionRunManager; runId: string }> = [];
afterEach(async () => {
  for (const { manager, runId } of active.splice(0)) {
    await manager.dispose();
    await removeExecutionRunMarker(runId);
  }
  vi.useRealTimers();
});

async function startRun(runClass: 'bounded' | 'long_lived', partial = false, mode = 'standard', failDuringSend = false,
  options: Readonly<{ boundedTimeoutMs?: number; customResumePrompt?: string; failurePrompt?: number; holdFirst?: boolean; resumable?: boolean; classification?: ConnectedServiceRuntimeFailureClassification;
    resolveAccountSettings?: () => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
    registration?: ExecutionRunConnectedServiceRegistrationV1 }> = {}) {
  const provider = providerHarness(partial, failDuringSend, options.classification, options.failurePrompt, options.holdFirst);
  if (options.resumable) {
    provider.backend.loadSessionWithReplayCapture = async (sessionId) => ({ sessionId, replay: [] });
  }
  const sendAcp = vi.fn();
  const manager = new ExecutionRunManager({
    parentProvider: 'codex', cwd: process.cwd(), sendAcp,
    createBackend: () => provider.backend,
    resolveAccountSettings: options.resolveAccountSettings ?? (() => ({ usageLimitRecoverySettingsV1: { resumePromptMode: mode, customResumePrompt: options.customResumePrompt } })),
    boundedTimeoutMs: options.boundedTimeoutMs,
  });
  const started = await manager.start({
    sessionId: 'parent-recovery', intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    instructions: 'Complete the assignment', permissionMode: 'read_only', retentionPolicy: 'resumable',
    runClass, ioMode: 'request_response',
    ...(options.registration ? { connectedServicesRegistration: options.registration,
      connectedServicesSelection: options.registration.connectedServicesBindings } : {}),
  });
  active.push({ manager, runId: started.runId });
  return { ...provider, manager, runId: started.runId, sendAcp };
}

describe('execution-run recovery through the run controller', () => {
  it.each(['off', 'custom'] as const)('honors %s account recovery settings on the first resumed long-lived turn', async (mode) => {
    vi.useFakeTimers();
    const customResumePrompt = 'Use the saved recovery instruction';
    const run = await startRun('long_lived', true, mode, false, {
      failurePrompt: 2, resumable: true, customResumePrompt,
    });
    await vi.waitFor(() => expect(run.manager.getPublic(run.runId)?.turnInFlight).toBe(false));
    await run.manager.stop(run.runId);
    await run.manager.waitForTerminal(run.runId);
    expect(run.manager.get(run.runId)?.resumeHandle?.kind).toBe('vendor_session.v1');

    await expect(run.manager.send(run.runId, { message: 'Resume the assignment', resume: true }))
      .resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(60_000);

    if (mode === 'off') {
      expect(run.manager.getPublic(run.runId)).toMatchObject({ status: 'failed', error: { code: 'capacity' } });
      expect(run.prompts).toHaveLength(2);
    } else {
      expect(run.prompts).toHaveLength(3);
      expect(run.prompts[2]).toEqual({ sessionId: run.prompts[1].sessionId, text: customResumePrompt });
      expect(run.manager.getPublic(run.runId)).toMatchObject({ status: 'running', turnInFlight: false });
    }
  });

  it.each(['bounded', 'long_lived'] as const)('%s waits for capacity then continues the same backend and conversation', async (runClass) => {
    vi.useFakeTimers();
    const run = await startRun(runClass);
    await vi.waitFor(() => expect(run.manager.getPublic(run.runId)?.error?.code).toBe('execution_run_recovering_capacity'));
    expect(run.prompts).toHaveLength(1);
    expect(run.dispose).not.toHaveBeenCalled();
    expect(run.sendAcp.mock.calls.some(([, body]) => body.type === 'message' && /Waiting/.test(body.message))).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(run.prompts).toHaveLength(2));
    expect(run.prompts[1]).toEqual({ sessionId: 'same-conversation', text: run.prompts[0].text });
    if (runClass === 'bounded') {
      await run.manager.waitForTerminal(run.runId);
      expect(run.manager.get(run.runId)?.status).toBe('succeeded');
    } else {
      await vi.waitFor(() => expect(run.manager.getPublic(run.runId)?.turnInFlight).toBe(false));
      expect(run.manager.get(run.runId)?.status).toBe('running');
    }
    expect(run.manager.getPublic(run.runId)?.error).toBeUndefined();
  });

  it('continues after partial tool work instead of replaying the original assignment', async () => {
    vi.useFakeTimers();
    const run = await startRun('bounded', true);
    await vi.waitFor(() => expect(run.manager.getPublic(run.runId)?.error?.code).toBe('execution_run_recovering_capacity'));
    await vi.advanceTimersByTimeAsync(60_000);
    await run.manager.waitForTerminal(run.runId);
    expect(run.prompts[1].text).toBe('Continue where you left off');
    expect(run.prompts[1].sessionId).toBe(run.prompts[0].sessionId);
  });

  it.each(['bounded', 'long_lived'] as const)('%s stop cancels the recovery wait and prevents any continuation', async (runClass) => {
    vi.useFakeTimers();
    const run = await startRun(runClass);
    await vi.waitFor(() => expect(run.manager.getPublic(run.runId)?.error?.code).toBe('execution_run_recovering_capacity'));
    await expect(run.manager.stop(run.runId)).resolves.toEqual({ ok: true });
    await run.manager.waitForTerminal(run.runId);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.prompts).toHaveLength(1);
    expect(run.manager.get(run.runId)?.status).toBe('cancelled');
    expect(run.manager.getPublic(run.runId)?.error).toBeUndefined();
  });

  it('honors disabled continuation and fails with the classified reason', async () => {
    const run = await startRun('bounded', false, 'off');
    await run.manager.waitForTerminal(run.runId);
    expect(run.manager.getPublic(run.runId)).toMatchObject({ status: 'failed', error: { code: 'capacity' } });
    expect(run.prompts).toHaveLength(1);
  });

  it('recovers a classified send rejection without treating it as an ambiguous delivery', async () => {
    vi.useFakeTimers();
    const run = await startRun('long_lived', false, 'standard', true);
    await vi.waitFor(() => expect(run.manager.getPublic(run.runId)?.error?.code).toBe('execution_run_recovering_capacity'));
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(run.prompts).toHaveLength(2));
    expect(run.manager.get(run.runId)?.status).toBe('running');
  });

  it('keeps the recovery wait within the bounded run timeout', async () => {
    vi.useFakeTimers();
    const run = await startRun('bounded', false, 'standard', false, { boundedTimeoutMs: 500 });
    await vi.waitFor(() => expect(run.manager.getPublic(run.runId)?.error?.code).toBe('execution_run_recovering_capacity'));
    await vi.advanceTimersByTimeAsync(600);
    await run.manager.waitForTerminal(run.runId);
    expect(run.manager.get(run.runId)?.status).toBe('timeout');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.prompts).toHaveLength(1);
  });

  it('uses the configured custom continuation after partial work', async () => {
    vi.useFakeTimers();
    const run = await startRun('bounded', true, 'custom', false, { customResumePrompt: 'Keep going carefully' });
    await vi.waitFor(() => expect(run.manager.getPublic(run.runId)?.error?.code).toBe('execution_run_recovering_capacity'));
    await vi.advanceTimersByTimeAsync(60_000);
    await run.manager.waitForTerminal(run.runId);
    expect(run.prompts[1].text).toBe('Keep going carefully');
  });

  it('does not continue after timeout while provider cancellation is still pending', async () => {
    vi.useFakeTimers();
    let releaseCancel!: () => void;
    const cancelled = new Promise<void>((resolve) => { releaseCancel = resolve; });
    const run = await startRun('bounded', false, 'standard', false, { boundedTimeoutMs: 500 });
    run.backend.cancel = async () => cancelled;
    await vi.waitFor(() => expect(run.manager.getPublic(run.runId)?.error?.code).toBe('execution_run_recovering_capacity'));
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(run.prompts).toHaveLength(1);
    } finally { releaseCancel(); }
    await run.manager.waitForTerminal(run.runId);
    expect(run.manager.get(run.runId)?.status).toBe('timeout');
  });

  it('retries the accepted replacement prompt after a user interrupts the bounded turn', async () => {
    vi.useFakeTimers();
    const run = await startRun('bounded', false, 'standard', false, { failurePrompt: 2, holdFirst: true });
    await vi.waitFor(() => expect(run.prompts).toHaveLength(1));
    await expect(run.manager.send(run.runId, { message: 'Use the new requirement', delivery: 'interrupt' })).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(run.manager.getPublic(run.runId)?.error?.code).toBe('execution_run_recovering_capacity'));
    await vi.advanceTimersByTimeAsync(60_000);
    await run.manager.waitForTerminal(run.runId);
    expect(run.prompts[1].text).toContain('Use the new requirement');
    expect(run.prompts[2].text).toBe(run.prompts[1].text);
  });

  it('keeps output-repair recovery inside the bounded timeout too', async () => {
    vi.useFakeTimers();
    const run = await startRun('bounded', false, 'standard', false, { boundedTimeoutMs: 500, failurePrompt: 2 });
    await vi.waitFor(() => expect(run.manager.getPublic(run.runId)?.error?.code).toBe('execution_run_recovering_capacity'));
    await vi.advanceTimersByTimeAsync(600);
    expect(run.manager.get(run.runId)?.status).toBe('timeout');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.prompts).toHaveLength(2);
  });

  it('retires old recovery when user interruption replaces its turn during settings lookup', async () => {
    vi.useFakeTimers();
    let releaseSettings!: (settings: Record<string, unknown>) => void;
    let settingsRequested = false;
    const settings = new Promise<Record<string, unknown>>((resolve) => { releaseSettings = resolve; });
    const run = await startRun('long_lived', false, 'standard', false, {
      resolveAccountSettings: () => { settingsRequested = true; return settings; },
    });
    await vi.waitFor(() => expect(settingsRequested).toBe(true));
    await expect(run.manager.send(run.runId, { message: 'New user request', delivery: 'interrupt' })).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(run.manager.getPublic(run.runId)?.turnInFlight).toBe(false));
    releaseSettings({ usageLimitRecoverySettingsV1: { resumePromptMode: 'standard' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(run.manager.getPublic(run.runId)?.error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    const outputs = run.sendAcp.mock.calls.filter(([, body]) => body.type === 'message' && body.message.includes('Recovered'));
    expect(outputs).toHaveLength(1);
    expect(run.prompts).toHaveLength(2);
  });

  it('does not replay a turn whose native steer acquired unknown delivery during recovery lookup', async () => {
    vi.useFakeTimers();
    let releaseSettings!: (settings: Record<string, unknown>) => void;
    let settingsRequested = false;
    const settings = new Promise<Record<string, unknown>>((resolve) => { releaseSettings = resolve; });
    const run = await startRun('long_lived', false, 'standard', false, {
      resolveAccountSettings: () => { settingsRequested = true; return settings; },
    });
    run.backend.sendSteerPrompt = async () => { throw new Error('steer outcome unknown'); };
    await vi.waitFor(() => expect(settingsRequested).toBe(true));
    await expect(run.manager.send(run.runId, { message: 'Native update', delivery: 'steer_if_supported' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'execution_run_send_outcome_unknown' });
    releaseSettings({ usageLimitRecoverySettingsV1: { resumePromptMode: 'standard' } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.prompts).toHaveLength(1);
  });

  it('reports usage limits under the child registration and waits for the shared pool-exhaustion disposition', async () => {
    vi.useFakeTimers();
    notifyFailure.mockReset();
    const retryAtMs = Date.now() + 120_000;
    notifyFailure.mockResolvedValue({ ok: true, resumePromptMode: 'standard', result: {
      status: 'switch_attempted', result: { status: 'no_eligible_member', groupExhausted: true, retryAtMs },
    } });
    const bindings = { v: 1 as const, bindingsByServiceId: {
      'openai-codex': { source: 'connected' as const, selection: 'group' as const, groupId: 'child-pool' },
    } };
    const registration: ExecutionRunConnectedServiceRegistrationV1 = {
      v: 1, agentId: 'codex', materializationKey: 'execution_run:child-recovery',
      connectedServicesBindings: bindings, brokerSelectionIdentity: null, runtimeAccountIdentitySelections: [],
      sessionDirectory: process.cwd(), materializedRoot: null,
      connectedServiceSelectionsJson: JSON.stringify([{ kind: 'group', serviceId: 'openai-codex',
        groupId: 'child-pool', activeProfileId: 'exhausted-child', fallbackProfileId: 'exhausted-child', generation: 2,
        credentialRevision: 'revision-child' }]),
    };
    const run = await startRun('bounded', true, 'standard', false, {
      registration, classification: { ...capacity, kind: 'usage_limit', quotaScope: 'account', resetsAtMs: retryAtMs },
    });
    await vi.waitFor(() => expect(run.manager.getPublic(run.runId)?.error?.code).toBe('execution_run_recovering_usage_limit'));
    expect(notifyFailure.mock.calls[0][0]).toMatchObject({ sessionId: registration.materializationKey,
      classification: { kind: 'usage_limit', groupId: 'child-pool', profileId: 'exhausted-child' } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.prompts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await run.manager.waitForTerminal(run.runId);
    expect(run.prompts[1].text).toBe('Continue where you left off');
  });
});
