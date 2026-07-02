import { z } from 'zod';

import { PluginUiActionDescriptorV1Schema } from './actions.js';
import { PluginUiCompatibilityV1Schema } from './compatibility.js';
import { PluginUiDisplayV1Schema } from './tokens.js';
import { PluginUiJsonValueV1Schema, type PluginUiJsonValueV1 } from './json.js';
import { PluginUiPredicateV1Schema } from './predicates.js';
import { PluginStructuredMessageRendererIdV1Schema } from './renderers.js';

type PluginJsonSchemaV1 = {
  readonly type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  readonly properties?: Readonly<Record<string, PluginJsonSchemaV1>>;
  readonly required?: readonly string[];
  readonly items?: PluginJsonSchemaV1;
  readonly enum?: readonly PluginUiJsonValueV1[];
  readonly format?: 'url' | 'timestamp' | 'sessionId' | 'machineId';
  readonly additionalProperties?: boolean;
};

export const PluginJsonSchemaV1Schema: z.ZodType<PluginJsonSchemaV1> = z.lazy(() => z.object({
  type: z.enum(['object', 'array', 'string', 'number', 'boolean', 'null']),
  properties: z.record(z.string(), PluginJsonSchemaV1Schema).optional(),
  required: z.array(z.string().trim().min(1)).optional(),
  items: PluginJsonSchemaV1Schema.optional(),
  enum: z.array(PluginUiJsonValueV1Schema).optional(),
  format: z.enum(['url', 'timestamp', 'sessionId', 'machineId']).optional(),
  additionalProperties: z.boolean().optional(),
}).strict());
export type { PluginJsonSchemaV1 };

export const PluginStructuredMessageRendererRefV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('host'),
    rendererId: PluginStructuredMessageRendererIdV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('none'),
    fallback: z.enum(['summary', 'hidden']).optional(),
  }).strict(),
]);
export type PluginStructuredMessageRendererRefV1 = z.infer<typeof PluginStructuredMessageRendererRefV1Schema>;

const PluginStructuredMessageKindV1Schema = z.string().trim().regex(
  /^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9_.-]*\.v[0-9]+$/,
  'plugin structured message kind must be qualified as <pluginId>/<local-kind>.vN',
);

export const PluginStructuredMessageDescriptorV1Schema = z.object({
  id: z.string().trim().min(1),
  kind: PluginStructuredMessageKindV1Schema,
  payloadSchema: PluginJsonSchemaV1Schema,
  renderer: PluginStructuredMessageRendererRefV1Schema,
  display: PluginUiDisplayV1Schema,
  actions: z.array(PluginUiActionDescriptorV1Schema).default([]),
  visibility: PluginUiPredicateV1Schema.optional(),
  featureGate: z.string().trim().min(1).optional(),
  order: z.number().int().optional(),
  compatibility: PluginUiCompatibilityV1Schema.optional(),
}).strict();
export type PluginStructuredMessageDescriptorV1 = z.infer<typeof PluginStructuredMessageDescriptorV1Schema>;
