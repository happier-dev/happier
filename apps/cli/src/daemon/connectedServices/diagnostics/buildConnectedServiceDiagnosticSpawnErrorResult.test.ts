import { describe, expect, it } from 'vitest';

import {
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
  SPAWN_SESSION_ERROR_CODES,
  isConnectedServiceUxDiagnosticSpawnErrorDetail,
  type ConnectedServiceUxDiagnosticCodeV1,
} from '@happier-dev/protocol';

import { buildConnectedServiceUxDiagnostic } from './connectedServiceUxDiagnostics';
import {
  buildConnectedServiceCredentialSpawnErrorResult,
  buildConnectedServiceCredentialRefreshSpawnErrorResult,
  buildConnectedServiceDiagnosticSpawnValidationErrorResult,
  buildConnectedServiceMaterializationSpawnErrorResult,
  readConnectedServiceSpawnFailureLogFields,
} from './buildConnectedServiceDiagnosticSpawnErrorResult';

describe('buildConnectedServiceDiagnosticSpawnValidationErrorResult', () => {
  it('attaches a protocol-owned ux diagnostic to connected-service spawn validation errors', () => {
    const result = buildConnectedServiceDiagnosticSpawnValidationErrorResult({
      errorMessage: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing,
      uxDiagnostic: buildConnectedServiceUxDiagnostic({
        code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing,
        failurePhase: 'materialization',
        source: 'spawn_resume',
        agentId: 'codex',
        retryable: false,
        diagnostics: {
          reason: 'missing_identity_and_resume_state',
        },
      }),
    });

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'connected_service_materialization_identity_missing',
    });
    expect(isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)).toBe(true);
    if (!isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)) {
      throw new Error('expected connected-service diagnostic spawn detail');
    }
    expect(result.errorDetail.uxDiagnostic.code).toBe('connected_service_materialization_identity_missing');
  });

  it('defaults Claude native-auth diagnostics to reconnect-focused actions', () => {
    const diagnostic = buildConnectedServiceUxDiagnostic({
      code: 'claude_subscription_missing_claude_code_scope' as ConnectedServiceUxDiagnosticCodeV1,
      failurePhase: 'materialization',
      source: 'usage_limit_recovery',
      serviceId: 'claude-subscription',
      providerId: 'claude',
      agentId: 'claude',
      profileId: 'claude-profile',
      retryable: false,
      diagnostics: {
        materializationReason: 'missing_scope',
      },
    });

    expect(diagnostic).toMatchObject({
      code: 'claude_subscription_missing_claude_code_scope',
      suggestedActions: [
        'reconnect_profile',
        'open_connected_accounts',
      ],
    });
  });

  it('maps runtime-auth supersession diagnostics to retry and account actions', () => {
    const diagnostic = buildConnectedServiceUxDiagnostic({
      code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.runtimeAuthRecoverySuperseded,
      failurePhase: 'runtime_auth_recovery',
      source: 'runtime_auth_recovery',
      serviceId: 'openai-codex',
      providerId: 'codex',
      agentId: 'codex',
      profileId: 'codex-profile',
      retryable: true,
      diagnostics: {
        reason: 'failing_profile_inactive',
      },
    });

    expect(diagnostic).toMatchObject({
      code: 'runtime_auth_recovery_superseded',
      suggestedActions: [
        'retry',
        'open_connected_accounts',
      ],
    });
  });

  it('preserves first-class Claude materialization diagnostic codes on spawn failure', () => {
    const result = buildConnectedServiceMaterializationSpawnErrorResult({
      agentId: 'claude',
      diagnostics: [{
        code: 'claude_subscription_missing_claude_code_scope',
        providerId: 'claude',
        serviceId: 'claude-subscription',
        severity: 'blocking',
        reason: 'missing_required_scope',
        entryName: 'user:sessions:claude_code',
      }],
    });

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'claude_subscription_missing_claude_code_scope',
    });
    expect(isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)).toBe(true);
    if (!isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)) {
      throw new Error('expected connected-service diagnostic spawn detail');
    }
    expect(result.errorDetail.uxDiagnostic).toMatchObject({
      code: 'claude_subscription_missing_claude_code_scope',
      failurePhase: 'materialization',
      source: 'spawn_resume',
      agentId: 'claude',
      providerId: 'claude',
      serviceId: 'claude-subscription',
      retryable: false,
      suggestedActions: ['reconnect_profile', 'open_connected_accounts'],
      diagnostics: {
        reason: 'missing_required_scope',
        materializationCode: 'claude_subscription_missing_claude_code_scope',
        entryName: 'user:sessions:claude_code',
      },
    });
  });

  it('builds a reconnect-required spawn diagnostic without leaking raw credential material', () => {
    const result = buildConnectedServiceCredentialRefreshSpawnErrorResult({
      agentId: 'claude',
      error: Object.assign(new Error('raw refresh token should not be copied'), {
        name: 'ConnectedServiceSpawnCredentialRefreshError',
        kind: 'reconnect_required',
        serviceId: 'claude-subscription',
        profileId: 'batiplus',
        diagnostic: {
          serviceId: 'claude-subscription',
          profileId: 'batiplus',
          reason: 'spawn_preflight',
          status: 'refresh_failed',
          category: 'invalid_grant',
          refreshToken: 'must-not-leak',
        },
      }),
    });
    expect(result).not.toBeNull();
    if (!result) {
      throw new Error('expected reconnect-required spawn diagnostic');
    }

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'connected_service_credential_reconnect_required',
    });
    expect(isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)).toBe(true);
    if (!isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)) {
      throw new Error('expected connected-service diagnostic spawn detail');
    }
    expect(result.errorDetail.uxDiagnostic).toMatchObject({
      code: 'connected_service_credential_reconnect_required',
      failurePhase: 'materialization',
      source: 'spawn_resume',
      serviceId: 'claude-subscription',
      agentId: 'claude',
      profileId: 'batiplus',
      retryable: false,
      suggestedActions: ['reconnect_profile', 'open_connected_accounts'],
      diagnostics: {
        reason: 'spawn_preflight',
        refreshStatus: 'refresh_failed',
        refreshCategory: 'invalid_grant',
      },
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });

  it('builds a reconnect-focused spawn diagnostic for missing connected-service credentials', () => {
    const result = buildConnectedServiceCredentialSpawnErrorResult({
      agentId: 'claude',
      error: Object.assign(new Error('Missing connected service credential (claude-subscription/batiplus)'), {
        name: 'ConnectedServiceCredentialResolutionError',
        kind: 'missing_credential',
        serviceId: 'claude-subscription',
        profileId: 'batiplus',
      }),
    });

    expect(result).not.toBeNull();
    if (!result) {
      throw new Error('expected missing-credential spawn diagnostic');
    }
    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'connected_service_credential_reconnect_required',
    });
    expect(isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)).toBe(true);
    if (!isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)) {
      throw new Error('expected connected-service diagnostic spawn detail');
    }
    expect(result.errorDetail.uxDiagnostic).toMatchObject({
      code: 'connected_service_credential_reconnect_required',
      failurePhase: 'materialization',
      source: 'spawn_resume',
      serviceId: 'claude-subscription',
      agentId: 'claude',
      profileId: 'batiplus',
      retryable: false,
      suggestedActions: ['reconnect_profile', 'open_connected_accounts'],
      diagnostics: {
        reason: 'missing_credential',
      },
    });
  });
});

describe('readConnectedServiceSpawnFailureLogFields', () => {
  it('names the service, profile and reason that failed the credential preflight', () => {
    // The daemon used to log only the generic reconnect-required code, so a spawn refused for one
    // of several connected accounts could not be traced back to the account that caused it.
    const result = buildConnectedServiceCredentialRefreshSpawnErrorResult({
      agentId: 'claude',
      error: {
        name: 'ConnectedServiceSpawnCredentialRefreshError',
        kind: 'reconnect_required',
        serviceId: 'claude-subscription',
        profileId: 'Claude2',
        diagnostic: { reason: 'spawn_preflight', status: 'refresh_failed', category: 'invalid_grant' },
      },
    });
    if (!result) throw new Error('expected a spawn error result');

    expect(readConnectedServiceSpawnFailureLogFields(result)).toEqual({
      serviceId: 'claude-subscription',
      profileId: 'Claude2',
      reason: 'spawn_preflight',
      refreshStatus: 'refresh_failed',
      refreshCategory: 'invalid_grant',
    });
  });

  it('returns nothing for an error that carries no connected-service diagnostic', () => {
    expect(readConnectedServiceSpawnFailureLogFields({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'something else',
    })).toEqual({});
  });
});
