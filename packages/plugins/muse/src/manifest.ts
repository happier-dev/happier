import { definePlugin } from '@happier-dev/plugin-sdk';
import { MUSE_ACCOUNT_SERVICE_ID, museAccountDescriptor } from './connectedAccounts/declarations.js';
import { museAccountNativeRuntimeDefinition } from './connectedAccounts/museAccountNativeRuntime.js';

/** Account operations run on the selected Machine; the Agent factory lands separately. */
export const MUSE_PLUGIN = definePlugin({
  id: 'happier.agent.muse',
  version: '0.0.0',
  displayName: 'Muse',
  brand: { iconResourceId: 'brand-icon', monochrome: true },
  resources: { 'brand-icon': { kind: 'asset', path: 'assets/icon.png', contentType: 'image/png' } },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'muse-account-network', capability: 'network',
      reason: 'Connect the selected Meta account for Muse.',
      scope: { targets: [
        { kind: 'fixedOrigin', origin: 'https://auth.meta.com' },
        { kind: 'fixedOrigin', origin: 'https://api.meta.ai' },
      ], methods: ['POST'] },
    }],
    optional: [],
  },
  connectedAccountDescriptors: {
    [MUSE_ACCOUNT_SERVICE_ID]: {
      declaration: museAccountDescriptor,
      runtime: museAccountNativeRuntimeDefinition,
    },
  },
  agents: {},
  systemTools: {},
  hooks: {},
  settings: {},
  ui: {},
});

export const PLUGIN_MANIFEST = MUSE_PLUGIN.manifest;
