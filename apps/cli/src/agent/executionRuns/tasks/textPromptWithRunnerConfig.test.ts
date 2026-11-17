import { describe, expect, it, vi } from 'vitest';
import { SessionModelRefSchema } from '@happier-dev/protocol/providers/selection/v2';
import { ExecutionRunStartRequestSchema } from '@happier-dev/protocol/execution/runs/startRequest';

import { runEphemeralExecutionRunTextPromptWithRunnerConfig } from './textPromptWithRunnerConfig';

describe('runEphemeralExecutionRunTextPromptWithRunnerConfig', () => {
  it('dispatches a configured Team model through the canonical Run Team carrier', async () => {
    const agentTargetKey = 'agent:happier.agent.codex/codex';
    const ref = { source: 'team_resource' as const, agentTargetKey, modelId: 'team-model',
      resourceId: 'team-resource', teamId: 'team', expectedResourceRevision: 3, deliveryMode: 'brokered' as const };
    const runner = { v: 1 as const, modelSelection: SessionModelRefSchema.parse(ref) };
    let admitted: ReturnType<typeof ExecutionRunStartRequestSchema.parse> | undefined;
    const executeStart = async (input: unknown) => {
      admitted = ExecutionRunStartRequestSchema.parse(input);
      return { ok: true as const,
        result: { runId: 'team-run', wait: { ok: true, status: 'succeeded', result: { latestToolResult: 'Team answer' } } } };
    };
    const params = { runner, sessionId: 'team-parent', permissionMode: 'no_tools' as const,
      intent: 'task' as const, prompt: 'Return OK', executeStart };
    await expect(runEphemeralExecutionRunTextPromptWithRunnerConfig(params)).resolves.toBe('Team answer');
    expect(admitted).toMatchObject({ teamCredentialModel: { kind: 'team_credential_provider_model',
      agentTargetKey, modelId: 'team-model', resourceId: 'team-resource', teamId: 'team',
      expectedResourceRevision: 3, deliveryMode: 'brokered' } });
    expect(admitted).not.toHaveProperty('modelSelection');
  });

  it('starts a configured ACP backend through the canonical action instead of constructing a local runtime', async () => {
    const executeStart = vi.fn(async () => ({
      ok: true as const,
      result: {
        runId: 'run_1',
        wait: {
          ok: true,
          status: 'succeeded',
          result: { latestToolResult: 'ok' },
        },
      },
    }));

    await expect(runEphemeralExecutionRunTextPromptWithRunnerConfig({
      cwd: '/tmp/workspace',
      sessionId: 'sess-1',
      runner: {
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      },
      intent: 'task',
      prompt: 'Return OK',
      executeStart,
    })).resolves.toBe('ok');

    expect(executeStart).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      intent: 'task',
      waitForCompletion: true,
    }), { surface: 'cli', authority: 'account_automation', defaultSessionId: 'sess-1' });
  });
});
