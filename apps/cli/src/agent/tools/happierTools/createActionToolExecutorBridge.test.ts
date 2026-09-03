import { describe, expect, it } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';

import { createActionToolExecutorBridge } from './createActionToolExecutorBridge';

describe('createActionToolExecutorBridge', () => {
  it('passes approval origin metadata through to action executor context', async () => {
    const calls: unknown[] = [];
    const actionsSettings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'session.list': {
          toolExposureModes: {
            session_agent: 'direct',
          },
        },
      },
    });
    const bridge = createActionToolExecutorBridge({
      surface: 'session_agent',
      actionsSettings,
      executor: {
        execute: async (_actionId, _input, ctx) => {
          calls.push(ctx);
          return {
            ok: true,
            result: { sessions: [] },
          };
        },
      },
    });

    const approvalOrigin = {
      kind: 'transcript_tool_call' as const,
      sessionId: 'sess-1',
      toolCallId: 'tool-1',
      toolName: 'session_list',
      toolInput: { limit: 20 },
    };
    const res = await bridge.executeActionByToolName('session_list', { limit: 20 }, 'sess-1', { approvalOrigin });

    expect(res.ok).toBe(true);
    expect(calls).toEqual([
      expect.objectContaining({
        defaultSessionId: 'sess-1',
        surface: 'session_agent',
        approvalOrigin,
      }),
    ]);
  });

  it('passes live caller permission mode through to action executor context', async () => {
    const calls: unknown[] = [];
    const actionsSettings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'session.list': {
          toolExposureModes: {
            session_agent: 'direct',
          },
        },
      },
    });
    const bridge = createActionToolExecutorBridge({
      surface: 'session_agent',
      actionsSettings,
      resolveCallerPermissionMode: () => 'yolo',
      executor: {
        execute: async (actionId, input, ctx) => {
          calls.push({ actionId, input, ctx });
          return {
            ok: true,
            result: { ok: true },
          };
        },
      },
    });

    await bridge.executeActionByToolName('action_execute', {
      actionId: 'session.spawn_new',
      input: { path: '/repo', permissionMode: 'bypassPermissions' },
    }, 'sess-1');
    await bridge.executeActionByToolName('session_list', { limit: 5 }, 'sess-1');

    expect(calls).toEqual([
      expect.objectContaining({
        actionId: 'session.spawn_new',
        ctx: expect.objectContaining({
          defaultSessionId: 'sess-1',
          surface: 'session_agent',
          callerPermissionMode: 'yolo',
        }),
      }),
      expect.objectContaining({
        actionId: 'session.list',
        ctx: expect.objectContaining({
          defaultSessionId: 'sess-1',
          surface: 'session_agent',
          callerPermissionMode: 'yolo',
        }),
      }),
    ]);
  });

  it('parses JSON-string action_execute input before invoking the action executor', async () => {
    const calls: unknown[] = [];
    const bridge = createActionToolExecutorBridge({
      surface: 'session_agent',
      executor: {
        execute: async (actionId, input, ctx) => {
          calls.push({ actionId, input, ctx });
          return {
            ok: true,
            result: { ok: true },
          };
        },
      },
    });

    const res = await bridge.executeActionByToolName('action_execute', {
      actionId: 'session.transcript.get',
      input: '{"sessionId":"sess-2","limit":20,"roles":["user","assistant"]}',
    }, 'sess-1');

    expect(res).toEqual({
      ok: true,
      result: { ok: true },
    });
    expect(calls).toEqual([
      expect.objectContaining({
        actionId: 'session.transcript.get',
        input: {
          sessionId: 'sess-2',
          limit: 20,
          roles: ['user', 'assistant'],
        },
        ctx: expect.objectContaining({
          defaultSessionId: 'sess-1',
          surface: 'session_agent',
          actionsSettings: null,
        }),
      }),
    ]);
  });

  it('binds only ActionSpec-declared current session and machine fields', async () => {
    const calls: Array<{ actionId: string; input: unknown; ctx: unknown }> = [];
    const bridge = createActionToolExecutorBridge({
      surface: 'session_agent',
      defaultSessionMachineId: 'machine-current',
      executor: {
        execute: async (actionId, input, ctx) => {
          calls.push({ actionId, input, ctx });
          return { ok: true, result: { ok: true } };
        },
      },
    });

    await bridge.executeActionByToolName('action_execute', {
      actionId: 'memory.search',
      input: { query: { v: 1, query: 'native tools', scope: { type: 'global' }, mode: 'hints' } },
    }, 'sess-current');
    await bridge.executeActionByToolName('action_execute', {
      actionId: 'memory.get_window',
      input: { seqFrom: 10, seqTo: 12 },
    }, 'sess-current');
    await bridge.executeActionByToolName('action_execute', {
      actionId: 'session.status.get',
      input: { live: true },
    }, 'sess-current');

    expect(calls).toEqual([
      expect.objectContaining({
        actionId: 'memory.search',
        input: expect.objectContaining({ machineId: 'machine-current' }),
        ctx: expect.objectContaining({ defaultSessionMachineId: 'machine-current' }),
      }),
      expect.objectContaining({
        actionId: 'memory.get_window',
        input: { machineId: 'machine-current', seqFrom: 10, seqTo: 12 },
      }),
      expect.objectContaining({
        actionId: 'session.status.get',
        input: { sessionId: 'sess-current', live: true },
      }),
    ]);
  });

  it('preserves explicit contextual values', async () => {
    const calls: unknown[] = [];
    const bridge = createActionToolExecutorBridge({
      surface: 'session_agent',
      defaultSessionMachineId: 'machine-current',
      executor: {
        execute: async (actionId, input) => {
          calls.push({ actionId, input });
          return { ok: true, result: { ok: true } };
        },
      },
    });

    await bridge.executeActionByToolName('action_execute', {
      actionId: 'memory.get_window',
      input: {
        machineId: 'machine-explicit',
        sessionId: 'sess-historical',
        seqFrom: 1,
        seqTo: 2,
      },
    }, 'sess-current');

    expect(calls).toEqual([{
      actionId: 'memory.get_window',
      input: {
        machineId: 'machine-explicit',
        sessionId: 'sess-historical',
        seqFrom: 1,
        seqTo: 2,
      },
    }]);
  });

  it('returns approved result-bearing action results without converting them to approval requests', async () => {
    const actionsSettings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'session.list': {
          toolExposureModes: {
            session_agent: 'direct',
          },
        },
      },
    });
    const bridge = createActionToolExecutorBridge({
      surface: 'session_agent',
      actionsSettings,
      executor: {
        execute: async () => ({
          ok: true,
          result: { sessions: [{ id: 'sess-1' }] },
        }),
      },
    });

    const res = await bridge.executeActionByToolName('session_list', {}, 'sess-1');

    expect(res).toEqual({
      ok: true,
      result: { sessions: [{ id: 'sess-1' }] },
    });
  });

  it('does not route discoverable-only first-party tools through direct tool names on session agents', async () => {
    const calls: unknown[] = [];
    const bridge = createActionToolExecutorBridge({
      surface: 'session_agent',
      executor: {
        execute: async (actionId, input, ctx) => {
          calls.push({ actionId, input, ctx });
          return {
            ok: true,
            result: { actionId, input, ctx },
          };
        },
      },
    });

    const res = await bridge.executeActionByToolName('subagents_delegate_start', {
      instructions: 'Delegate.',
      backendTargetKeys: ['agent:codex'],
    }, 'sess-1');

    expect(res).toEqual({
      ok: false,
      errorCode: 'unknown_tool',
      error: 'Unknown action-backed tool: subagents_delegate_start',
    });
    expect(calls).toEqual([]);
  });

  it('passes through approval_request_created results for execution.run.* actions', async () => {
    const bridge = createActionToolExecutorBridge({
      surface: 'mcp',
      executor: {
        execute: async (actionId) => ({
          ok: true,
          result: { kind: 'approval_request_created', artifactId: 'a1', actionId },
        }),
      },
    });

    const res = await bridge.executeActionByToolName('action_execute', {
      actionId: 'execution.run.start',
      input: {
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
    }, 'sess-1');

    expect(res).toEqual({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'a1', actionId: 'execution.run.start' },
    });
  });

  it('preserves start identity, effective permission, and nested wait through the public bridge', async () => {
    const bridge = createActionToolExecutorBridge({
      surface: 'session_agent',
      executor: {
        execute: async () => ({
          ok: true,
          result: {
            ok: true,
            data: {
              runId: 'run-1',
              callId: 'call-1',
              sidechainId: 'side-1',
              permissionMode: 'default',
              wait: {
                ok: true,
                status: 'running',
                disposition: 'observation_timeout',
                runId: 'run-1',
                timeoutMs: 1000,
                observedAtMs: 2000,
                deadlineAtMs: 2000,
              },
            },
          },
        }),
      },
    });

    const res = await bridge.executeActionByToolName('action_execute', {
      actionId: 'execution.run.start',
      input: {
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'default',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        waitForCompletion: true,
        waitTimeoutSeconds: 1,
      },
    }, 'session-1');

    expect(res).toMatchObject({
      ok: true,
      result: {
        runId: 'run-1',
        permissionMode: 'default',
        wait: { disposition: 'observation_timeout', runId: 'run-1' },
      },
    });
  });

  it('normalizes execution.run.wait success payloads instead of returning undefined tool content', async () => {
    const bridge = createActionToolExecutorBridge({
      surface: 'mcp',
      executor: {
        execute: async () => ({
          ok: true,
          result: {
            ok: true,
            status: 'failed',
            result: {
              run: {
                runId: 'run-1',
                status: 'failed',
              },
            },
          },
        }),
      },
    });

    const res = await bridge.executeActionByToolName('action_execute', {
      actionId: 'execution.run.wait',
      input: {
        sessionId: 'sess-1',
        runId: 'run-1',
        timeoutSeconds: 5,
      },
    }, 'sess-1');

    expect(res).toEqual({
      ok: true,
      result: {
        status: 'failed',
        result: {
          run: {
            runId: 'run-1',
            status: 'failed',
          },
        },
      },
    });
  });

  it('normalizes execution.run.wait timeout payloads into tool errors', async () => {
    const bridge = createActionToolExecutorBridge({
      surface: 'mcp',
      executor: {
        execute: async () => ({
          ok: true,
          result: {
            ok: true,
            status: 'running',
            disposition: 'observation_timeout',
            runId: 'run-1',
            timeoutMs: 5000,
            observedAtMs: 6000,
            deadlineAtMs: 6000,
          },
        }),
      },
    });

    const res = await bridge.executeActionByToolName('action_execute', {
      actionId: 'execution.run.wait',
      input: {
        sessionId: 'sess-1',
        runId: 'run-1',
        timeoutSeconds: 5,
      },
    }, 'sess-1');

    expect(res).toEqual({
      ok: true,
      result: {
        status: 'running',
        disposition: 'observation_timeout',
        runId: 'run-1',
        timeoutMs: 5000,
        observedAtMs: 6000,
        deadlineAtMs: 6000,
      },
    });
  });

  it('forwards dependent draftInput through the public option bridge', async () => {
    const calls: unknown[] = [];
    const bridge = createActionToolExecutorBridge({
      surface: 'session_agent',
      executor: {
        execute: async (actionId, input) => {
          calls.push({ actionId, input });
          return { ok: true, result: { actionId: 'subagents.delegate.start', fieldPath: 'modelId', optionsSourceId: 'agents.models.available', options: [] } };
        },
      },
    });

    await bridge.resolveActionOptions({
      actionId: 'subagents.delegate.start',
      fieldPath: 'modelId',
      optionsSourceId: null,
      sessionId: null,
      limit: null,
      query: null,
      draftInput: { backendTargetKeys: ['agent:pi'] },
    }, 'session_current');

    expect(calls).toEqual([{ actionId: 'action.options.resolve', input: {
      actionId: 'subagents.delegate.start',
      fieldPath: 'modelId',
      draftInput: { backendTargetKeys: ['agent:pi'] },
    } }]);
  });
});
