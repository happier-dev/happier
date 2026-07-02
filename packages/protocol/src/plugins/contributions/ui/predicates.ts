import { z } from 'zod';

import { PluginUiJsonValueV1Schema, type PluginUiJsonValueV1 } from './json.js';

export const PluginUiPredicateOperandV1Schema = z.enum([
  'accessEndpoint.available',
  'capability.enabled',
  'feature.enabled',
  'message.kind',
  'message.payload.equals',
  'message.payload.hasPath',
  'message.payload.matchesEnum',
  'platform.is',
  'plugin.enabled',
  'resource.kind',
  'resource.providerId',
  'resource.status',
  'session.backendId',
  'session.hasBackend',
  'session.hasCapability',
  'session.hasProvider',
  'session.hasResourceKind',
  'session.providerId',
]);
export type PluginUiPredicateOperandV1 = z.infer<typeof PluginUiPredicateOperandV1Schema>;

type PluginUiPredicateV1 =
  | { readonly all: readonly PluginUiPredicateV1[] }
  | { readonly any: readonly PluginUiPredicateV1[] }
  | { readonly not: PluginUiPredicateV1 }
  | {
      readonly operand: PluginUiPredicateOperandV1;
      readonly path?: string;
      readonly value?: PluginUiJsonValueV1;
      readonly values?: readonly PluginUiJsonValueV1[];
    };

export const PluginUiPredicateV1Schema: z.ZodType<PluginUiPredicateV1> = z.lazy(() => z.union([
  z.object({
    all: z.array(PluginUiPredicateV1Schema).min(1),
  }).strict(),
  z.object({
    any: z.array(PluginUiPredicateV1Schema).min(1),
  }).strict(),
  z.object({
    not: PluginUiPredicateV1Schema,
  }).strict(),
  z.object({
    operand: PluginUiPredicateOperandV1Schema,
    path: z.string().trim().min(1).optional(),
    value: PluginUiJsonValueV1Schema.optional(),
    values: z.array(PluginUiJsonValueV1Schema).optional(),
  }).strict(),
]));
export type { PluginUiPredicateV1 };
