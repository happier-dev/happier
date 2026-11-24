import { expect, it, vi } from 'vitest';

import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { registerTranscriptSecret } from '@/api/session/client/transport/transcriptSecretRedaction';
import type { ExecutionRunHostRuntime } from '../executionRunHostRuntime';
import { projectExecutionRunError } from '../errors';
import type { ExecutionRunState } from '../executionRunTypes';
import { sendBackendLongLivedRun } from './backendLongLivedPrompt';

it('masks a registered value that a failed exact-input turn error echoes, only in its own Session', async () => {
  const secret = 'synthetic-error-project-value';
  const owner = await runAddedHostedSession(
    {
      environment: { HAPPIER_TEST_ACCOUNT: 'owner' },
      workingDirectory: '/tmp/owner',
      end: () => {},
    },
    async () => {
      const release = registerTranscriptSecret(secret);
      // The provider runtime is the boundary: its turn fails with a message echoing the value.
      const backend = {
        getRuntimeLifetimeSignal: () => new AbortController().signal,
        deliverInput: async () => ({ status: 'admitted' as const }),
        waitForTurnCompletion: async () => {
          throw new Error(`provider failed ${secret} control-error`);
        },
        cancel: async () => {},
      } as unknown as ExecutionRunHostRuntime;
      const run: ExecutionRunState = {
        runId: 'error-run',
        callId: 'call',
        sidechainId: 'side',
        sessionId: null,
        depth: 0,
        intent: 'agent',
        backendId: 'acme',
        backendTarget: { kind: 'builtInAgent', agentId: 'acme' },
        instructions: '',
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'request_response',
        status: 'running',
        startedAtMs: 1,
      };
      const runs = new Map([[run.runId, run]]);
      const controller: ExecutionRunBackendController = {
        kind: 'backend',
        controllerOccurrenceId: 'error-run',
        backend,
        backendSupportsResume: true,
        runtimeId: 'error-run',
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
        pendingHostBarrier: Promise.resolve(),
        terminalPromise: Promise.resolve(),
        resolveTerminal: () => {},
        inputTurnOccurrenceId: 'error-occurrence',
      };
      const finishRun = vi.fn(
        async (_id: string, next: Partial<ExecutionRunState>) => {
          runs.set(run.runId, { ...runs.get(run.runId)!, ...next });
        },
      );
      await sendBackendLongLivedRun({
        runId: run.runId,
        params: { message: 'Do it', localInputId: 'workflow-input' },
        runs,
        controllers: new Map([[run.runId, controller]]),
        budgetRegistry: null,
        createRuntime: () => backend,
        maxTurns: null,
        getNowMs: () => 2,
        finishRun,
        sendAcp: async () => {},
        parentProvider: 'codex',
        streamedTranscriptSession: null,
        writeActivityMarker: async () => {},
      });
      await vi.waitFor(() =>
        expect(controller.lastInputTurn?.state).toBe('failed'),
      );
      await vi.waitFor(() =>
        expect(runs.get(run.runId)?.inputTurns?.last?.state).toBe('failed'),
      );
      // Another hosted Session's error is projected while this value is registered here.
      const otherSession = await runAddedHostedSession(
        { environment: { HAPPIER_TEST_ACCOUNT: 'other' }, workingDirectory: '/tmp/other', end: () => {} },
        async () => projectExecutionRunError(new Error(`other ${secret}`)).message,
      );
      release();
      // The exact-input Workflow step reads `inputTurns.last` and the stored Run state.
      return {
        otherSession,
        stored: JSON.stringify({ turn: controller.lastInputTurn, stored: runs.get(run.runId) }),
      };
    },
  );
  expect(owner.stored).not.toContain(secret);
  expect(owner.stored).toContain('control-error');
  expect(owner.otherSession).toBe(`other ${secret}`);
});
