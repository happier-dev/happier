import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { AgentState } from '@/api/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import { createSessionActionConfirmationAdapter } from '@/session/actions/approvals/sessionActionConfirmation';
import { createScopedRuntimeActionSettingsProvider } from '@/settings/scopedRuntimeActionSettingsProvider';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createSwapAwareRpcHandlerRegistrar } from '@/agent/runtime/session/loop/createSwapAwareRpcHandlerRegistrar';
import { BasePermissionHandler } from '@/agent/permissions/BasePermissionHandler';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';

// Daemon IPC is outside the Session process; the MCP/executor/approval owners stay real.
vi.mock('@/daemon/controlClient', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  requestDaemonPluginActionExecution: async () => ({ matched: false }),
}));
afterEach(() => vi.restoreAllMocks());

class WorkerQuestionHandler extends BasePermissionHandler {
  protected getLogPrefix() { return '[C7 worker question]'; }
}

it.each(['bound', 'foreign-owner', 'missing-witness'] as const)(
  'routes an Agent MCP question to its manager only with the bound Session origin: %s', async binding => {
    const sessionId = 'c7-worker';
    // The canonical fixture substitutes Session persistence/Home facts, not
    // MCP, Action admission, RPC origin, question routing or request custody.
    const session = createMutableApiSessionClientFixture({
      sessionId: binding === 'foreign-owner' ? 'another-worker' : sessionId,
      metadata: {},
      serverBinding: { serverId: 'c7-home', serverUrl: 'https://c7-home.test' },
      agentState: { requests: {}, completedRequests: {} },
      overrides: { readQuestionSessionSnapshot: async id => ({
        sessionId: id, accountId: 'c7-account', managerSessionId: id === sessionId ? 'c7-manager' : null,
        available: true, answersWorkerQuestions: true,
      }) },
    });
    new WorkerQuestionHandler(session);
    const runtime = createHappierMcpServer({ ...session, sessionId,
      getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
      getActiveTurnPermissionWitness: () => binding === 'missing-witness' ? null : {
        turnId: 'c7-native-turn', inputId: 'c7-input',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' as const },
      },
    }, { authorityScope: 'session', sessionCredentials: { token: 'c7-session-token', encryption: null },
      actionsSettingsProvider: createScopedRuntimeActionSettingsProvider(normalizeActionsSettingsV1({ v: 1 })),
    });
    const client = new Client({ name: 'c7-question', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await runtime.mcp.connect(serverTransport);
      await client.connect(clientTransport);
      const input = {
        mode: 'continue', assumption: 'Proceed with this harmless QA check', lasting: false, type: 'decision',
        questions: [{ id: 'c7-decision', prompt: 'Should this worker record manager attribution?', type: 'text' }],
      };
      if (binding === 'bound') {
        expect((await client.listTools()).tools).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: 'session_needs_you_raise' }),
        ]));
      }
      const response = CallToolResultSchema.parse(await client.callTool(binding === 'bound'
        ? { name: 'session_needs_you_raise', arguments: input }
        : { name: 'action_execute', arguments: { actionId: 'session.needs_you.raise', input } }));
      const requests = Object.values(session.getAgentStateSnapshot()?.requests ?? {});
      if (binding === 'bound') {
        expect(response, JSON.stringify(response)).not.toHaveProperty('isError', true);
        expect(requests).toEqual([expect.objectContaining({ kind: 'user_action', source: 'session.needs_you.raise',
          turnId: 'c7-native-turn', currentHandler: { kind: 'session', sessionId: 'c7-manager' },
          questionV1: { mode: 'continue', lasting: false, type: 'decision', assumption: 'Proceed with this harmless QA check' },
          responseTarget: { kind: 'session_question_answer', sessionId, sourceTurnId: 'c7-native-turn', sourceInputId: 'c7-input' },
        })]);
      } else {
        expect(response).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining(
          binding === 'foreign-owner' ? 'question_author_forbidden' : 'target_unavailable',
        ) }] });
        expect(requests).toEqual([]);
      }
    } finally {
      await client.close();
      await runtime.mcp.close();
    }
  },
);

it.each(['approve', 'deny', 'cancel', 'foreign', 'pending-deny'] as const)('settles MCP terminal controls through the bound Session approval and transport: %s', async decision => {
  const sessionId = 'actionwait-session';
  let state: AgentState = { requests: {}, completedRequests: {} };
  const session = { sessionId, getAgentStateSnapshot: () => state,
    updateAgentState: (update: (current: AgentState) => AgentState) => { state = update(state); },
    updateAgentStateRequestSettlement: async (update: (current: AgentState) => AgentState) => {
      session.updateAgentState(update);
    } };
  const store = new AgentStateRequestStore({ session, logPrefix: '[actionwait]' });
  const lifetime = new AbortController();
  const adapter = createSessionActionConfirmationAdapter({ sessionId, store, sessionSignal: lifetime.signal,
    getAuthenticatedAccountId: async () => 'actionwait-account' });
  let rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' });
  const currentRpc = createSwapAwareRpcHandlerRegistrar(() => rpc);
  let composer = 'own terminal draft';
  // The terminal is an OS boundary; the real Action reaches its registered Session RPC.
  currentRpc.registrar.registerHandler(SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR, async () => {
    composer = '';
    return { ok: true, status: 'cleared', sessionId };
  });
  const witness = { turnId: 'actionwait-turn',
    causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' as const } };
  const runtime = createHappierMcpServer({ sessionId, rpcHandlerManager: currentRpc.registrar, updateMetadata() {},
    getMetadataSnapshot: () => ({}),
    getServerBinding: () => ({ serverId: 'actionwait-home', serverUrl: 'https://actionwait.test' }),
    getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
    getActiveTurnPermissionWitness: () => witness,
    getRuntimeLifetimeSignal: () => lifetime.signal,
    confirmSessionAction: (request, binding) => adapter.confirm(request, binding),
  }, { authorityScope: 'session',
    actionsSettingsProvider: createScopedRuntimeActionSettingsProvider(normalizeActionsSettingsV1({ v: 1,
      ...(decision === 'foreign' ? { approvalWaivedSurfaces: { 'session.terminalComposer.clear': ['agent'] } } : {}),
    })) });
  const client = new Client({ name: 'actionwait', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let execution: Promise<unknown> | undefined;
  let settled: unknown;
  try {
    await runtime.mcp.connect(serverTransport);
    await client.connect(clientTransport);
    execution = client.callTool({ name: 'action_execute', arguments: {
      actionId: decision === 'pending-deny' ? 'session.pendingInput.interruptAndRun' : 'session.terminalComposer.clear',
      input: decision === 'foreign' ? { sessionId: 'other-session' } : decision === 'pending-deny' ? { localId: 'own-pending-input' } : {},
    } }).then(result => { settled = result; return result; });
    if (decision === 'foreign') {
      // A user waiver changes approval policy, never the runner's Session custody.
      const result = CallToolResultSchema.parse(await execution);
      expect(result).toMatchObject({ isError: true, content: [{ type: 'text',
        text: expect.stringContaining('unsupported_action'),
      }] });
      expect(composer).toBe('own terminal draft');
      expect(store.listOutstandingRequests()).toHaveLength(0);
      return;
    }
    await vi.waitFor(() => expect(store.listOutstandingRequests(), JSON.stringify(settled)).toHaveLength(1));
    expect(composer).toBe('own terminal draft');
    const request = store.listOutstandingRequests()[0]!;
    expect(request).toMatchObject({ kind: 'user_action', source: 'happier_action', turnId: witness.turnId });
    if (decision === 'approve') {
      const retiredRpc = rpc;
      rpc = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' });
      currentRpc.rebindTo(rpc);
      retiredRpc.registerHandler(SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR, async () => {
        throw new Error('Local invocation reached the retired Session transport');
      });
    }
    if (decision === 'cancel') lifetime.abort();
    else await store.completeRequest({ requestId: request.requestId,
      status: decision === 'approve' ? 'approved' : 'denied',
      decision: decision === 'approve' ? 'approved' : 'denied',
      extraCompletedFields: { permissionDecisionActorV1: {
        kind: 'accountUser', accountId: 'actionwait-account', relationship: 'owner',
      } } });
    const result = CallToolResultSchema.parse(await execution);
    expect(result.isError, JSON.stringify(result.content)).toBe(decision !== 'approve');
    const text = result.content.find(block => block.type === 'text');
    expect(text?.type).toBe('text');
    const payload: unknown = text?.type === 'text' ? JSON.parse(text.text) : null;
    expect(payload).toMatchObject(decision === 'approve'
      ? { ok: true, status: 'cleared', sessionId }
      : { errorCode: decision === 'deny' || decision === 'pending-deny' ? 'approval_rejected' : 'approval_canceled' });
    expect(composer).toBe(decision === 'approve' ? '' : 'own terminal draft');
    expect(store.listOutstandingRequests()).toHaveLength(0);
  } finally {
    lifetime.abort();
    await adapter.dispose();
    await client.close();
    await runtime.mcp.close();
    await execution?.catch(() => undefined);
  }
});

it('never delivers another Session target to the host-bound terminal transport', async () => {
  let composer = 'own terminal draft';
  const rpc = new RpcHandlerManager({ scopePrefix: 'actionwait-session', encryptionMode: 'plain' });
  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR, async () => {
    composer = '';
    return { ok: true, status: 'cleared', sessionId: 'actionwait-session' };
  });
  const deps = createCliActionDeps({ token: '', sessionId: 'actionwait-session', mode: 'plain', ctx: null,
    invokeBoundSessionRpc: (method, input) => rpc.invokeLocal(method, input) });
  const result = await deps.sessionTerminalComposerClear!({ sessionId: 'other-session' });
  expect(result).toMatchObject({ ok: false, errorCode: 'not_authenticated' });
  expect(composer).toBe('own terminal draft');
});
