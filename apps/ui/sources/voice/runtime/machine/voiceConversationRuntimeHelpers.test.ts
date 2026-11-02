import { beforeEach, describe, expect, it } from 'vitest';

import { voiceConversationRuntimeMachine } from './VoiceConversationRuntimeMachine';
import { createVoiceMachineError } from './voiceMachineError';

describe('voiceConversationRuntimeHelpers', () => {
    it.each([false, true])('presents the connected account owner reason and retryability (%s) at terminal Voice', async (retryable) => {
        const { ConnectedServiceUxDiagnosticV1Schema } = await import('@happier-dev/protocol/connect/connectedServiceUxDiagnostics');
        const { transitionVoiceRuntimeToIdle } = await import('./voiceConversationRuntimeHelpers');
        const { deriveLocalVoiceSessionSnapshot } = await import('./deriveLocalVoiceSessionSnapshot');
        const { projectVoiceAttemptPresentation } = await import('@/components/voice/attempt/projectVoiceAttemptPresentation');
        const { resolveConnectedServiceUxDiagnosticPresentation } = await import('@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnostics');
        const { t } = await import('@/text');
        const uxDiagnostic = ConnectedServiceUxDiagnosticV1Schema.parse({
            code: retryable ? 'connected_service_credential_refresh_unavailable' : 'connected_service_credential_reconnect_required',
            source: 'spawn_resume', failurePhase: 'materialization', serviceId: 'happier.agent.codex/openai-codex',
            profileId: 'work', retryable, suggestedActions: retryable ? ['retry'] : ['reconnect_profile', 'open_connected_accounts'],
        });
        const cause = Object.assign(new Error('PRIVATE_PROVIDER_BODY'), { rpcErrorCode: uxDiagnostic.code, uxDiagnostic });
        const { createVoiceTextTurnRejectedBeforeEffectError } = await import('@/voice/session/types');
        transitionVoiceRuntimeToIdle({ controlSessionId: 's1', reason: uxDiagnostic.code,
            cause: createVoiceTextTurnRejectedBeforeEffectError(cause, 'provider_unavailable_before_acceptance') });
        const snapshot = deriveLocalVoiceSessionSnapshot('local_conversation', 'local', voiceConversationRuntimeMachine.getSnapshot());
        expect(snapshot).toMatchObject({ errorMessage: uxDiagnostic.code, errorConnectedServiceDiagnostic: uxDiagnostic,
            errorRecoveryAction: retryable ? 'retry' : 'connect_agent' });
        const { resolveVoiceConnectRecoveryTarget } = await import('@/components/voice/surface/resolveVoiceConnectRecoveryTarget');
        const { executeVoiceAttemptRecovery, resolveVoiceAttemptRecoveryAvailable } = await import('@/components/voice/attempt/voiceAttemptRecovery');
        const { resolveVoiceSurfaceRecovery } = await import('@/components/voice/surface/resolveVoiceSurfaceRecovery');
        const { buildConnectedServiceSetupRoute } = await import('@/sync/domains/connectedServices/connectedAccountSettingsRoute');
        const recoveryContext = { connectRecoveryTarget: resolveVoiceConnectRecoveryTarget({
            uxDiagnostic, agentRuntime: null, bindingScope: 'global', runtimeTarget: null,
            provider: null, providerConfig: null, sessionMetadata: null, connectedServiceEntries: [],
        }), runtimeRecoveryTarget: null, attemptSessionId: 's1', startSessionId: 's1', globalStartAuthorized: false };
        const recoveryAvailable = resolveVoiceAttemptRecoveryAvailable(resolveVoiceSurfaceRecovery(snapshot.errorRecoveryAction), recoveryContext);
        const presentation = projectVoiceAttemptPresentation({
            control: { availability: 'recoverable', live: true, canStart: true, canStop: false, canMute: false, muted: false,
                capturing: false, primaryAction: 'recover', recoveryAvailable,
                surfaceState: 'error', tone: 'error', stop: 'blush', sessionId: 's1', markPose: 'blocked', statusCell: null },
            attemptId: 'attempt', ended: false, ...snapshot,
            recoveryAction: snapshot.errorRecoveryAction ?? null,
            recoveryContext,
            serviceTitle: 'Voice', agentTitle: 'Codex', agentMachineLabel: 'Dev machine',
        });
        expect(presentation.failureMessage).toBe(t(resolveConnectedServiceUxDiagnosticPresentation(uxDiagnostic)!.bodyKey));
        expect(presentation.recovery?.action ?? null).toBe(retryable ? 'retry' : 'connect_agent');
        if (!retryable) {
            expect(presentation.recovery?.label).toBe(t('connectedServices.detail.actions.reconnect'));
            const destinations: unknown[] = [];
            await expect(executeVoiceAttemptRecovery({ recoveryAction: snapshot.errorRecoveryAction ?? null,
                setupIncomplete: false, context: recoveryContext, navigate: href => { destinations.push(href); } })).resolves.toBe(true);
            expect(destinations).toEqual([buildConnectedServiceSetupRoute({ kind: 'reconnect',
                serviceKey: uxDiagnostic.serviceId!, accountId: uxDiagnostic.profileId! })]);
        }
        expect(JSON.stringify(presentation)).not.toContain('PRIVATE_PROVIDER_BODY');
    });
    beforeEach(() => {
        voiceConversationRuntimeMachine.reset();
    });

    it('confirms voice capture start through the machine listening transition', async () => {
        const { confirmVoiceCaptureStarted } = await import('./voiceConversationRuntimeHelpers');

        voiceConversationRuntimeMachine.transitionToAcquiringMic({
            controlSessionId: 's1',
        });
        confirmVoiceCaptureStarted('s1');

        expect(voiceConversationRuntimeMachine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'listening',
            error: null,
        });
    });

    it('surfaces capture errors onto disconnected runtime state carrying the error', async () => {
        const { surfaceRecoverableVoiceCaptureError } = await import('./voiceConversationRuntimeHelpers');

        const original = {
            controlSessionId: 's1',
            reason: 'device_stt_start_failed',
        };
        const privateCause = new Error('private native transport failure');
        Object.defineProperty(original, 'cause', { value: privateCause, enumerable: false });
        surfaceRecoverableVoiceCaptureError(original);

        expect(voiceConversationRuntimeMachine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'disconnected',
            error: {
                kind: 'provider_error',
                reason: 'device_stt_start_failed',
                recoverable: true,
            },
        });
        const error = voiceConversationRuntimeMachine.getSnapshot().error;
        expect(error).toHaveProperty('cause', privateCause);
        expect(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable).toBe(false);
        expect(JSON.stringify(error)).not.toContain('private native transport failure');
    });

    it('maps idle-without-error transitions onto the idle, mic-off connected runtime state', async () => {
        const { transitionVoiceRuntimeToIdle } = await import('./voiceConversationRuntimeHelpers');

        transitionVoiceRuntimeToIdle({
            controlSessionId: 's1',
        });

        expect(voiceConversationRuntimeMachine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'connected',
            error: null,
        });
    });

    it('ignores late capture-start confirmation after rearm timeout already moved the machine into stt_timeout', async () => {
        const { confirmVoiceCaptureStarted } = await import('./voiceConversationRuntimeHelpers');

        voiceConversationRuntimeMachine.setError({
            controlSessionId: 's1',
            error: createVoiceMachineError({ kind: 'stt_timeout', reason: 'listening_start_timeout' }),
        });

        confirmVoiceCaptureStarted('s1');

        expect(voiceConversationRuntimeMachine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'error',
            error: {
                kind: 'stt_timeout',
                reason: 'listening_start_timeout',
                recoverable: true,
            },
        });
    });
});
