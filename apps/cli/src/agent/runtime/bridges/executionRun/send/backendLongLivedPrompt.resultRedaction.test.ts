import { expect, it, vi } from 'vitest';

import type { ExecutionRunResultContractV1 } from '@happier-dev/protocol';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import {
  registerTranscriptSecret,
  TRANSCRIPT_SECRET_REDACTED as R,
} from '@/api/session/client/transport/transcriptSecretRedaction';
import type { ExecutionRunHostRuntime } from '../executionRunHostRuntime';
import type { ExecutionRunState } from '../executionRunTypes';
import { sendBackendLongLivedRun } from './backendLongLivedPrompt';

// A Workflow Session step: the provider runtime is the boundary and returns this exact answer text.
async function runTypedStep(
  answer: string,
  resultContract: ExecutionRunResultContractV1,
) {
  const releases = ['native', 'postgres', '1', 'secret', 'true'].map(
    registerTranscriptSecret,
  );
  try {
    let controller!: ExecutionRunBackendController;
    const backend = {
      getRuntimeLifetimeSignal: () => new AbortController().signal,
      deliverInput: async () => ({ status: 'admitted' as const }),
      waitForTurnCompletion: async () => {
        controller.buffer = answer;
      },
      cancel: async () => {},
    } as unknown as ExecutionRunHostRuntime;
    const run: ExecutionRunState = {
      runId: 'step-run',
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
    controller = {
      kind: 'backend',
      controllerOccurrenceId: 'step-run',
      backend,
      backendSupportsResume: true,
      runtimeId: 'step-run',
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
      inputTurnOccurrenceId: 'step-occurrence',
    };
    const runs = new Map([[run.runId, run]]);
    await sendBackendLongLivedRun({
      runId: run.runId,
      params: {
        message: 'Do it',
        localInputId: 'workflow-input',
        resultContract,
      },
      runs,
      controllers: new Map([[run.runId, controller]]),
      budgetRegistry: null,
      createRuntime: () => backend,
      maxTurns: null,
      getNowMs: () => 2,
      finishRun: vi.fn(async () => {}),
      sendAcp: async () => {},
      parentProvider: 'codex',
      streamedTranscriptSession: null,
      writeActivityMarker: async () => {},
    });
    await vi.waitFor(() =>
      expect(runs.get(run.runId)?.inputTurns?.last?.state).toBeDefined(),
    );
    return runs.get(run.runId)!.inputTurns!.last!;
  } finally {
    releases.forEach((release) => release());
  }
}

it('decodes a typed step result before masking, so numbers, booleans and keys survive and free text is masked', async () => {
  const last = await runTypedStep(
    '{"line":12,"secret":true,"note":"connect with postgres"}',
    {
      kind: 'json',
      schema: {
        type: 'object',
        required: ['line', 'secret', 'note'],
        properties: {
          line: { type: 'integer' },
          secret: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
    },
  );
  expect(last.state).toBe('completed');
  expect(last.result).toEqual({
    kind: 'json',
    value: { line: 12, secret: true, note: `connect with ${R}` },
  });
});

it('keeps a declared decision exact and masks only its reason', async () => {
  const last = await runTypedStep(
    '{"decision":"native","reason":"the secret is stale"}',
    { kind: 'decision', decisions: ['native', 'sqlite'] },
  );
  expect(last.state).toBe('completed');
  expect(last.result).toEqual({
    kind: 'decision',
    value: JSON.stringify({ decision: 'native', reason: `the ${R} is stale` }),
  });
});

it('masks a plain text step result as text', async () => {
  const last = await runTypedStep('use postgres on port 5432', {
    kind: 'text',
  });
  expect(last.result).toEqual({ kind: 'text', value: `use ${R} on port 5432` });
});
