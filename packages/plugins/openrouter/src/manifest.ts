import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { OPENROUTER_PROVIDER_CONTRIBUTION } from './provider/contribution.js';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.provider.openrouter',
  version: '0.0.0',
  displayName: 'OpenRouter',
  description: 'Use OpenRouter models through one provider connection.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  hostAccess: { required: [], optional: [] },
  contributes: { providers: [OPENROUTER_PROVIDER_CONTRIBUTION] },
} satisfies PluginManifest;
