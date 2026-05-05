import { z } from 'zod';

export const PluginDiagnosticCodeSchema = z.enum([
  'plugin_source_missing',
  'plugin_source_kind_unsupported',
  'plugin_manifest_missing',
  'plugin_manifest_invalid',
  'plugin_manifest_semantic_invalid',
  'plugin_trust_approval_required',
  'plugin_untrusted',
  'plugin_daemon_module_load_failed',
  'plugin_activation_failed',
  'plugin_runtime_capability_missing',
  'plugin_permission_missing',
  'plugin_backend_engine_undeclared_backend_id',
  'plugin_backend_engine_duplicate_backend_id',
  'plugin_notification_category_undeclared_id',
  'plugin_notification_category_duplicate_id',
  'plugin_notification_channel_undeclared_id',
  'plugin_notification_channel_duplicate_id',
  'plugin_request_interceptor_invalid_registration',
  'plugin_request_interceptor_duplicate_id',
  'plugin_scm_hosting_provider_invalid_registration',
  'plugin_scm_hosting_provider_undeclared_id',
  'plugin_scm_hosting_provider_duplicate_id',
  'scm_hosting_provider_duplicate',
  'plugin_hook_handler_missing',
  'plugin_hook_handler_invalid',
]);
export type PluginDiagnosticCode = z.infer<typeof PluginDiagnosticCodeSchema>;

export const PluginCompatibilityDiagnosticSchema = z.object({
  code: PluginDiagnosticCodeSchema,
  message: z.string().min(1),
}).strict();
export type PluginCompatibilityDiagnostic = z.infer<typeof PluginCompatibilityDiagnosticSchema>;
