import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ExecutionRunStartRequestSchema } from '@happier-dev/protocol/execution/runs/startRequest';
import { EXECUTION_RUN_INTENT_POLICY_MATRIX } from '@happier-dev/protocol/execution/runs/intentPolicyMatrix';

import { executeSessionComposerResolution } from './executeSessionComposerResolution';
import { resolveSessionComposerSend } from './resolveSessionComposerSend';

describe('composer start command → Action admission', () => {
  it.each([
    { command: '/h.voice', intent: 'voice_agent', permissionMode: 'read_only' },
    { command: '/h.plan', intent: 'plan', permissionMode: 'read_only' },
    { command: '/h.delegate', intent: 'delegate', permissionMode: 'workspace_write' },
  ] as const)('starts a valid $intent run from $command', async ({ command, intent, permissionMode }) => {
    const requests: unknown[] = [];
    const executor = createActionExecutor({
      // Execution-run RPC is the external boundary; parsing, defaults, agent-start
      // admission and fanout dispatch above it are the real production owners.
      executionRunStart: async (sessionId, input) => {
        const request = ExecutionRunStartRequestSchema.parse(input);
        const policy = EXECUTION_RUN_INTENT_POLICY_MATRIX[request.intent];
        expect(policy.allowedRetentionPolicies).toContain(request.retentionPolicy);
        expect(policy.allowedRunClasses).toContain(request.runClass);
        expect(policy.allowedIoModes).toContain(request.ioMode);
        requests.push({ sessionId, ...request });
        return { runId: 'run-1', callId: 'call-1', sidechainId: 'call-1' };
      },
    });
    const text = `${command} Say ready.`;
    const modalAlert = vi.fn();
    const trackMessageSent = vi.fn();
    const setMessage = vi.fn();
    const handled = await executeSessionComposerResolution({
      resolved: resolveSessionComposerSend({ input: text, executionRunsEnabled: true, sessionId: 'session-1' }),
      sessionId: 'session-1', agentId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'default', previousMessage: text,
      actionExecutor: {
        execute: (id, input, context) => executor.execute(id, input, {
          ...context,
          // The host supplies the current Session's admitted context, as it does
          // for a present-user Action; no dispatcher or internal policy is mocked.
          agentStartContext: {
            caller: { kind: 'session', sessionId: 'session-1', starterDepth: 0, turnDepth: 0 },
            baseline: { machineId: 'machine-1', directory: '/repo' },
            roles: {}, callerPermissionCeiling: 'default', ledSubtreeSessionIds: [], workDepthLimit: 4,
          },
        }),
      },
      setMessage, clearDraft: vi.fn(), trackMessageSent,
      navigateToRuns: vi.fn(), modalAlert,
    });

    expect(handled).toBe(true);
    expect(modalAlert).not.toHaveBeenCalled();
    expect(requests).toEqual([expect.objectContaining({
      sessionId: 'session-1', intent, instructions: 'Say ready.', permissionMode,
      retentionPolicy: intent === 'voice_agent' ? 'resumable' : 'ephemeral',
      runClass: intent === 'voice_agent' ? 'long_lived' : 'bounded',
      ioMode: intent === 'voice_agent' ? 'streaming' : 'request_response',
    })]);
    expect(trackMessageSent).toHaveBeenCalledOnce();
    expect(setMessage).toHaveBeenLastCalledWith('');
  });
});
