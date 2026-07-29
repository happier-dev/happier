import { describe, expect, it } from 'vitest';

import {
    SPAWN_SESSION_ERROR_CODES,
    SPAWN_SESSION_ERROR_DETAIL_KINDS,
    isConnectedServiceResumeUnreachableSpawnErrorDetail,
    isConnectedServiceUxDiagnosticSpawnErrorDetail,
} from '@happier-dev/protocol';

import { normalizeSpawnSessionResult } from './_shared';

describe('normalizeSpawnSessionResult errorDetail carry-through (D2)', () => {
    it('preserves the Remote predecessor accepted-pending recovery fields', () => {
        expect(normalizeSpawnSessionResult({
            type: 'success',
            spawnNonce: 'remote-predecessor-spawn-nonce',
            sessionIdStatus: 'pending',
        })).toEqual({
            type: 'success',
            spawnNonce: 'remote-predecessor-spawn-nonce',
            sessionIdStatus: 'pending',
        });
    });

    it('carries a structured connected-service resume-unreachable detail from the daemon payload', () => {
        const result = normalizeSpawnSessionResult({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
            errorMessage: 'provider_session_state_unavailable_for_resume (failurePhase=continuity): ...',
            errorDetail: {
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
            },
        });

        expect(result.type).toBe('error');
        if (result.type !== 'error') throw new Error('expected error result');
        // Existing fields are preserved unchanged.
        expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED);
        // The structured detail survives normalization so the UI can recognize it programmatically.
        expect(isConnectedServiceResumeUnreachableSpawnErrorDetail(result.errorDetail)).toBe(true);
        if (!isConnectedServiceResumeUnreachableSpawnErrorDetail(result.errorDetail)) {
            throw new Error('expected resume-unreachable detail');
        }
        expect(result.errorDetail.agentId).toBe('pi');
        expect(result.errorDetail.reason).toBe('no_resumable_session_file');
        expect(result.errorDetail).not.toHaveProperty('targetMaterializedRoot');
        expect(result.errorDetail).not.toHaveProperty('vendorResumeId');
        expect(result.errorDetail).not.toHaveProperty('cwd');
    });

    it('omits errorDetail when the daemon payload carries an unrecognized detail shape', () => {
        const result = normalizeSpawnSessionResult({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
            errorMessage: 'some other validation failure',
            errorDetail: { kind: 'totally_unknown_detail', whatever: 1 },
        });

        expect(result.type).toBe('error');
        if (result.type !== 'error') throw new Error('expected error result');
        expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED);
        // Unknown detail shapes must not leak through as a recognized structured detail.
        expect(result.errorDetail).toBeUndefined();
    });

    it('keeps a legacy error payload without errorDetail unchanged', () => {
        const result = normalizeSpawnSessionResult({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
            errorMessage: 'Claude CLI override is invalid',
        });

        expect(result).toEqual({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
            errorMessage: 'Claude CLI override is invalid',
        });
    });

    it('carries the structured detail through legacy success/error envelopes (success:false)', () => {
        const result = normalizeSpawnSessionResult({
            success: false,
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
            error: 'provider_session_state_unavailable_for_resume (failurePhase=continuity): ...',
            errorDetail: {
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
            },
        });

        expect(result.type).toBe('error');
        if (result.type !== 'error') throw new Error('expected error result');
        expect(isConnectedServiceResumeUnreachableSpawnErrorDetail(result.errorDetail)).toBe(true);
    });

    it('projects legacy resume-unreachable details and strips daemon-local fields before UI state stores them', () => {
        const result = normalizeSpawnSessionResult({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
            errorMessage: 'provider_session_state_unavailable_for_resume (failurePhase=continuity): ...',
            errorDetail: {
                kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE,
                continuityErrorCode: 'provider_session_state_unavailable_for_resume',
                failurePhase: 'continuity',
                agentId: 'codex',
                vendorResumeId: 'rollout-legacy',
                cwd: '/Users/leeroy/Documents/Development/happier/dev',
                reason: 'native_session_file_missing',
                targetMaterializedRoot: '/Users/leeroy/.happier/materialized/codex',
                candidatePersistedSessionFile: '/Users/leeroy/.codex/sessions/rollout-legacy.jsonl',
                uxDiagnostic: {
                    code: 'provider_session_state_unavailable_for_resume',
                    failurePhase: 'continuity',
                    source: 'spawn_resume',
                    agentId: 'codex',
                    retryable: false,
                    suggestedActions: ['start_fresh_under_selected_account', 'resume_current_account'],
                    diagnostics: {
                        reason: 'native_session_file_missing',
                        candidatePersistedSessionFile: '/Users/leeroy/.codex/sessions/rollout-legacy.jsonl',
                        requestedStateMode: 'shared',
                        effectiveStateMode: 'shared',
                    },
                },
            },
        });

        expect(result.type).toBe('error');
        if (result.type !== 'error') throw new Error('expected error result');
        expect(isConnectedServiceResumeUnreachableSpawnErrorDetail(result.errorDetail)).toBe(true);
        if (!isConnectedServiceResumeUnreachableSpawnErrorDetail(result.errorDetail)) {
            throw new Error('expected sanitized resume-unreachable detail');
        }
        expect(result.errorDetail).not.toHaveProperty('vendorResumeId');
        expect(result.errorDetail).not.toHaveProperty('cwd');
        expect(result.errorDetail).not.toHaveProperty('targetMaterializedRoot');
        expect(result.errorDetail).not.toHaveProperty('candidatePersistedSessionFile');
        expect(result.errorDetail.uxDiagnostic.diagnostics).toEqual({
            reason: 'native_session_file_missing',
            requestedStateMode: 'shared',
            effectiveStateMode: 'shared',
        });
    });

    it('synthesizes a safe diagnostic for pure legacy resume-unreachable details before UI state stores them', () => {
        const result = normalizeSpawnSessionResult({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
            errorMessage: 'provider_session_state_unavailable_for_resume (failurePhase=continuity): ...',
            errorDetail: {
                kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_RESUME_UNREACHABLE,
                continuityErrorCode: 'provider_session_state_unavailable_for_resume',
                failurePhase: 'continuity',
                agentId: 'pi',
                vendorResumeId: 'pi-session-missing',
                cwd: '/Users/leeroy/Documents/Development/happier/dev',
                reason: 'no_resumable_session_file',
                targetMaterializedRoot: '/Users/leeroy/.happier/materialized/pi',
            },
        });

        expect(result.type).toBe('error');
        if (result.type !== 'error') throw new Error('expected error result');
        expect(isConnectedServiceResumeUnreachableSpawnErrorDetail(result.errorDetail)).toBe(true);
        if (!isConnectedServiceResumeUnreachableSpawnErrorDetail(result.errorDetail)) {
            throw new Error('expected sanitized resume-unreachable detail');
        }
        expect(result.errorDetail.uxDiagnostic).toMatchObject({
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
        expect(result.errorDetail).not.toHaveProperty('vendorResumeId');
        expect(result.errorDetail).not.toHaveProperty('cwd');
        expect(result.errorDetail).not.toHaveProperty('targetMaterializedRoot');
    });

    it('carries generic connected-service UX diagnostic details through UI normalization', () => {
        const result = normalizeSpawnSessionResult({
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
        });

        expect(result.type).toBe('error');
        if (result.type !== 'error') throw new Error('expected error result');
        expect(isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)).toBe(true);
    });
});
