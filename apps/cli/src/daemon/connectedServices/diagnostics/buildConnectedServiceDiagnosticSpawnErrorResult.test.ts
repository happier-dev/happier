import { describe, expect, it } from 'vitest';

import {
  SPAWN_SESSION_ERROR_CODES,
  isConnectedServiceUxDiagnosticSpawnErrorDetail,
} from '@happier-dev/protocol';

import {
  buildConnectedServiceCredentialSpawnErrorResult,
  buildConnectedServiceCredentialRefreshSpawnErrorResult,
  buildConnectedServiceMaterializationSpawnErrorResult,
} from './buildConnectedServiceDiagnosticSpawnErrorResult';
import { ConnectedServiceCredentialResolutionError } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';

describe('buildConnectedServiceCredentialRefreshSpawnErrorResult', () => {
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

  it('builds a retryable transient-refresh diagnostic with only sanitized classification facts', () => {
    const rawProviderText = 'provider response token=must-not-leak';
    const result = buildConnectedServiceCredentialRefreshSpawnErrorResult({
      agentId: 'codex',
      error: Object.assign(new Error(rawProviderText), {
        name: 'ConnectedServiceSpawnCredentialRefreshError',
        kind: 'transient_refresh_failed',
        serviceId: 'openai-codex',
        profileId: 'voice-profile',
        diagnostic: {
          serviceId: 'openai-codex',
          profileId: 'voice-profile',
          reason: 'spawn_preflight',
          status: 'refresh_failed',
          category: 'network_error',
          providerErrorCode: rawProviderText,
          refreshToken: 'must-not-leak',
        },
      }),
    });

    expect(result).not.toBeNull();
    if (!result) throw new Error('expected transient-refresh spawn diagnostic');
    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'connected_service_credential_refresh_unavailable',
    });
    expect(isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)).toBe(true);
    if (!isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)) {
      throw new Error('expected connected-service diagnostic spawn detail');
    }
    expect(result.errorDetail.uxDiagnostic).toEqual({
      code: 'connected_service_credential_refresh_unavailable',
      failurePhase: 'materialization',
      source: 'spawn_resume',
      serviceId: 'openai-codex',
      agentId: 'codex',
      profileId: 'voice-profile',
      retryable: true,
      suggestedActions: ['retry', 'open_connected_accounts'],
      diagnostics: {
        reason: 'spawn_preflight',
        status: 'refresh_failed',
        category: 'network_error',
      },
    });
    expect(JSON.stringify(result)).not.toContain(rawProviderText);
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });

  it('keeps refresh-lease contention retryable without inventing a failure category', () => {
    const result = buildConnectedServiceCredentialRefreshSpawnErrorResult({
      agentId: 'codex',
      error: Object.assign(new Error('lease was held elsewhere'), {
        name: 'ConnectedServiceSpawnCredentialRefreshError',
        kind: 'transient_refresh_failed',
        diagnostic: {
          serviceId: 'openai-codex',
          profileId: 'voice-profile',
          reason: 'spawn_preflight',
          status: 'lease_not_acquired',
        },
      }),
    });

    expect(result).not.toBeNull();
    if (!result || !isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)) {
      throw new Error('expected refresh-lease diagnostic spawn detail');
    }
    expect(result.errorDetail.uxDiagnostic).toMatchObject({
      code: 'connected_service_credential_refresh_unavailable',
      retryable: true,
      suggestedActions: ['retry', 'open_connected_accounts'],
      diagnostics: {
        reason: 'spawn_preflight',
        status: 'lease_not_acquired',
        category: null,
      },
    });
  });

  it('maps profile action required spawn failures to the same reconnect diagnostic', () => {
    const result = buildConnectedServiceCredentialRefreshSpawnErrorResult({
      agentId: 'claude',
      error: Object.assign(new Error('profile needs reconnect'), {
        name: 'ConnectedServiceSpawnProfileActionRequiredError',
        kind: 'profile_action_required',
        action: 'reconnect_connected_service_profile',
        serviceId: 'claude-subscription',
        profileId: 'batiplus',
        status: 'needs_reauth',
      }),
    });

    expect(result).not.toBeNull();
    if (!result) {
      throw new Error('expected profile-action-required spawn diagnostic');
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
      source: 'spawn_resume',
      serviceId: 'claude-subscription',
      profileId: 'batiplus',
      diagnostics: {
        reason: 'profile_action_required',
        refreshStatus: 'needs_reauth',
      },
    });
  });

  it('maps missing connected-service credentials to the reconnect-required spawn diagnostic', () => {
    const result = buildConnectedServiceCredentialSpawnErrorResult({
      agentId: 'claude',
      error: new ConnectedServiceCredentialResolutionError({
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
      profileId: 'batiplus',
      retryable: false,
      suggestedActions: ['reconnect_profile', 'open_connected_accounts'],
      diagnostics: {
        reason: 'missing_credential',
      },
    });
  });
});
