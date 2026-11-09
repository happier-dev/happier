import type { ProviderContribution } from '@happier-dev/plugin-sdk/providers';

const publicHeaders = {
  'cf-aig-collect-log': 'false',
  'cf-aig-no-wholesale': 'true',
  'cf-aig-skip-cache': 'true',
};
const publicHeaderHints = {
  'cf-aig-collect-log': 'False suppresses stored gateway logs; upstream retention and exports are separate.',
  'cf-aig-no-wholesale': 'True prevents third-party prepaid credit fallback.',
  'cf-aig-skip-cache': 'True bypasses response caching; upstream prompt caching is separate.',
};

export const CLOUDFLARE_AI_GATEWAY_PROVIDER_CONTRIBUTION = {
  v: 1,
  id: 'cloudflare-ai-gateway',
  name: 'Cloudflare AI Gateway',
  websiteUrl: 'https://developers.cloudflare.com/ai-gateway/',
  kind: 'aggregator',
  endpointTemplates: [{
    id: 'cloudflare-anthropic',
    protocol: 'anthropic',
    requiresEndpointOverride: true,
    addressConstraint: {
      origin: 'https://gateway.ai.cloudflare.com',
      pathSegments: ['v1', null, null, 'anthropic'],
    },
    modelIdPattern: '^claude-[^/\\s]+$',
    publicHeaders,
    publicHeaderHints,
    capabilities: {
      streaming: 'supported',
      toolRoundTrips: 'unknown',
      statefulResponses: 'unsupported',
      reasoningControls: 'unknown',
    },
  }, {
    id: 'cloudflare-responses',
    protocol: 'openai-responses',
    requiresEndpointOverride: true,
    addressConstraint: {
      origin: 'https://gateway.ai.cloudflare.com',
      pathSegments: ['v1', null, null, 'openai'],
    },
    modelIdPattern: '^(?!claude-)[^/\\s]+$',
    publicHeaders,
    publicHeaderHints,
    capabilities: {
      streaming: 'supported',
      toolRoundTrips: 'unknown',
      statefulResponses: 'unknown',
      reasoningControls: 'unknown',
    },
  }, {
    id: 'cloudflare-chat',
    protocol: 'openai-chat',
    requiresEndpointOverride: true,
    addressConstraint: {
      origin: 'https://api.cloudflare.com',
      pathSegments: ['client', 'v4', 'accounts', null, 'ai', 'v1'],
    },
    modelIdPattern: '^[^/\\s]+/[^\\s]+$',
    requiredPublicHeaders: ['cf-aig-gateway-id'],
    publicHeaders,
    publicHeaderHints: {
      ...publicHeaderHints,
      'cf-aig-gateway-id': 'The gateway id is required for account Chat routing; no default gateway is selected.',
    },
    capabilities: {
      streaming: 'supported',
      toolRoundTrips: 'unknown',
      statefulResponses: 'unsupported',
      reasoningControls: 'unknown',
    },
  }],
  credential: {
    kind: 'apiKey',
    slotId: 'apiKey',
    required: true,
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    authorityDescription: 'AI Gateway Run tokens are account-wide: they can use every gateway in that Cloudflare account, including stored BYOK credentials. Claude pass-through also requires your own Anthropic API key. Account Chat requires Workers AI Read; a token for all endpoint families needs both permissions.',
    transports: [{
      id: 'cloudflare-anthropic-gateway',
      protocols: ['anthropic'],
      uses: ['probe', 'runtime'],
      destination: { kind: 'httpHeader', name: 'cf-aig-authorization', format: 'bearer' },
      additionalCredentials: [{
        slotId: 'anthropicApiKey',
        label: 'Anthropic API key',
        destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' },
      }],
    }, {
      id: 'cloudflare-responses-gateway',
      protocols: ['openai-responses'],
      uses: ['probe', 'runtime'],
      destination: { kind: 'httpHeader', name: 'cf-aig-authorization', format: 'bearer' },
    }, {
      id: 'cloudflare-chat-account',
      protocols: ['openai-chat'],
      uses: ['probe', 'runtime'],
      destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
    }],
  },
  catalog: { source: 'manual', manualModelPolicy: 'allowed' },
} satisfies ProviderContribution;
