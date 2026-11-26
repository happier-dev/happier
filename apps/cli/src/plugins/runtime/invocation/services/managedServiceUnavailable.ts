import { PluginError } from '@happier-dev/plugin-sdk';

type ManagedServiceUnavailableReason =
    | 'client_environment_unavailable'
    | 'connected_account_materialization_unavailable'
    | 'credential_file_materialization_unavailable'
    | 'credentials_changed'
    | 'declared_secret_resolver_unavailable'
    | 'declared_secret_unavailable'
    | 'deployment_native_observation_unavailable'
    | 'environment_control_admission_required'
    | 'environment_release_mismatch'
    | 'explicit_start_authority_unavailable'
    | 'explicit_start_endpoint_unavailable'
    | 'health_observation_unavailable'
    | 'http_health_requires_endpoint'
    | 'invocation_changed'
    | 'invocation_exec_owner_missing'
    | 'invocation_not_current'
    | 'invocation_scope_unavailable'
    | 'managed_launch_authorization_unavailable'
    | 'managed_service_owner_unavailable'
    | 'native_control_unsupported'
    | 'native_daemon_custody_required'
    | 'native_launch_authorization_unavailable'
    | 'native_lifecycle_unavailable'
    | 'native_log_follow_unsupported'
    | 'native_observation_invalid'
    | 'occurrence_owns_scope'
    | 'owner_retired'
    | 'project_admission_changed'
    | 'project_admission_not_current'
    | 'project_command_health_authorization_unavailable'
    | 'project_custody_inventory_incomplete'
    | 'project_custody_unavailable'
    | 'project_effect_identity_missing'
    | 'project_handle_unavailable'
    | 'project_launch_authorization_unavailable'
    | 'project_native_custody_unsettled'
    | 'project_service_not_started'
    | 'project_workspace_mismatch'
    | 'provider_authority_changed'
    | 'provider_endpoint_unavailable'
    | 'provider_invocation_unavailable'
    | 'readiness_unreported'
    | 'recovered_service_has_no_launch_authorization'
    | 'redaction_authority_unavailable'
    | 'redaction_scope_unavailable'
    | 'request_auth_not_current'
    | 'request_auth_unavailable'
    | 'request_unavailable'
    | 'response_body_invalid'
    | 'response_body_unavailable'
    | 'runner_launch_authorization_unavailable'
    | 'service_entry_unavailable'
    | 'service_handle_unavailable'
    | 'service_output_support_executable_missing'
    | 'session_runner_custody_required'
    | 'stop_unsupported'
    | 'stop_unverified';

/** Authored reasons travel through the existing Action cause. Only known service and plugin IDs accompany them. */
export function managedServiceUnavailable(
    reason: ManagedServiceUnavailableReason,
    message: string,
    { serviceId, pluginId, phase = 'managed_service.establishment', retryable }: Readonly<{
        serviceId?: string | undefined;
        pluginId?: string | undefined;
        phase?: string;
        retryable?: boolean;
    }> = {},
): PluginError {
    const code = 'plugin_managed_service_unavailable';
    return new PluginError({
        code,
        message,
        ...(retryable === undefined ? {} : { retryable }),
        ...(serviceId === undefined && pluginId === undefined ? {} : { details: {
            ...(serviceId === undefined ? {} : { serviceId }),
            ...(pluginId === undefined ? {} : { pluginId }),
        } }),
        failureCause: { phase, errorClass: 'Error', errorCode: code, httpStatus: null, nativeErrorReason: reason },
    });
}
