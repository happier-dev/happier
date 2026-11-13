import { expect, it } from 'vitest';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createSessionAccountActionExecutor } from './createSessionAccountActionExecutor';
import { createSessionDaemonAuthorityFixture } from './sessionDaemonAuthority.testkit';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';

it('separates fresh Agent launches with reused MCP ids while same-key recovery returns the original settlement', async () => {
  const sessionId = 'identity-parent';
  const witness = { turnId: 'identity-turn', inputId: 'identity-input', userMessageSeq: 1, userMessageSeqs: [1],
    agentStartCaller: { kind: 'session' as const, sessionId, starterDepth: 0, turnDepth: 0 } };
  const host = createHostActionOperationRuntime({ machineId: 'identity-machine', resolveAccountId: async () => 'identity-account' });
  let launches = 0;
  const ids: string[] = [];
  const daemon = await createSessionDaemonAuthorityFixture({ sessionId, execute: async operation => {
    ids.push(operation.requestId);
    const outcome = await host.observeExecution({ actionId: operation.actionId, input: operation.input,
      actionRequestId: operation.requestId, sessionId,
      // Physical child launch is the boundary. Its real retained settlement
      // must be returned without launching again on a same-key retry.
      execute: async () => ({ ok: true, result: { type: 'success', disposition: 'created',
        sessionId: `child-${++launches}`, executionTarget: { serverId: 'home', machineId: 'identity-machine' },
        organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } } }),
    });
    return outcome;
  } });
  const create = () => {
    const executor = createSessionAccountActionExecutor({
      base: createCliActionExecutor({ token: '', sessionId, mode: 'plain', ctx: null }),
      client: { sessionId, getServerBinding: () => ({ serverId: 'home', serverUrl: 'https://identity.test' }),
        rpcHandlerManager: { invokeLocal: async () => null, registerHandler() {} }, updateMetadata() {},
        getActiveTurnAdmissionWitness: () => witness },
    });
    const bridge = createActionToolExecutorBridge({ executor, surface: 'agent' });
    const handlers = new Map<string, (args: unknown, extra?: unknown) => Promise<unknown>>();
    registerHappierMcpBuiltInTools({ registerTool: (name, _meta, handler) => { handlers.set(name, handler); } }, {
      sessionId, surface: 'agent', deps: { ...bridge,
        resolveActionOptions: args => bridge.resolveActionOptions(args, sessionId),
        changeTitle: async () => ({ success: true }) },
    });
    const handler = handlers.get('action_execute');
    if (!handler) throw new Error('Missing real Action tool registration');
    return handler;
  };
  const input = (creationKey?: string) => SessionSpawnNewInputV2Schema.parse({
    ...(creationKey ? { creationKey } : {}), executionTarget: { serverId: 'home', machineId: 'identity-machine' },
    directory: { kind: 'path', path: '/workspace' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'coding' } },
    manager: { sessionId },
  });
  const invoke = async (executor: ReturnType<typeof create>, value: ReturnType<typeof input>, actionRequestId: string | number) => {
    const result = CallToolResultSchema.parse(await executor({ actionId: 'session.spawn_new', input: value }, { requestId: actionRequestId }));
    const text = result.content.find(block => block.type === 'text');
    if (text?.type !== 'text') throw new Error('Missing Action tool result');
    return { isError: result.isError, value: JSON.parse(text.text) as unknown };
  };
  try {
    const original = await invoke(create(), input('original-child'), 2);
    expect(original).toMatchObject({ isError: false, value: { sessionId: 'child-1' } });
    expect(await invoke(create(), input('fresh-child'), 2)).toMatchObject({ isError: false, value: { sessionId: 'child-2' } });
    witness.turnId = 'recovery-turn';
    expect(await invoke(create(), input('original-child'), '9')).toEqual(original);
    expect(await invoke(create(), { ...input('original-child'), directory: { kind: 'path', path: '/changed' } }, '10'))
      .toMatchObject({ isError: true, value: { errorCode: 'action_request_input_conflict' } });
    expect(launches).toBe(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[2]).toBe(ids[0]);
    expect(ids[3]).toBe(ids[0]);
    // A new client may reuse its counter against the same live MCP server.
    // Without an explicit creation key these are distinct invocations.
    const connection = create();
    expect(await invoke(connection, input(), '2')).toMatchObject({ isError: false, value: { sessionId: 'child-3' } });
    expect(await invoke(connection, input(), '2')).toMatchObject({ isError: false, value: { sessionId: 'child-4' } });
    // The public key has no length cap; the private request id has a 512-character
    // envelope bound. A valid key beyond that bound must still reach its owner.
    expect(await invoke(connection, input('k'.repeat(513)), 2))
      .toMatchObject({ isError: false, value: { sessionId: 'child-5' } });
  } finally {
    await daemon.close();
  }
});
