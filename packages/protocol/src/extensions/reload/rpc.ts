import { z } from 'zod';

import { OptionalStringSchema } from '../_shared.js';

export const ExtensionReloadReasonV1Schema = z.enum(['developer', 'install', 'update', 'enable', 'disable', 'manual']);
export type ExtensionReloadReasonV1 = z.infer<typeof ExtensionReloadReasonV1Schema>;

export const ExtensionReloadDiagnosticSeverityV1Schema = z.enum(['info', 'warning', 'error']);
export type ExtensionReloadDiagnosticSeverityV1 = z.infer<typeof ExtensionReloadDiagnosticSeverityV1Schema>;

export const ExtensionReloadDiagnosticV1Schema = z.object({
  severity: ExtensionReloadDiagnosticSeverityV1Schema,
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  pluginId: OptionalStringSchema,
}).strict();
export type ExtensionReloadDiagnosticV1 = z.infer<typeof ExtensionReloadDiagnosticV1Schema>;

export const ExtensionReloadRequestV1Schema = z.object({
  pluginId: OptionalStringSchema,
  reason: ExtensionReloadReasonV1Schema.default('manual'),
}).strict();
export type ExtensionReloadRequestV1 = z.infer<typeof ExtensionReloadRequestV1Schema>;

export const ExtensionReloadResponseV1Schema = z.object({
  ok: z.boolean(),
  generation: z.number().int().nonnegative(),
  changedPluginIds: z.array(z.string().trim().min(1)).default([]),
  diagnostics: z.array(ExtensionReloadDiagnosticV1Schema).default([]),
}).strict();
export type ExtensionReloadResponseV1 = z.infer<typeof ExtensionReloadResponseV1Schema>;

export const ExtensionReloadStatusRequestV1Schema = z.object({
  machineId: OptionalStringSchema,
}).strict();
export type ExtensionReloadStatusRequestV1 = z.infer<typeof ExtensionReloadStatusRequestV1Schema>;

export const ExtensionReloadStatusResponseV1Schema = z.object({
  generation: z.number().int().nonnegative(),
  reloading: z.boolean().default(false),
  diagnostics: z.array(ExtensionReloadDiagnosticV1Schema).default([]),
}).strict();
export type ExtensionReloadStatusResponseV1 = z.infer<typeof ExtensionReloadStatusResponseV1Schema>;
