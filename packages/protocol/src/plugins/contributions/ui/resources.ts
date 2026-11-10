import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

export const PluginSessionResourceTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('session'),
    idPath: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }),
  z.strictObject({
    kind: z.literal('message'),
    idPath: z.string().check(z.trim(), z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal('structuredMessage'),
    kindPath: z.optional(z.string().check(z.trim(), z.minLength(1))),
    idPath: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }),
  z.strictObject({
    kind: z.literal('sessionResource'),
    resourceKind: z.string().check(z.trim(), z.minLength(1)),
    resourceIdPath: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }),
  z.strictObject({
    kind: z.literal('machine'),
    idPath: z.string().check(z.trim(), z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal('workspace'),
    idPath: z.string().check(z.trim(), z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal('accessEndpoint'),
    endpointIdPath: z.string().check(z.trim(), z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal('localService'),
    idPath: z.string().check(z.trim(), z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal('pluginState'),
    keyPath: z.string().check(z.trim(), z.minLength(1)),
  }),
]));
export type PluginSessionResourceTargetV1 = z.infer<typeof PluginSessionResourceTargetV1Schema>;
