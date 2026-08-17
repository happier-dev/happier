import type { PluginApi } from '@happier-dev/plugin-sdk';

import { openAiConnectedAccountRuntime } from './auth/connectedAccountRuntime.js';
import { PLUGIN_MANIFEST } from './manifest.js';

export function activate(api: PluginApi): void {
  const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors.find(
    ({ id }) => id === 'openai',
  );
  if (!descriptor) {
    throw new Error('OpenAI plugin manifest must declare its Connected Account descriptor');
  }
  api.connectedAccounts.register(descriptor.id, openAiConnectedAccountRuntime);
}
