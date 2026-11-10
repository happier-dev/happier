import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

export const PluginSurfaceSessionTargetV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('session'),
  sessionIdPath: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

export const PluginSurfaceProjectTargetV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('project'),
  workspaceRefIdPath: z.optional(z.string().check(z.trim(), z.minLength(1))),
  serverIdPath: z.optional(z.string().check(z.trim(), z.minLength(1))),
  machineIdPath: z.optional(z.string().check(z.trim(), z.minLength(1))),
  rootPathPath: z.optional(z.string().check(z.trim(), z.minLength(1))),
  projectIdPath: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

export const PluginSurfaceAppTargetV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('app'),
}));

/** Whole Machine pages use an exact Machine identity, separately from Services panels. */
export const PluginSurfaceMachineTargetV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('machine'),
  serverIdPath: z.optional(z.string().check(z.trim(), z.minLength(1))),
  machineIdPath: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

export const PluginSurfaceBrowserTargetV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('browser'),
  browserViewIdPath: z.string().check(z.trim(), z.minLength(1)),
  sessionIdPath: z.optional(z.string().check(z.trim(), z.minLength(1))),
  profileIdPath: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

export const PluginSurfaceServicesTargetV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('services'),
  sessionIdPath: z.optional(z.string().check(z.trim(), z.minLength(1))),
  serverIdPath: z.optional(z.string().check(z.trim(), z.minLength(1))),
  machineIdPath: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

export const PluginSurfaceTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  PluginSurfaceSessionTargetV1Schema,
  PluginSurfaceProjectTargetV1Schema,
  PluginSurfaceAppTargetV1Schema,
  PluginSurfaceMachineTargetV1Schema,
  PluginSurfaceBrowserTargetV1Schema,
  PluginSurfaceServicesTargetV1Schema,
]));
export type PluginSurfaceTargetV1 = z.infer<typeof PluginSurfaceTargetV1Schema>;
