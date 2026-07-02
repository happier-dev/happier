import { z } from 'zod';

export const PluginSessionResourceTargetV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('session'),
    idPath: z.string().trim().min(1).optional(),
  }).strict(),
  z.object({
    kind: z.literal('message'),
    idPath: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('structuredMessage'),
    kindPath: z.string().trim().min(1).optional(),
    idPath: z.string().trim().min(1).optional(),
  }).strict(),
  z.object({
    kind: z.literal('sessionResource'),
    resourceKind: z.string().trim().min(1),
    resourceIdPath: z.string().trim().min(1).optional(),
  }).strict(),
  z.object({
    kind: z.literal('machine'),
    idPath: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('workspace'),
    idPath: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('accessEndpoint'),
    endpointIdPath: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('localService'),
    idPath: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('pluginState'),
    keyPath: z.string().trim().min(1),
  }).strict(),
]);
export type PluginSessionResourceTargetV1 = z.infer<typeof PluginSessionResourceTargetV1Schema>;
