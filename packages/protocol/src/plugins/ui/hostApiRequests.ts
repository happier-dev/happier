import { z } from 'zod';

import { PluginUiJsonValueV1Schema } from '../contributions/ui/json.js';
import { PluginUiHostApiMethodV1Schema } from './hostApi.js';
import { PluginUiSurfaceContextV1Schema } from './surfaceContext.js';

export const PluginUiHostApiErrorCodeV1Schema = z.enum([
  'unavailable',
  'denied',
  'invalid_payload',
  'unsupported_method',
  'stale_surface',
  'expired_resource',
  'timeout',
  'internal_error',
]);
export type PluginUiHostApiErrorCodeV1 =
  z.infer<typeof PluginUiHostApiErrorCodeV1Schema>;

export const PluginUiHostApiErrorPayloadV1Schema = z.object({
  code: PluginUiHostApiErrorCodeV1Schema,
  message: z.string().trim().min(1).optional(),
  diagnostics: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type PluginUiHostApiErrorPayloadV1 =
  z.infer<typeof PluginUiHostApiErrorPayloadV1Schema>;

export const PluginUiHostApiRequestEnvelopeV1Schema = z.object({
  version: z.literal(1),
  requestId: z.string().trim().min(1),
  surface: PluginUiSurfaceContextV1Schema,
  method: PluginUiHostApiMethodV1Schema,
  payload: PluginUiJsonValueV1Schema.optional(),
}).strict();
export type PluginUiHostApiRequestEnvelopeV1 =
  z.infer<typeof PluginUiHostApiRequestEnvelopeV1Schema>;

export const PluginUiHostApiResponseEnvelopeV1Schema = z.discriminatedUnion('kind', [
  z.object({
    version: z.literal(1),
    requestId: z.string().trim().min(1),
    surface: PluginUiSurfaceContextV1Schema,
    method: PluginUiHostApiMethodV1Schema,
    kind: z.literal('result'),
    payload: PluginUiJsonValueV1Schema,
  }).strict(),
  z.object({
    version: z.literal(1),
    requestId: z.string().trim().min(1),
    surface: PluginUiSurfaceContextV1Schema,
    method: PluginUiHostApiMethodV1Schema,
    kind: z.literal('error'),
    payload: PluginUiHostApiErrorPayloadV1Schema,
  }).strict(),
  z.object({
    version: z.literal(1),
    requestId: z.string().trim().min(1),
    surface: PluginUiSurfaceContextV1Schema,
    method: PluginUiHostApiMethodV1Schema,
    kind: z.literal('ack'),
    payload: PluginUiJsonValueV1Schema.optional(),
  }).strict(),
]);
export type PluginUiHostApiResponseEnvelopeV1 =
  z.infer<typeof PluginUiHostApiResponseEnvelopeV1Schema>;
