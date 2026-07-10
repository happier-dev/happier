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

  it('accepts bounded provider support on agents and rejects duplicate protocols/isolation keys', () => {
    const agent = {
      kindVersion: 1,
      id: 'acme.agent',
      display: { name: 'Acme Agent' },
      ownedBackendIds: [],
      runtime: { kind: 'custom' },
      providerSupport: {
        acceptsProtocols: ['openai-responses'],
        required: { streaming: true },
        credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
        authIsolation: { suppressConnectedServiceIds: ['openai-codex'], ownedEnvKeys: ['OPENAI_API_KEY'] },
        materialization: 'engineConfig',
        applyPolicy: 'restart_session',
        supportsFreeformModelIds: false,
      },
    } as const;
    expect(PluginAgentContributionV2Schema.parse(agent).providerSupport).toMatchObject({ materialization: 'engineConfig' });
    const invalid = structuredClone(agent) as any;
    invalid.providerSupport.acceptsProtocols.push('openai-responses');
    invalid.providerSupport.authIsolation.ownedEnvKeys.push('OPENAI_API_KEY');
    expect(PluginAgentContributionV2Schema.safeParse(invalid).success).toBe(false);
  });
});
