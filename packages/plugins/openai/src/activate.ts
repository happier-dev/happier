import type { PluginApi } from '@happier-dev/plugin-sdk';

import { openAiConnectedAccountRuntime } from './auth/connectedAccountRuntime.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import {
  OPENAI_REALTIME_CODEX_CLIENT_AUTH_ACTION_ID,
  OPENAI_REALTIME_CLIENT_AUTH_ACTION_ID,
  mintOpenAiRealtimeClientAuth,
  mintOpenAiRealtimeClientAuthWithCodexOAuth,
} from './voice/realtimeClientAuthAction.js';

export function activate(api: PluginApi): void {
  const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors.find(
    ({ id }) => id === 'openai',
  );
  if (!descriptor) {
    throw new Error('OpenAI plugin manifest must declare its Connected Account descriptor');
  }
  api.connectedAccounts.register(descriptor.id, openAiConnectedAccountRuntime);
  api.actions.register(
    OPENAI_REALTIME_CLIENT_AUTH_ACTION_ID,
    mintOpenAiRealtimeClientAuth,
  );
  api.actions.register(
    OPENAI_REALTIME_CODEX_CLIENT_AUTH_ACTION_ID,
    mintOpenAiRealtimeClientAuthWithCodexOAuth,
  );
}
