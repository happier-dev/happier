import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ModelFavoriteMutationV1Schema } from '../../providers/modelFavoritesV1.js';
import { z } from 'zod/mini';
import type { PreNormalizedActionSpec } from './definition.js';


function createModelFavoriteActionSpecs() {
  return Object.freeze([
  {
    id: 'models.favorite.set', approval: {result: 'none'},
    title: 'Favorite model',
    description: 'Add or remove an exact Agent, source and model selection from Account favorites.',
    safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'account', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: false },
    bindings: { mcpToolName: 'models_favorite_set' },
    inputSchema: ModelFavoriteMutationV1Schema,
    outputSchema: lazyZodSchema(() => z.strictObject({ status: z.literal('updated') })),
    inputHints: { fields: [{ path: 'selection', title: 'Model selection', widget: 'json', required: true },
      { path: 'favorite', title: 'Favorite', widget: 'boolean', required: true }] },
    cli: { acceptsServerId: true, commands: [{ path: ['models', 'favorite', 'set'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
] as const);
}

export const MODEL_FAVORITE_ACTION_SPECS: ReturnType<typeof createModelFavoriteActionSpecs> = lazyActionSpecArray(createModelFavoriteActionSpecs);

