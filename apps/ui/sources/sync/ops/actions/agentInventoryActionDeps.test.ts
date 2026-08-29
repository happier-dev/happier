import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';

type MachineCapabilitiesInvokeFn =
  typeof import('@/sync/ops/capabilities').machineCapabilitiesInvoke;
type MachineContributionRegistryProjectionDescribeFn =
  typeof import('@/sync/ops/machineContributionRegistryProjection').machineContributionRegistryProjectionDescribe;

const { machineCapabilitiesInvoke, machineContributionRegistryProjectionDescribe } = vi.hoisted(() => ({
  machineCapabilitiesInvoke: vi.fn<MachineCapabilitiesInvokeFn>(
    async () => ({ supported: false, reason: 'not-supported' }),
  ),
  machineContributionRegistryProjectionDescribe: vi.fn<MachineContributionRegistryProjectionDescribeFn>(
    async () => ({ supported: false, reason: 'not-supported' }) as never,
  ),
}));

vi.mock('@/sync/ops/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/sync/ops/capabilities')>();
  return {
    ...actual,
    machineCapabilitiesInvoke,
  };
});

vi.mock('@/sync/ops/machineContributionRegistryProjection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/sync/ops/machineContributionRegistryProjection')>();
  return { ...actual, machineContributionRegistryProjectionDescribe };
});

import { createDefaultActionExecutor } from './defaultActionExecutor';

const original = (() => {
  const state = storage.getState();
  return {
    settings: state.settings,
    settingsVersion: state.settingsVersion,
    profile: state.profile,
  };
})();

beforeEach(() => {
  machineCapabilitiesInvoke.mockReset();
  machineCapabilitiesInvoke.mockResolvedValue({ supported: false, reason: 'not-supported' });
  machineContributionRegistryProjectionDescribe.mockReset();
  machineContributionRegistryProjectionDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' } as never);
  const state = storage.getState();
  storage.setState({
    settings: {
      ...state.settings,
      acpCatalogSettingsV1: { v: 2 as const, backends: [] },
      backendEnabledByTargetKey: {},
    },
    profile: {
      ...(state.profile ?? {}),
      connectedAccountsV4: [{
        ref: {
          service: { pluginId: 'openai', localId: 'chatgpt' },
          accountId: 'acct-work',
        },
        status: 'connected',
        kind: 'oauth',
        authenticationModeId: 'oauth',
        configurationReady: true,
        configurationRevision: null,
        revisionSemantics: 'revisioned',
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        displayName: 'Work account',
        scopes: [],
      }],
      connectedAccountGroupsV4: [],
    },
  });
});

afterEach(() => {
  storage.setState(original);
});

describe('defaultActionExecutor canonical agent inventory corridor', () => {
  it('answers sessions.spawn.connected_services.list for a novel external qualified Agent instead of unsupported_action', async () => {
    machineContributionRegistryProjectionDescribe.mockResolvedValueOnce({
      supported: true,
      projection: {
        v: 2,
        generation: 1,
        agentsById: {
          'acme-voice-agent': {
            id: 'acme-voice-agent',
            identity: { pluginId: 'acme.voice', localId: 'agent' },
            title: 'Acme Voice Agent',
            connectedAccounts: [{
              purpose: 'models',
              service: { pluginId: 'openai', localId: 'chatgpt' },
              credentialKinds: ['oauth'],
            }],
          },
        },
        backendsById: {},
        familiesById: {},
      },
    } as never);
    const executor = createDefaultActionExecutor();

    const res = await executor.execute(
      'sessions.spawn.connected_services.list',
      { agentId: 'acme-voice-agent', backendTargetKey: 'agent:acme.voice/agent', machineId: 'machine-1' },
      { surface: 'voice', serverId: 'server-remote' },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const result = res.result as {
      agentId?: string;
      supportedServiceIds: readonly string[];
      items: readonly Readonly<{ value: string; label: string }>[];
    };
    expect(result.agentId).toBe('acme-voice-agent');
    expect(result.supportedServiceIds).toEqual(['openai/chatgpt']);
    expect(result.items).toEqual([
      expect.objectContaining({
        value: 'openai/chatgpt:profile:acct-work',
        label: 'Work account',
      }),
    ]);
    expect(machineContributionRegistryProjectionDescribe).toHaveBeenCalledWith(
      'machine-1',
      { serverId: 'server-remote' },
    );
  });

  it('answers agents.session_modes.list by probing the selected machine instead of unsupported_action', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: {
        ok: true,
        result: {
          agentId: 'acme-voice-agent',
          availableModes: [
            { id: 'build', name: 'Build', description: 'Full access' },
            { id: 'plan', name: 'Plan' },
          ],
          source: 'dynamic',
        },
      },
    } as never);
    const executor = createDefaultActionExecutor();

    const res = await executor.execute(
      'agents.session_modes.list',
      { agentId: 'acme-voice-agent', backendTargetKey: 'agent:acme.voice/agent', machineId: 'machine-1' },
      { surface: 'voice', serverId: 'server-remote' },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result).toEqual({
      agentId: 'acme-voice-agent',
      items: [
        { id: 'build', label: 'Build', description: 'Full access' },
        { id: 'plan', label: 'Plan' },
      ],
      source: 'dynamic',
    });
    expect(machineCapabilitiesInvoke).toHaveBeenCalledWith(
      'machine-1',
      expect.objectContaining({ method: 'probeModes' }),
      { serverId: 'server-remote' },
    );
  });

  it('answers agents.config_options.list by probing the selected machine instead of unsupported_action', async () => {
    machineCapabilitiesInvoke.mockResolvedValue({
      supported: true,
      response: {
        ok: true,
        result: {
          agentId: 'acme-voice-agent',
          configOptions: [
            {
              id: 'reasoning-effort',
              name: 'Reasoning effort',
              type: 'select',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'high', name: 'High', description: 'Slower' },
              ],
            },
          ],
          source: 'dynamic',
        },
      },
    } as never);
    const executor = createDefaultActionExecutor();

    const res = await executor.execute(
      'agents.config_options.list',
      { agentId: 'acme-voice-agent', backendTargetKey: 'agent:acme.voice/agent', machineId: 'machine-1' },
      { surface: 'voice', serverId: 'server-remote' },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result).toEqual({
      agentId: 'acme-voice-agent',
      items: [
        {
          id: 'reasoning-effort',
          label: 'Reasoning effort',
          type: 'select',
          options: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High', description: 'Slower' },
          ],
        },
      ],
      source: 'dynamic',
    });
    expect(machineCapabilitiesInvoke).toHaveBeenCalledWith(
      'machine-1',
      expect.objectContaining({ method: 'probeConfigOptions' }),
      { serverId: 'server-remote' },
    );
  });

  it('resolves the connected-services options source through the same canonical action options owner', async () => {
    machineContributionRegistryProjectionDescribe.mockResolvedValue({
      supported: true,
      projection: {
        v: 2,
        generation: 1,
        agentsById: {
          'acme-runtime-agent': {
            id: 'acme-runtime-agent',
            identity: { pluginId: 'acme.voice', localId: 'agent' },
            connectedAccounts: [{
              purpose: 'models',
              service: { pluginId: 'openai', localId: 'chatgpt' },
              credentialKinds: ['oauth'],
            }],
          },
        },
        backendsById: {},
        familiesById: {},
      },
    } as never);
    const executor = createDefaultActionExecutor();

    const res = await executor.execute(
      'action.options.resolve',
      {
        actionId: 'session.spawn_new',
        fieldPath: 'connectedServices',
        optionsSourceId: 'sessions.spawn.connected_services.available',
        executionTarget: { serverId: 'local', machineId: 'machine-1' },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'acme.voice', localId: 'agent' },
        },
      },
      { surface: 'voice' },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result).toMatchObject({
      options: [expect.objectContaining({ value: 'openai/chatgpt:profile:acct-work' })],
    });
    expect(machineContributionRegistryProjectionDescribe).toHaveBeenCalledWith(
      'machine-1',
      { serverId: 'local' },
    );
  });
});
