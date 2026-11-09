import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { kimiPortableAccountRuntime } from './runtime.js';

export function activate(api: PluginAccountApi): void {
  api.connectedAccounts.register('kimi-code', kimiPortableAccountRuntime);
}
