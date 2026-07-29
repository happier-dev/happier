import { describe, expect, it } from 'vitest';
import { ProviderContributionV1Schema } from '@happier-dev/protocol';

import { buildProviderDiscoveryEndpointOverrides } from './bridge';

const contribution = ProviderContributionV1Schema.parse({
  v: 1,
  id: 'ollama',
  name: 'Ollama',
  kind: 'local',
  endpointTemplates: [{
    id: 'native', protocol: 'ollama-native',
    localUrlCandidates: ['http://127.0.0.1:11434', 'http://localhost:11434'],
    capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unsupported', reasoningControls: 'supported' },
  }, {
    id: 'openai', protocol: 'openai-chat',
    localUrlCandidates: ['http://127.0.0.1:11434/v1', 'http://localhost:11434/v1'],
    capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unsupported', reasoningControls: 'supported' },
  }],
  catalog: {
    source: 'probe', manualModelPolicy: 'allowed',
    probes: [{ endpointTemplateId: 'native', path: '/api/tags', parser: 'ollama-tags' }],
  },
  discovery: {
    v: 1,
    listener: { executableBasenames: ['ollama'], defaultPorts: [11434] },
    availabilityProbe: { endpointTemplateId: 'native', path: '/api/tags', parser: 'ollama-tags' },
  },
});

describe('buildProviderDiscoveryEndpointOverrides', () => {
  it('projects one observed listener authority across every declared local endpoint path', () => {
    expect(buildProviderDiscoveryEndpointOverrides({
      contribution,
      endpointTemplateId: 'native',
      normalizedEndpointUrl: 'http://127.0.0.1:22434/',
    })).toEqual([
      { endpointTemplateId: 'native', baseUrl: 'http://127.0.0.1:22434/' },
      { endpointTemplateId: 'openai', baseUrl: 'http://127.0.0.1:22434/v1' },
    ]);
  });

  it('rejects a candidate path that is not the declared availability endpoint', () => {
    expect(() => buildProviderDiscoveryEndpointOverrides({
      contribution,
      endpointTemplateId: 'native',
      normalizedEndpointUrl: 'http://127.0.0.1:22434/v1',
    })).toThrow(/candidate endpoint/i);
  });

  it('rejects a contribution without the exact declared discovery endpoint', () => {
    expect(() => buildProviderDiscoveryEndpointOverrides({
      contribution,
      endpointTemplateId: 'openai',
      normalizedEndpointUrl: 'http://127.0.0.1:22434/v1',
    })).toThrow(/availability endpoint/i);
  });
});
