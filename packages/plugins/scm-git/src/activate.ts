import type { PluginApiV1 } from '@happier-dev/plugin-sdk';

import { registerGitScmBackend } from './backend.js';

export function activate(api: PluginApiV1): void {
  registerGitScmBackend(api);
}
