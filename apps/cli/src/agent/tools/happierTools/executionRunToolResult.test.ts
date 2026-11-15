import { describe, expect, it } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { waitForExecutionRunTerminal } from '@happier-dev/protocol/execution/runs/waitForTerminal';

import {
  normalizeExecutionRunRpcPayload,
  type ExecutionRunServiceResult,
} from '@/session/services/executionRuns';

import { normalizeExecutionRunToolResult } from './executionRunToolResult';

describe('normalizeExecutionRunToolResult', () => {
  it('keeps a live succeeded delegate observation valid against the wait Action output schema', async () => {
    // Account D live-run-compact-1.json: captured get response; content digests omitted.
    const snapshot = {
      run: {
        runId: 'run_36d95c4e-d7df-4659-8d82-511e7a760d5c',
        callId: 'subagent_run_d71ecb32-e4e2-42ee-810f-fcd3706cc55d',
        sidechainId: 'subagent_run_d71ecb32-e4e2-42ee-810f-fcd3706cc55d',
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        launchOrigin: { kind: 'session', sessionId: 'cmwhuxqcb02r2mcgcqt4xjs8c' },
        requestedConfiguration: { modelId: 'muse-spark-1.3' },
        resolvedSelection: {
          source: 'inherited',
          teamCredentialModel: {
            kind: 'team_credential_provider_model',
            resourceId: 'dffeaf2c-3705-444d-81d6-a4b1ddc90537',
            teamId: 'cmw5ex83c00ydmcalt3w8fvil',
            expectedResourceRevision: 3,
            agentTargetKey: 'agent:happier.agent.codex/codex',
            modelId: 'muse-spark-1.3',
            deliveryMode: 'brokered',
          },
          modelId: 'muse-spark-1.3',
          connectedServices: { v: 2, bindingsByServiceId: {} },
        },
        permissionMode: 'default',
        approvalProfileId: null,
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        status: 'succeeded',
        inputTurns: { occurrenceId: '4c1ac255-2ec5-4f6c-b47e-cd357c552fce' },
        lifecycle: { v: 1, state: 'unavailable' },
        availableActionIds: ['approval_profile.set'],
        startedAtMs: 1794748872145,
        finishedAtMs: 1794748906329,
      },
      latestToolResult: {
        status: 'succeeded',
        summary: 'Discovered session.list and settings.set specs, executed session.list successfully, executed settings.set resulting in approval_request_created awaiting person decision with no bypass or retry.',
        runId: 'run_36d95c4e-d7df-4659-8d82-511e7a760d5c',
      },
    };
    const observation = await waitForExecutionRunTerminal({
      runId: snapshot.run.runId,
      timeoutMs: null,
      // The captured response substitutes only the external Session RPC boundary.
      readRun: async () => ({ ok: true as const, data: snapshot }),
      waitForTerminal: async () => {},
    });
    const outputSchema = getActionSpec('execution.run.wait').outputSchema;
    expect(outputSchema.safeParse(observation).success).toBe(true);
    const toolResult = normalizeExecutionRunToolResult(observation, { runId: snapshot.run.runId });
    expect(toolResult.ok).toBe(true);
    if (!toolResult.ok) throw new Error(toolResult.error);
    expect(outputSchema.safeParse(toolResult.result).success).toBe(true);
    expect(toolResult.result).toEqual(observation);
  });

  it.each(['execution.run.send', 'execution.run.stop'] as const)(
    'preserves the %s acknowledgement required by its Action output schema', (actionId) => {
      const toolResult = normalizeExecutionRunToolResult({ ok: true });
      expect(toolResult.ok).toBe(true);
      if (!toolResult.ok) throw new Error(toolResult.error);
      expect(getActionSpec(actionId).outputSchema.safeParse(toolResult.result).success).toBe(true);
    },
  );

  it('unwraps the service envelope while retaining the operation acknowledgement', () => {
    expect(normalizeExecutionRunToolResult({ ok: true, data: { ok: true } })).toEqual({
      ok: true,
      result: { ok: true },
    });
  });

  it('preserves typed feature blocker details for CLI action callers', () => {
    const serviceResult = normalizeExecutionRunRpcPayload({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      error: 'Voice feature disabled',
      details: {
        featureId: 'voice.agent',
        blockedBy: 'dependency',
        blockerCode: 'dependency_disabled',
      },
    });

    expect(normalizeExecutionRunToolResult(serviceResult)).toEqual({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      error: 'Voice feature disabled',
      details: {
        featureId: 'voice.agent',
        blockedBy: 'dependency',
        blockerCode: 'dependency_disabled',
      },
    });
  });

  it('keeps failures from older peers valid when details are absent', () => {
    expect(normalizeExecutionRunToolResult({
      ok: false,
      code: 'execution_run_not_allowed',
      message: 'Voice feature disabled',
    })).toEqual({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      error: 'Voice feature disabled',
    });
  });

  it('keeps an accepted start successful when its nested shared waiter times out', () => {
    expect(normalizeExecutionRunToolResult({
      runId: 'run_wait_timeout_1',
      callId: 'call_wait_timeout_1',
      sidechainId: 'call_wait_timeout_1',
      wait: { ok: false, code: 'timeout' },
    })).toEqual({
      ok: true,
      result: {
        runId: 'run_wait_timeout_1',
        callId: 'call_wait_timeout_1',
        sidechainId: 'call_wait_timeout_1',
        wait: { ok: false, code: 'timeout' },
      },
    });
  });

  it('keeps a standalone observation timeout successful and nonterminal', () => {
    expect(normalizeExecutionRunToolResult(
      {
        ok: true,
        status: 'running',
        disposition: 'observation_timeout',
        runId: 'run_wait_timeout_1',
        timeoutMs: 5_000,
        observedAtMs: 6_000,
        deadlineAtMs: 6_000,
      },
      { runId: 'run_wait_timeout_1' },
    )).toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'running',
        disposition: 'observation_timeout',
        runId: 'run_wait_timeout_1',
        timeoutMs: 5_000,
        observedAtMs: 6_000,
        deadlineAtMs: 6_000,
      },
    });
  });

  it('revalidates details so a structurally typed caller cannot project extra fields', () => {
    const callerDetails = {
      featureId: 'voice.agent' as const,
      blockedBy: 'dependency' as const,
      blockerCode: 'dependency_disabled' as const,
      secret: 'must-not-cross-the-tool-boundary',
    };
    const typeRejectedCallerFailure: ExecutionRunServiceResult<unknown> = {
      ok: false,
      code: 'execution_run_not_allowed',
      message: 'Voice feature disabled',
      // @ts-expect-error Details are opaque and must originate from the canonical RPC normalizer.
      details: callerDetails,
    };
    void typeRejectedCallerFailure;
    // A JavaScript caller can still bypass TypeScript, so the runtime boundary must revalidate too.
    const callerForgedFailure = {
      ok: false,
      code: 'execution_run_not_allowed',
      message: 'Voice feature disabled',
      details: callerDetails,
    } as unknown as ExecutionRunServiceResult<unknown>;

    expect(normalizeExecutionRunToolResult(callerForgedFailure)).toEqual({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      error: 'Voice feature disabled',
      details: {
        featureId: 'voice.agent',
        blockedBy: 'dependency',
        blockerCode: 'dependency_disabled',
      },
    });
  });
});
