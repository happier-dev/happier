import { expect, it } from 'vitest';
import { z } from 'zod';
import { createActionExecutor, waitForExecutionRunTerminal, type ActionExecutorDeps } from '@happier-dev/protocol';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { registerHappierMcpBuiltInTools } from './registerHappierMcpBuiltInTools';

it('MCP cancellation reaches the same observation Action without cancelling work', async () => {
  const controller = new AbortController();
  controller.abort();
  // Session RPC and the SDK registrar are system boundaries; owners remain real.
  const owner = createActionExecutor({ executionRunWait: async (_session, request, options) => waitForExecutionRunTerminal({
    runId: request.runId, timeoutMs: null, signal: options?.signal,
    readRun: async () => ({ ok: true, data: { run: { runId: 'run', callId: 'call', sidechainId: 'call', intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only', retentionPolicy: 'ephemeral',
      runClass: 'bounded', ioMode: 'request_response', startedAtMs: 1, status: 'failed' } } }),
    waitForTerminal: async () => { throw new Error('Already terminal'); },
  }) } satisfies Pick<ActionExecutorDeps, 'executionRunWait'> as unknown as ActionExecutorDeps);
  const bridge = createActionToolExecutorBridge({ surface: 'mcp', executor: {
    execute: (id, input, context) => owner.execute(id, input, { ...context, serverId: 'home' }),
  } });
  let handler: ((args: unknown, extra?: unknown) => Promise<unknown>) | undefined;
  registerHappierMcpBuiltInTools({ registerTool: (name, _meta, registered) => { if (name === 'wait') handler = registered; } }, {
    sessionId: 'session', surface: 'mcp', deps: { ...bridge,
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
