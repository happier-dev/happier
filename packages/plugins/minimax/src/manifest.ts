import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { MINIMAX_CN_PROVIDER_CONTRIBUTION, MINIMAX_PROVIDER_CONTRIBUTION } from './provider/contribution.js';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.provider.minimax',
  version: '0.0.0',
  displayName: 'MiniMax',
  description: 'Use MiniMax models through compatible agents on the global or China endpoint.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  hostAccess: { required: [], optional: [] },
  contributes: { providers: [MINIMAX_PROVIDER_CONTRIBUTION, MINIMAX_CN_PROVIDER_CONTRIBUTION] },
} satisfies PluginManifest;
