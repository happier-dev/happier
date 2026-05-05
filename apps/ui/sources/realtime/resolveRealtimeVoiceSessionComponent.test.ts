import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captureExceptionIfEnabled = vi.fn();

vi.mock('@/utils/system/sentry', () => ({
    captureExceptionIfEnabled: (...args: unknown[]) => captureExceptionIfEnabled(...args),
}));

describe('resolveRealtimeVoiceSessionComponent', () => {
    beforeEach(() => {
        captureExceptionIfEnabled.mockReset();
    });

    it('returns null and reports when the realtime voice session module cannot load', async () => {
        const { resolveRealtimeVoiceSessionComponent } = await import('./resolveRealtimeVoiceSessionComponent');
        const error = new Error('voice module unavailable');

        const resolved = resolveRealtimeVoiceSessionComponent('native', () => {
            throw error;
        });

        expect(resolved).toBeNull();
        expect(captureExceptionIfEnabled).toHaveBeenCalledWith(error, {
            tags: {
                area: 'realtime_provider',
                platform: 'native',
            },
        });
    });

    it('returns the realtime voice session component when the module loads', async () => {
        const { resolveRealtimeVoiceSessionComponent } = await import('./resolveRealtimeVoiceSessionComponent');
        const VoiceSession = () => React.createElement('VoiceSessionMock', null);

        const resolved = resolveRealtimeVoiceSessionComponent('web', () => ({
            RealtimeVoiceSession: VoiceSession,
        }));

        expect(resolved).toBe(VoiceSession);
        expect(captureExceptionIfEnabled).not.toHaveBeenCalled();
    });
});
