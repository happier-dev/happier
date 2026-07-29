import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { ZAI_PROVIDER_CONTRIBUTION } from './provider/contribution.js';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.provider.zai',
  version: '0.0.0',
  displayName: 'Z.AI',
  description: 'Use Z.AI Coding Plan models through compatible agents.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  hostAccess: { required: [], optional: [] },
  contributes: { providers: [ZAI_PROVIDER_CONTRIBUTION] },
} satisfies PluginManifest;
