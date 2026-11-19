import { describe, expect, it } from 'vitest';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { resolveResumeFailurePresentation } from './resolveResumeFailurePresentation';
import { resolveSessionSpawnNewResultFailureMessage } from '@/sync/ops/actions/sessionSpawnFailurePresentation';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { t } from '@/text';

describe('session resume failure presentation', () => {
    it.each(['action', 'wake'] as const)('keeps the native writer recovery available on %s', source => {
        const code = 'agent_resume_session_in_use';
        const errorDetail = { kind: 'launch_error', code, message: 'Private diagnostic /private/session' };
        const presentation = resolveResumeFailurePresentation({
            errorCode: 'resume_failed',
            ...(source === 'action' ? { details: { errorDetail } } : { errorDetail }),
        }, 'Resume failed');

        expect(presentation).toMatchObject({ kind: 'alert', errorCode: code });
        if (presentation.kind !== 'alert') throw new Error('Expected a recovery alert');
        expect(presentation.message).toContain(t('session.startFailure.cause.agent_resume_session_in_use'));
        expect(presentation.message).not.toContain('/private/session');
    });

    it.each(['action', 'wake', 'direct'] as const)('explains manual Machine runtime repair for a %s start refusal', source => {
        const code = 'SOURCE_RUNTIME_RELOAD_REQUIRED';
        const errorDetail = { kind: 'launch_error', code, message: 'Private launch diagnostic' };
        const presentation = resolveResumeFailurePresentation({
            errorCode: source === 'direct' ? code : 'SPAWN_VALIDATION_FAILED',
            ...(source === 'action' ? { details: { errorDetail } } : source === 'wake' ? { errorDetail } : {}),
        }, 'Resume failed');
        expect(presentation).toMatchObject({ kind: 'alert', errorCode: code, recovery: 'machine_runtime_reload' });
        if (presentation.kind !== 'alert') throw new Error('Expected a repair alert');
        expect(presentation.message).toContain(t('session.startFailure.cause.SOURCE_RUNTIME_RELOAD_REQUIRED'));
        expect(presentation.message).toContain(t('workflows.recovery.reloadSourceRuntime'));
        expect(presentation.message).not.toContain(code);
        expect(presentation.message).not.toContain('Private launch diagnostic');
    });
    it.each(['action', 'wake'] as const)('preserves native continuity cause through the %s Resume result', source => {
        const code = 'provider_session_state_unavailable_for_resume';
        const uxDiagnostic = { code, failurePhase: 'continuity', source: 'spawn_resume', retryable: false,
            suggestedActions: ['start_fresh_under_selected_account'], diagnostics: { reason: 'claude_session_file_not_found' } };
        const errorDetail = { kind: 'connected_service_resume_unreachable', continuityErrorCode: code,
            failurePhase: 'continuity', agentId: 'claude', reason: 'claude_session_file_not_found', uxDiagnostic };
        const presentation = resolveResumeFailurePresentation({ errorCode: 'SPAWN_VALIDATION_FAILED',
            errorMessage: 'Private native path /private/account',
            ...(source === 'action' ? { details: { errorDetail } } : { errorDetail }),
        }, 'Resume failed');
        expect(presentation).toMatchObject({ kind: 'alert', errorCode: code });
        if (presentation.kind !== 'alert') throw new Error('Expected a continuity alert');
        expect(presentation.message).toContain(t('connectedServices.diagnostics.body.provider_session_state_unavailable_for_resume'));
        expect(presentation.message).toContain(code);
        expect(presentation.message).not.toContain('/private/account');
        expect(resolveSessionSpawnNewResultFailureMessage({ type: 'error', code: 'spawn_failed', retryable: false,
            launchError: { kind: 'launch_error', code, message: 'Private native path /private/account',
                uxDiagnostic: { ...uxDiagnostic, code, failurePhase: 'continuity', source: 'spawn_resume',
                    suggestedActions: ['start_fresh_under_selected_account'] } } })).toBe(presentation.message);
    });
    it.each(['action', 'wake'] as const)('offers existing Machine sign-in recovery for a signed-out %s resume', source => {
        const errorDetail = { kind: 'launch_error', code: 'agent_signed_out', message: 'Sign in before starting a session.',
            failureCause: { phase: 'authentication', failureReason: 'authentication_required', requestId: 'resume-auth-request' } };
        expect(resolveResumeFailurePresentation({ errorCode: 'resume_failed',
            ...(source === 'action' ? { details: { errorDetail } } : { errorDetail }),
        }, 'Resume failed')).toMatchObject({ kind: 'agent_setup', errorCode: 'agent_signed_out' });
    });
    it.each(['action', 'wake'] as const)('preserves the pool refusal and recovery through the %s result', source => {
        const errorDetail = { kind: 'launch_error', code: 'no_eligible_member', message: 'Private launch diagnostic',
            connectedAccountPool: { serviceId: 'happier.agent.codex/openai-codex', excluded: [
                { profileId: 'private-quota', reason: 'quota_exhausted' },
                { profileId: 'private-auth', reason: 'auth_invalid' },
            ] } };
        const presentation = resolveResumeFailurePresentation({ errorCode: 'SPAWN_VALIDATION_FAILED',
            errorMessage: 'Private launch diagnostic', ...(source === 'action' ? { details: { errorDetail } } : { errorDetail }),
        }, 'Resume failed');
        expect(presentation).toMatchObject({ kind: 'alert', errorCode: 'SPAWN_VALIDATION_FAILED',
            reasonCode: 'no_eligible_member', recovery: 'connected_accounts' });
        if (presentation.kind !== 'alert') throw new Error('Expected an alert');
        expect(presentation.message).toContain(t('connectedServicesPool.startUnavailableUsedUp', { count: 1 }));
        expect(presentation.message).toContain(t('connectedServicesPool.startUnavailableSignIn', { count: 1 }));
        expect(presentation.message).not.toMatch(/private-|Private launch/);
    });

    it.each(['provider_binding_changed', 'provider_model_not_found', 'provider_authorization_changed'] as const)(
        'shows the canonical Provider reason for %s instead of the generic Resume refusal', code => {
            const providerError = createProviderErrorV1(code, { connectionId: 'pc_gateway' });
            const message = resolveSessionSpawnNewResultFailureMessage({ type: 'error', code: 'spawn_failed',
                retryable: providerError.retryable, providerError });
            expect(resolveResumeFailurePresentation({ errorCode: 'SPAWN_VALIDATION_FAILED',
                errorMessage: 'Private validation details', details: { errorDetail: { kind: 'provider_error', providerError } },
            }, 'Resume failed')).toEqual({ kind: 'alert', message, errorCode: code });
            expect(message).not.toContain('Private validation details');
        },
    );
    it('offers the exact disabled plugin instead of repeating Resume, including configured Agents', () => {
        expect(resolveResumeFailurePresentation({ errorCode: 'plugin_disabled', errorMessage: 'Private diagnostic' }, 'Resume failed', {
            kind: 'agent', identity: { pluginId: 'happier.agent.pi', localId: 'pi' },
        })).toMatchObject({ kind: 'plugin_disabled', pluginId: 'happier.agent.pi' });
        expect(resolveResumeFailurePresentation({ errorCode: 'plugin_disabled' }, 'Resume failed', {
            kind: 'backend', backendId: 'my-acp', configuredBackendId: 'my-acp', sourceKind: 'configured',
        })).toMatchObject({ kind: 'plugin_disabled', pluginId: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId });
    });

    it('offers explicit private-folder recovery instead of a modal failure', () => {
        expect(resolveResumeFailurePresentation({
            errorCode: 'SESSION_DIRECTORY_MISSING', errorMessage: 'Machine-private diagnostic path',
        }, 'Resume failed')).toEqual({ kind: 'directory_missing', errorCode: 'SESSION_DIRECTORY_MISSING' });
    });

    it('keeps validation diagnostics out of generic resume alerts', () => {
        expect(resolveResumeFailurePresentation({
            errorCode: 'SPAWN_VALIDATION_FAILED', errorMessage: 'Private validation details',
        }, 'Resume failed')).toEqual({ kind: 'alert', message: 'Resume failed', errorCode: 'SPAWN_VALIDATION_FAILED' });
    });

    it('uses fresh-start recovery guidance for a typed reconnect refusal without disclosing private diagnostics', () => {
        const code = 'connected_service_credential_reconnect_required';
        const freshMessage = resolveSessionSpawnNewResultFailureMessage({ type: 'error', code: 'spawn_failed', retryable: false,
            launchError: { kind: 'launch_error', code, message: 'Private validation detail' } });
        expect(resolveResumeFailurePresentation({ errorCode: 'SPAWN_VALIDATION_FAILED', errorMessage: 'Private validation detail',
            details: { errorDetail: { kind: 'connected_service_ux_diagnostic', uxDiagnostic: {
                code, failurePhase: 'materialization', source: 'spawn_resume', retryable: false, suggestedActions: ['reconnect_profile'],
            } } },
        }, 'Resume failed')).toEqual({ kind: 'alert', message: freshMessage, errorCode: code });
        expect(freshMessage).not.toContain('Private validation detail');
    });

    it('retains the original Action refusal code for deliberate Technical details', () => {
        // This is the existing Action normalizer's result for the typed Home carrier refusal;
        // the recovery surface must not throw away the code while retaining only its prose.
        expect(resolveResumeFailurePresentation({
            errorCode: 'action_failed', errorMessage: 'No verified transport is available for the target Home',
        }, 'Resume failed')).toEqual({
            kind: 'alert', message: 'No verified transport is available for the target Home', errorCode: 'action_failed',
        });
    });
});
