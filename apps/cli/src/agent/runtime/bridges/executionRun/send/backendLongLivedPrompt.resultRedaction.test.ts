import { expect, it, vi } from 'vitest';

import type { ExecutionRunResultContractV1 } from '@happier-dev/protocol';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import {
  registerTranscriptSecret,
  TRANSCRIPT_SECRET_REDACTED as R,
} from '@/api/session/client/transport/transcriptSecretRedaction';
import type { ExecutionRunHostRuntime } from '../executionRunHostRuntime';
import type { ExecutionRunState } from '../executionRunTypes';
import { evaluateWorkflowCondition } from '@/daemon/workflows/input';
import { sendBackendLongLivedRun } from './backendLongLivedPrompt';

// A Workflow Session step: the provider runtime is the boundary and returns this exact answer text.
async function runTypedStep(
  answer: string,
  resultContract: ExecutionRunResultContractV1,
) {
  const releases = ['native', 'postgres', '1', 'secret', 'true', 'main'].map(
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

it('keeps a choice the result schema declares exact, so a later condition takes the right branch', async () => {
  const last = await runTypedStep('{"choice":"p1","mode":"main","note":"deploy main with p1"}', { kind: 'json', schema: {
    type: 'object', required: ['choice', 'mode', 'note'],
    properties: { choice: { enum: ['p1', 'main', 'other'] }, mode: { const: 'main' }, note: { type: 'string' } },
  } });
  expect(last.result).toEqual({ kind: 'json', value: { choice: 'p1', mode: 'main', note: `deploy ${R} with p${R}` } });
  const value = last.result?.kind === 'json' ? last.result.value : null;
  const choice = { kind: 'result', producer: { blockId: 'step', scope: { kind: 'current' } }, path: ['choice'] } as const;
  await expect(evaluateWorkflowCondition({ kind: 'compare', operator: 'eq', left: choice, right: { kind: 'literal', value: 'p1' } },
    { inputs: {}, resolveResult: async () => value })).resolves.toBe(true);
});
