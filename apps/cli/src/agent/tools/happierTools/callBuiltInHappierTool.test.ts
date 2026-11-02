import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

function createMockResolvedContributionRegistry(params?: Readonly<{
  actions?: ResolvedContributionRegistry['actions'];
}>): ResolvedContributionRegistry {
  return {
    backupDestinations: [],
    agents: [],
    actions: params?.actions ?? [],
    resources: [],
    activationTargets: [],
    actionsById: new Map<never, never>(),
    resourcesById: new Map<never, never>(),
    catalogEntriesById: {},
    agentDefinitionsById: new Map<never, never>(),
    pluginDiagnosticsByPluginId: {},
    voiceProviders: [],
    connectedAccountDescriptorsById: new Map(),
    providersByContributionKey: new Map(),
  };
}

const { getResolvedContributionRegistry } = vi.hoisted(() => ({
  getResolvedContributionRegistry: vi.fn<() => ResolvedContributionRegistry>(() => ({
    backupDestinations: [],
    agents: [],
    actions: [],
    resources: [],
    activationTargets: [],
    actionsById: new Map(),
    resourcesById: new Map(),
    catalogEntriesById: {},
    agentDefinitionsById: new Map(),
    pluginDiagnosticsByPluginId: {},
    voiceProviders: [],
    connectedAccountDescriptorsById: new Map(),
    providersByContributionKey: new Map(),
  })),
}));
const { readDaemonPluginCatalog } = vi.hoisted(() => ({
  readDaemonPluginCatalog: vi.fn(async () => ({
    kind: 'unavailable' as const,
    code: 'test_daemon_unavailable',
  })),
}));

const {
  resolveSessionTransportContext,
  updateSessionMetadataWithRetry,
  createCliActionExecutorFromCredentials,
  execute,
} = vi.hoisted(() => {
  const execute = vi.fn();
  return {
    resolveSessionTransportContext: vi.fn(),
    updateSessionMetadataWithRetry: vi.fn(),
    createCliActionExecutorFromCredentials: vi.fn(() => ({ execute })),
    execute,
  };
});
const { callSessionRpc, ensureCliActionPolicySettings } = vi.hoisted(() => ({
  callSessionRpc: vi.fn(),
  ensureCliActionPolicySettings: vi.fn(async () => undefined),
}));

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext,
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry,
}));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

vi.mock('@/session/actions/ensureCliActionPolicySettings', () => ({
  ensureCliActionPolicySettings,
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
  getResolvedContributionRegistry,
}));

vi.mock('@/daemon/controlClient', () => ({
  readDaemonPluginCatalog,
}));

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc,
}));

import { callBuiltInHappierTool } from './callBuiltInHappierTool';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { accountSettingsParse } from '@happier-dev/protocol';
import {
  commitActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';

const env = process.env;

function expectActionDisabled(result: unknown): void {
  expect(result).toMatchObject({
    ok: false,
    errorCode: 'action_disabled',
    error: 'Action is disabled',
  });
}

describe('callBuiltInHappierTool', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    execute.mockResolvedValue({ ok: true, result: { started: true } });
    createCliActionExecutorFromCredentials.mockReturnValue({
      execute,
    });
    ensureCliActionPolicySettings.mockResolvedValue(undefined);
    resetActiveAccountSettingsSnapshotForTests();
    process.env = { ...env };
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    readDaemonPluginCatalog.mockResolvedValue({
      kind: 'unavailable',
      code: 'test_daemon_unavailable',
    });
    getResolvedContributionRegistry.mockReturnValue(createMockResolvedContributionRegistry());
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession: {
        id: 'sess-1',
        metadata: { summary: { text: 'Old title' } },
      },
      ctx: null,
      mode: 'plain' as const,
    });
  });

  it('creates the shared action executor for a token-only plain Session', async () => {
    execute.mockResolvedValueOnce({ ok: true, result: { started: true } });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: null },
      sessionId: 'sess-1',
      toolName: 'action_execute',
      args: {
        actionId: 'subagents.plan.start',
        input: { backendTargetKeys: ['agent:codex'], instructions: 'Plan this change.' },
      },
    });

    expect(createCliActionExecutorFromCredentials).toHaveBeenCalledWith(expect.objectContaining({
      credentials: { token: 'token', encryption: null },
      serverId: configuration.activeServerId,
      serverApiUrl: resolveServerHttpBaseUrl(),
    }));
  });

  it('executes action_execute through the shared action executor on the CLI surface', async () => {
    execute.mockResolvedValueOnce({ ok: true, result: { started: true } });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'action_execute',
      args: {
        actionId: 'subagents.plan.start',
        input: { backendTargetKeys: ['agent:codex'], instructions: 'Plan this change.' },
      },
    });

    expect(result).toEqual({
      ok: true,
      result: { started: true },
    });
    expect(execute).toHaveBeenCalledWith(
      'subagents.plan.start',
      { backendTargetKeys: ['agent:codex'], instructions: 'Plan this change.', sessionId: 'sess-1' },
      { defaultSessionId: 'sess-1', surface: 'cli', actionsSettings: { v: 1, actions: {} } },
    );
  });

  it('routes the internal Agent bridge to the live Session tool owner without reconstructing authority', async () => {
    resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true,
      sessionId: 'sess-1',
      rawSession: { id: 'sess-1', machineId: 'machine-1', metadata: { permissionMode: 'safe-yolo' } },
      ctx: null,
      mode: 'plain' as const,
    });
    callSessionRpc.mockResolvedValueOnce({ ok: true, result: { items: [] } });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: null },
      sessionId: 'sess-1',
      toolName: 'action_execute',
      args: {
        actionId: 'memory.search',
        input: { query: { v: 1, query: 'handoff', scope: { type: 'global' }, mode: 'hints' } },
      },
      surface: 'agent',
      toolCallId: 'pi-tool-call-1',
    });

    expect(callSessionRpc).toHaveBeenCalledWith({
      token: 'token',
      sessionId: 'sess-1',
      method: 'session.agentTool.call.v1',
      request: {
        toolName: 'action_execute',
        args: {
          actionId: 'memory.search',
          input: { query: { v: 1, query: 'handoff', scope: { type: 'global' }, mode: 'hints' } },
        },
        toolCallId: 'pi-tool-call-1',
      },
      mode: 'plain',
      ctx: null,
      timeoutMs: expect.any(Number),
    });
    expect(createCliActionExecutorFromCredentials).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not decrypt mutable Session metadata in the subprocess before live authorization', async () => {
    resolveSessionTransportContext.mockResolvedValueOnce({
      ok: true,
      sessionId: 'sess-1',
      rawSession: {
        id: 'sess-1',
        machineId: 'machine-1',
        metadata: 'not-valid-encrypted-metadata',
      },
      ctx: { type: 'plain' as const },
      mode: 'e2ee' as const,
    });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    callSessionRpc.mockResolvedValueOnce({ ok: false, errorCode: 'causal_permission_authority_invalid', error: 'causal_permission_authority_invalid' });
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'action_execute',
      args: {
        actionId: 'session.message.send',
        input: { sessionId: 'sess-1', message: 'should not be sent' },
      },
      surface: 'agent',
      toolCallId: 'pi-tool-call-1',
    });

    expect(result).toEqual({ ok: false, errorCode: 'causal_permission_authority_invalid', error: 'causal_permission_authority_invalid' });
    expect(callSessionRpc).toHaveBeenCalledOnce();
    expect(createCliActionExecutorFromCredentials).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed for explicit plugin action ids that are not exposed by the authoritative registry', async () => {
    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'action_execute',
      args: {
        actionId: 'qa.self-improving.loop.tool',
        input: {},
      },
    });

    expectActionDisabled(result);
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed for runtime action ids through action_execute on the CLI tool surface', async () => {
    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'action_execute',
      args: {
        actionId: 'browser.navigate',
        input: {
          sessionId: 'sess-1',
          browserViewId: 'browser-view-1',
          url: 'https://example.test/',
        },
      },
    });

    expectActionDisabled(result);
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps ordinary action_options_resolve calls on the CLI surface', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: {
        actionId: null,
        fieldPath: null,
        optionsSourceId: 'session.modes.available',
        options: [],
      },
    });
    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'action_options_resolve',
      args: {
        optionsSourceId: 'session.modes.available',
      },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        actionId: null,
        fieldPath: null,
        optionsSourceId: 'session.modes.available',
        options: [],
      },
    });
    expect(execute).toHaveBeenCalledWith(
      'action.options.resolve',
      { optionsSourceId: 'session.modes.available', sessionId: 'sess-1' },
      expect.objectContaining({ surface: 'cli', defaultSessionId: 'sess-1' }),
    );
    expect(createCliActionExecutorFromCredentials).toHaveBeenCalledWith(expect.objectContaining({
      credentials: expect.objectContaining({ token: 'token' }),
    }));
  });

  it('preserves session resolution ambiguity details for built-in tool calls', async () => {
    resolveSessionTransportContext.mockResolvedValueOnce({
      ok: false,
      code: 'session_id_ambiguous',
      candidates: ['sess-1', 'sess-2'],
    });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess',
      toolName: 'change_title',
      args: { title: 'Renamed' },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'session_id_ambiguous',
      error: 'Session id is ambiguous',
      candidates: ['sess-1', 'sess-2'],
    });
  });

  it('reports session lookup timeouts without relabeling them as not-found', async () => {
    resolveSessionTransportContext.mockResolvedValueOnce({
      ok: false,
      code: 'session_lookup_timeout',
    });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'c000000000000000000000000',
      toolName: 'change_title',
      args: { title: 'Renamed' },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'session_lookup_timeout',
      error: 'Session lookup timed out; try again',
    });
  });

  it('routes change_title through the shared action executor on the CLI surface', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'a1', actionId: 'session.title.set' },
    });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'change_title',
      args: { title: 'Renamed' },
    });

    expect(result).toEqual({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'a1', actionId: 'session.title.set' },
    });
    expect(execute).toHaveBeenCalledWith(
      'session.title.set',
      { sessionId: 'sess-1', title: 'Renamed' },
      { defaultSessionId: 'sess-1', surface: 'cli' },
    );
    expect(updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  it('does not let process environment settings retarget a credential-scoped CLI action', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'subagents.plan.start': { enabled: true, disabledSurfaces: ['cli'], disabledPlacements: [] },
      },
    });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'action_execute',
      args: {
        actionId: 'subagents.plan.start',
        input: { backendTargetKeys: ['agent:codex'], instructions: 'Plan this change.' },
      },
    });

    expect(result).toEqual({ ok: true, result: { started: true } });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('uses the credential-scoped Account policy for direct tool admission', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    ensureCliActionPolicySettings.mockImplementation(async () => {
      commitActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({
          actionsSettingsV1: {
            v: 1,
            actions: {
              'subagents.plan.start': { disabledSurfaces: ['cli'] },
            },
          },
        }),
        settingsVersion: 1,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
        scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
      });
    });

    const direct = await callBuiltInHappierTool({
      credentials,
      sessionId: 'sess-1',
      toolName: 'execution_run_start',
      args: {
        intent: 'plan',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        instructions: 'Plan this change.',
      },
    });
    expectActionDisabled(direct);
    expect(execute).not.toHaveBeenCalled();
  });

  it('uses the post-bootstrap provider decision instead of a stale raw environment snapshot', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'subagents.plan.start': { disabledSurfaces: ['cli'] },
      },
    });
    ensureCliActionPolicySettings.mockImplementationOnce(async () => {
      delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    });

    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: null },
      sessionId: 'sess-1',
      toolName: 'action_execute',
      args: {
        actionId: 'subagents.plan.start',
        input: { backendTargetKeys: ['agent:codex'], instructions: 'Plan this change.' },
      },
    });

    expect(result).toEqual({ ok: true, result: { started: true } });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('admits memory search on the CLI surface through the shared Action executor', async () => {
    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'memory_search',
      args: {
        machineId: 'machine-1',
        query: { v: 1, query: 'needle', scope: { type: 'global' }, mode: 'hints' },
      },
    });

    expect(result).toEqual({ ok: true, result: { started: true } });
    expect(execute).toHaveBeenCalledWith('memory.search', expect.objectContaining({ machineId: 'machine-1' }),
      expect.objectContaining({ surface: 'cli' }));
  });

  it('preserves execution_run_start failures from the shared action executor', async () => {
    execute.mockResolvedValueOnce({
      ok: false,
      errorCode: 'execution_run_budget_exceeded',
      error: 'Execution run budget exceeded',
    });

    const { callBuiltInHappierTool } = await import('./callBuiltInHappierTool');
    const result = await callBuiltInHappierTool({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
      sessionId: 'sess-1',
      toolName: 'execution_run_start',
      args: {
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Review.',
      },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'execution_run_budget_exceeded',
      error: 'Execution run budget exceeded',
    });
  });
});
