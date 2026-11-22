import { definePlugin } from '@happier-dev/plugin-sdk';
import { VERCEL_AI_GATEWAY_PROVIDER_CONTRIBUTION, VERCEL_GATEWAY_ACCOUNT_PURPOSE, VERCEL_GATEWAY_PROVIDER_IDENTITY } from './provider/contribution.js';
import { parseVercelModels } from './provider/catalog/vercelModelsParser.js';
import { parseVercelCredits } from './provider/usage/parsers.js';

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: VERCEL_GATEWAY_PROVIDER_IDENTITY.pluginId, version: '0.0.0', displayName: 'Vercel AI Gateway',
  description: 'Use Vercel AI Gateway models through one provider connection.',
  brand: { iconResourceId: 'brand-icon', monochrome: true },
  resources: { 'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' } },
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: { required: [], optional: [{
    id: 'vercel-account.use', capability: 'connectedAccounts',
    reason: 'Use the selected Vercel account for AI Gateway.',
    scope: { serviceRefs: [VERCEL_GATEWAY_ACCOUNT_PURPOSE.service],
      operations: ['use'], materializationKinds: VERCEL_GATEWAY_ACCOUNT_PURPOSE.materializationKinds },
  }] },
  providers: { [VERCEL_GATEWAY_PROVIDER_IDENTITY.localId]: { declaration: VERCEL_AI_GATEWAY_PROVIDER_CONTRIBUTION,
    catalogParsers: { 'vercel-ai-gateway-models': parseVercelModels },
    usageParsers: { 'vercel-credits': parseVercelCredits } } },
});
