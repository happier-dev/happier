import { z } from 'zod';

import { OptionalStringSchema } from './_shared.js';

export const BackendRuntimeAdapterKindV1Schema = z.enum([
  'terminalRuntime',
  'directSessions',
  'attach',
  'sessionHandoff',
]);
export type BackendRuntimeAdapterKindV1 = z.infer<typeof BackendRuntimeAdapterKindV1Schema>;

export const BackendRuntimeAdapterHandlerRefV1Schema = z.object({
  target: z.literal('daemon'),
  exportName: OptionalStringSchema,
}).passthrough();
export type BackendRuntimeAdapterHandlerRefV1 = z.infer<typeof BackendRuntimeAdapterHandlerRefV1Schema>;

export const BackendRuntimeAdapterV1Schema = z.object({
  runtimeAdapterApiVersion: z.literal(1).default(1),
  id: z.string().trim().min(1),
  kind: BackendRuntimeAdapterKindV1Schema,
  handler: BackendRuntimeAdapterHandlerRefV1Schema,
  compatibility: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
export type BackendRuntimeAdapterV1 = z.infer<typeof BackendRuntimeAdapterV1Schema>;
