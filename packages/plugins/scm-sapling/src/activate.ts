import type { PluginApiV1 } from '@happier-dev/plugin-sdk';

import { registerSaplingScmBackend } from './backend/registerSaplingScmBackend.js';

export function activate(api: PluginApiV1): void {
    registerSaplingScmBackend(api);
}
