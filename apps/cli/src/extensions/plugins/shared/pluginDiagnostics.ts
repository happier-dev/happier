import { z } from 'zod';

export const PluginDiagnosticCodeSchema = z.enum([
  'plugin_source_missing',
  'plugin_source_kind_unsupported',
  'plugin_manifest_missing',
  'plugin_manifest_invalid',
  'plugin_manifest_semantic_invalid',
  'plugin_daemon_module_load_failed',
  'plugin_hook_handler_missing',
  'plugin_hook_handler_invalid',
]);
export type PluginDiagnosticCode = z.infer<typeof PluginDiagnosticCodeSchema>;

export const PluginCompatibilityDiagnosticSchema = z.object({
  code: PluginDiagnosticCodeSchema,
  message: z.string().min(1),
}).strict();
export type PluginCompatibilityDiagnostic = z.infer<typeof PluginCompatibilityDiagnosticSchema>;
