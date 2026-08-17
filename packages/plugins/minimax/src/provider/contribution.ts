import type { ProviderContribution as ProviderContributionV1 } from '@happier-dev/plugin-sdk/providers';

/**
 * MiniMax publishes two regional deployments with disjoint key namespaces: a key
 * issued on api.minimax.io is rejected by api.minimaxi.com and vice versa. A
 * contribution may declare only one endpoint per wire protocol, so each region is
 * its own provider rather than a switch inside one provider — which also matches
 * how users actually hold the credential.
 */

const MINIMAX_MODELS = [
  {
    id: 'MiniMax-M3',
    name: 'MiniMax M3',
    contextWindowTokens: 1_000_000,
    // MiniMax gates M3's full window behind a `[1m]` model id, the same
    // extended-context convention Claude models use. Declaring it here lets the
    // agent request the extended variant instead of every caller learning the
    // suffix, and keeps the legacy profile's hardcoded id from becoming the only
    // way to reach 1M.
    extendedContextModelId: 'MiniMax-M3[1m]',
    // Both regional Claude Code and Codex CLI guides drive these models through
    // tool-calling agents, so tool round trips are a documented model capability
    // rather than an assumption. Agents that require it resolve as verified
    // instead of degrading to an experimental badge.
    capabilities: { toolRoundTrips: 'supported' },
  },
  {
    id: 'MiniMax-M2.7',
    name: 'MiniMax M2.7',
    contextWindowTokens: 204_800,
    capabilities: { toolRoundTrips: 'supported' },
  },
] as const;

export const MINIMAX_PROVIDER_CONTRIBUTION = {
  v: 1,
  id: 'minimax',
  name: 'MiniMax',
  websiteUrl: 'https://platform.minimax.io',
  kind: 'frontier',
  endpointTemplates: [
    {
      id: 'minimax-anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://api.minimax.io/anthropic',
      capabilities: {
        streaming: 'supported',
        toolRoundTrips: 'supported',
        statefulResponses: 'unknown',
        reasoningControls: 'unknown',
      },
    },
    {
      id: 'minimax-openai-responses',
      protocol: 'openai-responses',
      baseUrl: 'https://api.minimax.io/v1',
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
    keyUrl: 'https://platform.minimax.io/user-center/payment/token-plan',
    transports: [{
      id: 'minimax-http-bearer',
      protocols: ['anthropic', 'openai-responses'],
      uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
    }],
  },
  catalog: {
    source: 'static',
    manualModelPolicy: 'allowed',
    staticModels: [...MINIMAX_MODELS],
  },
  legacyProfileMigrations: [{
    sourceProfileId: 'minimax',
    descriptorRevision: 1,
    // The legacy profile pins the extended-context id directly in ANTHROPIC_MODEL.
    // Migrate it onto the canonical catalog model, which carries the same variant
    // as a declared capability rather than a magic string.
    implicitModelAliasReplacements: [
      { legacyModelId: 'MiniMax-M3[1m]', replacementModelId: 'MiniMax-M3' },
    ],
    credentialBinding: { legacyEnvVarName: 'MINIMAX_AUTH_TOKEN', credentialSlotId: 'apiKey' },
    primaryModel: {
      agentTargetKey: 'agent:claude', legacyEnvVarName: 'ANTHROPIC_MODEL',
      legacyProcessEnvAlias: 'MINIMAX_MODEL', defaultModelId: 'MiniMax-M3',
    },
    migratedEnvironmentVariables: [
      { name: 'ANTHROPIC_BASE_URL', value: '${MINIMAX_BASE_URL:-https://api.minimax.io/anthropic}' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: '${MINIMAX_AUTH_TOKEN}' },
      { name: 'ANTHROPIC_MODEL', value: '${MINIMAX_MODEL:-MiniMax-M3[1m]}' },
    ],
    retainedEnvironmentVariables: [
      { name: 'API_TIMEOUT_MS', value: '${MINIMAX_API_TIMEOUT_MS:-600000}' },
      { name: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', value: '${MINIMAX_AUTO_COMPACT_WINDOW:-1000000}' },
      { name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: '${MINIMAX_OPUS_MODEL:-MiniMax-M3[1m]}' },
      { name: 'ANTHROPIC_DEFAULT_SONNET_MODEL', value: '${MINIMAX_SONNET_MODEL:-MiniMax-M3[1m]}' },
      { name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: '${MINIMAX_HAIKU_MODEL:-MiniMax-M2.7}' },
      { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '${MINIMAX_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}' },
    ],
  }],
} satisfies ProviderContributionV1;

export const MINIMAX_CN_PROVIDER_CONTRIBUTION = {
  v: 1,
  id: 'minimax-cn',
  name: 'MiniMax (China)',
  websiteUrl: 'https://platform.minimaxi.com',
  kind: 'frontier',
  endpointTemplates: [
    {
      id: 'minimax-cn-anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      capabilities: {
        streaming: 'supported',
        toolRoundTrips: 'supported',
        statefulResponses: 'unknown',
        reasoningControls: 'unknown',
      },
    },
    {
      id: 'minimax-cn-openai-responses',
      protocol: 'openai-responses',
      baseUrl: 'https://api.minimaxi.com/v1',
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
    keyUrl: 'https://platform.minimaxi.com/user-center/payment/token-plan',
    transports: [{
      id: 'minimax-cn-http-bearer',
      protocols: ['anthropic', 'openai-responses'],
      uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
    }],
  },
  catalog: {
    source: 'static',
    manualModelPolicy: 'allowed',
    staticModels: [...MINIMAX_MODELS],
  },
  legacyProfileMigrations: [{
    sourceProfileId: 'minimax-cn',
    descriptorRevision: 1,
    implicitModelAliasReplacements: [
      { legacyModelId: 'MiniMax-M3[1m]', replacementModelId: 'MiniMax-M3' },
    ],
    credentialBinding: { legacyEnvVarName: 'MINIMAX_CN_AUTH_TOKEN', credentialSlotId: 'apiKey' },
    primaryModel: {
      agentTargetKey: 'agent:claude', legacyEnvVarName: 'ANTHROPIC_MODEL',
      legacyProcessEnvAlias: 'MINIMAX_CN_MODEL', defaultModelId: 'MiniMax-M3',
    },
    migratedEnvironmentVariables: [
      { name: 'ANTHROPIC_BASE_URL', value: '${MINIMAX_CN_BASE_URL:-https://api.minimaxi.com/anthropic}' },
      { name: 'ANTHROPIC_AUTH_TOKEN', value: '${MINIMAX_CN_AUTH_TOKEN}' },
      { name: 'ANTHROPIC_MODEL', value: '${MINIMAX_CN_MODEL:-MiniMax-M3[1m]}' },
    ],
    retainedEnvironmentVariables: [
      { name: 'API_TIMEOUT_MS', value: '${MINIMAX_CN_API_TIMEOUT_MS:-600000}' },
      { name: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', value: '${MINIMAX_CN_AUTO_COMPACT_WINDOW:-1000000}' },
      { name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: '${MINIMAX_CN_OPUS_MODEL:-MiniMax-M3[1m]}' },
      { name: 'ANTHROPIC_DEFAULT_SONNET_MODEL', value: '${MINIMAX_CN_SONNET_MODEL:-MiniMax-M3[1m]}' },
      { name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: '${MINIMAX_CN_HAIKU_MODEL:-MiniMax-M2.7}' },
      { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '${MINIMAX_CN_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}' },
    ],
  }],
} satisfies ProviderContributionV1;
