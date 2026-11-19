import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { readSessionWorkStateV1FromMetadata } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { PromptLibraryRecordV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import axios from 'axios';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { registerSessionControlHandlers } from '@/rpc/handlers/sessionControls';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createHappierMcpServer } from './createHappierMcpServer';
import type { HappyMcpSessionClient } from './startHappyServer';
import { artifactListResponse } from '@/testkit/http/artifactHome';
import { createSessionRoleContext } from '@/session/roles/sessionRoleContext';
import { createRoleSourceReader } from '@/session/roles/roleSources';
import { bindHappierSessionTasks } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionWorkState';

function goalSessionRoles(metadata: ReturnType<typeof createTestMetadata>) {
  return createSessionRoleContext({ readMetadata: () => metadata, readOrganization: async () => ({}),
    readRoleSources: createRoleSourceReader({}),
    readAccountRoleOverrides: () => ({ status: 'ready', overrides: {} }),
    readAppliedChildSelection: () => ({ status: 'applied',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      modelId: 'fixture-model', connectedServices: null }),
  });
}

describe('createHappierMcpServer goal parity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetActiveAccountSettingsSnapshotForTests();
  });

  function admitAccountSettings(token: string) {
    const settings = accountSettingsParse({});
    setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: {}, settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(token),
      promptLibraryCatalog: { status: 'ready', rows: [{ revision: 1,
        record: PromptLibraryRecordV1Schema.parse({ key: 'role-overrides', value: { v: 1, overrides: {} } }),
      }], tombstones: [], diagnostics: [] },
    });
    // Account HTTP remains outside the process; admission and Role readers use
    // their real owners and the canonical empty Account fixture.
    vi.spyOn(axios, 'get').mockImplementation(async rawUrl => {
      const path = new URL(String(rawUrl)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(String(rawUrl), []) };
      throw new Error(`Unexpected Goal Account read: ${path}`);
    });
    return settings;
  }

  it.each([
    ['request', 'session_goal_set'],
    ['host-turn', 'action_execute'],
  ] as const)('settles the real bound Goal handler on %s cancellation through %s', async (cancellation, toolName) => {
    const sessionId = 'bound-goal-cancellation';
    const metadata = createTestMetadata({ flavor: 'claude', machineId: 'machine-1', path: '/repo' });
    const sessionRoles = goalSessionRoles(metadata);
    const rpcHandlerManager = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' });
    let releaseAcknowledgement!: () => void;
    const acknowledgement = new Promise<void>(resolve => { releaseAcknowledgement = resolve; });
    let nativeControlEntered = false;
    let signalNativeEntry!: () => void;
    const nativeEntry = new Promise<void>(resolve => { signalNativeEntry = resolve; });
    let nativeEffectCompleted = false;
    // Native Agent I/O is the system boundary. The production MCP, Action,
    // router, local RPC and registered Goal handler remain real.
    registerSessionControlHandlers(rpcHandlerManager, { getSessionMetadata: () => metadata,
      sessionRuntimeControls: { setGoal: async () => {
        nativeControlEntered = true;
        signalNativeEntry();
        await acknowledgement;
        nativeEffectCompleted = true;
      } },
    });
    const hostTurn = new AbortController();
    const request = new AbortController();
    const runtime = createHappierMcpServer({ sessionId, rpcHandlerManager, updateMetadata() {},
      getServerBinding: () => ({ serverId: 'goal-home', serverUrl: 'https://goal.test' }),
      getMetadataSnapshot: () => metadata,
      getBackendTarget: () => ({ kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }),
      getSessionRoleContext: () => sessionRoles,
      getCurrentSessionLocation: () => ({ machineId: 'machine-1', path: '/repo' }),
      getPermissionMode: () => 'default', getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
      getHostTurnAbortSignal: () => hostTurn.signal,
      getActiveTurnPermissionWitness: () => ({ turnId: 'goal-turn', causalPermissionAuthority: {
        kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default',
      } }),
    }, { credentials: { token: 'goal-account', encryption: null }, accountSettings: admitAccountSettings('goal-account'),
      requiredDirectActionIds: ['session.goal.set'] });
    const client = new Client({ name: 'goal-cancellation', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let execution: Promise<unknown> | undefined;
    let staleSuccess = false;
    let handlerIdle = false;
    let toolResult: unknown;
    try {
      await runtime.mcp.connect(serverTransport);
      await client.connect(clientTransport);
      execution = client.callTool({ name: toolName, arguments: toolName === 'action_execute'
        ? { actionId: 'session.goal.set', input: { objective: 'Delayed goal' } }
        : { objective: 'Delayed goal' },
      }, CallToolResultSchema, { signal: request.signal }).then(result => {
        toolResult = result;
        staleSuccess = result.isError !== true;
        return result;
      }, (error: unknown) => { toolResult = error; throw error; });
      void execution.catch(() => undefined);
      await Promise.race([nativeEntry, execution]);
      expect(nativeControlEntered, JSON.stringify(toolResult)).toBe(true);
      void rpcHandlerManager.waitForIdle().then(() => { handlerIdle = true; });
      (cancellation === 'request' ? request : hostTurn).abort();
      await vi.waitFor(() => expect(handlerIdle, 'Cancellation must settle the actual registered Goal handler before native ACK').toBe(true));
      expect(nativeEffectCompleted).toBe(false);
      const result = await execution.catch((error: unknown) => error);
      // The MCP SDK wraps client-side signal cancellation in its request error;
      // the real local handler's independent settlement is asserted above.
      if (cancellation === 'request') expect(result).toMatchObject({ code: ErrorCode.RequestTimeout });
      else expect(result).toMatchObject({ isError: true });
      releaseAcknowledgement();
      await acknowledgement;
      await vi.waitFor(() => expect(nativeEffectCompleted).toBe(true));
      expect(staleSuccess).toBe(false);
    } finally {
      releaseAcknowledgement();
      request.abort();
      hostTurn.abort();
      await execution?.catch(() => undefined);
      await rpcHandlerManager.waitForIdle();
      await client.close();
      await runtime.mcp.close();
    }
  });

  it('replaces the bound Session task list through MCP and preserves the provider goal', async () => {
    const sessionId = 'native-task-list-session';
    let metadata = createTestMetadata({
      flavor: 'claude', machineId: 'machine-1', path: '/repo',
      sessionWorkStateV1: {
        v: 1, backendId: 'claude', updatedAt: 1,
        items: [{ id: 'vendor-goal', kind: 'goal', origin: 'vendor', status: 'active', title: 'Ship', updatedAt: 1 }],
      },
    });
    let writes = 0;
    const session = { sessionId, async updateMetadata(update: (current: typeof metadata) => typeof metadata) {
      writes++;
      metadata = update(metadata);
    } };
    const runtime = createHappierMcpServer({
      ...session,
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
      publishHappierSessionTasks: bindHappierSessionTasks({ session, occurrenceId: 'task-runner', agentId: 'claude', isCurrent: () => true }),
      getMetadataSnapshot: () => metadata,
      getBackendTarget: () => ({ kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }),
      getSessionRoleContext: () => goalSessionRoles(metadata),
      getCurrentSessionLocation: () => ({ machineId: 'machine-1', path: '/repo' }),
      getPermissionMode: () => 'default', getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
      getActiveTurnPermissionWitness: () => ({ turnId: 'task-turn', causalPermissionAuthority: {
        kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default',
      } }),
    }, {
      credentials: { token: 'task-list-account', encryption: null },
      accountSettings: admitAccountSettings('task-list-account'),
    });
    const replace = (items: readonly { title: string; status: string }[]) => runtime.executeTool({
      toolName: 'action_execute', args: { actionId: 'session.tasks.set', input: { items } },
    });
    try {
      const tasks = [{ title: 'Write test', status: 'complete' }, { title: 'Run test', status: 'active' }];
      const result = await replace(tasks);
      if (!result.ok) throw new Error(JSON.stringify(result));
      expect(readSessionWorkStateV1FromMetadata(metadata)?.items).toEqual([
        expect.objectContaining({ id: 'vendor-goal', kind: 'goal' }),
        expect.objectContaining({ title: 'Write test', kind: 'task', origin: 'happier', status: 'complete' }),
        expect.objectContaining({ title: 'Run test', kind: 'task', origin: 'happier', status: 'active' }),
      ]);
      expect(runtime.toolNames).toContain('session_tasks_set');
      expect(await runtime.executeTool({ toolName: 'session_tasks_set', args: { items: tasks } })).toMatchObject({ ok: true });
      expect(await runtime.executeTool({ toolName: 'action_execute', args: {
        actionId: 'session.tasks.set', input: { sessionId: 'another-session', items: [] },
      } })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
      expect(await replace([])).toMatchObject({ ok: true });
      expect(readSessionWorkStateV1FromMetadata(metadata)?.items).toEqual([expect.objectContaining({ id: 'vendor-goal' })]);
      expect(writes).toBe(2);
    } finally {
      await runtime.mcp.close();
    }
  });

  it('routes Claude runner goal tools through the bound live Session RPC', async () => {
    const sessionId = 'claude-live-goal-session';
    const metadata = createTestMetadata({ flavor: 'claude', machineId: 'machine-1', path: '/repo' });
    const sessionRoles = goalSessionRoles(metadata);
    const rpcHandlerManager = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' });
    const setGoal = vi.fn(async (raw: unknown) => ({
      ok: true,
      workState: {
        v: 1,
        items: [{ id: 'goal:claude', kind: 'goal', status: 'active', title: (raw as { objective: string }).objective, updatedAt: 1 }],
        primaryItemId: 'goal:claude',
      },
    }));
    rpcHandlerManager.registerHandler(SESSION_RPC_METHODS.SESSION_GOAL_SET, setGoal);
    const session: HappyMcpSessionClient = {
      sessionId,
      getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
      rpcHandlerManager,
      updateMetadata: () => undefined,
      getMetadataSnapshot: () => metadata,
      getBackendTarget: () => ({ kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }),
      getSessionRoleContext: () => sessionRoles,
      getCurrentSessionLocation: () => ({ machineId: 'machine-1', path: '/repo' }),
      getPermissionMode: () => 'default',
      getWorkDepth: () => 0,
      getHostTurnWorkDepth: (turnId: string) => turnId === 'goal-turn' ? 0 : undefined,
      getActiveTurnPermissionWitness: () => ({
        turnId: 'goal-turn',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
      }),
    };
    const runtime = createHappierMcpServer(session, {
      credentials: { token: 'claude-goal-account', encryption: null },
      accountSettings: admitAccountSettings('claude-goal-account'),
      requiredDirectActionIds: ['session.goal.set'],
    });
    try {
      const dedicated = await runtime.executeTool({
        toolName: 'session_goal_set',
        args: { objective: 'Ship dedicated goal parity' },
      });
      const generic = await runtime.executeTool({
        toolName: 'action_execute',
        args: { actionId: 'session.goal.set', input: { objective: 'Ship generic goal parity' } },
      });

      if (!dedicated.ok) throw new Error(JSON.stringify(dedicated));
      expect(generic).toMatchObject({ ok: true });
      expect(setGoal).toHaveBeenNthCalledWith(1, expect.objectContaining({ objective: 'Ship dedicated goal parity' }), expect.anything());
      expect(setGoal).toHaveBeenNthCalledWith(2, expect.objectContaining({ objective: 'Ship generic goal parity' }), expect.anything());
    } finally {
      await runtime.mcp.close();
    }
  });
});
