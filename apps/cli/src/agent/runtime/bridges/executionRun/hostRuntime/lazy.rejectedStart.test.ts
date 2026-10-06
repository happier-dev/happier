import { describe, expect, it } from 'vitest';
import type { AgentExecutionRunEvent, AgentExecutionRunOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

import { createNativeAgentExecutionRunHostRuntime } from '../nativeAgentExecutionRun';
import { createLazyExecutionRunHostRuntime } from './lazy';

// This fixture implements the external Agent boundary. All host admission,
// event validation, terminal settlement and lazy runtime replacement stay real.
function createPoolRun(options: Readonly<{
  ineligible: number;
  exhausted?: boolean;
  workBeforeRejection?: boolean;
  rejectionCode?: string;
  beforeRecovery?: () => Promise<void>;
}>) {
  const requests: AgentExecutionRunOpenRequest[] = [];
  const disposedMembers: number[] = [];
  const recoveredMembers: number[] = [];
  let selectedMember = 0;
  const config = {
    resolveRuntime: async () => {
      const member = selectedMember;
      return createNativeAgentExecutionRunHostRuntime({
        runtime: { executionRuns: {
          async open(request) {
            requests.push(request);
            return {
              async send() { return { status: 'admitted' as const }; },
              async stop() { return { status: 'requested' as const }; },
              watch(listener) {
                const common = { runId: request.runId, emittedAtMs: 1 };
                const events: AgentExecutionRunEvent[] = [
                  { ...common, sequence: 1, kind: 'run-start' },
                ];
                if (options.workBeforeRejection) events.push({ ...common,
                  sequence: 2, kind: 'output-delta', channel: 'assistant', text: 'accepted partial work' });
                if (member < options.ineligible) events.push({ ...common,
                  sequence: 3, kind: 'run-failed', diagnostic: {
                    code: options.rejectionCode ?? 'connected_service_model_start_rejected', severity: 'error',
                    details: { runtimeAuthClassification: {
                      serviceId: 'happier.agent.codex/openai-codex',
                      profileId: `member-${member}`, groupId: 'pool', groupGeneration: member,
                      kind: 'plan', source: 'structured_provider_error',
                      limitCategory: 'plan_invalid', quotaScope: 'model', providerLimitId: 'gpt-6.1-sol',
                    } },
                  } });
                else events.push({ ...common, sequence: 3, kind: 'run-complete' });
                for (const event of events) listener(event);
                return { dispose() {} };
              },
              async dispose() { disposedMembers.push(member); },
            };
          },
        } },
        lease: { pluginId: 'happier.agent.codex', pluginVersion: '1.0.0',
          agentId: 'codex', localAgentId: 'codex', occurrenceId: 'fixture', isCurrent: () => true },
        options: { cwd: '/repo', runId: 'run-pool', scope: 'detached', backendId: 'codex',
          permissionMode: 'read_only', start: { profileId: 'delegate', localInputId: 'exact-initial-input' } },
        supportsResume: true,
      });
    },
    // The daemon HTTP recovery operation is a genuine process boundary. Its
    // real pool policy/state/selection path has separate owner-level coverage.
    recoverRejectedStart: async (_error: unknown) => {
      recoveredMembers.push(selectedMember);
      await options.beforeRecovery?.();
      if (options.exhausted && selectedMember + 1 === options.ineligible) {
        throw Object.assign(new Error("No enabled pool member can serve model 'gpt-6.1-sol'"), {
          executionRunErrorCode: 'connected_service_run_model_unavailable',
        });
      }
      selectedMember++;
      return true;
    },
  };
  return { host: createLazyExecutionRunHostRuntime(config), requests, disposedMembers, recoveredMembers };
}

describe('rejected model Run startup', () => {
  it.each(['provision', 'deliver'] as const)('starts on the third member and replays only the unaccepted initial input (%s)', async (entry) => {
    const { host, requests, recoveredMembers, disposedMembers } = createPoolRun({ ineligible: 2 });
    const messages: unknown[] = [];
    host.subscribeMessages((message) => messages.push(message));
    try {
      if (entry === 'provision') await host.provisionRuntime({ initialPrompt: 'same initial input' });
      else {
        const { runtimeId } = await host.provisionRuntime();
        await host.deliverInput(runtimeId, { text: 'same initial input' }, { localId: 'exact-initial-input' });
      }
      await host.waitForTurnCompletion?.();
      expect(recoveredMembers).toEqual([0, 1]);
      expect(requests).toHaveLength(3);
      expect(requests.map((request) => request.kind === 'create' && {
        input: request.input, localInputId: request.localInputId,
      })).toEqual(Array.from({ length: 3 }, () => ({
        input: { text: 'same initial input' }, localInputId: 'exact-initial-input',
      })));
      expect(disposedMembers).toEqual([0, 1]);
      expect(messages).not.toContainEqual(expect.objectContaining({ type: 'status', status: 'error' }));
      expect(host.getRuntimeLifetimeSignal().aborted).toBe(false);
    } finally { await host.dispose(); }
  });

  it('surfaces the typed model error when every enabled member rejects startup', async () => {
    const { host, recoveredMembers } = createPoolRun({ ineligible: 2, exhausted: true });
    try {
      await expect(host.provisionRuntime({ initialPrompt: 'initial' })).rejects.toMatchObject({
        executionRunErrorCode: 'connected_service_run_model_unavailable',
        message: expect.stringContaining('gpt-6.1-sol'),
      });
      expect(recoveredMembers).toEqual([0, 1]);
    } finally { await host.dispose(); }
  });

  it('does not replay a model rejection after partial provider output', async () => {
    const { host, recoveredMembers } = createPoolRun({ ineligible: 2, workBeforeRejection: true });
    try {
      await host.provisionRuntime({ initialPrompt: 'initial' });
      await expect(host.waitForTurnCompletion?.()).rejects.toThrow();
      expect(recoveredMembers).toEqual([]);
    } finally { await host.dispose(); }
  });

  it.each(['unattested', 'resume'] as const)('does not replay %s provider failure', async (mode) => {
    const { host, recoveredMembers } = createPoolRun({ ineligible: 2,
      ...(mode === 'unattested' ? { rejectionCode: 'codex_send_outcome_unknown' } : {}) });
    try {
      await host.provisionRuntime(mode === 'resume'
        ? { resumeRuntimeId: 'retained-native-session' }
        : { initialPrompt: 'initial' });
      await expect(host.waitForTurnCompletion?.()).rejects.toThrow();
      expect(recoveredMembers).toEqual([]);
    } finally { await host.dispose(); }
  });

  it.each(['dispose', 'cancel'] as const)('does not rematerialize or replay when %s wins during recovery', async (action) => {
    let finishRecovery!: () => void;
    let recoveryStarted!: () => void;
    const started = new Promise<void>((resolve) => { recoveryStarted = resolve; });
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
    const { host, requests } = createPoolRun({ ineligible: 2, beforeRecovery: async () => {
      recoveryStarted();
      await recovery;
    } });
    const provision = host.provisionRuntime({ initialPrompt: 'initial' });
    // An unexpected early settlement should fail instead of waiting for a
    // recovery boundary the implementation never reached.
    await Promise.race([started, provision.then(() => { throw new Error('No startup recovery'); })]);
    if (action === 'dispose') await host.dispose();
    else {
      const cancelling = host.cancel('run-pool');
      finishRecovery();
      await cancelling;
    }
    finishRecovery();
    await expect(provision).rejects.toThrow(/disposed|abort/i);
    expect(requests).toHaveLength(1);
    await host.dispose();
  });
});
