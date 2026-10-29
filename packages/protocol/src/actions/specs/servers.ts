import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import type { PreNormalizedActionSpec } from './definition.js';


export const ServersListInputSchema = lazyZodSchema(() => z.looseObject({
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
}));

export const SERVER_DISCOVERY_ACTION_SPECS = Object.freeze([
  {
    id: 'servers.list', executionPlacement: 'client', approval: {result: 'required'},
    title: 'List servers',
    sideEffectClass: 'read',
    description: 'List servers configured in the client.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listServers' },
    examples: {
      voice: { argsExample: '{"limit":50}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: false,
      cli: false,
      rpc: false,
      },
    inputHints: {
      title: 'List servers',
      fields: [{ path: 'limit', title: 'Limit', widget: 'text' }],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ServersListInputSchema,
  } satisfies PreNormalizedActionSpec,
] as const);

