import { expect, it } from 'vitest';
import { z } from 'zod/mini';
import { ActionsSettingsV1Schema, createActionExecutor, waitForExecutionRunTerminal } from '@happier-dev/protocol';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { registerHappierMcpBuiltInTools } from './registerHappierMcpBuiltInTools';

it('MCP cancellation reaches the same observation Action without cancelling work', async () => {
  const controller = new AbortController();
  controller.abort();
  const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
    wait: { toolExposureModes: { mcp: 'direct' } },
  } });
  // Session RPC and the SDK registrar are system boundaries; owners remain real.
  const owner = createActionExecutor({ ...createUnavailableActionTransportDeps(), executionRunWait: async (_session, request, options) => waitForExecutionRunTerminal({
    runId: request.runId, timeoutMs: null, signal: options?.signal,
    readRun: async () => ({ ok: true, data: { run: { runId: 'run', callId: 'call', sidechainId: 'call', intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only', retentionPolicy: 'ephemeral',
      runClass: 'bounded', ioMode: 'request_response', startedAtMs: 1, status: 'failed' } } }),
    waitForTerminal: async () => { throw new Error('Already terminal'); },
  }) });
  const bridge = createActionToolExecutorBridge({ surface: 'mcp', actionsSettings, executor: {
    execute: (id, input, context) => owner.execute(id, input, { ...context, serverId: 'home' }),
  } });
  let handler: ((args: unknown, extra?: unknown) => Promise<unknown>) | undefined;
  registerHappierMcpBuiltInTools({ registerTool: (name, _meta, registered) => { if (name === 'wait') handler = registered; } }, {
    sessionId: 'session', surface: 'mcp', actionsSettings, deps: { ...bridge,
      resolveActionOptions: args => bridge.resolveActionOptions(args, 'session'),
      changeTitle: async () => { throw new Error('Unrelated tool'); } },
  });
  expect(handler).toBeDefined();
  const result = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })) }).parse(await handler!({
    target: { kind: 'execution_run', serverId: 'home', machineId: 'machine', sessionId: 'session', runId: 'run' },
    condition: { kind: 'terminal' },
  }, { signal: controller.signal }));
  expect(JSON.parse(result.content[0]!.text)).toMatchObject({ disposition: 'cancelled' });
});
