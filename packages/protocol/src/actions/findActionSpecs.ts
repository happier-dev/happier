import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import type { PreNormalizedActionSpec } from './actionSpecs.js';

export const FindOptionsSchema = lazyZodSchema(() => z.strictObject({ matchCase: z.boolean(), regex: z.boolean() }));
const target = { target: z.optional(z.string().check(z.minLength(1))) };
export const UiFindInputSchema = lazyZodSchema(() => z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('read'), ...target }),
  z.strictObject({ op: z.literal('set'), query: z.string(), options: z.optional(FindOptionsSchema), ...target }),
  z.strictObject({ op: z.literal('step'), direction: z.union([z.literal(1), z.literal(-1)]), ...target }),
  z.strictObject({ op: z.literal('stop'), ...target }),
  z.strictObject({ op: z.literal('refold'), ...target }),
  z.strictObject({ op: z.literal('close'), ...target }),
]));
export const UiFindOutputSchema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('noMountedSurface') }),
  z.strictObject({ status: z.literal('idle') }),
  z.strictObject({ status: z.literal('invalidPattern') }),
  z.strictObject({ status: z.literal('results'), current: z.nullable(z.number().check(z.int(), z.nonnegative())), total: z.number().check(z.int(), z.nonnegative()),
    files: z.optional(z.number().check(z.int(), z.nonnegative())), coverage: z.enum(['complete', 'loaded', 'olderRemaining', 'limited', 'partialErrors']) }),
  z.strictObject({ status: z.literal('searching'), total: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.enum(['offline', 'unsupportedEngine', 'noClient', 'unsupportedOperation', 'noRevealedFold']) }),
  // Public engine actions expose controls, but not the widget's current counts.
  // Query/options here are the last explicit host seed, never private engine state.
  z.strictObject({ status: z.literal('unavailable'), unavailable: z.literal('engineOwned'),
    query: z.string(), options: FindOptionsSchema }),
]));

/** Additive client Action: no persistence, remote corpus or second Find decision owner. */
export const FIND_ACTION_SPECS = [{
  id: 'ui.find', approval: {result: 'required'}, title: 'Find in the current surface',
  clientPresenter: 'session',
  description: 'Read or control Find on a mounted client surface. Every operation may address a mounted surface id; omission uses the focused surface. Returns coverage/counts when available, or host-known query/options with typed engine-owned count status. Never returns corpus text.',
  safety: 'safe', sideEffectClass: 'external', executionPlacement: 'client', placements: [],
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: false, rpc: false },
  bindings: { voiceClientToolName: 'findInSurface', mcpToolName: 'ui_find' },
  inputSchema: UiFindInputSchema, outputSchema: UiFindOutputSchema,
  inputHints: { fields: [
    { path: 'op', title: 'Operation', widget: 'select', required: true, options: [
      { value: 'read', label: 'Read' }, { value: 'set', label: 'Search' },
      { value: 'step', label: 'Next or previous result' }, { value: 'stop', label: 'Stop' }, { value: 'refold', label: 'Fold again' }, { value: 'close', label: 'Close' },
    ] },
    { path: 'query', title: 'Search text', widget: 'text' },
    { path: 'options', title: 'Case and regular-expression options', widget: 'json' },
    { path: 'target', title: 'Mounted surface id', widget: 'text' },
    { path: 'direction', title: 'Next (1) or previous (-1)', widget: 'text' },
  ] },
  examples: { voice: { argsExample: '{"op":"set","query":"TODO"}' } },
}] as const satisfies readonly PreNormalizedActionSpec[];
