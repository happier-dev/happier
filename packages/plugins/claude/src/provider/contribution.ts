import type { ProviderContribution } from '@happier-dev/plugin-sdk/providers';

import { ANTHROPIC_STATIC_MODELS } from './catalog.js';

export const ANTHROPIC_PROVIDER_CONTRIBUTION: ProviderContribution = {
  v: 1,
  id: 'anthropic',
  name: 'Anthropic',
  websiteUrl: 'https://www.anthropic.com',
  kind: 'frontier',
  endpointTemplates: [{
    id: 'anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/',
    publicHeaders: { 'anthropic-version': '2023-06-01' },
    capabilities: {
      streaming: 'supported',
      toolRoundTrips: 'supported',
      statefulResponses: 'unknown',
      reasoningControls: 'supported',
    },
  }],
  credential: {
    kind: 'apiKey',
    slotId: 'apiKey',
    required: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    transports: [{
      id: 'anthropic-x-api-key',
      protocols: ['anthropic'],
      uses: ['probe', 'runtime'],
      destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' },
    }],
  },
  catalog: {
    source: 'static+probe',
    manualModelPolicy: 'allowed',
    membershipPolicy: 'probe-authoritative',
    staticModels: ANTHROPIC_STATIC_MODELS.map(({ modelOptions, ...model }) => ({
      ...model,
      ...(modelOptions ? { modelOptions: modelOptions.map(({ options, overridesWhenOn, ...option }) => ({
        ...option,
        ...(options ? { options: [...options] } : {}),
        ...(overridesWhenOn ? { overridesWhenOn: { ...overridesWhenOn, optionIds: [...overridesWhenOn.optionIds] } } : {}),
      })) } : {}),
    })),
    probes: [{
      endpointTemplateId: 'anthropic',
      path: '/v1/models?limit=1000',
      parser: 'claude-models',
    }],
  },
};
