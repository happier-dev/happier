import { describe, expect, it } from 'vitest';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { resolveResumeFailurePresentation } from './resolveResumeFailurePresentation';
import { resolveSessionSpawnNewResultFailureMessage } from '@/sync/ops/actions/sessionSpawnFailurePresentation';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';

describe('session resume failure presentation', () => {
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
        }, 'Resume failed')).toEqual({ kind: 'directory_missing' });
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
