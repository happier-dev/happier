import type { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import type { ExecutionRunState } from './executionRunTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import type { FinishExecutionRun } from './executionRunFinishRun';
import { settleExecutionRunController } from './settleExecutionRunController';
import { readExecutionRunControllerHostBarrier } from '@/agent/executionRuns/controllers/failureSignal';
import { createExecutionRunOccurrenceWitnessRegistry, projectExecutionRunInputTurn, projectExecutionRunInputTurns } from './runOccurrenceWitness';

export async function stopExecutionRun(args: Readonly<{
  runId: string;
  runs: Map<string, ExecutionRunState>;
  controllers: Map<string, ExecutionRunController>;
  voiceAgentManager: VoiceAgentManager;
  getNowMs: () => number;
  finishRun: FinishExecutionRun;
  onPublicStateUpdated?: (runId: string) => void;
}>): Promise<{ ok: boolean; errorCode?: string; error?: string }> {
  const run = args.runs.get(args.runId);
  if (!run) return { ok: false, errorCode: 'execution_run_not_found', error: 'Not found' };
  if (run.status !== 'running') return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
  const ctrl = args.controllers.get(args.runId);
  if (ctrl) {
    // Read the exact-input occurrence before cancellation revokes a retained
    // Run's live witness; it labels the cancelled turn retained below.
    const occurrenceId = projectExecutionRunInputTurns({
      runId: args.runId,
      retained: run.inputTurns,
      controller: ctrl,
      // The canonical reader is a pure projection over this same controller map.
      reader: createExecutionRunOccurrenceWitnessRegistry(args.controllers).reader,
    })?.occurrenceId;
    ctrl.cancelled = true;
    if (ctrl.kind === 'backend' && ctrl.currentInputTurn) {
      ctrl.lastInputTurn = { ...ctrl.currentInputTurn, state: 'cancelled' };
      // Retain the exact interaction binding until controller settlement
      // unregisters its responder and aborts the runtime's pending permissions.
      // Native detached runtimes resolve the durable store through this field.
      ctrl.currentInputTurn = undefined;
      if (occurrenceId) {
        args.runs.set(args.runId, {
          ...run,
          inputTurns: { occurrenceId, last: projectExecutionRunInputTurn(ctrl.lastInputTurn) },
        });
      }
    }
    // Leaf cancellation is a best-effort notification, never a gate on host-owned
    // terminal truth: a plugin/backend cancel or Voice stop that throws or never
    // settles must not block the cancelled terminal publication below, the
    // terminal waiter, or bridge disposal. Cleanup/disposal still settles exactly
    // once through settleExecutionRunController in the finally block.
    void (async (): Promise<void> => {
      if (ctrl.kind === 'backend') {
        if (ctrl.runtimeId) {
          await ctrl.backend.cancel(ctrl.runtimeId);
        }
        return;
      }
      await args.voiceAgentManager.stop({ voiceAgentId: ctrl.voiceAgentId });
    })().catch(() => {
      // Best effort: synchronous throws and async rejections are absorbed here.
    });
  } else if (run.inputTurns?.current?.state === 'active') {
    // A retained Run can outlive its controller. Stop is the host's terminal
    // fact for that input too; otherwise the saved active witness survives the
    // cancelled Run and its Workflow keeps waiting for a turn that cannot run.
    const { current, ...turns } = run.inputTurns;
    args.runs.set(args.runId, { ...run, inputTurns: {
      ...turns, last: { ...current, state: 'cancelled' },
    } });
  }

  const finishedAtMs = args.getNowMs();
  const output = {
    status: 'cancelled',
    summary: 'Cancelled',
    runId: run.runId,
    callId: run.callId,
    sidechainId: run.sidechainId,
    backendTarget: run.backendTarget,
    intent: run.intent,
    startedAtMs: run.startedAtMs,
    finishedAtMs,
  };

  try {
    if (ctrl?.kind === 'backend') {
      const pendingWorkflowFacts = readExecutionRunControllerHostBarrier(ctrl);
      if (pendingWorkflowFacts) await pendingWorkflowFacts;
    }
    await args.finishRun(args.runId, { status: 'cancelled', summary: 'Cancelled', finishedAtMs }, { output });
  } finally {
    if (ctrl) {
      await settleExecutionRunController({
        runId: args.runId,
        controller: ctrl,
        controllers: args.controllers,
      });
      args.onPublicStateUpdated?.(args.runId);
    }
  }
  return { ok: true };
}
