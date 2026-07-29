import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { DEEPSEEK_PROVIDER_CONTRIBUTION } from './provider/contribution.js';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.provider.deepseek',
  version: '0.0.0',
  displayName: 'DeepSeek',
  description: 'Use DeepSeek models through Anthropic- or OpenAI-compatible agents.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  hostAccess: { required: [], optional: [] },
  contributes: { providers: [DEEPSEEK_PROVIDER_CONTRIBUTION] },
} satisfies PluginManifest;
