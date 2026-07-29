import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { CLIPROXYAPI_PROVIDER_CONTRIBUTION } from './provider/contribution.js';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.provider.cliproxyapi',
  version: '0.0.0',
  displayName: 'CLIProxyAPI',
  description: 'Use models served by an external or locally detected CLIProxyAPI gateway.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  hostAccess: { required: [], optional: [] },
  contributes: { providers: [CLIPROXYAPI_PROVIDER_CONTRIBUTION] },
} satisfies PluginManifest;
