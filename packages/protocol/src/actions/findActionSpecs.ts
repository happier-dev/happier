import { z } from 'zod';
import type { PreNormalizedActionSpec } from './actionSpecs.js';

const FindOptionsSchema = z.object({ matchCase: z.boolean(), regex: z.boolean() }).strict();
export const UiFindInputSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('read') }).strict(),
  z.object({ op: z.literal('set'), query: z.string(), options: FindOptionsSchema.optional(), target: z.string().min(1).optional() }).strict(),
  z.object({ op: z.literal('step'), direction: z.union([z.literal(1), z.literal(-1)]) }).strict(),
  z.object({ op: z.literal('stop') }).strict(),
  z.object({ op: z.literal('close') }).strict(),
]);
export const UiFindOutputSchema = z.union([
  z.object({ status: z.literal('noMountedSurface') }).strict(),
  z.object({ status: z.literal('idle') }).strict(),
  z.object({ status: z.literal('invalidPattern') }).strict(),
  z.object({ status: z.literal('results'), current: z.number().int().nonnegative().nullable(), total: z.number().int().nonnegative(),
    files: z.number().int().nonnegative().optional(), coverage: z.enum(['complete', 'loaded', 'olderRemaining', 'limited', 'partialErrors']) }).strict(),
  z.object({ status: z.literal('searching'), total: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.enum(['offline', 'unsupportedEngine', 'noClient']) }).strict(),
  // Public engine actions expose controls, but not the widget's current counts.
  // Query/options here are the last explicit host seed, never private engine state.
  z.object({ status: z.literal('unavailable'), unavailable: z.literal('engineOwned'),
    query: z.string(), options: FindOptionsSchema }).strict(),
]);

/** Additive client Action: no persistence, remote corpus or second Find decision owner. */
export const FIND_ACTION_SPECS = [{
  id: 'ui.find', title: 'Find in the current surface',
  description: 'Read or control Find on a mounted client surface. Returns coverage/counts when available, or host-known query/options with typed engine-owned count status. Never returns corpus text. Set may address a mounted surface id.',
  safety: 'safe', sideEffectClass: 'external', executionPlacement: 'client', placements: [],
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: false, rpc: false },
  bindings: { voiceClientToolName: 'findInSurface', mcpToolName: 'ui_find' },
  toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
  inputSchema: UiFindInputSchema, outputSchema: UiFindOutputSchema,
}] as const satisfies readonly PreNormalizedActionSpec[];
