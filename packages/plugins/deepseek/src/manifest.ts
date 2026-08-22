import { definePlugin } from '@happier-dev/plugin-sdk';

import { DEEPSEEK_PROVIDER_CONTRIBUTION } from './provider/contribution.js';

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.provider.deepseek',
  version: '0.0.0',
  displayName: 'DeepSeek',
  description: 'Use DeepSeek models through Anthropic- or OpenAI-compatible agents.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  hostAccess: { required: [], optional: [] },
  providers: {
    deepseek: { declaration: DEEPSEEK_PROVIDER_CONTRIBUTION },
  },
});
