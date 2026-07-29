import type { PluginApi } from '@happier-dev/plugin-sdk';

import { createGitScmBackendRuntimeRegistration } from './backend.js';

export function activate(api: PluginApi): void {
  const { id, ...runtime } = createGitScmBackendRuntimeRegistration();
  api.scm.registerBackend(id, runtime);
}
