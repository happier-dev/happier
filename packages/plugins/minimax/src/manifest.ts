import { definePlugin } from '@happier-dev/plugin-sdk';

import { MINIMAX_CN_PROVIDER_CONTRIBUTION, MINIMAX_PROVIDER_CONTRIBUTION } from './provider/contribution.js';

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.provider.minimax',
  version: '0.0.0',
  displayName: 'MiniMax',
  description: 'Use MiniMax models through compatible agents on the global or China endpoint.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  hostAccess: { required: [], optional: [] },
  providers: {
    minimax: { declaration: MINIMAX_PROVIDER_CONTRIBUTION },
    'minimax-cn': { declaration: MINIMAX_CN_PROVIDER_CONTRIBUTION },
  },
});
