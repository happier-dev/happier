import { describe, expect, it } from 'vitest';

import { deriveLocalVoiceRuntimeProjection, deriveLocalVoiceSessionSnapshot } from './deriveLocalVoiceSessionSnapshot';
import type { VoiceConversationRuntimeSnapshot } from './voiceConversationRuntimeTypes';

function createRuntimeSnapshot(
    overrides: Partial<VoiceConversationRuntimeSnapshot> = {},
): VoiceConversationRuntimeSnapshot {
    return {
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

    it('maps runtime errors into the local compat projection without a separate localVoiceState facade', () => {
        const projection = deriveLocalVoiceRuntimeProjection(
            createRuntimeSnapshot({
                controlSessionId: 'session-2',
                state: 'error',
                error: {
                    kind: 'mic_permission_denied',
                    reason: 'mic_permission_denied',
                    recoverable: true,
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
});
