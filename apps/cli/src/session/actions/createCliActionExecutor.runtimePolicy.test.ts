import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, normalizeActionsSettingsV1, MACHINE_POOL_ACTION_IDS_V1, type ApprovalRequest } from '@happier-dev/protocol';

import { createCliActionExecutor } from './createCliActionExecutor';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { registerHappierSessionAgentToolRpc } from '@/mcp/startHappyServer';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

import {
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

// The daemon control transport is outside the Session process. Keep the real
// inventory, scoped policy and Action executor beneath this boundary.
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  readDaemonPluginCatalog: async () => ({ kind: 'available' as const, plugins: [], tools: [] }),
  requestDaemonPluginActionExecution: async () => ({ matched: false }),
}));

const denied = normalizeActionsSettingsV1({ v: 1, actions: { 'session.message.send': { enabled: false } } });
const allowed = normalizeActionsSettingsV1({ v: 1, actions: {} });

function publish(scopeKey: string, settingsVersion: number, enabled: boolean) {
  setActiveAccountSettingsSnapshot({
    scopeKey,
    settingsVersion,
    source: 'network',
    loadedAtMs: settingsVersion,
    settingsSecretsReadKeys: [],
    settings: accountSettingsParse({ actionsSettingsV1: {
      v: 1, actions: { 'session.message.send': { enabled } },
    } }),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetActiveAccountSettingsSnapshotForTests();
});

describe('runtime Actions policy binding', () => {
  it('requires an Artifact owner for durable Agent reads despite an injected Session confirmation', async () => {
    const sessionActionConfirmation = vi.fn(async () => ({ decision: 'reject' as const, isCurrent: () => true }));
    const executor = createCliActionExecutor({
      token: 'restricted-runtime-token', sessionId: 'session-a', mode: 'plain', ctx: null,
      pluginActionExecutionOwner: 'current_process',
      getCurrentSessionMetadata: () => ({}),
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({
        v: 1, actions: { 'session.activity.get': { approvalRequiredSurfaces: ['agent'] } },
      }) },
      // Human response is the real Session transport boundary.
      sessionActionConfirmation,
    });
    await expect(executor.execute('session.activity.get', { sessionId: 'session-a' }, {
      surface: 'agent', authority: 'account_automation', defaultSessionId: 'session-a',
    })).resolves.toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(sessionActionConfirmation).not.toHaveBeenCalled();
  });

  it('fails a scoped-runtime approval closed when the Session producer is unavailable', async () => {
    const harness = createCliActionExecutorHarness({
      token: 'restricted-runtime-token',
      credentials: { token: 'restricted-runtime-token', encryption: null },
      sessionId: 'session-a',
      mode: 'plain',
      ctx: null,
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({
        v: 1,
        actions: { 'session.activity.get': { approvalRequiredSurfaces: ['agent'] } },
      }) },
    });

    await expect(harness.executor.execute('session.activity.get', { sessionId: 'session-a' }, {
      surface: 'agent',
      authority: 'account_automation',
      defaultSessionId: 'session-a',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'approval_context_unavailable',
      error: 'approval_context_unavailable',
    });
    expect(harness.deps.approvalsList).toBeUndefined();
    expect(harness.deps.approvalsCreate).toBeUndefined();
    expect(harness.deps.approvalsGet).toBeUndefined();
    expect(harness.deps.approvalsUpdate).toBeUndefined();
    expect(harness.deps.sessionActivityGet).toBeTypeOf('function');
  });

  it.each(['execute', 'prepare'] as const)('refuses unavailable list access before credential refresh or external transport during %s', async (method) => {
    const readCredentials = vi.fn(async () => null);
    const executor = createCliActionExecutorFromCredentials({
      credentials: { token: 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43), credentialProvenance: 'api_token', encryption: null },
      readCredentials,
    });
    const result = await executor[method]('session.list', {}, {
      surface: 'agent', authority: 'account_automation', sessionListAccess: 'unavailable',
    });
    expect('kind' in result && result.kind === 'settled' ? result.result : result).toMatchObject({
      ok: false, errorCode: 'unsupported_action',
    });
    expect(readCredentials).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'agent_surface_denied'] as const)('prevents every Pool operation when runtime policy is %s', async (denial) => {
    const settings = normalizeActionsSettingsV1({ v: 1, actions: Object.fromEntries(
      MACHINE_POOL_ACTION_IDS_V1.map((id) => [id, denial === 'disabled'
        ? { enabled: false }
        : { disabledSurfaces: ['agent'] }]),
    ) });
    const executor = createCliActionExecutorHarness({
      token: 'runtime-alice', sessionId: 'session-a', mode: 'plain', ctx: null,
      actionsSettingsProvider: { getActionsSettings: () => settings },
    }).executor;
    const poolId = '99d55938-f860-4af8-8023-01fecec86f35';
    const inputs = {
      'machines.pools.list': {},
      'machines.pools.get': { poolId },
      'machines.pools.create': { poolId, name: { content: { t: 'plain', v: 'Development' }, recipients: [] }, members: [] },
      'machines.pools.update': { poolId, expectedRevision: 0, name: { content: { t: 'plain', v: 'Development' }, recipients: [] }, members: [] },
      'machines.pools.delete': { poolId, expectedRevision: 0 },
      'machines.pools.resolve': { poolId, requestKey: 'selection-a' },
    } as const;
    for (const actionId of MACHINE_POOL_ACTION_IDS_V1) {
      const context = { surface: 'agent' as const, authority: 'account_automation' as const, actionsSettings: allowed };
      await expect(executor.execute(actionId, inputs[actionId], context)).resolves.toMatchObject({
        ok: false, errorCode: 'action_disabled',
      });
      await expect(executor.prepare(actionId, inputs[actionId], context)).resolves.toMatchObject({
        kind: 'settled', result: { ok: false, errorCode: 'action_disabled' },
      });
    }
  });

  it.each(['execute', 'prepare'] as const)('rechecks runtime enablement after a blocking approval during %s', async (method) => {
    const lifetime = new AbortController();
    let settings = normalizeActionsSettingsV1({ v: 1, actions: {
      'action.spec.get': { approvalRequiredSurfaces: ['agent'] },
    } });
    let storedRequest: ApprovalRequest | null = null;
    const harness = createCliActionExecutorHarness({
      token: 'runtime-alice', sessionId: 'session-a', mode: 'plain', ctx: null,
      getCurrentSessionMetadata: () => ({}),
      actionsSettingsProvider: { getActionsSettings: () => settings },
    }, {
      hostActionApprovalLifetime: { actionId: 'action.spec.get', surface: 'agent', signal: lifetime.signal },
      // The Account-private Artifact store and human decision are external boundaries.
      approvalsCreate: async ({ request }) => {
        storedRequest = request;
        return { artifactId: 'approval-runtime-policy' };
      },
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }) => {
        storedRequest = request;
        return { ok: true };
      },
      approvalsWaitForDecision: async ({ request }) => {
        settings = normalizeActionsSettingsV1({ v: 1, actions: {
          'action.spec.get': { enabled: false },
        } });
        return { decision: 'approve', request };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    });

    const result = await harness.executor[method]('action.spec.get', { id: 'session.message.send' }, {
      surface: 'agent', authority: 'account_automation', defaultSessionId: 'session-a',
      serverId: 'runtime-policy-home', serverIdentityId: 'runtime-policy-home-identity',
      actionRequestId: `runtime-policy-${method}`, signal: lifetime.signal,
      defaultSessionMachineId: 'runtime-policy-machine',
    });
    if (method === 'prepare') {
      expect(result).toMatchObject({ kind: 'ready' });
      expect(storedRequest).toMatchObject({ status: 'approved' });
    }
    const execution = 'kind' in result && result.kind === 'ready' ? await result.invocation.run() : result;
    expect(execution).toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(storedRequest).toMatchObject({
      status: 'failed', execution: { ok: false, errorCode: 'action_disabled' },
    });
  });

  it('keeps reviewed policy authoritative in both executor entry points', async () => {
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify(allowed));
    publish('bob', 1, true);
    const params = {
      token: 'restricted-runtime-token',
      sessionId: 'session-a',
      mode: 'plain' as const,
      ctx: null,
      actionsSettingsProvider: { getActionsSettings: () => denied },
    };
    const executors = [
      createCliActionExecutor(params),
      createCliActionExecutorHarness(params).executor,
    ];
    for (const executor of executors) {
      const context = { surface: 'agent' as const, actionsSettings: allowed };
      await expect(executor.prepare('session.message.send', {
        sessionId: 'session-a', message: 'Do not send',
      }, context)).resolves.toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'action_disabled' } });
      await expect(executor.execute('session.message.send', {
        sessionId: 'session-a', message: 'Do not send',
      }, context)).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
    }
  });

  it('keeps the native Agent bridge bound across separately dispatched tool calls', async () => {
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
    const publishToolPolicy = (scopeKey: string, enabled: boolean, settingsVersion = 1) => setActiveAccountSettingsSnapshot({
      scopeKey, settingsVersion, source: 'network', loadedAtMs: 1, settingsSecretsReadKeys: [],
      settings: accountSettingsParse({ actionsSettingsV1: {
        v: 1, actions: { 'action.spec.get': { enabled } },
      } }),
    });
    const aliceScopeKey = resolveAccountSettingsScopeKeyForToken('runtime-alice');
    publishToolPolicy(aliceScopeKey, false);
    const aliceSettings = getActiveAccountSettingsSnapshot()!.settings;
    const serverBinding = Object.freeze({
      serverId: configuration.activeServerId,
      serverUrl: resolveServerHttpBaseUrl(),
    });
    const session = Object.assign(createMutableApiSessionClientFixture({
      sessionId: 'session-alice', serverBinding,
      metadata: createTestMetadata({ machineId: 'runtime-policy-machine' }),
    }), {
      getCurrentSessionLocation: () => ({ machineId: 'runtime-policy-machine', path: '/tmp/runtime-policy' }),
      getPermissionMode: () => 'default',
      getWorkDepth: () => 0,
      getActiveTurnPermissionWitness: () => ({
        turnId: 'alice-turn',
        workDepth: 0,
        causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' as const },
      }),
    });
    registerHappierSessionAgentToolRpc(session, {
      credentials: { token: 'runtime-alice', encryption: null },
      accountSettings: aliceSettings,
      // This is the callback supplied by runHostSessionRuntime, not a pinned fixture callback.
      getAccountSettings: () => getActiveAccountSettingsSnapshot()?.settings ?? aliceSettings,
    });
    const invoke = () => session.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1, {
      toolName: 'action_spec_get', args: { id: 'session.list' },
    });
    await expect(invoke()).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
    publishToolPolicy(aliceScopeKey, true, 2);
    await expect(invoke()).resolves.toMatchObject({ ok: true });
    publishToolPolicy(aliceScopeKey, false, 3);
    await expect(invoke()).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
    publishToolPolicy(resolveAccountSettingsScopeKeyForToken('runtime-bob'), true);
    await expect(invoke()).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
  });

  it('refreshes the bound Account without adopting another active Account', () => {
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
    publish('alice', 1, true);
    const provider = createActionSettingsProvider({ scopeKey: 'alice' });
    publish('alice', 2, false);
    expect(provider.getActionsSettings().actions['session.message.send']?.enabled).toBe(false);
    publish('bob', 1, true);
    expect(provider.getActionsSettings().actions['session.message.send']?.enabled).toBe(false);
    expect(provider.getAccountSettings()?.actionsSettingsV1.actions['session.message.send']?.enabled).toBe(false);
  });

  it('preserves callback precedence for callers without an Account scope', () => {
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
    publish('alice', 1, false);
    let callbackSettings = accountSettingsParse({ actionsSettingsV1: {
      v: 1, actions: { 'session.message.send': { enabled: true } },
    } });
    const provider = createActionSettingsProvider({ getAccountSettings: () => callbackSettings });
    expect(provider.getActionsSettings().actions['session.message.send']?.enabled).toBe(true);
    callbackSettings = accountSettingsParse({ actionsSettingsV1: {
      v: 1, actions: { 'session.message.send': { enabled: false } },
    } });
    expect(provider.getActionsSettings().actions['session.message.send']?.enabled).toBe(false);
  });
});
