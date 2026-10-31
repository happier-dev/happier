import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import { AccountSettingsSchema, ActionsSettingsV1Schema, SessionGoalSetRequestV1Schema, SessionWorkStateGetResponseV1Schema } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';

const { nativeRpc } = vi.hoisted(() => ({
  nativeRpc: vi.fn<typeof import('@/session/transport/rpc/sessionRpc').callSessionRpc>(),
}));
vi.mock('@/session/transport/rpc/sessionRpc', () => ({ callSessionRpc: nativeRpc }));
// The machine settings file and OS host lookup are external process boundaries.
vi.mock('@/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/persistence')>()),
  readSettings: async () => ({ machineId: 'machine-test' }),
}));
vi.mock('@/daemon/machine/metadata', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/daemon/machine/metadata')>()),
  getPreferredHostName: async () => 'test-host',
}));

import { createActionToolExecutorBridge } from './createActionToolExecutorBridge';

describe('createActionToolExecutorBridge', () => {
  const envScope = createEnvKeyScope(['HAPPIER_ACTIONS_SETTINGS_V1']);
  const cleanups: Array<() => Promise<void>> = [];

  beforeEach(() => {
    envScope.patch({ HAPPIER_ACTIONS_SETTINGS_V1: undefined });
    nativeRpc.mockReset();
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    envScope.restore();
  });

  // HTTP and native session RPC are external boundaries. Keep session lookup,
  // authentication, goal routing, encrypted approvals and their coordinator real.
  async function createGoalHarness() {
    const app = Fastify();
    app.addHook('onRequest', async (request, reply) => {
      if (request.headers.authorization !== 'Bearer test-token') {
        await reply.code(401).send({ error: 'not_authenticated' });
      }
    });
    const artifacts = new Map<string, {
      id: string; header: string; body: string; dataEncryptionKey: string;
      headerVersion: number; bodyVersion: number;
    }>();
    let notifyCreated!: (id: string) => void;
    const approvalCreated = new Promise<string>((resolve) => { notifyCreated = resolve; });
    app.get<{ Params: { id: string } }>('/v2/sessions/:id', async (request) => ({
      session: createSessionRecordFixture({
        id: request.params.id, active: true, encryptionMode: 'plain', metadata: '{}',
      }),
    }));
    app.post<{ Body: { id: string; header: string; body: string; dataEncryptionKey: string } }>(
      '/v1/artifacts', async (request) => {
        artifacts.set(request.body.id, { ...request.body, headerVersion: 1, bodyVersion: 1 });
        notifyCreated(request.body.id);
        return { id: request.body.id };
      },
    );
    app.get<{ Params: { id: string } }>('/v1/artifacts/:id', async (request, reply) => {
      const artifact = artifacts.get(request.params.id);
      return artifact ?? reply.code(404).send();
    });
    app.post<{
      Params: { id: string };
      Body: { header: string; body: string; expectedHeaderVersion: number; expectedBodyVersion: number };
    }>('/v1/artifacts/:id', async (request, reply) => {
      const artifact = artifacts.get(request.params.id);
      if (!artifact) return reply.code(404).send();
      if (artifact.headerVersion !== request.body.expectedHeaderVersion
          || artifact.bodyVersion !== request.body.expectedBodyVersion) {
        return { success: false, error: 'version-mismatch' };
      }
      artifacts.set(artifact.id, {
        ...artifact, header: request.body.header, body: request.body.body,
        headerVersion: artifact.headerVersion + 1, bodyVersion: artifact.bodyVersion + 1,
      });
      return { success: true };
    });
    await app.ready();
    const restoreAdapter = installAxiosFastifyAdapter({ app, origin: new URL(resolveServerHttpBaseUrl()).origin });
    cleanups.push(async () => { restoreAdapter(); await app.close(); });

    let goal: { objective: string; status: string } | null = { objective: 'Blocked goal', status: 'blocked' };
    nativeRpc.mockImplementation(async ({ sessionId, method, request }) => {
      expect(method.startsWith(`${sessionId}:`)).toBe(true);
      if (method.endsWith(`:${SESSION_RPC_METHODS.SESSION_GOAL_CLEAR}`)) {
        goal = null;
      } else if (method.endsWith(`:${SESSION_RPC_METHODS.SESSION_GOAL_SET}`)) {
        const mutation = SessionGoalSetRequestV1Schema.parse(request);
        goal = { objective: mutation.objective ?? goal?.objective ?? '', status: mutation.status ?? 'active' };
      } else {
        expect(method).toBe(`${sessionId}:${SESSION_RPC_METHODS.SESSION_GOAL_GET}`);
      }
      return SessionWorkStateGetResponseV1Schema.parse({
        workState: {
          v: 1, backendId: 'codex', agentId: 'codex', updatedAt: 1,
          items: goal ? [{
            id: 'native-goal', kind: 'goal', origin: 'vendor', status: goal.status,
            title: goal.objective, vendorRef: 'thread-native', updatedAt: 1,
          }] : [],
          primaryItemId: goal ? 'native-goal' : null,
        },
      });
    });
    const credentials = { token: 'test-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) } };
    const harness = createCliActionExecutorHarness({
      token: 'test-token', sessionId: 'sess-current', credentials,
      ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'legacy' },
    });
    return { ...harness, approvalCreated, credentials };
  }

  it.each(['direct', 'generic'] as const)('can replace its blocked goal without a session ID through %s MCP tools', async (route) => {
    const { credentials } = await createGoalHarness();
    const { mcp } = createHappierMcpServer({
      sessionId: 'sess-current',
      rpcHandlerManager: {
        registerHandler: () => {},
        invokeLocal: async () => { throw new Error('Goal calls must use the authenticated goal router'); },
      },
      sendClaudeSessionMessage: () => {}, updateMetadata: () => {},
    }, { credentials });
    const client = new Client({ name: 'goal-regression', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    cleanups.push(async () => { await client.close(); await mcp.close(); });
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const execute = async (operation: 'get' | 'clear' | 'set', input = {}) => {
      const reply = await client.callTool(route === 'direct'
        ? { name: `session_goal_${operation}`, arguments: input }
        : { name: 'action_execute', arguments: { actionId: `session.goal.${operation}`, input } });
      expect(reply.isError).toBe(false);
      const content = reply.content;
      if (!Array.isArray(content)) throw new Error('Missing MCP result content');
      const text = content.find((part) => part.type === 'text')?.text;
      if (typeof text !== 'string') throw new Error('Missing MCP result text');
      return SessionWorkStateGetResponseV1Schema.parse(JSON.parse(text));
    };
    expect((await execute('get')).workState?.items).toMatchObject([{ title: 'Blocked goal', status: 'blocked' }]);
    expect((await execute('clear')).workState?.items).toEqual([]);
    expect((await execute('get')).workState?.items).toEqual([]);
    expect((await execute('set', { objective: 'Replacement goal' })).workState?.items)
      .toMatchObject([{ title: 'Replacement goal', status: 'active' }]);
    expect((await execute('get')).workState?.items).toMatchObject([{ title: 'Replacement goal', status: 'active' }]);
    expect(nativeRpc).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'sess-current' }));
  });

  it('preserves explicit goal targets and rejects unbound goal calls without IDs', async () => {
    const { executor } = await createGoalHarness();
    const bridge = createActionToolExecutorBridge({ executor, surface: 'mcp' });
    expect(await bridge.executeActionByToolName('session_goal_get', { sessionId: 'sess-explicit' }, 'sess-current'))
      .toMatchObject({ ok: true, result: { workState: { items: [{ status: 'blocked' }] } } });
    expect(nativeRpc).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-explicit' }));
    for (const actionId of ['session.goal.get', 'session.goal.set', 'session.goal.clear'] as const) {
      expect(await executor.execute(actionId, { objective: 'Replacement' }, { surface: 'mcp' }))
        .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    }
  });

  it('surfaces native goal transport failure without clearing or replacing the blocked goal', async () => {
    const { executor } = await createGoalHarness();
    const bridge = createActionToolExecutorBridge({ executor, surface: 'session_agent' });
    nativeRpc.mockRejectedValueOnce(new Error('Native session disconnected'));
    expect(await bridge.executeActionByToolName('session_goal_clear', {}, 'sess-current')).toMatchObject({
      result: { ok: false, errorCode: 'session_rpc_failed' },
    });
    expect(await bridge.executeActionByToolName('session_goal_get', {}, 'sess-current')).toMatchObject({
      result: { workState: { items: [{ status: 'blocked' }] } },
    });
  });

  it.each(['approve', 'reject'] as const)('waits for %s before settling a policy-gated goal clear', async (decision) => {
    envScope.patch({ HAPPIER_ACTIONS_SETTINGS_V1: JSON.stringify({
      v: 1, actions: { 'session.goal.clear': { approvalRequiredSurfaces: ['session_agent'] } },
    }) });
    const { executor, deps, approvalCreated } = await createGoalHarness();
    const bridge = createActionToolExecutorBridge({ executor, surface: 'session_agent' });
    let settled = false;
    const clear = bridge.executeActionByToolName('session_goal_clear', {}, 'sess-current').then((result) => {
      settled = true;
      return result;
    });
    const artifactId = await approvalCreated;
    const request = await deps.approvalsGet?.({ artifactId });
    expect(request?.actionArgs).toEqual({ sessionId: 'sess-current' });
    expect(settled).toBe(false);
    expect(await bridge.executeActionByToolName('session_goal_get', {}, 'sess-current')).toMatchObject({
      result: { workState: { items: [{ status: 'blocked' }] } },
    });
    expect(await executor.execute('approval.request.decide', { artifactId, decision }, { surface: 'cli' }))
      .toMatchObject({ ok: true });
    expect(await clear).toMatchObject(decision === 'approve'
      ? { ok: true, result: { workState: { items: [] } } }
      : { ok: false, errorCode: 'approval_rejected' });
    expect(await bridge.executeActionByToolName('session_goal_get', {}, 'sess-current')).toMatchObject({
      result: { workState: { items: decision === 'approve' ? [] : [{ status: 'blocked' }] } },
    });
  });

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

  it.each(['plan', 'delegate'] as const)(
    'starts a %s run through MCP when its intent action is discoverable-only',
    async (intent) => {
      const requests: unknown[] = [];
      const { mcp, toolNames } = createHappierMcpServer({
        sessionId: 'sess-current',
        getPermissionMode: () => 'default',
        rpcHandlerManager: {
          registerHandler: () => {},
          invokeLocal: async (method, request) => {
            expect(method).toBe('execution.run.start');
            requests.push(request);
            return { ok: true, data: { runId: 'run-started', callId: 'call-started', sidechainId: 'side-started' } };
          },
        },
        sendClaudeSessionMessage: () => {},
        updateMetadata: () => {},
      }, {
        accountSettings: AccountSettingsSchema.parse({
          actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1,
            actions: { 'execution.run.start': { toolExposureModes: { session_agent: 'direct' } } },
          }),
        }),
      });
      expect(toolNames).toContain('execution_run_start');
      expect(toolNames).not.toContain(`subagents_${intent}_start`);
      const client = new Client({ name: 'execution-start-regression', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      cleanups.push(async () => { await client.close(); await mcp.close(); });
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);

      const reply = await client.callTool({
        name: 'execution_run_start',
        arguments: {
          intent,
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          instructions: 'Analyze this task.',
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
        },
      });
      expect(reply.isError, JSON.stringify(reply.content)).toBe(false);
      expect(reply.content).toEqual([{ type: 'text', text: expect.stringContaining('run-started') }]);
      expect(requests).toEqual([expect.objectContaining({
        intent,
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        instructions: 'Analyze this task.',
        permissionMode: 'read_only',
        launchOrigin: { kind: 'session', sessionId: 'sess-current' },
      })]);
    },
  );

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
