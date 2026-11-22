import type { ProviderContribution } from '@happier-dev/plugin-sdk/providers';

const gatewayOrigin = 'https://ai-gateway.vercel.sh';

export const VERCEL_GATEWAY_PROVIDER_IDENTITY = { pluginId: 'happier.provider.vercel-ai-gateway', localId: 'vercel-ai-gateway' } as const;

const endpointTemplates = [
  {
    id: 'vercel-anthropic', protocol: 'anthropic',
    baseUrl: `${gatewayOrigin}/claude-code`,
    publicHeaders: { 'http-referer': 'https://happier.dev', 'x-title': 'Happier' },
    capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unsupported', reasoningControls: 'supported' },
  },
  {
    id: 'vercel-responses', protocol: 'openai-responses',
    // Codex needs the ModelsResponse metadata here; other paths use the standard handlers.
    baseUrl: `${gatewayOrigin}/codex/v1`,
    publicHeaders: { 'http-referer': 'https://happier.dev', 'x-title': 'Happier' },
    capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'supported' },
  },
  {
    id: 'vercel-chat', protocol: 'openai-chat',
    baseUrl: `${gatewayOrigin}/coding-agent/v1`,
    publicHeaders: { 'http-referer': 'https://happier.dev', 'x-title': 'Happier' },
    capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unsupported', reasoningControls: 'supported' },
  },
] satisfies ProviderContribution['endpointTemplates'];

export const VERCEL_GATEWAY_ACCOUNT_PURPOSE = {
  purpose: 'model-inference',
  service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' },
  required: false,
  credentialKinds: ['oauth'],
  materializationKinds: ['httpHeaders'],
  endpointTemplateIds: endpointTemplates.map(endpoint => endpoint.id),
  catalogObservation: { provider: VERCEL_GATEWAY_PROVIDER_IDENTITY },
} satisfies NonNullable<ProviderContribution['connectedAccounts']>[number];

export const VERCEL_AI_GATEWAY_PROVIDER_CONTRIBUTION = {
  v: 1,
  id: VERCEL_GATEWAY_PROVIDER_IDENTITY.localId,
  name: 'Vercel AI Gateway',
  websiteUrl: 'https://vercel.com/ai-gateway',
  kind: 'aggregator',
  endpointTemplates,
  connectedAccounts: [VERCEL_GATEWAY_ACCOUNT_PURPOSE],
  requestAuthUses: [{
    purpose: VERCEL_GATEWAY_ACCOUNT_PURPOSE.purpose,
    materialization: { kind: 'httpHeaders', origin: gatewayOrigin,
      headerNames: ['authorization', 'x-vercel-ai-gateway-team'], queryParameterNames: ['teamId'] },
  }],
  credential: {
    kind: 'apiKey', slotId: 'apiKey', required: true,
    keyUrl: 'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway',
    transports: [{ id: 'vercel-bearer', protocols: ['anthropic', 'openai-responses', 'openai-chat'],
      uses: ['probe', 'runtime'], destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } }],
  },
  catalog: { source: 'probe', manualModelPolicy: 'allowed',
    probes: [{ endpointTemplateId: 'vercel-chat', path: '/v1/models', parser: 'vercel-ai-gateway-models' }] },
  usageSources: [{ id: 'credits', endpointTemplateId: 'vercel-chat', path: '/v1/credits', parser: 'vercel-credits',
    connectedAccount: {
      purpose: VERCEL_GATEWAY_ACCOUNT_PURPOSE.purpose,
      headerNames: ['authorization'],
      omitMetersByPlan: [
        { planLabel: 'Enterprise', meterIds: ['balance'] },
        { planLabel: 'Flex', meterIds: ['balance'] },
      ],
    } }],
} satisfies ProviderContribution;
