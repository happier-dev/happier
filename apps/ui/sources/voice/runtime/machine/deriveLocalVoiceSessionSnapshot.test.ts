import { describe, expect, it } from 'vitest';

import { deriveLocalVoiceRuntimeProjection, deriveLocalVoiceSessionSnapshot } from './deriveLocalVoiceSessionSnapshot';
import type { VoiceConversationRuntimeSnapshot } from './voiceConversationRuntimeTypes';

function createRuntimeSnapshot(
    overrides: Partial<VoiceConversationRuntimeSnapshot> = {},
): VoiceConversationRuntimeSnapshot {
    return {
        adapterId: null,
        controlSessionId: null,
        state: 'disconnected',
        micMuted: false,
        error: null,
        ...overrides,
    };
}

describe('deriveLocalVoiceSessionSnapshot', () => {
    it('projects listening runtime snapshots into the canonical local session snapshot contract', () => {
        const snapshot = deriveLocalVoiceSessionSnapshot(
            'local_direct',
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

    it('projects a non-recoverable error state as a hard error that must be dismissed', () => {
        const projection = deriveLocalVoiceRuntimeProjection(
            createRuntimeSnapshot({
                controlSessionId: 'session-2',
                state: 'error',
                error: {
                    kind: 'mic_permission_denied',
                    reason: 'mic_permission_denied',
                    recoverable: false,
                },
            }),
        );

        expect(projection).toEqual({
            compatStatus: 'error',
            sessionStatus: 'error',
            sessionMode: 'idle',
            canStop: true,
        });
    });

    it('projects a recoverable error state as a graceful disconnected end carrying the error code', () => {
        const snapshot = deriveLocalVoiceSessionSnapshot(
            'realtime_elevenlabs',
            createRuntimeSnapshot({
                adapterId: 'realtime_elevenlabs',
                controlSessionId: 'session-2',
                state: 'error',
                error: {
                    kind: 'provider_error',
                    reason: 'realtime_provider_error',
                    recoverable: true,
                },
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
            createRuntimeSnapshot({
                adapterId: 'realtime_elevenlabs',
                controlSessionId: 'session-3',
                state: 'disconnected',
                error: {
                    kind: 'mic_plateau',
                    reason: 'realtime_outbound_audio_plateau',
                    recoverable: true,
                },
            }),
        );

        expect(snapshot).toMatchObject({
            status: 'disconnected',
            canStop: false,
            errorCode: 'mic_plateau',
            errorMessage: 'realtime_outbound_audio_plateau',
        });
    });

    it('projects a non-recoverable disconnected error as a hard error', () => {
        const projection = deriveLocalVoiceRuntimeProjection(
            createRuntimeSnapshot({
                controlSessionId: 'session-4',
                state: 'disconnected',
                error: {
                    kind: 'mic_permission_denied',
                    reason: 'mic_permission_denied',
                    recoverable: false,
                },
            }),
        );

        expect(projection).toMatchObject({
            sessionStatus: 'error',
            canStop: true,
        });
    });
});
