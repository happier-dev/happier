import { describe, expect, it } from 'vitest';

import { createExpoAudioRecorder } from './createExpoAudioRecorder';

function createRecorderConstructor() {
    const calls: unknown[] = [];
    class Recorder {
        readonly options: unknown;
        uri: string | null = null;

        constructor(options: unknown) {
            this.options = options;
            calls.push(options);
        }

        async prepareToRecordAsync(): Promise<void> {}
        pause(): void {}
        record(): void {}
        async stop(): Promise<void> {}
    }
    return { calls, Recorder };
}

describe('createExpoAudioRecorder', () => {
    it('uses Expo AudioRecorderWeb with the web preset in browser runtimes', () => {
        const native = createRecorderConstructor();
        const web = createRecorderConstructor();
        const webPreset = { mimeType: 'audio/webm' };

        const recorder = createExpoAudioRecorder({
            audioModule: { AudioRecorder: native.Recorder, AudioRecorderWeb: web.Recorder },
            nativePreset: { extension: '.m4a' },
            platformOS: 'web',
            webPreset,
        });

        expect(web.calls).toEqual([webPreset]);
        expect(native.calls).toEqual([]);
        expect(recorder).toBeInstanceOf(web.Recorder);
    });

    it('uses Expo AudioRecorder with the native preset outside browser runtimes', () => {
        const native = createRecorderConstructor();
        const web = createRecorderConstructor();
        const nativePreset = { extension: '.m4a' };

        const recorder = createExpoAudioRecorder({
            audioModule: { AudioRecorder: native.Recorder, AudioRecorderWeb: web.Recorder },
            nativePreset,
            platformOS: 'ios',
            webPreset: { mimeType: 'audio/webm' },
        });

        expect(native.calls).toEqual([nativePreset]);
        expect(web.calls).toEqual([]);
        expect(recorder).toBeInstanceOf(native.Recorder);
    });

    it('fails explicitly when the selected Expo recorder constructor is absent', () => {
        const native = createRecorderConstructor();

        expect(() => createExpoAudioRecorder({
            audioModule: { AudioRecorder: native.Recorder },
            nativePreset: { extension: '.m4a' },
            platformOS: 'web',
            webPreset: { mimeType: 'audio/webm' },
        })).toThrow('expo_audio_recorder_unavailable:web');
    });
});
