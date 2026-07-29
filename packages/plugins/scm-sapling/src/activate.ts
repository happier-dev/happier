import type { PluginApi } from '@happier-dev/plugin-sdk';

import { createSaplingScmBackendRegistration } from './backend.js';

export function activate(api: PluginApi): void {
    const { id, ...runtime } = createSaplingScmBackendRegistration();
    api.scm.registerBackend(id, runtime);
}
