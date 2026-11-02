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
            errorRecoveryAction: retryable ? 'retry' : 'none' });
        const presentation = projectVoiceAttemptPresentation({
            control: { availability: 'recoverable', live: true, canStart: true, canStop: false, canMute: false, muted: false,
                capturing: false, primaryAction: retryable ? 'recover' : 'start', recoveryAvailable: retryable,
                surfaceState: 'error', tone: 'error', stop: 'blush', sessionId: 's1', markPose: 'blocked', statusCell: null },
            attemptId: 'attempt', ended: false, ...snapshot,
            recoveryAction: snapshot.errorRecoveryAction ?? null,
            recoveryContext: { connectRecoveryTarget: { kind: 'default' }, runtimeRecoveryTarget: null,
                attemptSessionId: 's1', startSessionId: 's1', globalStartAuthorized: false },
            serviceTitle: 'Voice', agentTitle: 'Codex', agentMachineLabel: 'Dev machine',
        });
        expect(presentation.failureMessage).toBe(t(resolveConnectedServiceUxDiagnosticPresentation(uxDiagnostic)!.bodyKey));
        expect(presentation.recovery?.action ?? null).toBe(retryable ? 'retry' : null);
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
