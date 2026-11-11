import { definePlugin } from '@happier-dev/plugin-sdk';

import { OPENROUTER_PROVIDER_CONTRIBUTION } from './provider/contribution.js';
import { parseOpenRouterCredits, parseOpenRouterKeyUsage, parseOpenRouterRequestCost } from './provider/usage/parsers.js';

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.provider.openrouter',
  version: '0.0.0',
  displayName: 'OpenRouter',
  description: 'Use OpenRouter models through one provider connection.',
  brand: { iconResourceId: 'brand-icon', monochrome: true },
  resources: {
    'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' },
  },
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: { required: [], optional: [] },
  providers: {
    openrouter: { declaration: OPENROUTER_PROVIDER_CONTRIBUTION, requestCostParser: parseOpenRouterRequestCost, usageParsers: {
      'openrouter-key-usage': parseOpenRouterKeyUsage, 'openrouter-account-credits': parseOpenRouterCredits,
    } },
  },
});
