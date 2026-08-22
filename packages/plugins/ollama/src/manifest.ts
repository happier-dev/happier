import { definePlugin } from '@happier-dev/plugin-sdk';

import { OLLAMA_PROVIDER_CONTRIBUTION } from './provider/contribution.js';
import { OLLAMA_PUBLIC_MANAGED_PROVIDER_RUNTIME } from './provider/publicManagedRuntime.js';

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.provider.ollama',
  version: '0.0.0',
  displayName: 'Ollama',
  description: 'Use models served locally by Ollama.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
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
  providers: {
    ollama: {
      declaration: OLLAMA_PROVIDER_CONTRIBUTION,
      runtime: OLLAMA_PUBLIC_MANAGED_PROVIDER_RUNTIME,
    },
  },
  systemTools: {
    'ollama-cli': {
      title: 'Ollama CLI',
      executableNames: ['ollama'],
    },
  },
});
