import type {
  PluginApi,
} from '@happier-dev/plugin-sdk';

import { registerGitScmBackend } from './backend.js';

export function activate(api: PluginApi): void {
  registerGitScmBackend(api);
}
