import type { ProviderContribution } from '@happier-dev/plugin-sdk/providers';

export const VERCEL_AI_GATEWAY_PROVIDER_CONTRIBUTION = {
  v: 1,
  id: 'vercel-ai-gateway',
  name: 'Vercel AI Gateway',
  websiteUrl: 'https://vercel.com/ai-gateway',
  kind: 'aggregator',
  endpointTemplates: [
    {
      id: 'vercel-anthropic', protocol: 'anthropic',
      baseUrl: 'https://ai-gateway.vercel.sh/claude-code',
      publicHeaders: { 'http-referer': 'https://happier.dev', 'x-title': 'Happier' },
      capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unsupported', reasoningControls: 'supported' },
    },
    {
      id: 'vercel-responses', protocol: 'openai-responses',
      // Codex needs the ModelsResponse metadata here; other paths use the standard handlers.
      baseUrl: 'https://ai-gateway.vercel.sh/codex/v1',
      publicHeaders: { 'http-referer': 'https://happier.dev', 'x-title': 'Happier' },
      capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'supported' },
    },
    {
      id: 'vercel-chat', protocol: 'openai-chat',
      baseUrl: 'https://ai-gateway.vercel.sh/coding-agent/v1',
      publicHeaders: { 'http-referer': 'https://happier.dev', 'x-title': 'Happier' },
      capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unsupported', reasoningControls: 'supported' },
    },
  ],
  credential: {
    kind: 'apiKey', slotId: 'apiKey', required: true,
    keyUrl: 'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway',
    transports: [{ id: 'vercel-bearer', protocols: ['anthropic', 'openai-responses', 'openai-chat'],
      uses: ['probe', 'runtime'], destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } }],
  },
  catalog: { source: 'probe', manualModelPolicy: 'allowed',
    probes: [{ endpointTemplateId: 'vercel-chat', path: '/v1/models', parser: 'vercel-ai-gateway-models' }] },
  usageSources: [{ id: 'credits', endpointTemplateId: 'vercel-chat', path: '/v1/credits', parser: 'vercel-credits' }],
} satisfies ProviderContribution;
