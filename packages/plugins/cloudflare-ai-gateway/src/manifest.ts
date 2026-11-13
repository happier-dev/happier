import { definePlugin } from '@happier-dev/plugin-sdk';
import { CLOUDFLARE_AI_GATEWAY_PROVIDER_CONTRIBUTION } from './provider/contribution.js';

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.provider.cloudflare-ai-gateway',
  version: '0.0.0',
  displayName: 'Cloudflare AI Gateway',
  description: 'Use Cloudflare AI Gateway with an account gateway token; Claude pass-through also uses your own Anthropic API key.',
  brand: { iconResourceId: 'brand-icon', monochrome: true },
  resources: {
    'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' },
  },
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: { required: [], optional: [] },
  providers: {
    'cloudflare-ai-gateway': { declaration: CLOUDFLARE_AI_GATEWAY_PROVIDER_CONTRIBUTION },
  },
});
