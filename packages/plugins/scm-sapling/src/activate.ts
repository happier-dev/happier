import type {
  PluginApi,
} from '@happier-dev/plugin-sdk';

import { registerSaplingScmBackend } from './backend.js';

export function activate(api: PluginApi): void {
    registerSaplingScmBackend(api);
}
