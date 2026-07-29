import { describe, expect, it } from 'vitest';

import { deriveLocalVoiceRuntimeProjection, deriveLocalVoiceSessionSnapshot } from './deriveLocalVoiceSessionSnapshot';
import type { VoiceConversationRuntimeSnapshot } from './voiceConversationRuntimeTypes';
import { createVoiceMachineError } from './voiceMachineError';

function createRuntimeSnapshot(
    overrides: Partial<VoiceConversationRuntimeSnapshot> = {},
): VoiceConversationRuntimeSnapshot {
    return {
        adapterId: null,
        controlSessionId: null,
        state: 'disconnected',
        reconnecting: false,
        micMuted: false,
        error: null,
        ...overrides,
    };
}

describe('deriveLocalVoiceSessionSnapshot', () => {
    it('projects provider-neutral reconnecting presentation ahead of an interrupted machine state', () => {
        const snapshot = deriveLocalVoiceSessionSnapshot(
            'realtime_elevenlabs',
            'realtime',
            createRuntimeSnapshot({
                adapterId: 'realtime_elevenlabs',
                controlSessionId: 'session-reconnecting',
                state: 'interrupted',
                reconnecting: true,
            }),
        );

        expect(snapshot.presentationState).toBe('reconnecting');
    });

    it('does not project a null-owned local machine snapshot for a realtime adapter', () => {
        const snapshot = deriveLocalVoiceSessionSnapshot(
            'realtime_elevenlabs',
            'realtime',
            createRuntimeSnapshot({ controlSessionId: 'session-1', state: 'listening' }),
        );

        expect(snapshot).toEqual({
            adapterId: 'realtime_elevenlabs',
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });
    });

    it('does not grant a fabricated future realtime adapter ownership of a null-owned snapshot', () => {
        const snapshot = deriveLocalVoiceSessionSnapshot(
            'future_realtime',
            'realtime',
            createRuntimeSnapshot({ controlSessionId: 'session-1', state: 'speaking' }),
        );

        expect(snapshot.status).toBe('disconnected');
        expect(snapshot.sessionId).toBeNull();
    });

    it.each(['local_direct', 'local_conversation'])('keeps null ownership for declared local adapter %s', (adapterId) => {
        const snapshot = deriveLocalVoiceSessionSnapshot(
            adapterId,
            'local',
            createRuntimeSnapshot({ controlSessionId: 'session-1', state: 'listening' }),
        );

        expect(snapshot).toMatchObject({ adapterId, sessionId: 'session-1', status: 'connected' });
    });

    it('projects listening runtime snapshots into the canonical local session snapshot contract', () => {
        const snapshot = deriveLocalVoiceSessionSnapshot(
            'local_direct',
            'local',
            createRuntimeSnapshot({
                controlSessionId: 'session-1',
                state: 'listening',
            }),
        );

        expect(snapshot).toEqual({
            adapterId: 'local_direct',
            sessionId: 'session-1',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        });
    });

    it('projects a thinking runtime snapshot into the canonical thinking session mode', () => {
        const snapshot = deriveLocalVoiceSessionSnapshot(
            'local_conversation',
            'local',
            createRuntimeSnapshot({
                controlSessionId: 'session-1',
                state: 'thinking',
            }),
        );

        expect(snapshot).toMatchObject({
            adapterId: 'local_conversation',
            status: 'connected',
            mode: 'thinking',
        });
    });

    it('reports disconnected when the machine is owned by a different adapter', () => {
        const snapshot = deriveLocalVoiceSessionSnapshot(
            'local_direct',
            'local',
            createRuntimeSnapshot({
                adapterId: 'realtime_elevenlabs',
                controlSessionId: 'session-1',
                state: 'speaking',
            }),
        );

        expect(snapshot).toEqual({
            adapterId: 'local_direct',
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });
    });

    it('projects the snapshot when the requesting adapter owns the machine', () => {
        const snapshot = deriveLocalVoiceSessionSnapshot(
            'realtime_elevenlabs',
            'realtime',
            createRuntimeSnapshot({
                adapterId: 'realtime_elevenlabs',
                controlSessionId: 'session-1',
                state: 'speaking',
            }),
        );

        expect(snapshot).toMatchObject({
            adapterId: 'realtime_elevenlabs',
            status: 'connected',
            mode: 'speaking',
        });
    });

    it('projects a terminal user-action error without a stale stop affordance', () => {
        const projection = deriveLocalVoiceRuntimeProjection(
            createRuntimeSnapshot({
                controlSessionId: 'session-2',
                state: 'error',
                error: createVoiceMachineError({ kind: 'mic_permission_revoked', reason: 'mic_permission_revoked' }),
            }),
        );

        expect(projection).toEqual({
            compatStatus: 'error',
            sessionStatus: 'error',
            sessionMode: 'idle',
            canStop: false,
        });
    });

    it('projects a recoverable error state as a graceful disconnected end carrying the error code', () => {
        const snapshot = deriveLocalVoiceSessionSnapshot(
            'realtime_elevenlabs',
            'realtime',
            createRuntimeSnapshot({
                adapterId: 'realtime_elevenlabs',
                controlSessionId: 'session-2',
                state: 'error',
                error: createVoiceMachineError({ kind: 'provider_error', reason: 'realtime_provider_error' }),
            }),
        );

        // Recoverable failures must read as "call ended, retry" — disconnected with
        // the error code surfaced, not a hard error and not a stoppable session.
        expect(snapshot).toMatchObject({
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
            errorCode: 'provider_error',
            errorMessage: 'realtime_provider_error',
        });
    });

    it('projects a recoverable disconnected end carrying the error code without a stop affordance', () => {
        const snapshot = deriveLocalVoiceSessionSnapshot(
            'realtime_elevenlabs',
            'realtime',
            createRuntimeSnapshot({
                adapterId: 'realtime_elevenlabs',
                controlSessionId: 'session-3',
                state: 'disconnected',
                error: createVoiceMachineError({ kind: 'mic_plateau', reason: 'realtime_outbound_audio_plateau' }),
            }),
        );

        expect(snapshot).toMatchObject({
            status: 'disconnected',
            canStop: false,
            errorCode: 'mic_plateau',
            errorMessage: 'realtime_outbound_audio_plateau',
        });
    });

    it('preserves structured recovery for a disconnected credential preflight failure', () => {
        const projection = deriveLocalVoiceSessionSnapshot(
            'realtime_grok',
            'realtime',
            createRuntimeSnapshot({
                adapterId: 'realtime_grok',
                controlSessionId: 'session-4',
                state: 'disconnected',
                error: createVoiceMachineError({ kind: 'provider_auth_invalid', reason: 'credential_unavailable' }),
            }),
        );

        expect(projection).toMatchObject({
            status: 'error',
            canStop: false,
            errorCode: 'provider_auth_invalid',
            errorRecoveryAction: 'review_credentials',
            errorPresentation: 'error',
        });
    });

    it.each([
        'session_unavailable',
        'feature_unavailable',
    ] as const)('projects the non-retryable %s failure as a hard error with no recovery action', (kind) => {
        const projection = deriveLocalVoiceSessionSnapshot(
            'realtime_codex',
            'realtime',
            createRuntimeSnapshot({
                adapterId: 'realtime_codex',
                controlSessionId: 'session-hard-error',
                state: 'error',
                error: createVoiceMachineError({ kind, reason: kind }),
            }),
        );

        expect(projection).toMatchObject({
            status: 'error',
            canStop: false,
            errorCode: kind,
            errorRecoveryAction: 'none',
            errorPresentation: 'error',
        });
    });
});
