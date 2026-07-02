import { z } from 'zod';

import { PluginUiActionDescriptorV1Schema, PluginUiFallbackRefV1Schema } from './actions.js';
import { PluginUiCompatibilityV1Schema } from './compatibility.js';
import { PluginUiPredicateV1Schema } from './predicates.js';
import { PluginSessionResourceTargetV1Schema } from './resources.js';
import { PluginSessionSurfaceRendererIdV1Schema } from './renderers.js';
import { PluginUiBadgeDescriptorV1Schema, PluginUiDisplayV1Schema } from './tokens.js';

export const PluginSessionSurfaceKindV1Schema = z.enum([
  'detailsPane',
  'previewPane',
  'toolPane',
  'sidePane',
]);
export type PluginSessionSurfaceKindV1 = z.infer<typeof PluginSessionSurfaceKindV1Schema>;

export const PluginSessionSurfaceRendererRefV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('host'),
    rendererId: PluginSessionSurfaceRendererIdV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('hostedWeb'),
    contributionId: z.string().trim().min(1),
    fallbackRendererId: PluginSessionSurfaceRendererIdV1Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('reactNativeBundle'),
    contributionId: z.string().trim().min(1),
    fallback: PluginUiFallbackRefV1Schema.optional(),
  }).strict(),
]);
export type PluginSessionSurfaceRendererRefV1 = z.infer<typeof PluginSessionSurfaceRendererRefV1Schema>;

export const PluginSessionSurfaceDescriptorV1Schema = z.object({
  id: z.string().trim().min(1),
  surfaceKind: PluginSessionSurfaceKindV1Schema,
  target: PluginSessionResourceTargetV1Schema,
  renderer: PluginSessionSurfaceRendererRefV1Schema,
  display: PluginUiDisplayV1Schema,
  visibility: PluginUiPredicateV1Schema.optional(),
  enabled: PluginUiPredicateV1Schema.optional(),
  order: z.number().int().optional(),
  badge: PluginUiBadgeDescriptorV1Schema.optional(),
  actions: z.array(PluginUiActionDescriptorV1Schema).default([]),
  fallback: PluginUiFallbackRefV1Schema.optional(),
  compatibility: PluginUiCompatibilityV1Schema.optional(),
}).strict();
export type PluginSessionSurfaceDescriptorV1 = z.infer<typeof PluginSessionSurfaceDescriptorV1Schema>;
