import { describe, expect, it, vi } from 'vitest';

import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';

import { stopExecutionRun } from './executionRunStop';
import type { ExecutionRunState } from './executionRunTypes';

describe('stopExecutionRun permission cleanup', () => {
  it('reports the terminal status when host publication retires the controller during Stop', async () => {
    const runId = 'run-ended-during-stop';
    const barrier = Promise.withResolvers<void>();
    const run = { runId, status: 'running' } as ExecutionRunState;
    const runs = new Map([[runId, run]]);
    const controllers = new Map<string, ExecutionRunController>([[runId, {
      kind: 'backend',
      hostWorkPending: true,
      lastInputTurn: { turnId: 'turn-1', inputIds: ['input-1'], state: 'completed' },
      pendingHostBarrier: barrier.promise,
    } as ExecutionRunController]]);
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => { throw new Error('Voice runtime is not used by this test'); },
    });
    const finishRun = vi.fn(async () => { throw new Error('The original terminal outcome should survive Stop'); });
    const stop = () => stopExecutionRun({
      runId, runs, controllers, voiceAgentManager, getNowMs: () => 2, finishRun,
    });
    try {
      const stopping = stop();
      runs.set(runId, { ...run, status: 'succeeded', finishedAtMs: 2 });
      controllers.delete(runId);
      barrier.resolve();
      await expect(stopping).resolves.toEqual({ ok: true, status: 'succeeded' });
      await expect(stop()).resolves.toEqual({ ok: true, status: 'succeeded' });
      expect(finishRun).not.toHaveBeenCalled();
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('waits for exact Workflow observation persistence before publishing cancellation', async () => {
    const runId = 'run-workflow';
    const events: string[] = [];
    let releaseObservation!: () => void;
    const pendingHostBarrier = new Promise<void>((resolve) => {
      releaseObservation = () => {
        events.push('observation-persisted');
        resolve();
      };
    });
    const controller = {
      kind: 'backend',
      runtimeId: null,
      cancelled: false,
      currentInputTurn: { turnId: 'turn-1', inputIds: ['input-1'], state: 'active' },
      backend: { dispose: vi.fn(async () => undefined) },
      pendingHostBarrier,
      terminalMarkerWritePromise: Promise.resolve(),
      admittedLiveInterventions: [],
      admittedLiveInterventionsSignal: null,
      resolveTerminal: vi.fn(),
    } as never;
    const run = {
      runId,
      status: 'running',
      callId: 'call-1',
      sidechainId: 'sidechain-1',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      intent: 'agent',
      startedAtMs: 1,
      inputTurns: {
        occurrenceId: 'occurrence-1',
        current: { turnId: 'turn-1', inputIds: ['input-1'], state: 'active' },
      },
    } as never;
    const runs = new Map<string, ExecutionRunState>([[runId, run]]);
    const controllers = new Map<string, ExecutionRunController>([[runId, controller]]);
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => { throw new Error('Voice runtime is not used by this test'); },
    });
    const finishRun = vi.fn(async () => {
      runs.set(runId, { ...run, status: 'cancelled', finishedAtMs: 2 });
      events.push('terminal-published');
    });

    try {
      const stopping = stopExecutionRun({
        runId, runs, controllers, voiceAgentManager, getNowMs: () => 2, finishRun,
      });
      await Promise.resolve();
      expect(finishRun).not.toHaveBeenCalled();

      releaseObservation();
      await expect(stopping).resolves.toEqual({ ok: true, status: 'cancelled' });
      expect(events).toEqual(['observation-persisted', 'terminal-published']);
    } finally {
      await voiceAgentManager.dispose();
    }
  });

  it('keeps the exact input interaction store reachable until pending permissions are aborted', async () => {
    const runId = 'run-detached';
    const interactionStore = { registerResponseTargetHandler: vi.fn() };
    const releaseResponseTarget = vi.fn();
    let controller!: ExecutionRunController;
    let observedInteractionStoreDuringAbort: unknown = null;
    const abortPendingPermissionRequests = vi.fn(async () => {
      if (controller.kind !== 'backend') return;
      observedInteractionStoreDuringAbort = controller.currentInputPermissionRequestStore?.store ?? null;
    });
    const resolveTerminal = vi.fn();
    controller = {
      kind: 'backend',
      runtimeId: null,
      cancelled: false,
      currentInputTurn: { turnId: 'turn-1', inputIds: ['input-1'], state: 'active' },
      currentInputPermissionRequestStore: {
        localInputId: 'input-1',
        turnId: 'turn-1',
        store: interactionStore,
        releaseResponseTarget,
      },
      backend: {
        abortPendingPermissionRequests,
        dispose: vi.fn(async () => undefined),
      },
      terminalMarkerWritePromise: Promise.resolve(),
      admittedLiveInterventions: [],
      admittedLiveInterventionsSignal: null,
      resolveTerminal,
    } as never;
    const run = {
      runId,
      status: 'running',
      callId: 'call-1',
      sidechainId: 'sidechain-1',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      intent: 'agent',
      startedAtMs: 1,
      inputTurns: {
        occurrenceId: 'occurrence-1',
        current: { turnId: 'turn-1', inputIds: ['input-1'], state: 'active' },
      },
    } as never;
    const runs = new Map<string, ExecutionRunState>([[runId, run]]);
    const controllers = new Map<string, ExecutionRunController>([[runId, controller]]);
    const voiceAgentManager = new VoiceAgentManager({
      createRuntime: () => {
        throw new Error('Voice runtime is not used by this test');
      },
    });

    try {
      await expect(stopExecutionRun({
        runId,
        runs,
        controllers,
        voiceAgentManager,
        getNowMs: () => 2,
        finishRun: async (_runId, terminal) => {
          const current = runs.get(runId);
          if (!current) throw new Error('expected execution run state');
          runs.set(runId, { ...current, ...terminal });
        },
      })).resolves.toEqual({ ok: true, status: 'cancelled' });

      expect(abortPendingPermissionRequests).toHaveBeenCalledWith('Execution run settled');
      expect(observedInteractionStoreDuringAbort).toBe(interactionStore);
      expect(releaseResponseTarget).toHaveBeenCalledOnce();
      expect(resolveTerminal).toHaveBeenCalledOnce();
    } finally {
      await voiceAgentManager.dispose();
    }
  });
});
