import { describe, expect, it } from 'vitest';

import {
  SPAWN_SESSION_ERROR_CODES,
  SPAWN_SESSION_ERROR_DETAIL_KINDS,
  SpawnSessionErrorCodeSchema,
  SpawnSessionExecutionAuthorizationSchema,
  SessionCreationTerminalSpawnErrorDetailSchema,
  isSessionCreationTerminalSpawnErrorDetail,
  isSessionCreationCorrespondenceConflictSpawnErrorDetail,
  isSessionCreationOrganizationInvalidSpawnErrorDetail,
  isConnectedServiceUxDiagnosticSpawnErrorDetail,
  isConnectedServiceResumeUnreachableSpawnErrorDetail,
  normalizeSpawnSessionErrorDetail,
  type SpawnSessionErrorDetail,
  type SpawnSessionResult,
} from './spawnSession.js';

describe('spawn-session execution authorization', () => {
  it('preserves bounded terminal-host setup recovery from the daemon', () => {
    const detail = { kind: 'terminal_host_unavailable', host: 'herdr', reason: 'server_version_unsupported' };
    expect(normalizeSpawnSessionErrorDetail(detail)).toEqual(detail);
    expect(normalizeSpawnSessionErrorDetail({ ...detail, reason: 'installation_unavailable' })).toEqual({ ...detail, reason: 'installation_unavailable' });
    expect(normalizeSpawnSessionErrorDetail({ ...detail, host: 'other' })).toBeUndefined();
    expect(normalizeSpawnSessionErrorDetail({ ...detail, localPath: '/private' })).toBeUndefined();
  });
  it('preserves opaque request-id bytes and rejects blank ids without collapsing identities', () => {
    const first = SpawnSessionExecutionAuthorizationSchema.parse({
      provenance: 'user_request',
      requestId: ' request-1',
    });
    const second = SpawnSessionExecutionAuthorizationSchema.parse({
      provenance: 'user_request',
      requestId: 'request-1 ',
    });

    expect(first.requestId).toBe(' request-1');
    expect(second.requestId).toBe('request-1 ');
    expect(first.requestId).not.toBe(second.requestId);
    expect(() => SpawnSessionExecutionAuthorizationSchema.parse({
      provenance: 'user_request',
      requestId: '   ',
    })).toThrow();
  });

  it('keeps older identity-only authorization accepted and carries an optional rearm timestamp', () => {
    expect(SpawnSessionExecutionAuthorizationSchema.parse({
      provenance: 'user_request',
      requestId: 'local-inactive',
    })).toEqual({ provenance: 'user_request', requestId: 'local-inactive' });
    expect(SpawnSessionExecutionAuthorizationSchema.parse({
      provenance: 'user_request',
      requestId: 'local-inactive',
      requestedAt: 1_234,
    })).toEqual({ provenance: 'user_request', requestId: 'local-inactive', requestedAt: 1_234 });
    expect(SpawnSessionExecutionAuthorizationSchema.safeParse({
      provenance: 'user_request',
      requestId: 'local-inactive',
      requestedAt: -1,
    }).success).toBe(false);
    expect(SpawnSessionExecutionAuthorizationSchema.safeParse({
      provenance: 'user_request',
      requestId: 'local-inactive',
      requestedAction: { v: 1, kind: 'send_now' },
    }).success).toBe(false);
  });
});

describe('spawn-session error detail contract (D2 structured continuity)', () => {
  it('carries only typed initial-trigger birth refusals as terminal creation outcomes', () => {
    for (const code of ['invalid_input', 'target_unavailable', 'feature_disabled']) {
      const detail = { kind: 'session_creation_initial_trigger_refused', code };
      expect(SessionCreationTerminalSpawnErrorDetailSchema.safeParse(detail).success).toBe(true);
      expect(normalizeSpawnSessionErrorDetail(detail)).toEqual(detail);
      expect(isSessionCreationTerminalSpawnErrorDetail(detail)).toBe(true);
      expect(normalizeSpawnSessionErrorDetail({ ...detail, rawDiagnostic: '/private' })).toBeUndefined();
    }
    expect(normalizeSpawnSessionErrorDetail({ kind: 'session_creation_initial_trigger_refused', code: 'timeout' })).toBeUndefined();
  });
  it('preserves only the exact initial-access update requirement as a terminal creation refusal', () => {
    const detail = {
      kind: 'update_required',
      operation: 'session.spawn_new',
      component: 'server',
      reason: 'session_initial_access_update_required',
    };
    expect(SessionCreationTerminalSpawnErrorDetailSchema.safeParse(detail).success).toBe(true);
    expect(normalizeSpawnSessionErrorDetail(detail)).toEqual(detail);
    expect(isSessionCreationTerminalSpawnErrorDetail(detail)).toBe(true);
    expect(normalizeSpawnSessionErrorDetail({ ...detail, component: 'daemon' }))
      .toEqual({ ...detail, component: 'daemon' });
    for (const invalid of [
      { ...detail, operation: 'session.access.grant.set' },
      { ...detail, reason: 'timeout' },
      { ...detail, component: 'client' },
      { ...detail, rawDiagnostic: '/private/path' },
    ]) {
      expect(SessionCreationTerminalSpawnErrorDetailSchema.safeParse(invalid).success).toBe(false);
      expect(normalizeSpawnSessionErrorDetail(invalid)).toBeUndefined();
      expect(isSessionCreationTerminalSpawnErrorDetail(invalid)).toBe(false);
    }
  });

  it('carries the Home\'s typed initial-access refusal, never an update requirement, as a terminal creation refusal', () => {
    const detail = {
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.SESSION_CREATION_ACCESS_REFUSED,
      code: 'session_access_sharing_unavailable',
    } as const;
    expect(normalizeSpawnSessionErrorDetail(detail)).toEqual(detail);
    expect(isSessionCreationTerminalSpawnErrorDetail(detail)).toBe(true);
    for (const invalid of [
      { ...detail, code: 'timeout' },
      { ...detail, code: 'update_required' },
      { ...detail, rawDiagnostic: '/private/path' },
    ]) {
      expect(isSessionCreationTerminalSpawnErrorDetail(invalid)).toBe(false);
      expect(normalizeSpawnSessionErrorDetail(invalid)).toBeUndefined();
    }
  });

  it('carries exact terminal Session-creation refusals without widening their codes', () => {
    const detail: SpawnSessionErrorDetail = {
      kind: 'session_creation_organization_invalid',
      code: 'organization_invalid',
    };

    expect(normalizeSpawnSessionErrorDetail(detail)).toEqual(detail);
    expect(isSessionCreationOrganizationInvalidSpawnErrorDetail(detail)).toBe(true);
    // `organization_unavailable` remains a public Action result arm for its
    // eventual pre-dispatch owner. The session-create server does not emit it,
    // so this terminal startup carrier must not manufacture that meaning.
    expect(normalizeSpawnSessionErrorDetail({
      kind: 'session_creation_organization_invalid',
      code: 'organization_unavailable',
    })).toBeUndefined();

    const correspondenceConflict = {
      kind: 'session_creation_correspondence_conflict',
      code: 'creation_conflict',
    } as const;
    expect(normalizeSpawnSessionErrorDetail(correspondenceConflict)).toEqual(
      correspondenceConflict,
    );
    expect(isSessionCreationCorrespondenceConflictSpawnErrorDetail(correspondenceConflict)).toBe(true);
    expect(normalizeSpawnSessionErrorDetail({
      ...correspondenceConflict,
      code: 'organization_invalid',
    })).toBeUndefined();
  });

  it('round-trips a strict structured provider refusal without accepting extra diagnostics', () => {
    const detail = {
      kind: 'provider_error',
      providerError: {
        v: 1,
        code: 'provider_machine_grant_stale',
        connectionId: 'pc_work',
        machineId: 'machine-a',
        retryable: false,
        action: 'review_machine_grant',
      },
    };

    expect(normalizeSpawnSessionErrorDetail(detail)).toEqual(detail);
    expect(normalizeSpawnSessionErrorDetail({ ...detail, rawDiagnostic: 'secret/path' })).toBeUndefined();
    expect(normalizeSpawnSessionErrorDetail({
      ...detail,
      providerError: { ...detail.providerError, rawDiagnostic: 'secret/path' },
    })).toBeUndefined();
  });

  it('keeps the existing error result shape valid without an errorDetail (backward compatibility)', () => {
    // A pre-existing SPAWN_VALIDATION_FAILED consumer must still type-check and be usable with no
    // errorDetail field present. errorDetail is purely additive/optional.
    const legacy: SpawnSessionResult = {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'Claude CLI override is invalid',
    };

    expect(legacy.type).toBe('error');
    if (legacy.type !== 'error') throw new Error('expected error result');
    expect(legacy.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED);
    expect('errorDetail' in legacy).toBe(false);
  });

  it.each([
    'not_authenticated',
    'recipient_key_unavailable',
    'session_access_invalid_recipient_envelope',
    'session_access_request_failed',
    'session_access_subject_not_found',
    'session_data_key_unavailable',
  ] as const)('carries the physical-host initial-access failure %s through spawn settlement', (errorCode) => {
    expect(SpawnSessionErrorCodeSchema.safeParse(errorCode)).toMatchObject({ success: true });
  });

  it('carries a structured connected-service resume-unreachable detail alongside SPAWN_VALIDATION_FAILED', () => {
    const detail: SpawnSessionErrorDetail = {
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE,
      continuityErrorCode: 'provider_session_state_unavailable_for_resume',
      failurePhase: 'continuity',
      agentId: 'pi',
      reason: 'no_resumable_session_file',
      uxDiagnostic: {
        code: 'provider_session_state_unavailable_for_resume',
        failurePhase: 'continuity',
        source: 'spawn_resume',
        agentId: 'pi',
        retryable: false,
        suggestedActions: ['start_fresh_under_selected_account', 'resume_current_account'],
        diagnostics: {
          reason: 'no_resumable_session_file',
        },
      },
    };

    const result: SpawnSessionResult = {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'provider_session_state_unavailable_for_resume (failurePhase=continuity): ...',
      errorDetail: detail,
    };

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected error result');
    // The existing fields are unchanged: code stays SPAWN_VALIDATION_FAILED so legacy consumers work.
    expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED);
    expect(result.errorDetail).toBe(detail);
    expect(result.errorDetail).not.toHaveProperty('vendorResumeId');
    expect(result.errorDetail).not.toHaveProperty('cwd');
    expect(result.errorDetail).not.toHaveProperty('targetMaterializedRoot');
  });

  it('recognizes the UI-safe connected-service resume-unreachable detail via the type guard', () => {
    const detail: SpawnSessionErrorDetail = {
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE,
      continuityErrorCode: 'provider_session_state_unavailable_for_resume',
      failurePhase: 'continuity',
      agentId: 'codex',
      reason: 'native_session_file_missing',
      uxDiagnostic: {
        code: 'provider_session_state_unavailable_for_resume',
        failurePhase: 'continuity',
        source: 'spawn_resume',
        agentId: 'codex',
        retryable: false,
        suggestedActions: ['start_fresh_under_selected_account', 'resume_current_account'],
        diagnostics: {
          reason: 'native_session_file_missing',
        },
      },
    };

    expect(isConnectedServiceResumeUnreachableSpawnErrorDetail(detail)).toBe(true);
  });

  it('recognizes generic connected-service ux diagnostic spawn details', () => {
    const detail: SpawnSessionErrorDetail = {
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_UX_DIAGNOSTIC,
      uxDiagnostic: {
        code: 'connected_service_materialization_identity_missing',
        failurePhase: 'materialization',
        source: 'spawn_resume',
        agentId: 'codex',
        retryable: false,
        suggestedActions: ['start_fresh_under_selected_account', 'resume_current_account'],
        diagnostics: {
          reason: 'missing_identity_and_resume_state',
        },
      },
    };

    expect(isConnectedServiceUxDiagnosticSpawnErrorDetail(detail)).toBe(true);
    expect(isConnectedServiceResumeUnreachableSpawnErrorDetail(detail)).toBe(false);
  });

  it('rejects daemon-local forensic fields in public generic UX diagnostic details', () => {
    expect(isConnectedServiceUxDiagnosticSpawnErrorDetail({
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_UX_DIAGNOSTIC,
      vendorResumeId: 'rollout-123',
      cwd: '/work/repo',
      candidatePersistedSessionFile: '/Users/leeroy/.codex/sessions/rollout-123.jsonl',
      targetMaterializedRoot: '/tmp/materialized/codex',
      uxDiagnostic: {
        code: 'connected_service_materialization_identity_missing',
        failurePhase: 'materialization',
        source: 'spawn_resume',
        agentId: 'codex',
        retryable: false,
        suggestedActions: ['start_fresh_under_selected_account', 'resume_current_account'],
        diagnostics: {
          reason: 'missing_identity_and_resume_state',
        },
      },
    })).toBe(false);
  });

  it('rejects unsafe nested diagnostics in public generic UX diagnostic details', () => {
    expect(isConnectedServiceUxDiagnosticSpawnErrorDetail({
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_UX_DIAGNOSTIC,
      uxDiagnostic: {
        code: 'connected_service_materialization_identity_missing',
        failurePhase: 'materialization',
        source: 'spawn_resume',
        agentId: 'codex',
        retryable: false,
        suggestedActions: ['start_fresh_under_selected_account', 'resume_current_account'],
        diagnostics: {
          reason: 'missing_identity_and_resume_state',
          targetMaterializedRoot: '/tmp/materialized/codex',
        },
      },
    })).toBe(false);
  });

  it('rejects unsafe daemon-local forensic fields in public resume-unreachable details', () => {
    const detail = {
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE,
      continuityErrorCode: 'provider_session_state_unavailable_for_resume',
      failurePhase: 'continuity',
      agentId: 'codex',
      vendorResumeId: 'rollout-123',
      cwd: '/work/repo',
      reason: 'native_session_file_missing',
      targetMaterializedRoot: '/tmp/materialized/codex',
      candidatePersistedSessionFile: '/Users/leeroy/.codex/sessions/rollout-123.jsonl',
      uxDiagnostic: {
        code: 'provider_session_state_unavailable_for_resume',
        failurePhase: 'continuity',
        source: 'spawn_resume',
        agentId: 'codex',
        retryable: false,
        suggestedActions: ['start_fresh_under_selected_account', 'resume_current_account'],
        diagnostics: {
          reason: 'native_session_file_missing',
        },
      },
    };

    expect(isConnectedServiceResumeUnreachableSpawnErrorDetail(detail)).toBe(false);
    expect(isConnectedServiceResumeUnreachableSpawnErrorDetail({
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE,
      continuityErrorCode: 'provider_session_state_unavailable_for_resume',
      failurePhase: 'continuity',
      agentId: 'codex',
      reason: 'native_session_file_missing',
      candidatePersistedSessionFile: '/Users/leeroy/.codex/sessions/rollout-123.jsonl',
      uxDiagnostic: detail.uxDiagnostic,
    })).toBe(false);
  });

  it('rejects unsafe nested diagnostics in public resume-unreachable details', () => {
    expect(isConnectedServiceResumeUnreachableSpawnErrorDetail({
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE,
      continuityErrorCode: 'provider_session_state_unavailable_for_resume',
      failurePhase: 'continuity',
      agentId: 'codex',
      reason: 'native_session_file_missing',
      uxDiagnostic: {
        code: 'provider_session_state_unavailable_for_resume',
        failurePhase: 'continuity',
        source: 'spawn_resume',
        agentId: 'codex',
        retryable: false,
        suggestedActions: ['start_fresh_under_selected_account', 'resume_current_account'],
        diagnostics: {
          reason: 'native_session_file_missing',
          candidatePersistedSessionFile: '/Users/leeroy/.codex/sessions/rollout-123.jsonl',
        },
      },
    })).toBe(false);
  });

  it('projects legacy resume-unreachable details into the UI-safe public shape', () => {
    const detail = normalizeSpawnSessionErrorDetail({
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE,
      continuityErrorCode: 'provider_session_state_unavailable_for_resume',
      failurePhase: 'continuity',
      agentId: 'codex',
      vendorResumeId: 'rollout-123',
      cwd: '/Users/leeroy/Documents/Development/happier/dev',
      reason: 'native_session_file_missing',
      targetMaterializedRoot: '/Users/leeroy/.happier/materialized/codex',
      candidatePersistedSessionFile: '/Users/leeroy/.codex/sessions/rollout-123.jsonl',
      uxDiagnostic: {
        code: 'provider_session_state_unavailable_for_resume',
        failurePhase: 'continuity',
        source: 'spawn_resume',
        agentId: 'codex',
        retryable: false,
        suggestedActions: ['start_fresh_under_selected_account', 'resume_current_account'],
        diagnostics: {
          reason: 'native_session_file_missing',
          cwd: '/Users/leeroy/Documents/Development/happier/dev',
          targetMaterializedRoot: '/Users/leeroy/.happier/materialized/codex',
          candidatePersistedSessionFile: '/Users/leeroy/.codex/sessions/rollout-123.jsonl',
          requestedStateMode: 'shared',
          effectiveStateMode: 'shared',
        },
      },
    });

    expect(isConnectedServiceResumeUnreachableSpawnErrorDetail(detail)).toBe(true);
    if (!isConnectedServiceResumeUnreachableSpawnErrorDetail(detail)) {
      throw new Error('expected sanitized resume-unreachable detail');
    }
    expect(detail.reason).toBe('native_session_file_missing');
    expect(detail.agentId).toBe('codex');
    expect(detail).not.toHaveProperty('vendorResumeId');
    expect(detail).not.toHaveProperty('cwd');
    expect(detail).not.toHaveProperty('targetMaterializedRoot');
    expect(detail).not.toHaveProperty('candidatePersistedSessionFile');
    expect(detail.uxDiagnostic.diagnostics).toEqual({
      reason: 'native_session_file_missing',
      requestedStateMode: 'shared',
      effectiveStateMode: 'shared',
    });
  });

  it('synthesizes a safe diagnostic for legacy resume-unreachable details without uxDiagnostic', () => {
    const detail = normalizeSpawnSessionErrorDetail({
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE,
      continuityErrorCode: 'provider_session_state_unavailable_for_resume',
      failurePhase: 'continuity',
      agentId: 'pi',
      vendorResumeId: 'pi-session-missing',
      cwd: '/Users/leeroy/Documents/Development/happier/dev',
      reason: 'no_resumable_session_file',
      targetMaterializedRoot: '/Users/leeroy/.happier/materialized/pi',
    });

    expect(isConnectedServiceResumeUnreachableSpawnErrorDetail(detail)).toBe(true);
    if (!isConnectedServiceResumeUnreachableSpawnErrorDetail(detail)) {
      throw new Error('expected sanitized resume-unreachable detail');
    }
    expect(detail.reason).toBe('no_resumable_session_file');
    expect(detail.uxDiagnostic).toMatchObject({
      code: 'provider_session_state_unavailable_for_resume',
      failurePhase: 'continuity',
      source: 'spawn_resume',
      agentId: 'pi',
      retryable: false,
      suggestedActions: ['start_fresh_under_selected_account', 'resume_current_account'],
      diagnostics: {
        reason: 'no_resumable_session_file',
      },
    });
    expect(detail).not.toHaveProperty('vendorResumeId');
    expect(detail).not.toHaveProperty('cwd');
    expect(detail).not.toHaveProperty('targetMaterializedRoot');
  });

  it('does not recognize unrelated values as a resume-unreachable detail', () => {
    expect(isConnectedServiceResumeUnreachableSpawnErrorDetail(null)).toBe(false);
    expect(isConnectedServiceResumeUnreachableSpawnErrorDetail(undefined)).toBe(false);
    expect(isConnectedServiceResumeUnreachableSpawnErrorDetail({ kind: 'something_else' })).toBe(false);
    expect(isConnectedServiceResumeUnreachableSpawnErrorDetail('provider_session_state_unavailable_for_resume')).toBe(false);
  });
});
