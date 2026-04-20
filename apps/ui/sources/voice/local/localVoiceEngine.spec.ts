import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type { VoiceSessionSnapshot } from '@/voice/session/types';

import {
    getStorage,
    loadLocalVoiceEngineWithCompatState,
    registerLocalVoiceEngineHarnessHooks,
    sendMessage,
} from './localVoiceEngine.testHarness';

const getRealtimeSessionSnapshot = vi.fn<() => VoiceSessionSnapshot>(() => ({
    adapterId: 'realtime_elevenlabs',
    sessionId: null,
    status: 'disconnected',
    mode: 'idle',
    canStop: false,
}));

vi.mock('@/voice/runtime/realtime/RealtimeTransport', () => ({
    realtimeTransport: {
        getSessionSnapshot: () => getRealtimeSessionSnapshot(),
    },
}));

describe('local voice engine (turn-based) smoke', () => {
    registerLocalVoiceEngineHarnessHooks();

    it('records then transcribes and sends a message on stop', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();

        await toggleLocalVoiceTurn('s1');
        expect(getLocalVoiceState().status).toBe('recording');

        await toggleLocalVoiceTurn('s1');
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(sendMessage).toHaveBeenCalledWith('s1', 'hello world');
        // After a turn completes, the local voice session remains active (ready for another turn)
        // until the user explicitly hangs up.
        expect(getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: 's1' });
    }, 120_000);

    it('does not start a local voice turn while realtime voice is connected', async () => {
        getRealtimeSessionSnapshot.mockReturnValueOnce({
            adapterId: 'realtime_elevenlabs',
            sessionId: null,
            status: 'connected',
            mode: 'idle',
            canStop: true,
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');

        // Local voice should not start recording while a realtime call is active.
        expect(getLocalVoiceState().status).toBe('idle');
    });

    it('does not start a local voice turn when realtime is the selected voice provider', async () => {
        const storage = await getStorage();
        storage.__setState({
            ...storage.getState(),
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'realtime_elevenlabs',
                },
            },
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');

        expect(getLocalVoiceState().status).toBe('idle');
        expect(sendMessage).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
});
