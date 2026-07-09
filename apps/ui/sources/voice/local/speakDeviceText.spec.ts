import { describe, expect, it, vi } from 'vitest';

const speakSpy = vi.fn();
const stopSpy = vi.fn();

vi.mock('expo-speech', () => ({
    speak: (text: string, opts: any) => speakSpy(text, opts),
    stop: () => stopSpy(),
}));

import { speakDeviceText, stopDeviceSpeech } from './speakDeviceText';

describe('speakDeviceText', () => {
    it('invokes onStart then ExpoSpeech.speak and resolves on onDone', async () => {
        speakSpy.mockReset();
        const onStart = vi.fn();
        speakSpy.mockImplementationOnce((_text: string, opts: any) => {
            opts.onDone();
        });

        await expect(speakDeviceText('hello', onStart)).resolves.toBeUndefined();
        expect(onStart).toHaveBeenCalledTimes(1);
        expect(speakSpy).toHaveBeenCalledTimes(1);
    });

    it('skips ExpoSpeech.speak when the abort signal is already aborted (pre-interrupt)', async () => {
        speakSpy.mockReset();
        const onStart = vi.fn();
        const controller = new AbortController();
        controller.abort();

        await expect(
            speakDeviceText('hello', onStart, { signal: controller.signal }),
        ).resolves.toBeUndefined();

        expect(speakSpy).not.toHaveBeenCalled();
        // onStart (the speaking transition) must not fire if we never speak.
        expect(onStart).not.toHaveBeenCalled();
    });

    it('invokes onStart only after deciding to speak (not before the abort check)', async () => {
        speakSpy.mockReset();
        const onStart = vi.fn();
        speakSpy.mockImplementationOnce((_text: string, opts: any) => opts.onStopped());

        await speakDeviceText('hi', onStart, { signal: new AbortController().signal });
        expect(onStart).toHaveBeenCalledTimes(1);
    });

    it('rejects when ExpoSpeech reports an error', async () => {
        speakSpy.mockReset();
        speakSpy.mockImplementationOnce((_text: string, opts: any) => opts.onError(new Error('synth_boom')));
        await expect(speakDeviceText('hi')).rejects.toThrow('synth_boom');
    });

    it('stopDeviceSpeech calls ExpoSpeech.stop', () => {
        stopSpy.mockReset();
        stopDeviceSpeech();
        expect(stopSpy).toHaveBeenCalledTimes(1);
    });
});
