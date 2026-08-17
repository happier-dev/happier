import { z } from 'zod';

export const PluginSurfaceSessionTargetV1Schema = z.object({
  kind: z.literal('session'),
  sessionIdPath: z.string().trim().min(1).optional(),
}).strict();

export const PluginSurfaceProjectTargetV1Schema = z.object({
  kind: z.literal('project'),
  workspaceRefIdPath: z.string().trim().min(1).optional(),
  serverIdPath: z.string().trim().min(1).optional(),
  machineIdPath: z.string().trim().min(1).optional(),
  rootPathPath: z.string().trim().min(1).optional(),
  projectIdPath: z.string().trim().min(1).optional(),
}).strict();

export const PluginSurfaceAppTargetV1Schema = z.object({
  kind: z.literal('app'),
}).strict();

export const PluginSurfaceBrowserTargetV1Schema = z.object({
  kind: z.literal('browser'),
  browserViewIdPath: z.string().trim().min(1),
  sessionIdPath: z.string().trim().min(1).optional(),
  profileIdPath: z.string().trim().min(1).optional(),
}).strict();

export const PluginSurfaceServicesTargetV1Schema = z.object({
  kind: z.literal('services'),
  sessionIdPath: z.string().trim().min(1).optional(),
  serverIdPath: z.string().trim().min(1).optional(),
  machineIdPath: z.string().trim().min(1).optional(),
}).strict();

export const PluginSurfaceTargetV1Schema = z.discriminatedUnion('kind', [
  PluginSurfaceSessionTargetV1Schema,
  PluginSurfaceProjectTargetV1Schema,
  PluginSurfaceAppTargetV1Schema,
  PluginSurfaceBrowserTargetV1Schema,
  PluginSurfaceServicesTargetV1Schema,
]);
export type PluginSurfaceTargetV1 = z.infer<typeof PluginSurfaceTargetV1Schema>;
