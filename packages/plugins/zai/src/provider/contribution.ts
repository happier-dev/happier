import type { ProviderContribution as ProviderContributionV1 } from '@happier-dev/plugin-sdk/providers';

export const ZAI_PROVIDER_CONTRIBUTION = {
  v: 1,
  id: 'zai',
  name: 'Z.AI',
  websiteUrl: 'https://z.ai',
  kind: 'frontier',
  endpointTemplates: [
    {
      id: 'zai-anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://api.z.ai/api/anthropic',
      capabilities: {
        streaming: 'supported',
        toolRoundTrips: 'supported',
        statefulResponses: 'unknown',
        reasoningControls: 'unknown',
      },
    },
    {
      id: 'zai-openai-chat',
      protocol: 'openai-chat',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      capabilities: {
        streaming: 'supported',
        toolRoundTrips: 'supported',
        statefulResponses: 'unknown',
        reasoningControls: 'unknown',
      },
    },
  ],
  credential: {
    kind: 'apiKey',
    slotId: 'apiKey',
    required: true,
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    transports: [{
      id: 'zai-http-bearer',
      protocols: ['anthropic', 'openai-chat'],
      uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
    }],
  },
  catalog: {
    source: 'static',
    manualModelPolicy: 'allowed',
    staticModels: [
      { id: 'glm-5.2', name: 'GLM-5.2' },
      { id: 'glm-5-turbo', name: 'GLM-5 Turbo' },
      { id: 'glm-4.7', name: 'GLM-4.7' },
    ],
  },
  legacyProfileMigrations: [{
    sourceProfileId: 'zai',
    descriptorRevision: 1,
    implicitModelAliasReplacements: [],
    credentialBinding: { legacyEnvVarName: 'Z_AI_AUTH_TOKEN', credentialSlotId: 'apiKey' },
    primaryModel: {
      agentTargetKey: 'agent:claude', legacyEnvVarName: 'ANTHROPIC_MODEL',
      legacyProcessEnvAlias: 'Z_AI_MODEL', defaultModelId: 'GLM-4.6',
    },
    migratedEnvironmentVariables: [
      { name: 'ANTHROPIC_BASE_URL', value: '${Z_AI_BASE_URL:-https://api.z.ai/api/anthropic}' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: '${Z_AI_AUTH_TOKEN}' },
      { name: 'ANTHROPIC_MODEL', value: '${Z_AI_MODEL:-GLM-4.6}' },
    ],
    retainedEnvironmentVariables: [
      { name: 'API_TIMEOUT_MS', value: '${Z_AI_API_TIMEOUT_MS:-3000000}' },
      { name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: '${Z_AI_OPUS_MODEL:-GLM-4.6}' },
      { name: 'ANTHROPIC_DEFAULT_SONNET_MODEL', value: '${Z_AI_SONNET_MODEL:-GLM-4.6}' },
      { name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: '${Z_AI_HAIKU_MODEL:-GLM-4.5-Air}' },
    ],
  }],
} satisfies ProviderContributionV1;
