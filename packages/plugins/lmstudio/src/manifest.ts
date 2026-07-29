import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { LMSTUDIO_PROVIDER_CONTRIBUTION } from './provider/contribution.js';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.provider.lmstudio',
  version: '0.0.0',
  displayName: 'LM Studio',
  description: 'Use models served locally by LM Studio 0.4.1 or newer.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  hostAccess: { required: [], optional: [] },
  contributes: { providers: [LMSTUDIO_PROVIDER_CONTRIBUTION] },
} satisfies PluginManifest;
