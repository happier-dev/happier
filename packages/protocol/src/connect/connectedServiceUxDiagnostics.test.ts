import { describe, expect, it } from 'vitest';

import {
  CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
  ConnectedServiceUxDiagnosticV1Schema,
  isConnectedServiceUxDiagnosticV1,
  normalizeConnectedServiceUxDiagnosticV1,
} from './connectedServiceUxDiagnostics.js';

describe('ConnectedServiceUxDiagnosticV1', () => {
  it('accepts the shared safe diagnostic shape used by CLI and UI surfaces', () => {
    const diagnostic = ConnectedServiceUxDiagnosticV1Schema.parse({
      code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerAccountAdoptionMismatch,
      failurePhase: 'post_switch_verification',
      source: 'manual_auth_switch',
      serviceId: 'openai-codex',
      providerId: 'codex',
      agentId: 'codex',
      profileId: 'backup',
      groupId: 'codex-main',
      retryable: true,
      suggestedActions: [
        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.retry,
        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts,
      ],
      diagnostics: {
        reason: 'provider reported a different active account',
        attemptCount: 1,
        recovered: false,
      },
    });

    expect(diagnostic).toMatchObject({
      code: 'provider_account_adoption_mismatch',
      failurePhase: 'post_switch_verification',
      source: 'manual_auth_switch',
      retryable: true,
      suggestedActions: ['retry', 'open_connected_accounts'],
    });
  });

  it('rejects raw nested provider payloads from diagnostics', () => {
    expect(() => ConnectedServiceUxDiagnosticV1Schema.parse({
      code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume,
      failurePhase: 'continuity',
      source: 'spawn_resume',
      retryable: false,
      suggestedActions: [CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.startFreshUnderSelectedAccount],
      diagnostics: {
        tokenPayload: { accessToken: 'secret' },
      },
    })).toThrow();
  });

  it('rejects generic token-bearing diagnostic keys', () => {
    for (const key of ['token', 'sessionToken']) {
      expect(() => ConnectedServiceUxDiagnosticV1Schema.parse({
        code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryRetryScheduled,
        failurePhase: 'runtime_auth_recovery',
        source: 'runtime_auth_recovery',
        retryable: true,
        suggestedActions: [CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.retry],
        diagnostics: {
          [key]: 'secret',
        },
      })).toThrow();
    }
  });

  it('keeps count and prose keys that merely contain credential substrings', () => {
    const parsed = ConnectedServiceUxDiagnosticV1Schema.safeParse({
      code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryRetryScheduled,
      failurePhase: 'runtime_auth_recovery',
      source: 'runtime_auth_recovery',
      retryable: true,
      diagnostics: {
        sessionCount: 3,
        tokenCount: 4,
        secretary: 'meeting-notes',
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('normalizes omitted suggested actions while keeping the guard runtime-sound', () => {
    const payload = {
      code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryRetryScheduled,
      failurePhase: 'runtime_auth_recovery',
      source: 'runtime_auth_recovery',
      retryable: true,
    };
    const diagnostic = ConnectedServiceUxDiagnosticV1Schema.parse(payload);

    expect(diagnostic.suggestedActions).toEqual([]);
    expect(normalizeConnectedServiceUxDiagnosticV1(payload)?.suggestedActions).toEqual([]);
    expect(isConnectedServiceUxDiagnosticV1(payload)).toBe(false);
    expect(isConnectedServiceUxDiagnosticV1(diagnostic)).toBe(true);
  });

  it('accepts usage-limit recovery as a distinct diagnostic source from manual and runtime-auth flows', () => {
    const diagnostic = ConnectedServiceUxDiagnosticV1Schema.parse({
      code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.metadataUpdateFailed,
      failurePhase: 'metadata',
      source: 'usage_limit_recovery',
      serviceId: 'openai-codex',
      profileId: 'backup',
      groupId: 'codex-main',
      retryable: true,
      suggestedActions: [CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.retry],
      diagnostics: {
        reason: 'pre-turn quota switch could not persist the target binding',
      },
    });

    expect(diagnostic.source).toBe('usage_limit_recovery');
  });

  it('accepts a retryable connected-service credential refresh diagnostic', () => {
    const diagnostic = ConnectedServiceUxDiagnosticV1Schema.parse({
      code: 'connected_service_credential_refresh_unavailable',
      failurePhase: 'materialization',
      source: 'spawn_resume',
      serviceId: 'openai-codex',
      agentId: 'codex',
      profileId: 'voice-profile',
      retryable: true,
      suggestedActions: [
        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.retry,
        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts,
      ],
      diagnostics: {
        reason: 'spawn_preflight',
        status: 'refresh_failed',
        category: 'network_error',
      },
    });

    expect(diagnostic).toMatchObject({
      code: 'connected_service_credential_refresh_unavailable',
      retryable: true,
      suggestedActions: ['retry', 'open_connected_accounts'],
    });
  });

  it.each([
    'claude_subscription_missing_claude_code_scope',
    'claude_subscription_native_auth_materialization_failed',
    'claude_subscription_setup_token_not_supported_for_unified',
  ])('accepts Claude native-auth diagnostic code %s as a first-class UX diagnostic', (code) => {
    const diagnostic = ConnectedServiceUxDiagnosticV1Schema.safeParse({
      code,
      failurePhase: 'materialization',
      source: 'manual_auth_switch',
      serviceId: 'claude-subscription',
      providerId: 'claude',
      agentId: 'claude',
      profileId: 'work',
      groupId: 'claude-main',
      retryable: false,
      suggestedActions: [
        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.reconnectProfile,
        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts,
      ],
      diagnostics: {
        reason: 'missing_required_scope',
        missingScope: 'user:sessions:claude_code',
      },
    });

    expect(diagnostic.success).toBe(true);
  });
});
