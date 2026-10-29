import { DIAGNOSTICS_ACTION_IDS } from './diagnosticsActionIdsV1.js';
export { DIAGNOSTICS_ACTION_IDS } from './diagnosticsActionIdsV1.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
export type DiagnosticsActionId = typeof DIAGNOSTICS_ACTION_IDS[number];
export const DiagnosticsActionIdSchema = lazyZodSchema(() => z.enum(DIAGNOSTICS_ACTION_IDS));

const EmptyInputSchema = lazyZodSchema(() => z.strictObject({}));
const UnavailableSchema = lazyZodSchema(() => z.strictObject({ status: z.literal('unavailable') }));
export const DiagnosisReportSchema = lazyZodSchema(() => z.strictObject({
  capturedAt: z.string(),
  findings: z.array(z.strictObject({
    code: z.enum(['server.mismatch.ui_vs_machine', 'server.mismatch.ui_vs_pasted', 'server.mismatch.settings_vs_resolved',
      'server.multiple_machines_multiple_servers', 'server.profile_missing_for_active_url', 'auth.mismatch.ui_vs_machine_account',
      'auth.machine_missing_account', 'machine.none_online', 'server.diagnostics_disabled', 'auth.server_401', 'server.unreachable', 'server.http_error']),
    severity: z.enum(['info', 'warning', 'error']),
    machineIds: z.optional(z.array(z.string())),
    details: z.optional(z.strictObject({
      activeServerId: z.optional(z.string()), activeServerUrl: z.optional(z.string()),
      uiServerUrl: z.optional(z.string()), machineServerUrl: z.optional(z.string()), pastedServerUrl: z.optional(z.string()),
      uiProfileId: z.optional(z.nullable(z.string())), machineAccountId: z.optional(z.string()),
      settingsActiveServerId: z.optional(z.string()), resolvedServerId: z.optional(z.string()),
      machineServerUrls: z.optional(z.array(z.string())), httpStatus: z.optional(z.number().check(z.int())), detail: z.optional(z.string()),
    })),
  })),
}));
export type DiagnosisReportV1 = z.infer<typeof DiagnosisReportSchema>;

export const DiagnosticsActionInputSchemas = {
  'diagnostics.diagnosis.run': EmptyInputSchema,
  'diagnostics.daemons.check': EmptyInputSchema,
  'diagnostics.status.get': EmptyInputSchema,
} as const;
export const DiagnosticsActionOutputSchemas = {
  'diagnostics.diagnosis.run': lazyZodSchema(() => z.union([
    z.strictObject({ status: z.literal('completed'), report: DiagnosisReportSchema }), UnavailableSchema,
  ])),
  'diagnostics.daemons.check': lazyZodSchema(() => z.union([
    z.strictObject({ status: z.literal('completed'), machines: z.array(z.strictObject({
      machineId: z.string(), status: z.enum(['ready', 'error']),
    })) }), UnavailableSchema,
  ])),
  // This is the incumbent sanitized Copy JSON export, not an executable or policy envelope.
  'diagnostics.status.get': lazyZodSchema(() => z.union([
    z.strictObject({ status: z.literal('available'), json: z.string() }), UnavailableSchema,
  ])),
} as const;
export type DiagnosticsActionResult = z.infer<typeof DiagnosticsActionOutputSchemas[DiagnosticsActionId]>;
