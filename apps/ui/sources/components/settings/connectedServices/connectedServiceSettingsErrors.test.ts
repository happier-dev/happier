import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import {
  isConnectedServiceCredentialReferencedByGroupError,
  resolveConnectedServiceSettingsErrorMessage,
} from './connectedServiceSettingsErrors';

describe('connected-service settings errors', () => {
  // Current daemon, authentication/configuration owners and UI/API adapter errors
  // share recovery categories; raw diagnostics never become user-facing copy.
  const accountErrorCategories = [
    {
      key: 'connectedServices.errors.accountRuntimeChanged',
      codes: [
        'connected_account_runtime_generation_changed',
        'connected_account_producer_result_stale',
      ],
    },
    {
      key: 'connectedServices.errors.accountMachineUnavailable',
      codes: [
        'connected_account_daemon_unavailable',
        'connected_account_daemon_owner_unavailable',
        'connected_account_daemon_runtime_unavailable',
        'connected_account_runtime_unavailable',
        'connected_account_peer_operation_admission_unavailable',
      ],
    },
    {
      key: 'connectedServices.errors.accountServiceUnavailable',
      codes: [
        'connect_quotas_not_found',
        'connected_account_service_unavailable',
        'connected_account_service_description_unavailable',
        'connected_account_options_unavailable',
        'connected_account_control_unavailable',
        'connected_account_authentication_mode_unavailable',
        'connected_account_authentication_operation_unavailable',
        'connected_account_authentication_unavailable',
        'connected_account_attempt_internal_unavailable',
        'connected_account_attempt_unavailable',
        'connected_account_attempt_discovery_unavailable',
        'connected_account_producer_context_unavailable',
        'connected_account_configuration_target_unavailable',
        'connected_account_purpose_binding_owner_unavailable',
        'connected_account_materialization_consumer_unavailable',
        'connected_account_request_auth_unavailable',
        'connected_account_request_auth_backoff_unavailable',
        'connected_account_request_auth_http_port_unavailable',
        'connected_account_session_binding_unavailable',
        'connected_account_launch_environment_purpose_unavailable',
        'connected_account_launch_file_environment_purpose_unavailable',
        'connected_account_purpose_unavailable',
      ],
    },
    {
      key: 'connectedServices.errors.accountOperationUnsupported',
      codes: [
        'connect_credential_unsupported_format',
        'connect_group_runtime_fallback_unsupported',
        'connected_account_legacy_operation_unsupported',
        'connected_account_v4_operation_unsupported',
        'connected_account_service_identity_unsupported',
        'connected_account_v4_contract_unavailable',
        'connected_account_v4_contract_violation',
        'connected_account_capability_indeterminate',
        'connected_account_daemon_response_invalid',
        'connected_account_producer_result_invalid',
        'connected_account_credential_conflict_response_invalid',
        'connected_account_group_conflict_response_invalid',
      ],
    },
    {
      key: 'connectedServices.errors.accountConfigurationRequired',
      codes: [
        'connected_account_configuration_required',
        'connected_account_configured_origins_unavailable',
      ],
    },
    {
      key: 'connectedServices.errors.accountConfigurationChanged',
      codes: [
        'connected_account_configuration_changed',
        'connected_account_configuration_stale',
        'connected_account_configuration_consequence_stale',
        'connected_account_configuration_settings_conflict',
        'connected_account_credential_changed',
        'connected_account_settlement_conflict',
        'connected_account_device_transaction_conflict',
        'connected_account_attempt_transaction_conflict',
        'connected_account_configuration_revision_unavailable',
      ],
    },
    {
      key: 'connectedServices.errors.accountStateUncertain',
      codes: [
        'connected_account_authentication_outcome_unknown',
        'connected_account_settlement_outcome_unknown',
        'connected_account_configuration_settings_outcome_unknown',
        'connected_account_revoke_outcome_unknown',
        'connected_account_provider_operation_interrupted',
        'connected_account_late_evidence_unavailable',
        'connected_account_authentication_reconciliation_unavailable',
        'connected_account_configuration_consequence_unavailable',
        'connected_account_configuration_atomic_service_settlement_unavailable',
        'connected_account_request_auth_activation_failed',
        'connected_account_session_binding_activation_failed',
      ],
    },
    {
      key: 'connectedServices.errors.accountAuthenticationRestartRequired',
      codes: [
        'connect_authentication_mode_mismatch',
        'connect_oauth_state_mismatch',
        'connect_oauth_timeout',
        'connect_oauth_invalid_grant',
        'connect_oauth_missing_refresh_token',
        'connect_reconnect_required',
        'connected_account_attempt_expired',
        'connected_account_attempt_not_found',
        'connected_account_attempt_cancelled',
        'connected_account_attempt_phase_mismatch',
        'connected_account_authentication_mode_mismatch',
        'connected_account_device_authorization_expired',
        'connected_account_device_transaction_invalid',
        'connected_account_device_transaction_unavailable',
        'connected_account_oauth_authorization_interrupted',
        'connected_account_oauth_transaction_invalid',
        'connected_account_oauth_transaction_unavailable',
        'connected_account_attempt_transaction_not_found',
        'connected_account_configuration_settings_cancelled',
      ],
    },
    {
      key: 'connectedServices.errors.accountOperationBusy',
      codes: [
        'connected_account_attempt_in_progress',
        'connected_account_attempt_capacity_exhausted',
        'connected_account_attempt_configuration_capacity_exhausted',
        'connected_account_attempt_cleanup_pending',
        'connected_account_configuration_settings_locked',
        'connected_account_request_auth_capability_lock_timeout',
      ],
    },
    {
      key: 'connectedServices.errors.accountAuthenticationRejected',
      codes: [
        'connect_credential_invalid',
        'connect_oauth_exchange_failed',
        'connected_account_authentication_rejected',
        'connected_account_manual_fields_invalid',
        'connected_account_oauth_completion_invalid',
        'connected_account_provider_result_invalid',
        'connected_account_identity_unavailable',
      ],
    },
    {
      key: 'connectedServices.errors.accountIdentityMismatch',
      codes: [
        'connect_reconnect_provider_identity_mismatch',
        'connected_account_reconnect_identity_mismatch',
        'connected_account_reconnect_provider_identity_mismatch',
        'connected_account_settlement_identity_mismatch',
        'connected_account_configuration_target_mismatch',
        'connected_account_canonical_session_identity_conflict',
        'connected_account_purpose_resolution_account_mismatch',
        'connected_account_purpose_resolution_service_mismatch',
        'connected_account_scm_hosting_purpose_consumer_identity_mismatch',
      ],
    },
    {
      key: 'connectedServices.errors.accountAccessUnavailable',
      codes: [
        'connected_account_session_binding_already_active',
        'connected_account_session_binding_duplicate_purpose',
        'connected_account_session_binding_undeclared_purpose',
        'connected_account_session_binding_duplicate_binding',
        'connected_account_session_binding_direct_material_origin_mismatch',
        'connected_account_session_binding_duplicate_direct_material_origin',
        'connected_account_execution_run_binding_already_active',
        'connected_account_execution_run_binding_duplicate_purpose',
        'connected_account_execution_run_binding_undeclared_purpose',
        'connected_account_execution_run_binding_duplicate_binding',
        'connected_account_execution_run_binding_direct_material_origin_mismatch',
        'connected_account_execution_run_binding_duplicate_direct_material_origin',
        'connected_account_agent_catalog_observation_binding_already_active',
        'connected_account_agent_catalog_observation_binding_duplicate_purpose',
        'connected_account_agent_catalog_observation_binding_undeclared_purpose',
        'connected_account_agent_catalog_observation_binding_duplicate_binding',
        'connected_account_agent_catalog_observation_binding_consumer_mismatch',
        'connected_account_agent_catalog_observation_binding_direct_material_consumer_unsupported',
        'connected_account_operation_binding_already_active',
        'connected_account_operation_binding_duplicate_purpose',
        'connected_account_operation_binding_undeclared_purpose',
        'connected_account_operation_binding_duplicate_binding',
        'connected_account_operation_binding_consumer_mismatch',
        'connected_account_operation_binding_direct_material_origin_mismatch',
        'connected_account_operation_binding_duplicate_direct_material_origin',
        'connected_account_operation_binding_direct_material_consumer_unsupported',
        'connected_account_managed_provider_operation_binding_already_active',
        'connected_account_managed_provider_operation_binding_duplicate_purpose',
        'connected_account_managed_provider_operation_binding_undeclared_purpose',
        'connected_account_managed_provider_operation_binding_duplicate_binding',
        'connected_account_managed_provider_operation_binding_consumer_mismatch',
        'connected_account_managed_provider_operation_binding_direct_material_consumer_unsupported',
        'connected_account_ambiguous',
        'connected_account_attempt_identity_forbidden',
        'connected_account_configuration_read_only',
        'connected_account_request_auth_capability_path_unsafe',
        'connected_account_request_auth_capability_scope_invalid',
        'connected_account_purpose_projection_conflicting_scope',
        'connected_account_purpose_reconciliation_consumer_mismatch',
        'connected_account_purpose_reconciliation_duplicate_consumer',
        'connected_account_purpose_reconciliation_duplicate_purpose',
        'connected_account_agent_purpose_consumer_identity_missing',
        'connected_account_session_binding_snapshot_invalid',
        'connected_account_session_binding_snapshot_duplicate_binding',
        'connected_account_session_binding_snapshot_duplicate_purpose',
        'connected_account_session_binding_snapshot_undeclared_purpose',
        'connected_account_session_binding_scope_duplicate_purpose',
        'connected_account_session_binding_scope_subject_id_required',
        'connected_account_session_binding_session_id_required',
        'connected_account_execution_run_binding_agent_id_required',
        'connected_account_execution_run_binding_run_id_required',
        'connected_account_execution_run_binding_runner_pid_required',
        'connected_account_agent_catalog_observation_binding_operation_id_required',
        'connected_account_operation_binding_operation_id_required',
        'connected_account_managed_provider_operation_binding_identity_required',
        'connected_account_managed_provider_operation_binding_operation_id_required',
      ],
    },
    {
      key: 'connectedServices.errors.accountSaveUnavailable',
      codes: [
        'connect_credential_seal_unavailable',
        'connected_account_configuration_atomic_persistence_unavailable',
        'connected_account_configuration_persistence_unavailable',
        'connected_account_persistence_unavailable',
        'connected_account_device_settlement_persistence_unavailable',
        'connected_account_oauth_settlement_persistence_unavailable',
        'connected_account_oauth_transaction_persistence_unavailable',
        'connected_account_configuration_settings_unavailable',
        'connected_account_configuration_unavailable',
        'connected_account_attempt_transaction_storage_mode_mismatch',
        'connected_account_attempt_transaction_unreadable',
        'connected_account_revoke_unavailable',
      ],
    },
    {
      key: 'connectedServices.errors.profileNotFound',
      codes: [
        'connect_credential_not_found',
        'connected_account_not_found',
      ],
    },
    {
      key: 'connectedServices.errors.generationRequired',
      codes: ['connect_group_runtime_state_revision_required'],
    },
    {
      key: 'connectedServices.account.configurationInvalid',
      codes: [
        'connect_oauth_invalid_client',
        'connected_account_configuration_invalid',
        'connected_account_configuration_secret_field_invalid',
        'connected_account_configuration_settings_invalid',
        'connected_account_settlement_configuration_invalid',
        'connected_account_attempt_transaction_contract_invalid',
        'connected_account_attempt_transaction_expiry_invalid',
      ],
    },
  ] as const;

  it.each(accountErrorCategories)('explains account failures with $key recovery guidance', ({ key, codes }) => {
    for (const code of codes) {
      const message = resolveConnectedServiceSettingsErrorMessage({
        code,
        message: 'remote failure: token=never-render-this',
        status: 409,
      });

      expect(message, code).toBe(t(key));
      expect(message, code).not.toBe(t('connectedServices.errors.generic'));
      expect(message, code).not.toContain(code);
      expect(message, code).not.toContain('token=never-render-this');
    }
  });

  it('keeps unknown account failures generic even when they carry an HTTP status', () => {
    expect(resolveConnectedServiceSettingsErrorMessage({
      code: 'connected_account_future_failure',
      message: 'token=never-render-this',
      status: 409,
    })).toBe(t('connectedServices.errors.generic'));
  });

  it('resolves known codes carried by an Error without disclosing arbitrary messages', () => {
    expect(resolveConnectedServiceSettingsErrorMessage(
      new Error('connected_account_runtime_generation_changed'),
    )).toBe(t('connectedServices.errors.accountRuntimeChanged'));
  });

  it('preserves account group conflict and cooldown guidance', () => {
    expect(resolveConnectedServiceSettingsErrorMessage({
      code: 'connect_group_generation_conflict',
      generation: 3,
    })).toBe(t('connectedServices.errors.generationConflictWithGeneration', { generation: 3 }));
    expect(resolveConnectedServiceSettingsErrorMessage({
      code: 'connect_group_profile_runtime_cooldown',
    })).toBe(t('connectedServices.errors.runtimeCooldown', {
      time: t('connectedServices.errors.unknownResetTime'),
    }));
  });

  it('recognizes a credential still referenced by a pool', () => {
    expect(isConnectedServiceCredentialReferencedByGroupError({
      code: 'connect_credential_referenced_by_group',
      status: 409,
    })).toBe(true);
    expect(isConnectedServiceCredentialReferencedByGroupError({
      code: 'connect_credential_mutation_superseded',
      status: 409,
    })).toBe(false);
  });

  it('explains an invalid account configuration rather than falling back to generic copy', () => {
    const message = resolveConnectedServiceSettingsErrorMessage({
      code: 'connected_account_configuration_invalid',
    });

    expect(message).toBe(t('connectedServices.account.configurationInvalid'));
    expect(message).not.toBe(t('connectedServices.errors.generic'));
  });

  it('does not surface an untyped Error message', () => {
    const message = resolveConnectedServiceSettingsErrorMessage(
      new Error('remote failure: token=never-render-this'),
    );

    expect(message).toBe(t('connectedServices.errors.generic'));
    expect(message).not.toContain('token=never-render-this');
  });
});
