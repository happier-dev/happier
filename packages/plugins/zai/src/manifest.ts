import { definePlugin } from '@happier-dev/plugin-sdk';

import { ZAI_PROVIDER_CONTRIBUTION } from './provider/contribution.js';

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.provider.zai',
  version: '0.0.0',
  displayName: 'Z.AI',
  description: 'Use Z.AI Coding Plan models through compatible agents.',
  brand: { iconResourceId: 'brand-icon', monochrome: true },
  resources: {
    'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' },
  },
  hostAccess: { required: [], optional: [] },
  providers: {
    zai: { declaration: ZAI_PROVIDER_CONTRIBUTION },
  },
});
