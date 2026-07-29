import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { OPENAI_PROVIDER_CONTRIBUTION } from './provider/contribution.js';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.provider.openai',
  version: '0.0.0',
  displayName: 'OpenAI',
  description: 'Use OpenAI API models through a SavedSecret-backed provider connection.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  hostAccess: { required: [], optional: [] },
  contributes: { providers: [OPENAI_PROVIDER_CONTRIBUTION] },
} satisfies PluginManifest;
