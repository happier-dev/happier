import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { OLLAMA_PROVIDER_CONTRIBUTION } from './provider/contribution.js';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.provider.ollama',
  version: '0.0.0',
  displayName: 'Ollama',
  description: 'Use models served locally by Ollama.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [{
      id: 'ollama-process',
      capability: 'process',
      reason: 'Run the declared Ollama executable.',
      scope: {
        executables: [{ kind: 'systemTool', id: 'ollama-cli' }],
      },
    }],
    optional: [],
  },
  contributes: {
    providers: [OLLAMA_PROVIDER_CONTRIBUTION],
    systemTools: [{
      id: 'ollama-cli',
      title: 'Ollama CLI',
      executableNames: ['ollama'],
    }],
  },
} satisfies PluginManifest;
