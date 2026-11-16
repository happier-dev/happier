import { describe, expect, it } from 'vitest';

import { t } from '@/text';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { PluginDiagnosticDataV1Schema } from '@happier-dev/protocol/daemon/pluginContributionIntrospection';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountAuthenticationContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { neonPortableRuntime } from '../../../../../../packages/plugins/deployment-neon/src/connectedAccounts/runtime';
import { supabasePortableRuntime } from '../../../../../../packages/plugins/deployment-supabase/src/connectedAccounts/runtime';

import {
  readConnectedServiceSettingsErrorCode,
  readConnectedServiceSettingsErrorDetailsCode,
  resolveConnectedServiceSettingsErrorRecovery,
  resolveConnectedServiceSettingsErrorMessage,
} from './connectedServiceSettingsErrors';

const neonConfigurationValues: ConnectedAccountAuthenticationContext['configuration']['values'] = { organizationId: 'org-example' };
const supabaseConfigurationValues: ConnectedAccountAuthenticationContext['configuration']['values'] = { organizationSlug: 'org-example' };

describe('connected-service settings errors', () => {
  it('names app-side artifact failure without blaming the selected Machine', () => {
    expect(resolveConnectedServiceSettingsErrorMessage({ code: 'connected_account_app_service_unavailable' }))
      .toBe(t('connectedServices.errors.accountAppServiceUnavailable'));
  });
  it.each([
    { runtime: neonPortableRuntime, pluginId: 'happier.deploy.neon', localId: 'neon', values: neonConfigurationValues,
      status: 503, code: 'neon_unavailable', key: 'connectedServices.errors.accountAuthenticationUnavailable', recovery: 'retry' },
    { runtime: supabasePortableRuntime, pluginId: 'happier.deploy.supabase', localId: 'supabase', values: supabaseConfigurationValues,
      status: 401, code: 'supabase_invalid_token', key: 'connectedServices.errors.accountAuthenticationRejected', recovery: 'edit' },
  ] as const)('presents the actual $localId authentication producer refusal', async row => {
    const http = createPluginHttpFixture({ async request() {
      return { status: row.status, headers: {}, body: new Uint8Array() };
    } });
    // Only HTTP is used by these refusals; all other external host services fail loudly.
    const services = new Proxy({ http } as ConnectedAccountAuthenticationContext['services'], {
      get(target, key) { if (key === 'http') return target.http; throw new Error('Unexpected host service'); },
    });
    const service = { pluginId: row.pluginId, localId: row.localId };
    const context = {
      plugin: { id: row.pluginId, version: '0.0.0' }, contribution: { id: row.localId, qualifiedId: `${row.pluginId}/${row.localId}` },
      surface: 'ui', invokedAtMs: 1, service, signal: new AbortController().signal, services,
      attempt: { kind: 'connect', attemptId: 'diagnostic-fixture' },
      configuration: { target: { kind: 'attempt', service, modeId: 'token', attemptId: 'diagnostic-fixture' },
        revision: 'config-1', values: row.values, async getSecret() { return null; } },
      attemptCredentials: { async get() { return null; }, async set() { throw new Error('Refusal must not save credentials'); }, async delete() {} },
    } satisfies ConnectedAccountAuthenticationContext;
    const mode = row.runtime.authentication.modes.token;
    if (!mode || mode.kind !== 'manual') throw new Error('Missing manual authentication');
    const result = await mode.complete({ fields: { token: 'dummy-diagnostic-fixture' } }, context);
    expect(resolveConnectedServiceSettingsErrorMessage(result)).toBe(t(row.key));
    expect(readConnectedServiceSettingsErrorDetailsCode(result)).toBe(row.code);
    expect(resolveConnectedServiceSettingsErrorRecovery(result)).toBe(row.recovery);
  });

  it.each([
    ['reconnectRequired', 'accountAuthenticationRestartRequired'],
    ['outcomeUnknown', 'accountStateUncertain'],
  ] as const)('uses the authentication owner’s %s disposition for any service', (status, copy) => {
    const error = { status, code: 'example_service_diagnostic' };
    expect(resolveConnectedServiceSettingsErrorMessage(error)).toBe(t(`connectedServices.errors.${copy}`));
    expect(resolveConnectedServiceSettingsErrorRecovery(error)).toBe(status === 'reconnectRequired' ? 'edit' : 'retry');
  });
  it.each([
    ['unauthorized', 'catalogSignInRequired'],
    ['forbidden', 'accountAccessUnavailable'],
    ['unsupported', 'accountOperationUnsupported'],
    ['unreachable', null],
    ['scope-retired', 'accountConfigurationChanged'],
    ['action_account_scope_changed', 'accountConfigurationChanged'],
    ['source-currentness-unavailable', 'accountSaveUnavailable'],
    ['source-transfer-unavailable', 'accountSaveUnavailable'],
    ['source-version-conflict', 'accountConfigurationChanged'],
    ['authority-not-confirmed', 'accountSaveUnavailable'],
    ['database_transaction_conflict_exhausted', 'accountSaveUnavailable'],
    ['account-not-found', 'accountConfigurationChanged'],
    ['account-inconsistent', 'catalogEncryptionUnavailable'],
    ['account-mode-mismatch', 'catalogEncryptionUnavailable'],
    ['encryption-material-unavailable', 'catalogEncryptionUnavailable'],
    ['invalid-stored-content', 'catalogContentUnreadable'],
    ['invalid-reference', 'catalogSecretUnavailable'],
    ['saved-secret-unavailable', 'catalogSecretUnavailable'],
    ['conflict', 'accountConfigurationChanged'],
    ['settings-conflict', 'accountConfigurationChanged'],
    ['outcome_unknown', 'accountStateUncertain'],
    ['cancelled', 'catalogCancelled'],
    ['not_dispatched', 'accountSaveUnavailable'],
  ] as const)('preserves the catalog refusal and its recovery (%s)', (code, key) => {
    const error = { code };
    expect(resolveConnectedServiceSettingsErrorMessage(error)).toBe(key
      ? t(`connectedServices.errors.${key}`) : t('errors.connectedAccountsUnavailable'));
    expect(readConnectedServiceSettingsErrorDetailsCode(error)).toBe(code);
  });

  it('presents a catalog HTTP refusal with its status and recovery without exposing transport prose', () => {
    expect(resolveConnectedServiceSettingsErrorMessage({ code: 'connected_account_catalog_http_503', message: 'private response' }))
      .toBe(t('connectedServices.errors.requestFailedWithStatus', { status: 503 }));
  });

  it('keeps the specific safe provider code for reconnect and uncertain details', () => {
    for (const status of ['reconnectRequired', 'outcomeUnknown']) {
      const error = { status, code: 'connected_account_authentication_outcome_unknown',
        diagnostic: { code: 'claude_subscription_oauth_response_invalid' } };
      expect(readConnectedServiceSettingsErrorDetailsCode(error))
        .toBe('claude_subscription_oauth_response_invalid');
      expect(readConnectedServiceSettingsErrorCode(error)).toBe('connected_account_authentication_outcome_unknown');
      expect(resolveConnectedServiceSettingsErrorMessage(error))
        .toBe(t('connectedServices.errors.accountStateUncertain'));
    }
    expect(readConnectedServiceSettingsErrorDetailsCode({ status: 'reconnectRequired',
      code: 'connected_account_authentication_outcome_unknown', diagnostic: { message: 'private prose' } }))
      .toBe('connected_account_authentication_outcome_unknown');
  });
  it.each(['connected_account_reconnect_provider_identity_mismatch'])(
    'explains the established credential identity mismatch (%s)', code => {
      expect(resolveConnectedServiceSettingsErrorMessage({ status: 'rejected', code }))
        .toBe(t('connectedServices.errors.accountIdentityMismatch'));
    });
  it('explains how browser sign-in can continue when no trusted Machine is online', () => {
    expect(resolveConnectedServiceSettingsErrorMessage({ status: 'unavailable',
      code: 'connected_account_browser_sign_in_machine_unavailable' }))
      .toBe(t('connectedServices.errors.browserSignInMachineUnavailable'));
  });
  it('offers an update or app handoff when the chosen Machine cannot run sign-in', () => {
    expect(resolveConnectedServiceSettingsErrorMessage({ status: 'unavailable', code: 'cli_update_required' }))
      .toBe(t('connectedServices.errors.browserSignInMachineUpdateRequired'));
  });
  it.each([
    ['connected_account_authentication_outcome_unknown', 'accountStateUncertain'],
    ['connected_account_authentication_rejected', 'accountAuthenticationRejected'],
    ['connected_account_authentication_unavailable', 'accountAuthenticationUnavailable'],
    ['connect_reconnect_required', 'accountAuthenticationRestartRequired'],
  ] as const)('gives a recovery message for the authentication owner’s public cause (%s)', (code, copy) => {
    expect(resolveConnectedServiceSettingsErrorMessage({ code })).toBe(t(`connectedServices.errors.${copy}`));
  });
  it('keeps pre-dispatch discovery failure retryable while an issued effect stays uncertain', () => {
    expect(resolveConnectedServiceSettingsErrorMessage(new RpcError('private transport diagnostics', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE)))
      .toBe(t('connectedServices.errors.accountMachineUnavailable'));
    expect(resolveConnectedServiceSettingsErrorMessage(new RpcError('private transport diagnostics', RPC_ERROR_CODES.OUTCOME_UNKNOWN)))
      .toBe(t('connectedServices.errors.accountStateUncertain'));
  });
  it.each([
    { status: 'rejected', code: 'cloudflare_token_rejected', message: 'The Cloudflare token is invalid, expired or revoked.' },
    { status: 'unavailable', code: 'cloudflare_verification_unavailable', message: 'Cloudflare could not verify this connection. No token was saved; try again.' },
    { status: 'rejected', code: 'vercel_invalid_token', message: 'The Vercel token is invalid, expired or revoked.' },
  ])('shows the admitted probe message for $code', ({ status, code, message }) => {
    expect(resolveConnectedServiceSettingsErrorMessage({ status, code,
      diagnostic: { code, severity: 'error', message } })).toBe(message);
  });

  it.each([
    { status: 'unavailable', code: 'connected_account_service_unavailable', remediation: { kind: 'retry' },
      remedy: () => t('externalSessions.settingsIntegrationRemediationRetry') },
    { status: 'rejected', code: 'connected_account_authentication_rejected', remediation: { kind: 'openSettings', path: '/settings/accounts' },
      remedy: () => t('externalSessions.settingsIntegrationRemediationOpenSettings', { path: '/settings/accounts' }) },
    { status: 'unavailable', code: 'connected_account_authentication_unavailable',
      remediation: { kind: 'selectAccount', service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' } },
      remedy: () => t('externalSessions.settingsIntegrationRemediationSelectAccount', { service: 'happier.deploy.cloudflare/cloudflare' }) },
    { status: 'unavailable', code: 'connected_account_service_unavailable', remediation: { kind: 'installDependency', dependencyId: 'cloudflared' },
      remedy: () => t('externalSessions.settingsIntegrationRemediationInstallDependency', { dependency: 'cloudflared' }) },
    { status: 'unavailable', code: 'connected_account_service_unavailable', remediation: { kind: 'openUrl', url: 'https://example.com/sign-in' },
      remedy: () => t('externalSessions.settingsIntegrationRemediationOpenUrl', { url: 'https://example.com/sign-in' }) },
  ] as const)('names the typed cause over the generic $code copy, with its $remediation.kind remediation', ({ status, code, remediation, remedy }) => {
    const message = 'Cloudflare could not verify this connection. No token was saved.';
    // The wire diagnostic as the connected-account host projects it (protocol schema, not a hand copy).
    const diagnostic = PluginDiagnosticDataV1Schema.parse({ code: 'cloudflare_verification_unavailable', severity: 'error', message, remediation });
    expect(resolveConnectedServiceSettingsErrorMessage({ status, code, diagnostic })).toBe(`${message} ${remedy()}`);
    expect(resolveConnectedServiceSettingsErrorMessage({ status, code, diagnostic: { ...diagnostic, remediation: undefined } })).toBe(message);
  });

  it('preserves typed rejection when no probe message is available without exposing untyped errors', () => {
    expect(resolveConnectedServiceSettingsErrorMessage({ status: 'rejected', code: 'another_leaf_rejection' }))
      .toBe(t('connectedServices.errors.accountAuthenticationRejected'));
    expect(resolveConnectedServiceSettingsErrorMessage(new Error('private transport prose')))
      .toBe(t('connectedServices.errors.generic'));
    expect(resolveConnectedServiceSettingsErrorRecovery({ status: 'rejected', code: 'credential_unavailable' })).toBe('edit');
  });

  it.each([
    { status: 'unavailable', code: 'neon_unavailable', key: 'connectedServices.errors.accountAuthenticationUnavailable' },
    { status: 'rejected', code: 'supabase_invalid_token', key: 'connectedServices.errors.accountAuthenticationRejected' },
  ] as const)('keeps code-as-message $code in Details rather than primary copy', ({ status, code, key }) => {
    const error = { status, diagnostic: { code, severity: 'error', message: code } };
    expect(resolveConnectedServiceSettingsErrorMessage(error)).toBe(t(key));
    expect(readConnectedServiceSettingsErrorDetailsCode(error)).toBe(code);
    expect(resolveConnectedServiceSettingsErrorRecovery(error)).toBe(status === 'rejected' ? 'edit' : 'retry');
  });

  it('localizes a message-free authentication diagnostic while retaining its details and recovery', () => {
    const unavailable = { status: 'unavailable', diagnostic: { code: 'neon_unavailable', severity: 'error' } };
    expect(resolveConnectedServiceSettingsErrorMessage(unavailable))
      .toBe(t('connectedServices.errors.accountAuthenticationUnavailable'));
    expect(readConnectedServiceSettingsErrorDetailsCode(unavailable)).toBe('neon_unavailable');
    expect(resolveConnectedServiceSettingsErrorRecovery(unavailable)).toBe('retry');
    expect(resolveConnectedServiceSettingsErrorMessage({ status: 'unavailable' }))
      .toBe(t('connectedServices.errors.accountServiceUnavailable'));
    expect(resolveConnectedServiceSettingsErrorMessage({ ...unavailable, code: 'plugin_setup_unavailable' }))
      .toBe(t('connectedServices.errors.accountServiceUnavailable'));
  });

  it('explains an unavailable saved secret without parsing it as authentication or generic failure', () => {
    expect(resolveConnectedServiceSettingsErrorMessage(new Error('saved-secret-unavailable')))
      .toBe(t('connectedServices.errors.catalogSecretUnavailable'));
  });
  it.each(['plugin_setup_unavailable', 'connected_account_configuration_unavailable'])(
    'classifies the typed unavailable preparation outcome for %s without implying a save', code => {
      expect(resolveConnectedServiceSettingsErrorMessage({ status: 'unavailable', code }))
        .toBe(t('connectedServices.errors.accountServiceUnavailable'));
    });

  // Loading a sign-in (its description, its form, a waiting attempt) changes nothing: an unexplained
  // failure there says the sign-in could not load, never that a change or a save did not finish.
  describe('while the sign-in loads', () => {
    const load = { phase: 'load', serviceName: 'Boat' } as const;
    const loadFailed = t('connectedServices.errors.signInLoadFailed', { service: 'Boat' });

    it.each([
      ['an unrecognised code', { status: 'conflict', code: 'boat_setup_declaration_unreadable' }],
      ['an untyped request failure', { code: 'connected_service_request_failed' }],
      ['no code at all', new Error('private transport diagnostics')],
      ['the form read failing without a typed outcome', { code: 'connected_account_configuration_unavailable' }],
    ])('says the sign-in could not load for %s', (_case, error) => {
      expect(resolveConnectedServiceSettingsErrorMessage(error, load)).toBe(loadFailed);
      expect(resolveConnectedServiceSettingsErrorRecovery(error)).toBe('retry');
    });

    it('keeps a typed computer, service or rejection reason', () => {
      expect(resolveConnectedServiceSettingsErrorMessage({ code: 'connected_account_daemon_unavailable' }, load))
        .toBe(t('connectedServices.errors.accountMachineUnavailable'));
      expect(resolveConnectedServiceSettingsErrorMessage({ status: 'unavailable', code: 'plugin_setup_unavailable' }, load))
        .toBe(t('connectedServices.errors.accountServiceUnavailable'));
      expect(resolveConnectedServiceSettingsErrorMessage({ status: 'rejected', code: 'credential_unavailable' }, load))
        .toBe(t('connectedServices.errors.accountAuthenticationRejected'));
    });

    it.each(['plugin_account_execution_unavailable', 'plugin_ui_declaration_pending',
      'plugin_ui_declaration_invalid', 'plugin_release_unavailable'])(
      'explains unavailable sign-in plugin preparation (%s)', code => {
        expect(resolveConnectedServiceSettingsErrorMessage({ code }))
          .toBe(t('sessionDrafts.availability.pluginUnavailable'));
      });

    it('still reports a failed save as a save once something was written', () => {
      expect(resolveConnectedServiceSettingsErrorMessage({ code: 'connected_account_configuration_unavailable' }))
        .toBe(t('connectedServices.errors.accountSaveUnavailable'));
    });
  });

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
      key: 'connectedServices.errors.accountAuthenticationUnavailable',
      codes: ['connected_account_authentication_unavailable'],
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
    const resetAtMs = Date.UTC(2026, 10, 6, 12);
    expect(resolveConnectedServiceSettingsErrorMessage({
      code: 'connect_group_profile_runtime_cooldown', resetAtMs,
    })).toBe(t('connectedServices.errors.runtimeCooldown', {
      time: new Date(resetAtMs).toLocaleString(),
    }));
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
