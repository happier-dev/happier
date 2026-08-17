import type { PluginApi } from '@happier-dev/plugin-sdk';

import { CLIPROXYAPI_PUBLIC_MANAGED_PROVIDER_RUNTIME } from './provider/publicManagedRuntime.js';

export function activate(api: Pick<PluginApi, 'providers'>): void {
  api.providers.register('cliproxyapi', CLIPROXYAPI_PUBLIC_MANAGED_PROVIDER_RUNTIME);
}
