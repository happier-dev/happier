import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSharedVoicePcmCaptureMock = vi.hoisted(() => vi.fn());

vi.mock('@happier-dev/audio-stream-native', () => ({
    getSharedVoicePcmCapture: () => getSharedVoicePcmCaptureMock(),
}));

describe('resolveDaemonSpeechPcmCaptureAvailability (native)', () => {
    beforeEach(() => {
        getSharedVoicePcmCaptureMock.mockReset();
    });

    it('reports native daemon PCM capture available when the shared capture owner is installed', async () => {
        getSharedVoicePcmCaptureMock.mockReturnValue({ acquire: vi.fn() });

        const { resolveDaemonSpeechPcmCaptureAvailability } = await import('./resolveDaemonSpeechPcmCaptureAvailability.native');

        expect(resolveDaemonSpeechPcmCaptureAvailability()).toBe('available');
    });

    it('fails closed when the installed module lacks the coordinator contract', async () => {
        getSharedVoicePcmCaptureMock.mockReturnValue(null);

        const { resolveDaemonSpeechPcmCaptureAvailability } = await import('./resolveDaemonSpeechPcmCaptureAvailability.native');

        expect(resolveDaemonSpeechPcmCaptureAvailability()).toBe('unavailable');
    });
});
