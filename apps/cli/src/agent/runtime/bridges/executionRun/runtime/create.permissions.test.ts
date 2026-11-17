import { describe, expect, it, vi } from 'vitest';

import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import { resolveExecutionRunPermissionInteractionMode } from '@/agent/executionRuns/policy/executionRunPermissionInteractionPolicy';
import {
  createRunScopedExecutionPermissionHandler,
  readRunScopedExecutionProviderRequestId,
} from '@/agent/executionRuns/policy/runScopedExecutionPermissionHandler';

const TEST_RECOVERY_BACKEND_ID = `${'recovery'}.${'backend'}`;

describe('execution run permission handler', () => {
  it.each(['answer', 'cancel'] as const)('routes read-only review questions by run and supports %s without allowing writes', async (completion) => {
    const published: string[] = [];
    const makeScope = (runId: string) => createRunScopedExecutionPermissionHandler({
      runId, controllerOccurrenceId: `${runId}-occurrence`, parentSessionId: null,
      handler: createExecutionRunPermissionHandler({
        backendId: 'claude', permissionMode: 'read-only',
        publishPendingRequest: ({ requestId }) => { published.push(requestId); },
      }),
      readInteractionMode: (requestKind) => resolveExecutionRunPermissionInteractionMode({
        intent: 'review', runClass: 'bounded', ioMode: 'request_response', retentionPolicy: 'ephemeral',
        permissionMode: 'read-only', parentSessionId: null, interactionTargetAvailable: true, requestKind,
        backendCapabilities: { canRespondToPermission: true, canSurfaceParentSessionPrompt: true },
      }),
    });
    const scope = makeScope('review-one');
    const other = makeScope('review-two');
    const pending = scope.handler.handleToolCall('question', 'AskUserQuestion', {
      questions: [{ question: 'Which branch?', header: 'Branch', options: [{ label: 'Main', description: 'Main branch' }], multiSelect: false }],
    });
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(other.respondToPermissionRequest('question', { decision: 'approved', answers: { Branch: 'Main' } })).toBe(false);
    await expect(scope.handler.handleToolCall('write', 'write', { path: 'file.ts', content: 'unsafe' })).resolves.toMatchObject({ decision: 'denied' });
    expect(published).toHaveLength(1);
    if (completion === 'answer') {
      expect(await scope.respondToPermissionRequest('question', { decision: 'approved', answers: { Branch: 'Main' } })).toMatchObject({ answers: { Branch: 'Main' } });
      await expect(pending).resolves.toMatchObject({ answers: { Branch: 'Main' } });
    } else {
      await scope.dispose('review stopped');
      await expect(pending).resolves.toMatchObject({ decision: 'denied' });
      expect(scope.respondToPermissionRequest('question', true)).toBe(false);
    }
    await scope.dispose('done');
    await other.dispose('done');
  });

  it.each(['auto', 'safe-yolo', 'acceptEdits'])(
    'deterministically approves residual tool calls for the %s Auto alias within its causal ceiling',
    async (permissionMode) => {
      const published: string[] = [];
      const handler = createExecutionRunPermissionHandler({
        backendId: 'copilot',
        permissionMode,
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'safe-yolo',
        },
        publishPendingRequest: ({ requestId }) => {
          published.push(requestId);
        },
      });

      await expect(handler.handleToolCall(`tool-${permissionMode}`, 'bash', {
        command: 'bash -lc "echo hi"',
      })).resolves.toEqual({ decision: 'approved_for_session' });
      expect(published).toEqual([]);
    },
  );

  it.each([
    ['default', 'default'],
    ['read-only', 'read-only'],
    ['plan', 'plan'],
  ] as const)(
    'does not let Auto bypass an admitted %s causal ceiling',
    async (_label, admittedPermissionCeiling) => {
      const handler = createExecutionRunPermissionHandler({
        backendId: 'copilot',
        permissionMode: 'auto',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling,
        },
      });

      if (admittedPermissionCeiling === 'default') {
        await expect(handler.handleToolCall('tool-auto-narrower', 'bash', {
          command: 'bash -lc "echo hi"',
        })).rejects.toMatchObject({ code: 'execution_run_interaction_unavailable' });
        return;
      }

      await expect(handler.handleToolCall('tool-auto-narrower', 'bash', {
        command: 'bash -lc "echo hi"',
      })).resolves.toEqual({ decision: 'denied' });
    },
  );

  it('fails Auto closed when supplied causal authority is malformed', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'auto',
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: 'not-a-mode',
      } as never,
    });

    await expect(handler.handleToolCall('tool-auto-malformed', 'bash', {
      command: 'bash -lc "echo hi"',
    })).resolves.toEqual({ decision: 'denied' });
  });

  it('keeps provider ids only in response routing while host request ids and disposal are controller-occurrence-scoped', async () => {
    const published: Array<{ requestId: string; providerRequestId: string }> = [];
    const canceled: string[] = [];
    const createRun = (runId: string, controllerOccurrenceId: string) => {
      const base = createExecutionRunPermissionHandler({
        backendId: 'copilot',
        permissionMode: 'default',
        publishPendingRequest: ({ requestId }) => {
          const providerRequestId = readRunScopedExecutionProviderRequestId({
            runId,
            controllerOccurrenceId,
            requestId,
          });
          if (!providerRequestId) throw new Error('missing provider request id');
          published.push({ requestId, providerRequestId });
        },
      });
      return createRunScopedExecutionPermissionHandler({
        runId,
        controllerOccurrenceId,
        handler: base,
        onPendingRequestAborted: ({ requestId }) => {
          canceled.push(requestId);
        },
      });
    };
    const runA = createRun('run-shared', 'occurrence-a');
    const runB = createRun('run-shared', 'occurrence-b');

    expect(runA.respondToPermissionRequest('provider-call-1', true)).toBe(false);

    const pendingA = runA.handler.handleToolCall('provider-call-1', 'bash', { command: 'echo a' });
    const pendingB = runB.handler.handleToolCall('provider-call-1', 'bash', { command: 'echo b' });
    expect(published).toEqual([
      { requestId: 'execution-run:run-shared:occurrence-a:provider-call-1', providerRequestId: 'provider-call-1' },
      { requestId: 'execution-run:run-shared:occurrence-b:provider-call-1', providerRequestId: 'provider-call-1' },
    ]);

    expect(runA.respondToPermissionRequest('provider-call-1', true)).toBe(true);
    await expect(pendingA).resolves.toEqual({ decision: 'approved' });
    expect(runA.respondToPermissionRequest('provider-call-1', true)).toBe(false);
    await runA.dispose('Execution run stopped');
    expect(canceled).toEqual([]);

    await runB.dispose('Execution run stopped');
    await expect(pendingB).resolves.toEqual({ decision: 'denied' });
    expect(canceled).toEqual(['execution-run:run-shared:occurrence-b:provider-call-1']);
  });

  it('keeps exact cancellation retriable when durable run cleanup fails', async () => {
    let attempts = 0;
    const base = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'default',
      publishPendingRequest: () => undefined,
    });
    const run = createRunScopedExecutionPermissionHandler({
      runId: 'run-retry',
      controllerOccurrenceId: 'run-retry-occurrence',
      handler: base,
      onPendingRequestAborted: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('persistence unavailable');
      },
    });
    const pending = run.handler.handleToolCall('provider-call', 'bash', { command: 'echo hi' });

    await expect(run.dispose('Execution run settled')).rejects.toThrow('persistence unavailable');
    await expect(pending).resolves.toEqual({ decision: 'denied' });
    await expect(run.dispose('Execution run disposed')).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it('does not let a broader execution-run mode exceed its admitted causal ceiling', () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'yolo',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
    });

    expect(handler.getImmediateDecision('causal-ceiling-run-1', 'bash', {
      command: 'bash -lc "echo hi"',
    })).toBeNull();
  });

  it('does not let Auto approve writes above a read-only causal ceiling', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'auto',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
    });

    await expect(handler.handleToolCall('tool-auto-ceiling', 'bash', {
      command: 'bash -lc "echo hi"',
    })).resolves.toEqual({ decision: 'denied' });
  });

  it('blocks write-like ACP tools for default execution runs until a response is provided', async () => {
    const published: string[] = [];
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'default',
      publishPendingRequest: ({ requestId }) => {
        published.push(requestId);
      },
    });

    let resolved = false;
    const pending = handler.handleToolCall('tool-1', 'bash', { command: 'bash -lc "echo hi"' }).then((result) => {
      resolved = true;
      return result;
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);
    expect(published).toEqual(['tool-1']);

    expect(handler.respondToPermissionRequest('tool-1', true)).toBe(true);

    await expect(pending).resolves.toEqual({ decision: 'approved' });
  });

  it('surfaces a durable interaction publication failure instead of waiting on an unanswerable request', async () => {
    const persistenceError = Object.assign(new Error('workflow interaction exceeds durable content capacity'), {
      code: 'workflow_invocation_content_too_large',
    });
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'default',
      publishPendingRequest: async () => {
        throw persistenceError;
      },
    });

    await expect(handler.handleToolCall('tool-too-large', 'bash', { command: 'large command' }))
      .rejects.toBe(persistenceError);
  });

  it('preserves the exact admitted turn id when publishing an interactive request', async () => {
    const publishPendingRequest = vi.fn(async () => undefined);
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'default',
      publishPendingRequest,
    });
    const pending = handler.handleToolCall(
      'tool-turn',
      'bash',
      { command: 'echo hi' },
      { turnId: 'native-turn-b' },
    );
    await Promise.resolve();
    expect(publishPendingRequest).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'native-turn-b' }));
    handler.respondToPermissionRequest('tool-turn', false);
    await expect(pending).resolves.toEqual({ decision: 'denied' });
  });

  it('reports an unavailable interaction target instead of denying an interactive request', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'default',
    });

    await expect(handler.handleToolCall('tool-no-target', 'bash', { command: 'echo hi' }))
      .rejects.toMatchObject({ code: 'execution_run_interaction_unavailable' });
  });

  it.each(['deterministic', 'fail_closed'] as const)(
    'denies without publishing when the canonical interaction mode is %s',
    async (interactionMode) => {
      const published: string[] = [];
      const base = createExecutionRunPermissionHandler({
        backendId: 'copilot',
        permissionMode: 'default',
        publishPendingRequest: ({ requestId }) => {
          published.push(requestId);
        },
      });
      const handler = createRunScopedExecutionPermissionHandler({
        runId: 'run-policy',
        controllerOccurrenceId: 'run-policy-occurrence',
        handler: base,
        readInteractionMode: () => interactionMode,
      }).handler;

      await expect(handler.handleToolCall('tool-no-prompt', 'bash', { command: 'echo hi' }))
        .resolves.toEqual({ decision: 'denied' });
      expect(published).toEqual([]);
    },
  );

  it('reports canonical interaction_unavailable without publishing', async () => {
    const published: string[] = [];
    const base = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'default',
      publishPendingRequest: ({ requestId }) => {
        published.push(requestId);
      },
    });
    const handler = createRunScopedExecutionPermissionHandler({
      runId: 'run-unavailable',
      controllerOccurrenceId: 'run-unavailable-occurrence',
      handler: base,
      readInteractionMode: () => 'interaction_unavailable',
    }).handler;

    await expect(handler.handleToolCall('tool-no-target-policy', 'bash', { command: 'echo hi' }))
      .rejects.toMatchObject({ code: 'execution_run_interaction_unavailable' });
    expect(published).toEqual([]);
  });

  it('keeps a detached request pending until an explicit denial is delivered', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'default',
      publishPendingRequest: () => undefined,
    });
    const pending = handler.handleToolCall('tool-deny', 'bash', { command: 'echo hi' });
    expect(handler.respondToPermissionRequest('tool-deny', false)).toBe(true);
    await expect(pending).resolves.toEqual({ decision: 'denied' });
  });

  it('rejects an unsolicited response and does not apply it to a later request reusing that id', async () => {
    const publishPendingRequest = vi.fn();
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'default',
      publishPendingRequest,
    });

    expect(handler.respondToPermissionRequest('reused-provider-id', true)).toBe(false);

    const pending = handler.handleToolCall('reused-provider-id', 'bash', { command: 'echo hi' });
    await vi.waitFor(() => expect(publishPendingRequest).toHaveBeenCalledOnce());
    let settled = false;
    void pending.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    expect(handler.respondToPermissionRequest('reused-provider-id', false)).toBe(true);
    await expect(pending).resolves.toEqual({ decision: 'denied' });
    expect(handler.respondToPermissionRequest('reused-provider-id', true)).toBe(false);
  });

  it('denies write-like ACP tools for read-only execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'read_only',
    });

    await expect(handler.handleToolCall('tool-2', 'bash', { command: 'bash -lc "echo hi"' })).resolves.toEqual({
      decision: 'denied',
    });
  });

  it('does not let an unsolicited approval bypass a narrower effective mode', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'read_only',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
    });

    expect(handler.respondToPermissionRequest('tool-buffered-read-only', true)).toBe(false);

    await expect(handler.handleToolCall(
      'tool-buffered-read-only',
      'bash',
      { command: 'bash -lc "echo hi"' },
    )).resolves.toEqual({ decision: 'denied' });
  });

  it('does not let an unsolicited approval authorize malformed causal authority', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'yolo',
    });

    expect(handler.respondToPermissionRequest('tool-buffered-malformed-authority', true)).toBe(false);

    await expect(handler.handleToolCall(
      'tool-buffered-malformed-authority',
      'bash',
      { command: 'bash -lc "echo hi"' },
      {
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'unexpected-mode',
        } as never,
      },
    )).resolves.toEqual({ decision: 'denied' });
  });

  it('does not let an unsolicited approval authorize a missing active-turn authority', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'yolo',
    });

    expect(handler.respondToPermissionRequest('tool-buffered-missing-authority', true)).toBe(false);

    await expect(handler.handleToolCall(
      'tool-buffered-missing-authority',
      'bash',
      { command: 'bash -lc "echo hi"' },
      { causalPermissionAuthority: null } as never,
    )).resolves.toEqual({ decision: 'denied' });
  });

  it('auto-approves read-like ACP tools for read-only execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: TEST_RECOVERY_BACKEND_ID,
      permissionMode: 'read_only',
    });

    await expect(handler.handleToolCall('tool-3', 'read', { path: 'README.md' })).resolves.toEqual({
      decision: 'approved',
    });
  });

  it('denies unknown, external MCP, and punctuation aliases in read-only execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: TEST_RECOVERY_BACKEND_ID,
      permissionMode: 'read_only',
    });

    await expect(handler.handleToolCall('tool-db', 'mcp__db__drop_table', {})).resolves.toEqual({
      decision: 'denied',
    });
    await expect(handler.handleToolCall('tool-k8s', 'mcp__k8s__apply_manifest', {})).resolves.toEqual({
      decision: 'denied',
    });
    await expect(handler.handleToolCall('tool-punctuation', 'r-e-a-d', {})).resolves.toEqual({
      decision: 'denied',
    });
  });

  it('allows only curated exact git inspection commands in read-only execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'claude',
      permissionMode: 'read_only',
    });

    await expect(handler.handleToolCall('git-status', 'bash', { command: 'git status' })).resolves.toEqual({
      decision: 'approved',
    });
    await expect(handler.handleToolCall('git-env', 'bash', { command: 'PATH=/tmp/evil git status' })).resolves.toEqual({
      decision: 'denied',
    });
    await expect(handler.handleToolCall('git-args', 'bash', { command: 'git status --porcelain' })).resolves.toEqual({
      decision: 'denied',
    });
    await expect(handler.handleToolCall('git-compound', 'bash', { command: 'git status && id' })).resolves.toEqual({
      decision: 'denied',
    });
  });

  it('denies all ACP tools for no_tools execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: TEST_RECOVERY_BACKEND_ID,
      permissionMode: 'no_tools',
    });

    await expect(handler.handleToolCall('tool-4', 'read', { path: 'README.md' })).resolves.toEqual({
      decision: 'denied',
    });
  });

  it('still auto-approves session_title_set for no_tools execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: TEST_RECOVERY_BACKEND_ID,
      permissionMode: 'no_tools',
    });

    await expect(handler.handleToolCall('tool-5', 'session_title_set', {})).resolves.toEqual({
      decision: 'approved',
    });
  });
});
