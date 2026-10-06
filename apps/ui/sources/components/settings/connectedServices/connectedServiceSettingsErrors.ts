import { t } from '@/text';

type ErrorLike = Readonly<{
    code?: unknown;
    message?: unknown;
    status?: unknown;
    generation?: unknown;
    resetAtMs?: unknown;
}>;

function asErrorLike(error: unknown): ErrorLike {
    return error && typeof error === 'object' ? error as ErrorLike : {};
}

export function readConnectedServiceSettingsErrorCode(error: unknown): string | null {
    const errorLike = asErrorLike(error);
    if (typeof errorLike.code === 'string' && errorLike.code.trim().length > 0) {
        return errorLike.code;
    }
    if (typeof errorLike.message === 'string' && /^connect[_a-z0-9]+$/i.test(errorLike.message)) {
        return errorLike.message;
    }
    return null;
}

export function isConnectedServiceRuntimeCooldownError(error: unknown): boolean {
    return readConnectedServiceSettingsErrorCode(error) === 'connect_group_profile_runtime_cooldown';
}

export function isConnectedServiceCredentialReferencedByGroupError(error: unknown): boolean {
    return readConnectedServiceSettingsErrorCode(error) === 'connect_credential_referenced_by_group';
}

export function readConnectedServiceRuntimeCooldownResetAtMs(error: unknown): number | null {
    const value = asErrorLike(error).resetAtMs;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatResetAt(error: unknown): string {
    const resetAtMs = readConnectedServiceRuntimeCooldownResetAtMs(error);
    return resetAtMs === null ? t('connectedServices.errors.unknownResetTime') : new Date(resetAtMs).toLocaleString();
}

export function resolveConnectedServiceSettingsErrorMessage(error: unknown): string {
    const errorLike = asErrorLike(error);
    const code = readConnectedServiceSettingsErrorCode(error);

    switch (code) {
        case 'connected_account_runtime_generation_changed':
        case 'connected_account_producer_result_stale':
            return t('connectedServices.errors.accountRuntimeChanged');
        case 'connected_account_daemon_unavailable':
        case 'connected_account_daemon_owner_unavailable':
        case 'connected_account_daemon_runtime_unavailable':
        case 'connected_account_runtime_unavailable':
        case 'connected_account_peer_operation_admission_unavailable':
            return t('connectedServices.errors.accountMachineUnavailable');
        case 'connect_quotas_not_found':
        case 'connected_account_service_unavailable':
        case 'connected_account_service_description_unavailable':
        case 'connected_account_options_unavailable':
        case 'connected_account_control_unavailable':
        case 'connected_account_authentication_mode_unavailable':
        case 'connected_account_authentication_operation_unavailable':
        case 'connected_account_authentication_unavailable':
        case 'connected_account_attempt_internal_unavailable':
        case 'connected_account_attempt_unavailable':
        case 'connected_account_attempt_discovery_unavailable':
        case 'connected_account_producer_context_unavailable':
        case 'connected_account_configuration_target_unavailable':
        case 'connected_account_purpose_binding_owner_unavailable':
        case 'connected_account_materialization_consumer_unavailable':
        case 'connected_account_request_auth_unavailable':
        case 'connected_account_request_auth_backoff_unavailable':
        case 'connected_account_request_auth_http_port_unavailable':
        case 'connected_account_session_binding_unavailable':
        case 'connected_account_launch_environment_purpose_unavailable':
        case 'connected_account_launch_file_environment_purpose_unavailable':
        case 'connected_account_purpose_unavailable':
            return t('connectedServices.errors.accountServiceUnavailable');
        case 'connect_credential_unsupported_format':
        case 'connect_group_runtime_fallback_unsupported':
        case 'connected_account_legacy_operation_unsupported':
        case 'connected_account_service_identity_unsupported':
        case 'connected_account_v4_contract_unavailable':
        case 'connected_account_v4_contract_violation':
        case 'connected_account_capability_indeterminate':
        case 'connected_account_daemon_response_invalid':
        case 'connected_account_producer_result_invalid':
        case 'connected_account_credential_conflict_response_invalid':
        case 'connected_account_group_conflict_response_invalid':
            return t('connectedServices.errors.accountOperationUnsupported');
        case 'connected_account_configuration_required':
        case 'connected_account_configured_origins_unavailable':
            return t('connectedServices.errors.accountConfigurationRequired');
        case 'connected_account_configuration_changed':
        case 'connected_account_configuration_stale':
        case 'connected_account_configuration_consequence_stale':
        case 'connected_account_configuration_settings_conflict':
        case 'connected_account_credential_changed':
        case 'connected_account_settlement_conflict':
        case 'connected_account_device_transaction_conflict':
        case 'connected_account_attempt_transaction_conflict':
        case 'connected_account_configuration_revision_unavailable':
            return t('connectedServices.errors.accountConfigurationChanged');
        case 'connected_account_authentication_outcome_unknown':
        case 'connected_account_settlement_outcome_unknown':
        case 'connected_account_configuration_settings_outcome_unknown':
        case 'connected_account_revoke_outcome_unknown':
        case 'connected_account_provider_operation_interrupted':
        case 'connected_account_late_evidence_unavailable':
        case 'connected_account_authentication_reconciliation_unavailable':
        case 'connected_account_configuration_consequence_unavailable':
        case 'connected_account_configuration_atomic_service_settlement_unavailable':
        case 'connected_account_request_auth_activation_failed':
        case 'connected_account_session_binding_activation_failed':
            return t('connectedServices.errors.accountStateUncertain');
        case 'connect_authentication_mode_mismatch':
        case 'connect_oauth_state_mismatch':
        case 'connect_oauth_timeout':
        case 'connect_oauth_invalid_grant':
        case 'connect_oauth_missing_refresh_token':
        case 'connect_reconnect_required':
        case 'connected_account_attempt_expired':
        case 'connected_account_attempt_not_found':
        case 'connected_account_attempt_cancelled':
        case 'connected_account_attempt_phase_mismatch':
        case 'connected_account_authentication_mode_mismatch':
        case 'connected_account_device_authorization_expired':
        case 'connected_account_device_transaction_invalid':
        case 'connected_account_device_transaction_unavailable':
        case 'connected_account_oauth_authorization_interrupted':
        case 'connected_account_oauth_transaction_invalid':
        case 'connected_account_oauth_transaction_unavailable':
        case 'connected_account_attempt_transaction_not_found':
        case 'connected_account_configuration_settings_cancelled':
            return t('connectedServices.errors.accountAuthenticationRestartRequired');
        case 'connected_account_attempt_in_progress':
        case 'connected_account_attempt_capacity_exhausted':
        case 'connected_account_attempt_configuration_capacity_exhausted':
        case 'connected_account_attempt_cleanup_pending':
        case 'connected_account_configuration_settings_locked':
        case 'connected_account_request_auth_capability_lock_timeout':
            return t('connectedServices.errors.accountOperationBusy');
        case 'connect_credential_invalid':
        case 'connect_oauth_exchange_failed':
        case 'connected_account_authentication_rejected':
        case 'connected_account_manual_fields_invalid':
        case 'connected_account_oauth_completion_invalid':
        case 'connected_account_provider_result_invalid':
        case 'connected_account_identity_unavailable':
            return t('connectedServices.errors.accountAuthenticationRejected');
        case 'connect_reconnect_provider_identity_mismatch':
        case 'connected_account_reconnect_identity_mismatch':
        case 'connected_account_reconnect_provider_identity_mismatch':
        case 'connected_account_settlement_identity_mismatch':
        case 'connected_account_configuration_target_mismatch':
        case 'connected_account_canonical_session_identity_conflict':
        case 'connected_account_purpose_resolution_account_mismatch':
        case 'connected_account_purpose_resolution_service_mismatch':
        case 'connected_account_scm_hosting_purpose_consumer_identity_mismatch':
            return t('connectedServices.errors.accountIdentityMismatch');
        case 'connected_account_session_binding_already_active':
        case 'connected_account_session_binding_duplicate_purpose':
        case 'connected_account_session_binding_undeclared_purpose':
        case 'connected_account_session_binding_duplicate_binding':
        case 'connected_account_session_binding_direct_material_origin_mismatch':
        case 'connected_account_session_binding_duplicate_direct_material_origin':
        case 'connected_account_execution_run_binding_already_active':
        case 'connected_account_execution_run_binding_duplicate_purpose':
        case 'connected_account_execution_run_binding_undeclared_purpose':
        case 'connected_account_execution_run_binding_duplicate_binding':
        case 'connected_account_execution_run_binding_direct_material_origin_mismatch':
        case 'connected_account_execution_run_binding_duplicate_direct_material_origin':
        case 'connected_account_agent_catalog_observation_binding_already_active':
        case 'connected_account_agent_catalog_observation_binding_duplicate_purpose':
        case 'connected_account_agent_catalog_observation_binding_undeclared_purpose':
        case 'connected_account_agent_catalog_observation_binding_duplicate_binding':
        case 'connected_account_agent_catalog_observation_binding_consumer_mismatch':
        case 'connected_account_agent_catalog_observation_binding_direct_material_consumer_unsupported':
        case 'connected_account_operation_binding_already_active':
        case 'connected_account_operation_binding_duplicate_purpose':
        case 'connected_account_operation_binding_undeclared_purpose':
        case 'connected_account_operation_binding_duplicate_binding':
        case 'connected_account_operation_binding_consumer_mismatch':
        case 'connected_account_operation_binding_direct_material_origin_mismatch':
        case 'connected_account_operation_binding_duplicate_direct_material_origin':
        case 'connected_account_operation_binding_direct_material_consumer_unsupported':
        case 'connected_account_managed_provider_operation_binding_already_active':
        case 'connected_account_managed_provider_operation_binding_duplicate_purpose':
        case 'connected_account_managed_provider_operation_binding_undeclared_purpose':
        case 'connected_account_managed_provider_operation_binding_duplicate_binding':
        case 'connected_account_managed_provider_operation_binding_consumer_mismatch':
        case 'connected_account_managed_provider_operation_binding_direct_material_consumer_unsupported':
        case 'connected_account_ambiguous':
        case 'connected_account_attempt_identity_forbidden':
        case 'connected_account_configuration_read_only':
        case 'connected_account_request_auth_capability_path_unsafe':
        case 'connected_account_request_auth_capability_scope_invalid':
        case 'connected_account_purpose_projection_conflicting_scope':
        case 'connected_account_purpose_reconciliation_consumer_mismatch':
        case 'connected_account_purpose_reconciliation_duplicate_consumer':
        case 'connected_account_purpose_reconciliation_duplicate_purpose':
        case 'connected_account_agent_purpose_consumer_identity_missing':
        case 'connected_account_session_binding_snapshot_invalid':
        case 'connected_account_session_binding_snapshot_duplicate_binding':
        case 'connected_account_session_binding_snapshot_duplicate_purpose':
        case 'connected_account_session_binding_snapshot_undeclared_purpose':
        case 'connected_account_session_binding_scope_duplicate_purpose':
        case 'connected_account_session_binding_scope_subject_id_required':
        case 'connected_account_session_binding_session_id_required':
        case 'connected_account_execution_run_binding_agent_id_required':
        case 'connected_account_execution_run_binding_run_id_required':
        case 'connected_account_execution_run_binding_runner_pid_required':
        case 'connected_account_agent_catalog_observation_binding_operation_id_required':
        case 'connected_account_operation_binding_operation_id_required':
        case 'connected_account_managed_provider_operation_binding_identity_required':
        case 'connected_account_managed_provider_operation_binding_operation_id_required':
            return t('connectedServices.errors.accountAccessUnavailable');
        case 'connect_credential_seal_unavailable':
        case 'connected_account_configuration_atomic_persistence_unavailable':
        case 'connected_account_configuration_persistence_unavailable':
        case 'connected_account_persistence_unavailable':
        case 'connected_account_device_settlement_persistence_unavailable':
        case 'connected_account_oauth_settlement_persistence_unavailable':
        case 'connected_account_oauth_transaction_persistence_unavailable':
        case 'connected_account_configuration_settings_unavailable':
        case 'connected_account_configuration_unavailable':
        case 'connected_account_attempt_transaction_storage_mode_mismatch':
        case 'connected_account_attempt_transaction_unreadable':
        case 'connected_account_revoke_unavailable':
            return t('connectedServices.errors.accountSaveUnavailable');
        case 'connect_credential_not_found':
        case 'connected_account_not_found':
            return t('connectedServices.errors.profileNotFound');
        case 'connect_oauth_invalid_client':
        case 'connected_account_configuration_invalid':
        case 'connected_account_configuration_secret_field_invalid':
        case 'connected_account_configuration_settings_invalid':
        case 'connected_account_settlement_configuration_invalid':
        case 'connected_account_attempt_transaction_contract_invalid':
        case 'connected_account_attempt_transaction_expiry_invalid':
            return t('connectedServices.account.configurationInvalid');
        case 'connect_credential_referenced_by_group':
            return t('connectedServices.errors.credentialReferencedByGroup');
        case 'connect_credential_mutation_superseded':
            return t('connectedServices.errors.generic');
        case 'connect_group_profile_runtime_cooldown':
            return t('connectedServices.errors.runtimeCooldown', { time: formatResetAt(error) });
        case 'connect_group_generation_conflict':
        case 'connect_group_incarnation_conflict':
        case 'connect_group_runtime_state_revision_conflict':
        case 'connect_group_source_revision_conflict':
            return typeof errorLike.generation === 'number'
                ? t('connectedServices.errors.generationConflictWithGeneration', { generation: errorLike.generation })
                : t('connectedServices.errors.generationConflict');
        case 'connect_group_generation_required':
        case 'connect_group_runtime_state_revision_required':
            return t('connectedServices.errors.generationRequired');
        case 'connect_group_not_found':
            return t('connectedServices.errors.groupNotFound');
        case 'connect_group_member_not_found':
            return t('connectedServices.errors.groupMemberNotFound');
        case 'connect_group_member_profile_not_found':
            return t('connectedServices.errors.profileNotFound');
        case 'connect_group_active_profile_not_member':
            return t('connectedServices.errors.activeProfileNotMember');
        case 'connect_group_fallback_disabled':
            return t('connectedServices.errors.fallbackDisabled');
        case 'connect_group_duplicate_member':
        case 'connect_group_member_already_exists':
            return t('connectedServices.errors.duplicateMember');
        case 'connect_group_already_exists':
            return t('connectedServices.errors.groupAlreadyExists');
        case 'connect_group_invalid':
            return t('connectedServices.errors.invalidGroup');
        case 'connected_service_request_failed':
            break;
        default:
            if (code) return t('connectedServices.errors.generic');
    }

    if (typeof errorLike.status === 'number') {
        return t('connectedServices.errors.requestFailedWithStatus', { status: errorLike.status });
    }
    return t('connectedServices.errors.generic');
}

export function resolveConnectedServiceRuntimeCooldownOverrideBody(error: unknown): string {
    return t('connectedServices.errors.runtimeCooldownOverrideBody', { time: formatResetAt(error) });
}
