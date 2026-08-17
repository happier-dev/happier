import type { ProviderContribution as ProviderContributionV1 } from '@happier-dev/plugin-sdk/providers';

export const DEEPSEEK_PROVIDER_CONTRIBUTION = {
  v: 1,
  id: 'deepseek',
  name: 'DeepSeek',
  websiteUrl: 'https://www.deepseek.com',
  kind: 'frontier',
  endpointTemplates: [
    {
      id: 'deepseek-anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://api.deepseek.com/anthropic',
      capabilities: {
        streaming: 'supported',
        toolRoundTrips: 'supported',
        statefulResponses: 'unknown',
        reasoningControls: 'unknown',
      },
    },
    {
      id: 'deepseek-openai-chat',
      protocol: 'openai-chat',
      baseUrl: 'https://api.deepseek.com/v1',
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
    keyUrl: 'https://platform.deepseek.com/api_keys',
    transports: [
      {
        id: 'deepseek-anthropic-x-api-key',
        protocols: ['anthropic'],
        uses: ['runtime'],
        destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' },
      },
      {
        id: 'deepseek-openai-bearer',
        protocols: ['openai-chat'],
        uses: ['probe', 'runtime'],
        destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
      },
    ],
  },
  catalog: {
    source: 'static+probe',
    manualModelPolicy: 'allowed',
    staticModels: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ],
    probes: [{ endpointTemplateId: 'deepseek-openai-chat', path: '/v1/models', parser: 'openai-models' }],
  },
  legacyProfileMigrations: [{
    sourceProfileId: 'deepseek',
    descriptorRevision: 2,
    implicitModelAliasReplacements: [
      { legacyModelId: 'deepseek-chat', replacementModelId: 'deepseek-v4-flash' },
      { legacyModelId: 'deepseek-reasoner', replacementModelId: 'deepseek-v4-flash' },
    ],
    credentialBinding: { legacyEnvVarName: 'DEEPSEEK_AUTH_TOKEN', credentialSlotId: 'apiKey' },
    primaryModel: {
      agentTargetKey: 'agent:claude', legacyEnvVarName: 'ANTHROPIC_MODEL',
      legacyProcessEnvAlias: 'DEEPSEEK_MODEL', defaultModelId: 'deepseek-v4-flash',
    },
    migratedEnvironmentVariables: [
      { name: 'ANTHROPIC_BASE_URL', value: '${DEEPSEEK_BASE_URL:-https://api.deepseek.com/anthropic}' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' },
      { name: 'ANTHROPIC_MODEL', value: '${DEEPSEEK_MODEL:-deepseek-v4-flash}' },
    ],
    retainedEnvironmentVariables: [
      { name: 'API_TIMEOUT_MS', value: '${DEEPSEEK_API_TIMEOUT_MS:-600000}' },
      { name: 'ANTHROPIC_SMALL_FAST_MODEL', value: '${DEEPSEEK_SMALL_FAST_MODEL:-deepseek-v4-flash}' },
      { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '${DEEPSEEK_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}' },
    ],
  }],
} satisfies ProviderContributionV1;
