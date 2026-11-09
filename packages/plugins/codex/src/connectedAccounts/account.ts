import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { openAiCodexConnectedAccountRuntime } from './openAiCodexRuntime.js';

/** Ordinary Account activation; native credential import stays daemon-only. */
export function activate(api: PluginAccountApi): void {
  api.connectedAccounts.register('openai-codex', openAiCodexConnectedAccountRuntime);
}
