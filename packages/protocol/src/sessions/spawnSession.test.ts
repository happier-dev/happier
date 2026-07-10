import { describe, expect, it } from 'vitest';

import {
  SPAWN_SESSION_ERROR_CODES,
  SPAWN_SESSION_ERROR_DETAIL_KINDS,
  isConnectedServiceUxDiagnosticSpawnErrorDetail,
  isConnectedServiceResumeUnreachableSpawnErrorDetail,
  normalizeSpawnSessionErrorDetail,
  type SpawnSessionErrorDetail,
  type SpawnSessionResult,
} from './spawnSession.js';

describe('spawn-session error detail contract (D2 structured continuity)', () => {
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
