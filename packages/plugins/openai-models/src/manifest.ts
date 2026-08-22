import { definePlugin } from '@happier-dev/plugin-sdk';

import { OPENAI_PROVIDER_CONTRIBUTION } from './provider/contribution.js';

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.provider.openai',
  version: '0.0.0',
  displayName: 'OpenAI',
  description: 'Use OpenAI API models through a SavedSecret-backed provider connection.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  hostAccess: { required: [], optional: [] },
  providers: {
    openai: { declaration: OPENAI_PROVIDER_CONTRIBUTION },
  },
});
