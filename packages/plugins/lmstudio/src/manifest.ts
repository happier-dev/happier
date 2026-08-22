import { definePlugin } from '@happier-dev/plugin-sdk';

import { LMSTUDIO_PROVIDER_CONTRIBUTION } from './provider/contribution.js';

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.provider.lmstudio',
  version: '0.0.0',
  displayName: 'LM Studio',
  description: 'Use models served locally by LM Studio 0.4.1 or newer.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  hostAccess: { required: [], optional: [] },
  providers: {
    lmstudio: { declaration: LMSTUDIO_PROVIDER_CONTRIBUTION },
  },
});
