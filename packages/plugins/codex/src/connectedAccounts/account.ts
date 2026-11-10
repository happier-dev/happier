import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { openAiCodexConnectedAccountRuntime } from './openAiCodexRuntime.js';
import { OPENAI_CODEX_CONNECTED_ACCOUNT_SERVICE } from './service.js';

/** Ordinary Account activation; native credential import stays daemon-only. */
export function activate(api: PluginAccountApi): void {
  api.connectedAccounts.register(OPENAI_CODEX_CONNECTED_ACCOUNT_SERVICE.localId, openAiCodexConnectedAccountRuntime);
}
