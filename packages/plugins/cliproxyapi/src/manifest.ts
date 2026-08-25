import { definePlugin } from '@happier-dev/plugin-sdk';

import {
  CLIPROXYAPI_PROVIDER_CONTRIBUTION,
  CLIPROXYAPI_PROVIDER_LOCAL_ID,
} from './provider/contribution.js';
import { CLIPROXYAPI_PUBLIC_MANAGED_PROVIDER_RUNTIME } from './provider/publicManagedRuntime.js';

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.provider.cliproxyapi',
  version: '0.0.0',
  displayName: 'CLIProxyAPI',
  description: 'Use models served by an external or locally detected CLIProxyAPI gateway.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [], optional: [] },
  providers: {
    [CLIPROXYAPI_PROVIDER_LOCAL_ID]: {
      declaration: CLIPROXYAPI_PROVIDER_CONTRIBUTION,
      runtime: CLIPROXYAPI_PUBLIC_MANAGED_PROVIDER_RUNTIME,
    },
  },
});
