import { definePlugin } from '@happier-dev/plugin-sdk';

import { DEEPSEEK_PROVIDER_CONTRIBUTION } from './provider/contribution.js';
import { parseDeepSeekBalance } from './provider/usage/parsers.js';

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.provider.deepseek',
  version: '0.0.0',
  displayName: 'DeepSeek',
  description: 'Use DeepSeek models through Anthropic- or OpenAI-compatible agents.',
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  brand: { iconResourceId: 'brand-icon', monochrome: true },
  resources: {
    'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' },
  },
  hostAccess: { required: [], optional: [] },
  providers: {
    deepseek: { declaration: DEEPSEEK_PROVIDER_CONTRIBUTION,
      usageParsers: { 'deepseek-balance': parseDeepSeekBalance } },
  },
});
