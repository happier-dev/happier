import { describe, expect, it } from 'vitest';

import {
    emitSpeechRecEvent,
    getStorage,
    registerLocalVoiceEngineHarnessHooks,
    sendMessage,
    speechRecStart,
    speechRecStop,
} from './localVoiceEngine.testHarness';

describe('local voice engine device STT (experimental)', () => {
    registerLocalVoiceEngineHarnessHooks();

    it('sends recognized text without requiring an STT endpoint', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voiceLocalUseDeviceStt: true,
                voiceLocalSttBaseUrl: null,
                voiceLocalAutoSpeakReplies: false,
            },
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        expect(getLocalVoiceState().status).toBe('recording');
        expect(speechRecStart).toHaveBeenCalled();

        // Simulate native/web recognition delivering a final result before stop.
        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'hello from device stt', confidence: 0.9, segments: [] }] });

        const stopPromise = toggleLocalVoiceTurn('s1');

        // Stop should request recognizer stop; engine resolves once `end` fires.
        expect(speechRecStop).toHaveBeenCalled();
        emitSpeechRecEvent('end', {});

        await stopPromise;

        expect(sendMessage).toHaveBeenCalledWith('s1', 'hello from device stt');
        expect((globalThis.fetch as any).mock.calls.length).toBe(0);
    });
});

