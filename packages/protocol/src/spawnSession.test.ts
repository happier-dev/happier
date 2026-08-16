import { describe, expect, it } from 'vitest';

import {
  SPAWN_SESSION_ERROR_CODES,
  SPAWN_SESSION_ERROR_DETAIL_KINDS,
  PendingFirstInputV1Schema,
  SpawnSessionExecutionAuthorizationSchema,
  isConnectedServiceUxDiagnosticSpawnErrorDetail,
  isConnectedServiceResumeUnreachableSpawnErrorDetail,
  isSpawnSessionErrorDetail,
  normalizeSpawnSessionErrorDetail,
  type SpawnSessionErrorDetail,
  type SpawnSessionResult,
} from './spawnSession.js';

describe('spawn-session pending first input', () => {
  it('preserves prompt bytes, opaque identity, and optional message metadata', () => {
    expect(PendingFirstInputV1Schema.parse({
      text: '  keep prompt whitespace  ',
      localId: ' first-turn-opaque ',
      meta: { model: 'opus', happierStructuredInputV1: { v: 1 } },
    })).toEqual({
      text: '  keep prompt whitespace  ',
      localId: ' first-turn-opaque ',
      meta: { model: 'opus', happierStructuredInputV1: { v: 1 } },
    });
    expect(PendingFirstInputV1Schema.safeParse({ text: ' ', localId: 'first-turn' }).success).toBe(false);
    expect(PendingFirstInputV1Schema.safeParse({ text: 'prompt', localId: ' ' }).success).toBe(false);
  });
});

describe('spawn-session execution authorization', () => {
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

  it('rejects the removed pending delivery selector and command', () => {
    expect(() => SpawnSessionExecutionAuthorizationSchema.parse({
      provenance: 'user_request',
      requestId: 'pending-local-1',
      pendingDeliverySelector: {
        kind: 'exact_target',
        localId: 'pending-local-1',
        ownerAuthorizedOverride: 'send_now',
      },
      pendingDeliveryCommand: 'resume_process_now',
    })).toThrow();
  });
});

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

  it('projects legacy resume-unreachable details into the UI-safe public shape', () => {
    const detail = normalizeSpawnSessionErrorDetail({
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE,
      continuityErrorCode: 'provider_session_state_unavailable_for_resume',
      failurePhase: 'continuity',
      agentId: 'codex',
      vendorResumeId: 'rollout-123',
      cwd: '/Users/leeroy/Documents/Development/happier/remote-dev',
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
          cwd: '/Users/leeroy/Documents/Development/happier/remote-dev',
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
      cwd: '/Users/leeroy/Documents/Development/happier/remote-dev',
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

  it('does not recognize unrelated values as a resume-unreachable detail', () => {
    expect(isConnectedServiceResumeUnreachableSpawnErrorDetail(null)).toBe(false);
    expect(isConnectedServiceResumeUnreachableSpawnErrorDetail(undefined)).toBe(false);
    expect(isConnectedServiceResumeUnreachableSpawnErrorDetail({ kind: 'something_else' })).toBe(false);
    expect(isConnectedServiceResumeUnreachableSpawnErrorDetail('provider_session_state_unavailable_for_resume')).toBe(false);
  });

  it('recognizes generic connected-service diagnostic spawn details', () => {
    const result: SpawnSessionResult = {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'connected_service_materialization_identity_missing',
      errorDetail: {
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
      },
    };

    expect(isSpawnSessionErrorDetail(result.errorDetail)).toBe(true);
    expect(isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)).toBe(true);
    if (!isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)) {
      throw new Error('expected connected-service diagnostic detail');
    }
    expect(result.errorDetail.uxDiagnostic.code).toBe('connected_service_materialization_identity_missing');
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

  it('rejects resume-unreachable details with missing or malformed required fields', () => {
    expect(isConnectedServiceResumeUnreachableSpawnErrorDetail({
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE,
    })).toBe(false);

    expect(isConnectedServiceResumeUnreachableSpawnErrorDetail({
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE,
      continuityErrorCode: 'some_other_reason',
      failurePhase: 'continuity',
      agentId: 'codex',
      reason: 'native_session_file_missing',
    })).toBe(false);

    expect(isConnectedServiceResumeUnreachableSpawnErrorDetail({
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE,
      continuityErrorCode: 'provider_session_state_unavailable_for_resume',
      failurePhase: 'continuity',
      agentId: 'codex',
      reason: '',
    })).toBe(false);
  });
});
