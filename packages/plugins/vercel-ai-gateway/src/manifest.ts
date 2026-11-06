import { definePlugin } from '@happier-dev/plugin-sdk';
import { VERCEL_AI_GATEWAY_PROVIDER_CONTRIBUTION } from './provider/contribution.js';
import { parseVercelModels } from './provider/catalog/vercelModelsParser.js';
import { parseVercelCredits } from './provider/usage/parsers.js';

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.provider.vercel-ai-gateway', version: '0.0.0', displayName: 'Vercel AI Gateway',
  description: 'Use Vercel AI Gateway models through one provider connection.',
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [], optional: [] },
  providers: { 'vercel-ai-gateway': { declaration: VERCEL_AI_GATEWAY_PROVIDER_CONTRIBUTION,
    catalogParsers: { 'vercel-ai-gateway-models': parseVercelModels },
    usageParsers: { 'vercel-credits': parseVercelCredits } } },
});
