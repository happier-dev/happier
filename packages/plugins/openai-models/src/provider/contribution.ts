import type { ProviderContributionV1 } from '@happier-dev/plugin-sdk/experimental/providers';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export const OPENAI_PROVIDER_CONTRIBUTION = {
  v: 1,
  id: 'openai',
  name: 'OpenAI',
  websiteUrl: 'https://openai.com',
  kind: 'frontier',
  endpointTemplates: [
    {
      id: 'openai-chat', protocol: 'openai-chat', baseUrl: OPENAI_BASE_URL,
      capabilities: {
        streaming: 'supported', toolRoundTrips: 'supported',
        statefulResponses: 'unknown', reasoningControls: 'supported',
      },
    },
    {
      id: 'openai-responses', protocol: 'openai-responses', baseUrl: OPENAI_BASE_URL,
      capabilities: {
        streaming: 'supported', toolRoundTrips: 'supported',
        statefulResponses: 'supported', reasoningControls: 'supported',
      },
    },
  ],
  credential: {
    kind: 'apiKey', slotId: 'apiKey', required: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    transports: [{
      id: 'openai-http-bearer', protocols: ['openai-chat', 'openai-responses'],
      uses: ['probe', 'runtime'],
      destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
    }],
  },
  catalog: {
    source: 'probe', manualModelPolicy: 'allowed',
    probes: [{ endpointTemplateId: 'openai-responses', path: '/v1/models', parser: 'openai-models' }],
  },
  legacyProfileMigrations: [{
    sourceProfileId: 'openai',
    descriptorRevision: 1,
    implicitModelAliasReplacements: [],
    credentialBinding: { legacyEnvVarName: 'OPENAI_API_KEY', credentialSlotId: 'apiKey' },
    primaryModel: { agentTargetKey: 'agent:codex', legacyEnvVarName: 'OPENAI_MODEL', defaultModelId: 'gpt-5-codex-high' },
    migratedEnvironmentVariables: [
      { name: 'OPENAI_BASE_URL', value: 'https://api.openai.com/v1' },
      { name: 'OPENAI_MODEL', value: 'gpt-5-codex-high' },
    ],
    retainedEnvironmentVariables: [
      { name: 'OPENAI_API_TIMEOUT_MS', value: '600000' },
      { name: 'OPENAI_SMALL_FAST_MODEL', value: 'gpt-5-codex-low' },
      { name: 'API_TIMEOUT_MS', value: '600000' },
      { name: 'CODEX_SMALL_FAST_MODEL', value: 'gpt-5-codex-low' },
    ],
  }],
} satisfies ProviderContributionV1;
