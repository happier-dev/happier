import { describe, expect, it } from 'vitest';

import { PluginAgentContributionV2Schema, PluginContributesV2Schema } from './v2.js';

const capabilities = {
  streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown',
} as const;

const provider = (id: string) => ({
  v: 1,
  id,
  name: id,
  kind: 'cloud',
  endpointTemplates: [{ id: 'chat', protocol: 'openai-chat', baseUrl: 'https://example.test/v1', capabilities }],
  catalog: { source: 'manual', manualModelPolicy: 'allowed' },
}) as const;

describe('providers plugin contribution family', () => {
  it('defaults to an empty family and accepts multiple provider contributions from one plugin', () => {
    expect(PluginContributesV2Schema.parse({}).providers).toEqual([]);
    expect(PluginContributesV2Schema.parse({ providers: [provider('one'), provider('two')] }).providers.map((entry) => entry.id))
      .toEqual(['one', 'two']);
  });

  it('rejects duplicate provider ids because their qualified contribution keys would collide', () => {
    expect(PluginContributesV2Schema.safeParse({ providers: [provider('same'), provider('same')] }).success).toBe(false);
  });

  it('accepts bounded provider requirements on agents and rejects duplicate protocols/isolation keys', () => {
    const agent = {
      id: 'acme-agent',
      title: 'Acme Agent',
      runtime: { kind: 'custom' },
      primary: 'sessions',
      capabilities: {
        sessions: {
          open: ['create'],
          delivery: ['newTurn'],
          cancel: true,
        },
      },
      providerRequirements: {
        acceptsProtocols: ['openai-responses'],
        required: { streaming: true },
        credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
        authIsolation: { suppressConnectedServiceIds: ['openai-codex'], ownedEnvKeys: ['OPENAI_API_KEY'] },
        materialization: 'engineConfig',
        applyPolicy: 'restart_session',
        supportsFreeformModelIds: false,
      },
    } as const;
    expect(PluginAgentContributionV2Schema.parse(agent).providerRequirements)
      .toMatchObject({ materialization: 'engineConfig' });
    const invalid = {
      ...agent,
      providerRequirements: {
        ...agent.providerRequirements,
        acceptsProtocols: ['openai-responses', 'openai-responses'],
        authIsolation: {
          ...agent.providerRequirements.authIsolation,
          ownedEnvKeys: ['OPENAI_API_KEY', 'OPENAI_API_KEY'],
        },
      },
    } as const;
    expect(PluginAgentContributionV2Schema.safeParse(invalid).success).toBe(false);
  });

  it('declares runtime activity snapshot support only as literal true', () => {
    const agent = {
      id: 'activity-agent',
      title: 'Activity Agent',
      runtime: { kind: 'custom' },
      primary: 'sessions',
      capabilities: {
        sessions: {
          open: ['create'],
          delivery: ['newTurn'],
          cancel: true,
          runtimeActivitySnapshots: true,
        },
      },
    } as const;

    expect(PluginAgentContributionV2Schema.safeParse(agent).success).toBe(true);
    expect(PluginAgentContributionV2Schema.safeParse({
      ...agent,
      capabilities: { sessions: { ...agent.capabilities.sessions, runtimeActivitySnapshots: false } },
    }).success).toBe(false);
    expect(PluginAgentContributionV2Schema.safeParse({
      ...agent,
      capabilities: { sessions: { ...agent.capabilities.sessions, runtimeActivitySnapshots: { enabled: true } } },
    }).success).toBe(false);
  });

  it('accepts only an explicit bounded tool-delivery declaration', () => {
    const agent = {
      id: 'tool-delivery-agent',
      title: 'Tool delivery Agent',
      runtime: { kind: 'custom' },
      primary: 'sessions',
      capabilities: {
        sessions: {
          open: ['create'],
          delivery: ['newTurn'],
          cancel: true,
        },
        tools: { delivery: 'native_mcp' },
      },
    } as const;

    expect(PluginAgentContributionV2Schema.safeParse(agent).success).toBe(true);
    expect(PluginAgentContributionV2Schema.safeParse({
      ...agent,
      capabilities: { ...agent.capabilities, tools: { delivery: 'native_extension' } },
    }).success).toBe(true);
    expect(PluginAgentContributionV2Schema.safeParse({
      ...agent,
      capabilities: { ...agent.capabilities, tools: { delivery: 'shell_bridge' } },
    }).success).toBe(true);
    expect(PluginAgentContributionV2Schema.safeParse({
      ...agent,
      capabilities: { ...agent.capabilities, tools: { delivery: 'unsupported' } },
    }).success).toBe(false);
    expect(PluginAgentContributionV2Schema.safeParse({
      ...agent,
      capabilities: {
        ...agent.capabilities,
        tools: { delivery: 'native_mcp', support: 'supported' },
      },
    }).success).toBe(false);
  });

  it('rejects duplicate connected-account purposes within one Agent contribution', () => {
    const agent = {
      id: 'account-consuming-agent',
      title: 'Account-consuming Agent',
      runtime: { kind: 'custom' },
      primary: 'sessions',
      capabilities: {
        sessions: {
          open: ['create'],
          delivery: ['newTurn'],
          cancel: true,
        },
      },
      connectedAccounts: [
        {
          purpose: 'primary',
          service: { pluginId: 'happier.connected-account.openai', localId: 'openai-codex' },
        },
        {
          purpose: 'primary',
          service: { pluginId: 'happier.connected-account.claude', localId: 'claude-subscription' },
        },
      ],
    } as const;

    expect(PluginAgentContributionV2Schema.safeParse(agent).success).toBe(false);
  });
});
