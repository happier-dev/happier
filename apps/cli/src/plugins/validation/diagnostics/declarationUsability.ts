import { type PluginDiagnosticCode, PluginDiagnosticCodeSchema } from './types';

/**
 * Does a plugin diagnostic invalidate the plugin's STATIC declarations, or does
 * it only report that the plugin's runtime is unhealthy?
 *
 * This distinction is required by UI-T28: host-rendered settings and Connected
 * Account setup must stay reachable exactly when a plugin's daemon activation
 * fails, is degraded or needs configuration — that is the moment the user needs
 * them. Gating those surfaces on "the plugin has no diagnostics at all" makes
 * the repair UI unreachable in precisely the state it exists for.
 *
 * - `declaration` — the source, manifest or trust admission that PRODUCED the
 *   declaration is missing, malformed or unapproved, so the host cannot trust
 *   the declared identity, auth modes or fields it would render. Fail closed.
 * - `runtime` — the declaration is sound; the plugin's executable side failed,
 *   drifted or could not bind. Host-rendered configuration stays reachable and
 *   the diagnostic is disclosed alongside it.
 *
 * The mapping is exhaustive by construction: a new `PluginDiagnosticCode` fails
 * to compile here until it is classified, rather than silently defaulting.
 */
export type PluginDiagnosticUsabilityClass = 'declaration' | 'runtime';

const PLUGIN_DIAGNOSTIC_USABILITY_CLASS: Readonly<Record<
    PluginDiagnosticCode,
    PluginDiagnosticUsabilityClass
>> = Object.freeze({
    // The package or its manifest is missing/unreadable/contradictory: nothing
    // it declares can be trusted.
    plugin_source_missing: 'declaration',
    plugin_source_kind_unsupported: 'declaration',
    plugin_manifest_missing: 'declaration',
    plugin_manifest_invalid: 'declaration',
    plugin_manifest_duplicate_id: 'declaration',
    plugin_manifest_semantic_invalid: 'declaration',
    plugin_manifest_engine_range_invalid: 'declaration',
    // Pre-acquisition metadata could not establish a valid static declaration.
    plugin_compatibility_projection_invalid: 'declaration',
    plugin_compatibility_projection_missing: 'declaration',
    // Not admitted by the trust owner: the host must not offer to send
    // credentials to it.
    plugin_trust_approval_required: 'declaration',
    plugin_untrusted: 'declaration',

    // Everything below is a fact about the plugin's executable side or about a
    // single runtime registration. The static declarations remain valid, so
    // host-rendered configuration and recovery stay reachable.
    plugin_daemon_module_load_failed: 'runtime',
    plugin_activation_failed: 'runtime',
    plugin_runtime_capability_missing: 'runtime',
    plugin_permission_missing: 'runtime',
    plugin_backend_engine_undeclared_backend_id: 'runtime',
    plugin_backend_engine_duplicate_backend_id: 'runtime',
    plugin_agent_runtime_undeclared_agent_id: 'runtime',
    // The Agent's declaration is intact; only its runtime provider leaf
    // refused this configured source, possibly transiently.
    plugin_external_session_source_refused: 'runtime',
    plugin_agent_runtime_duplicate_agent_id: 'runtime',
    plugin_daemon_auth_bridge_invalid_service_id: 'runtime',
    plugin_daemon_auth_bridge_duplicate_service_id: 'runtime',
    plugin_tool_undeclared_id: 'runtime',
    plugin_command_undeclared_id: 'runtime',
    plugin_hook_undeclared_id: 'runtime',
    plugin_hook_unsupported_id: 'runtime',
    plugin_lifecycle_handler_undeclared_id: 'runtime',
    plugin_notification_category_undeclared_id: 'runtime',
    plugin_notification_category_duplicate_id: 'runtime',
    plugin_notification_channel_undeclared_id: 'runtime',
    plugin_notification_channel_duplicate_id: 'runtime',
    plugin_execution_run_profile_undeclared_id: 'runtime',
    plugin_execution_run_profile_duplicate_id: 'runtime',
    plugin_request_interceptor_invalid_registration: 'runtime',
    plugin_request_interceptor_manifest_fields_redeclared: 'runtime',
    plugin_request_interceptor_undeclared_id: 'runtime',
    plugin_request_interceptor_duplicate_id: 'runtime',
    plugin_scm_hosting_provider_invalid_registration: 'runtime',
    plugin_scm_hosting_provider_undeclared_id: 'runtime',
    plugin_scm_hosting_provider_duplicate_id: 'runtime',
    scm_hosting_provider_duplicate: 'runtime',
    plugin_scm_backend_invalid_registration: 'runtime',
    plugin_scm_backend_undeclared_id: 'runtime',
    plugin_scm_backend_duplicate_id: 'runtime',
    plugin_scm_backend_missing_activation: 'runtime',
    plugin_scm_backend_activation_drift: 'runtime',
    scm_backend_duplicate: 'runtime',
    plugin_mcp_server_undeclared_id: 'runtime',
    plugin_mcp_discovery_source_undeclared_id: 'runtime',
    installable_duplicate_key: 'runtime',
    installable_duplicate_capability: 'runtime',
    plugin_hook_handler_missing: 'runtime',
    plugin_hook_handler_invalid: 'runtime',
    plugin_action_undeclared_id: 'runtime',
    plugin_action_duplicate_id: 'runtime',
    plugin_action_metadata_drift: 'runtime',
    plugin_action_manifest_fields_redeclared: 'runtime',
    plugin_tool_manifest_fields_redeclared: 'runtime',
    plugin_command_manifest_fields_redeclared: 'runtime',

    // Targeted-contribution admission and semantic diagnostics disable that
    // projection, not the contributor's unrelated static declarations.
    target_absent: 'runtime',
    point_absent: 'runtime',
    protocol_unsupported: 'runtime',
    required_operation_missing: 'runtime',
    action_not_found: 'runtime',
    action_schema_invalid: 'runtime',
    action_surface_mismatch: 'runtime',
    action_danger_level_mismatch: 'runtime',
    descriptor_unsupported: 'runtime',
    descriptor_missing: 'runtime',
    descriptor_invalid: 'runtime',
    required_surface_missing: 'runtime',
    surface_schema_invalid: 'runtime',
    renderer_not_found: 'runtime',
    renderer_chain_invalid: 'runtime',
    contribution_identity_conflict: 'runtime',
    contributor_contribution_limit_exceeded: 'runtime',
    snapshot_limit_exceeded: 'runtime',
    contributor_retired: 'runtime',
    target_retired: 'runtime',
    target_semantics_unavailable: 'runtime',
    descriptor_semantic_invalid: 'runtime',
    surface_semantic_invalid: 'runtime',
} satisfies Record<PluginDiagnosticCode, PluginDiagnosticUsabilityClass>);

/**
 * Classify one diagnostic code. An unrecognized code is treated as
 * `declaration` (fail closed): the host cannot reason about a diagnostic
 * vocabulary it does not own.
 */
export function classifyPluginDiagnosticUsability(
    code: string,
): PluginDiagnosticUsabilityClass {
    const parsed = PluginDiagnosticCodeSchema.safeParse(code);
    return parsed.success ? PLUGIN_DIAGNOSTIC_USABILITY_CLASS[parsed.data] : 'declaration';
}

/**
 * True when at least one diagnostic makes the plugin's static declarations
 * unusable, so a host-rendered surface derived from them must not be offered.
 */
export function hasUnusablePluginDeclarationDiagnostic(
    codes: readonly string[],
): boolean {
    return codes.some((code) => classifyPluginDiagnosticUsability(code) === 'declaration');
}
