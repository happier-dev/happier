import { describe, expect, it } from 'vitest';

import {
    CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS,
    CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
    SPAWN_SESSION_ERROR_CODES,
    SPAWN_SESSION_ERROR_DETAIL_KINDS,
    type SpawnSessionResult,
} from '@happier-dev/protocol';

import { resolveConnectedServiceSwitchUnavailablePresentation } from './connectedServiceSwitchUnavailable';

function makeResumeUnreachableResult(): Extract<SpawnSessionResult, { type: 'error' }> {
    return {
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
                code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume,
                failurePhase: 'continuity',
                source: 'spawn_resume',
                agentId: 'pi',
                retryable: false,
                suggestedActions: [
                    CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.startFreshUnderSelectedAccount,
                    CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.resumeCurrentAccount,
                ],
                diagnostics: {
                    reason: 'no_resumable_session_file',
                },
            },
        },
    };
}

function makeGenericUxDiagnosticResult(): Extract<SpawnSessionResult, { type: 'error' }> {
    return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'connected_service_materialization_identity_missing',
        errorDetail: {
            kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_UX_DIAGNOSTIC,
            uxDiagnostic: {
                code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing,
                failurePhase: 'materialization',
                source: 'spawn_resume',
                agentId: 'codex',
                retryable: false,
                suggestedActions: [
                    CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.startFreshUnderSelectedAccount,
                    CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.resumeCurrentAccount,
                ],
                diagnostics: {
                    reason: 'missing_identity_and_resume_state',
                },
            },
        },
    };
}

function makeGenericRetryOnlyUxDiagnosticResult(): Extract<SpawnSessionResult, { type: 'error' }> {
    return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'metadata_update_failed',
        errorDetail: {
            kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_UX_DIAGNOSTIC,
            uxDiagnostic: {
                code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.metadataUpdateFailed,
                failurePhase: 'metadata',
                source: 'new_session',
                agentId: 'codex',
                retryable: true,
                suggestedActions: [
                    CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.retry,
                    CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts,
                ],
                diagnostics: {
                    reason: 'metadata_update_failed',
                },
            },
        },
    };
}

describe('resolveConnectedServiceSwitchUnavailablePresentation (D2 recognition + explanation + start-fresh)', () => {
    it('recognizes the structured resume-unreachable detail programmatically (not via message copy)', () => {
        const presentation = resolveConnectedServiceSwitchUnavailablePresentation(makeResumeUnreachableResult());
        expect(presentation).not.toBeNull();
    });

    it('does not recognize a generic SPAWN_VALIDATION_FAILED error without the structured detail', () => {
        const presentation = resolveConnectedServiceSwitchUnavailablePresentation({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
            errorMessage: 'provider_session_state_unavailable_for_resume (failurePhase=continuity): ...',
        });
        // Even though the message string mentions the continuity code, recognition must be by
        // structured detail only — copy parsing is explicitly forbidden by the contract.
        expect(presentation).toBeNull();
    });

    it('does not recognize non-error or success results', () => {
        expect(resolveConnectedServiceSwitchUnavailablePresentation({ type: 'success', sessionId: 's1' })).toBeNull();
        expect(resolveConnectedServiceSwitchUnavailablePresentation({
            type: 'requestToApproveDirectoryCreation',
            directory: '/tmp',
        })).toBeNull();
    });

    it('explains WHY using the concrete structured reason and exposes a start-fresh action', () => {
        const presentation = resolveConnectedServiceSwitchUnavailablePresentation(makeResumeUnreachableResult());
        if (!presentation) throw new Error('expected a switch-unavailable presentation');

        // The dialog carries the concrete machine-readable reason (so the explanation is grounded in
        // WHY, not a generic failure), plus the agent id for context.
        expect(presentation.reason).toBe('no_resumable_session_file');
        expect(presentation.agentId).toBe('pi');

        // It offers a distinct, recognizable "start fresh under the new account" action alongside a
        // cancel/dismiss action — asserted by structural action ids, not display copy.
        const actionKinds = presentation.actions.map((action) => action.kind);
        expect(actionKinds).toContain('start_fresh');
        expect(actionKinds).toContain('dismiss');

        // Title + explanatory body are addressed via i18n keys (we assert keys, not English copy).
        expect(typeof presentation.titleKey).toBe('string');
        expect(typeof presentation.bodyKey).toBe('string');
        expect(presentation.titleKey.length).toBeGreaterThan(0);
        expect(presentation.bodyKey.length).toBeGreaterThan(0);
    });

    it('passes the structured reason and agent id as body interpolation params', () => {
        const presentation = resolveConnectedServiceSwitchUnavailablePresentation(makeResumeUnreachableResult());
        if (!presentation) throw new Error('expected a switch-unavailable presentation');

        // The explanatory body interpolates the concrete reason + agent so the user sees WHY the
        // switch could not continue, not just that it failed.
        expect(presentation.bodyParams).toMatchObject({
            reason: 'no_resumable_session_file',
            agentId: 'pi',
        });
    });

    it('uses the shared UX diagnostic actions when the spawn detail carries one', () => {
        const result = makeResumeUnreachableResult();
        const presentation = resolveConnectedServiceSwitchUnavailablePresentation({
            ...result,
            errorDetail: {
                ...result.errorDetail,
                uxDiagnostic: {
                    code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume,
                    failurePhase: 'continuity',
                    source: 'new_session',
                    agentId: 'pi',
                    retryable: false,
                    suggestedActions: [CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.dismiss],
                    diagnostics: {
                        reason: 'target_file_missing',
                    },
                },
            },
        } as SpawnSessionResult);
        if (!presentation) throw new Error('expected a switch-unavailable presentation');

        expect(presentation.bodyParams).toMatchObject({
            reason: 'target_file_missing',
            agentId: 'pi',
        });
        expect(presentation.actions).toEqual([
            { kind: 'dismiss', labelKey: 'common.cancel' },
        ]);
    });

    it('renders generic connected-service UX diagnostic spawn details through the shared presentation owner', () => {
        const presentation = resolveConnectedServiceSwitchUnavailablePresentation(makeGenericUxDiagnosticResult());
        if (!presentation) throw new Error('expected a switch-unavailable presentation');

        expect(presentation.reason).toBe('missing_identity_and_resume_state');
        expect(presentation.agentId).toBe('codex');
        expect(presentation.bodyParams).toMatchObject({
            reason: 'missing_identity_and_resume_state',
            agentId: 'codex',
        });
        expect(presentation.actions.map((action) => action.kind)).toEqual(['start_fresh', 'dismiss']);
    });

    it('does not invent a start-fresh action for generic diagnostics that do not request it', () => {
        const presentation = resolveConnectedServiceSwitchUnavailablePresentation(makeGenericRetryOnlyUxDiagnosticResult());
        if (!presentation) throw new Error('expected a switch-unavailable presentation');

        expect(presentation.actions.map((action) => action.kind)).toEqual(['dismiss']);
    });
});
