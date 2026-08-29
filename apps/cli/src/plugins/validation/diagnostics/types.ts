import { z } from 'zod';
import {
  PluginContributionIdentityV1Schema,
  PluginDiagnosticStageV1Schema,
  PluginDiagnosticTextV1Schema,
  PluginJsonValueV2Schema,
} from '@happier-dev/protocol';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';

const HostPluginContributionIdentityV1Schema = asHostProtocolZod(
  PluginContributionIdentityV1Schema,
);

export const PluginDiagnosticCodeSchema = z.enum([
  'plugin_source_missing',
  'plugin_source_kind_unsupported',
  'plugin_manifest_missing',
  'plugin_manifest_invalid',
  'plugin_manifest_duplicate_id',
  'plugin_manifest_semantic_invalid',
  'plugin_trust_approval_required',
  'plugin_untrusted',
  'plugin_daemon_module_load_failed',
  'plugin_activation_failed',
  'plugin_runtime_capability_missing',
  'plugin_permission_missing',
  'plugin_backend_engine_undeclared_backend_id',
  'plugin_backend_engine_duplicate_backend_id',
  'plugin_agent_runtime_undeclared_agent_id',
  // One Agent's own provider leaf refused its configured External Sessions
  // source. Deliberately NOT `plugin_activation_failed`: that code is in
  // `BLOCKING_PLUGIN_RELOAD_DIAGNOSTIC_CODES`, so a transient provider probe
  // failure would reject the whole readiness candidate and block that
  // plugin's reload adoption. The refusal is author-actionable, not fatal.
  'plugin_external_session_source_refused',
  'plugin_agent_runtime_duplicate_agent_id',
  'plugin_daemon_auth_bridge_invalid_service_id',
  'plugin_daemon_auth_bridge_duplicate_service_id',
  'plugin_tool_undeclared_id',
  'plugin_command_undeclared_id',
  'plugin_hook_undeclared_id',
  'plugin_hook_unsupported_id',
  'plugin_lifecycle_handler_undeclared_id',
  'plugin_notification_category_undeclared_id',
  'plugin_notification_category_duplicate_id',
  'plugin_notification_channel_undeclared_id',
  'plugin_notification_channel_duplicate_id',
  'plugin_execution_run_profile_undeclared_id',
  'plugin_execution_run_profile_duplicate_id',
  'plugin_request_interceptor_invalid_registration',
  'plugin_request_interceptor_manifest_fields_redeclared',
  'plugin_request_interceptor_undeclared_id',
  'plugin_request_interceptor_duplicate_id',
  'plugin_scm_hosting_provider_invalid_registration',
  'plugin_scm_hosting_provider_undeclared_id',
  'plugin_scm_hosting_provider_duplicate_id',
  'scm_hosting_provider_duplicate',
  'plugin_scm_backend_invalid_registration',
  'plugin_scm_backend_undeclared_id',
  'plugin_scm_backend_duplicate_id',
  'plugin_scm_backend_missing_activation',
  'plugin_scm_backend_activation_drift',
  'scm_backend_duplicate',
  'plugin_mcp_server_undeclared_id',
  'plugin_mcp_discovery_source_undeclared_id',
  'installable_duplicate_key',
  'installable_duplicate_capability',
  'plugin_hook_handler_missing',
  'plugin_hook_handler_invalid',
  'plugin_action_undeclared_id',
  'plugin_action_duplicate_id',
  'plugin_action_metadata_drift',
  'plugin_action_manifest_fields_redeclared',
  'plugin_tool_manifest_fields_redeclared',
  'plugin_command_manifest_fields_redeclared',
  'plugin_manifest_engine_range_invalid',
  'plugin_compatibility_projection_invalid',
  'plugin_compatibility_projection_missing',
  'target_absent',
  'point_absent',
  'protocol_unsupported',
  'required_operation_missing',
  'action_not_found',
  'action_schema_invalid',
  'action_surface_mismatch',
  'action_danger_level_mismatch',
  'descriptor_unsupported',
  'descriptor_missing',
  'descriptor_invalid',
  'required_surface_missing',
  'surface_schema_invalid',
  'renderer_not_found',
  'renderer_chain_invalid',
  'contribution_identity_conflict',
  'contributor_contribution_limit_exceeded',
  'snapshot_limit_exceeded',
  'contributor_retired',
  'target_retired',
  'target_semantics_unavailable',
  'descriptor_semantic_invalid',
  'surface_semantic_invalid',
]);
export type PluginDiagnosticCode = z.infer<typeof PluginDiagnosticCodeSchema>;

/**
 * An author-actionable source location, always relative to the plugin's local
 * development project root. Present only for a locally trusted development
 * plugin whose authenticated root is known; every other realm publishes the
 * ordinary redacted message and nothing else.
 */
export const PluginDiagnosticSourceLocationSchema = z.object({
  file: z.string().trim().min(1),
  line: z.number().int().positive().optional(),
  column: z.number().int().nonnegative().optional(),
}).strict();
export type PluginDiagnosticSourceLocationRecord = z.infer<
  typeof PluginDiagnosticSourceLocationSchema
>;

export const PluginCompatibilityDiagnosticSchema = z.object({
  code: PluginDiagnosticCodeSchema,
  message: PluginDiagnosticTextV1Schema,
  contribution: HostPluginContributionIdentityV1Schema.optional(),
  details: PluginJsonValueV2Schema.optional(),
  stage: PluginDiagnosticStageV1Schema.optional(),
  /** Local-development realm only; see `PluginDiagnosticSourceLocationSchema`. */
  source: PluginDiagnosticSourceLocationSchema.optional(),
  /** Local-development realm only: root-rebased, credential- and path-redacted. */
  stack: PluginDiagnosticTextV1Schema.optional(),
}).strict();
export type PluginCompatibilityDiagnostic = z.infer<typeof PluginCompatibilityDiagnosticSchema>;
