import { describe, expect, it } from 'vitest';

import {
    CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS,
    CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
    ConnectedServiceUxDiagnosticCodeV1Schema,
    type ConnectedServiceUxDiagnosticV1,
} from '@happier-dev/protocol';

import { resolveConnectedServiceUxDiagnosticPresentation } from './connectedServiceUxDiagnostics';

describe('resolveConnectedServiceUxDiagnosticPresentation', () => {
    it('maps resume-unreachable diagnostics to product copy without forwarding raw diagnostic detail', () => {
        const diagnostic: ConnectedServiceUxDiagnosticV1 = {
            code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume,
            failurePhase: 'continuity',
            source: 'new_session',
            agentId: 'pi',
            retryable: false,
            suggestedActions: [
                CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.startFreshUnderSelectedAccount,
                CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts,
            ],
            diagnostics: {
                reason: '/private/runner/session?token=never-render-this',
            },
        };

        const presentation = resolveConnectedServiceUxDiagnosticPresentation(diagnostic);

        expect(presentation).toMatchObject({
            code: 'provider_session_state_unavailable_for_resume',
            statusKey: 'connectedServices.diagnostics.status.provider_session_state_unavailable_for_resume',
            titleKey: 'connectedServices.diagnostics.title.provider_session_state_unavailable_for_resume',
            actions: [
                expect.objectContaining({ kind: 'start_fresh_under_selected_account' }),
                expect.objectContaining({ kind: 'open_connected_accounts' }),
            ],
        });
        expect(presentation).not.toHaveProperty('bodyParams');
    });

    it('uses one presentation mapping for switch verification failures', () => {
        const presentation = resolveConnectedServiceUxDiagnosticPresentation({
            code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerAccountAdoptionMismatch,
            failurePhase: 'post_switch_verification',
            source: 'manual_auth_switch',
            serviceId: 'openai-codex',
            providerId: 'codex',
            agentId: 'codex',
            retryable: true,
            suggestedActions: [
                CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.retry,
                CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts,
            ],
        });

        expect(presentation).toMatchObject({
            code: 'provider_account_adoption_mismatch',
            statusKey: 'connectedServices.diagnostics.status.provider_account_adoption_mismatch',
            actions: [
                expect.objectContaining({ kind: 'retry' }),
                expect.objectContaining({ kind: 'open_connected_accounts' }),
            ],
        });
    });

    it('normalizes protocol-valid diagnostics that omit suggestedActions before presentation mapping', () => {
        const presentation = resolveConnectedServiceUxDiagnosticPresentation({
            code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryRetryScheduled,
            failurePhase: 'runtime_auth_recovery',
            source: 'runtime_auth_recovery',
            retryable: true,
        });

        expect(presentation).toMatchObject({
            code: 'recovery_retry_scheduled',
            actions: [],
        });
    });

    it.each([
        'claude_subscription_missing_claude_code_scope',
        'claude_subscription_native_auth_materialization_failed',
        'claude_subscription_setup_token_not_supported_for_unified',
    ] as const)('maps Claude native-auth diagnostic %s to reconnect presentation data', (code) => {
        const presentation = resolveConnectedServiceUxDiagnosticPresentation({
            code,
            failurePhase: 'materialization',
            source: 'manual_auth_switch',
            serviceId: 'claude-subscription',
            providerId: 'claude',
            agentId: 'claude',
            profileId: 'work',
            retryable: false,
            suggestedActions: [
                CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.reconnectProfile,
                CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts,
            ],
        });

        expect(presentation).toMatchObject({
            code,
            titleKey: `connectedServices.diagnostics.title.${code}`,
            bodyKey: `connectedServices.diagnostics.body.${code}`,
            statusKey: `connectedServices.diagnostics.status.${code}`,
            actions: [
                expect.objectContaining({ kind: 'reconnect_profile' }),
                expect.objectContaining({ kind: 'open_connected_accounts' }),
            ],
        });
    });

    it.each(ConnectedServiceUxDiagnosticCodeV1Schema.options)('maps %s without falling back to another diagnostic code', (code) => {
        const diagnostic: ConnectedServiceUxDiagnosticV1 = {
            code,
            failurePhase: code === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryRetryScheduled
                || code === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryDeadLettered
                ? 'runtime_auth_recovery'
                : code === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerAccountAdoptionMismatch
                    || code === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.postSwitchVerificationFailed
                    ? 'post_switch_verification'
                    : code === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.metadataUpdateFailed
                        ? 'metadata'
                        : code === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing
                            ? 'materialization'
                            : 'continuity',
            source: 'manual_auth_switch',
            agentId: 'codex',
            retryable: code === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryRetryScheduled,
            suggestedActions: [CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.retry],
            diagnostics: {
                reason: 'test_reason',
            },
        };

        const presentation = resolveConnectedServiceUxDiagnosticPresentation(diagnostic);

        expect(presentation).not.toBeNull();
        expect(presentation?.code).toBe(code);
        expect(presentation?.titleKey).toBe(`connectedServices.diagnostics.title.${code}`);
        expect(presentation?.bodyKey).toBe(`connectedServices.diagnostics.body.${code}`);
        expect(presentation?.statusKey).toBe(`connectedServices.diagnostics.status.${code}`);
    });
});
