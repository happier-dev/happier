import { beforeEach, describe, expect, it, vi } from 'vitest';

const getOptionalHappierAudioStreamNativeModuleMock = vi.hoisted(() => vi.fn());

vi.mock('@happier-dev/audio-stream-native', () => ({
    getOptionalHappierAudioStreamNativeModule: () => getOptionalHappierAudioStreamNativeModuleMock(),
}));

describe('resolveDaemonSpeechPcmCaptureAvailability (native)', () => {
    beforeEach(() => {
        getOptionalHappierAudioStreamNativeModuleMock.mockReset();
    });

    it('reports native daemon PCM capture available when the optional native module is installed', async () => {
        getOptionalHappierAudioStreamNativeModuleMock.mockReturnValue({
            start: vi.fn(),
            stop: vi.fn(),
            addListener: vi.fn(),
        });

        const { resolveDaemonSpeechPcmCaptureAvailability } = await import('./resolveDaemonSpeechPcmCaptureAvailability.native');

        expect(resolveDaemonSpeechPcmCaptureAvailability()).toBe('available');
    });

    it('fails closed when the optional native audio stream module is missing', async () => {
        getOptionalHappierAudioStreamNativeModuleMock.mockReturnValue(null);

        const { resolveDaemonSpeechPcmCaptureAvailability } = await import('./resolveDaemonSpeechPcmCaptureAvailability.native');

        expect(resolveDaemonSpeechPcmCaptureAvailability()).toBe('unavailable');
    });
});
