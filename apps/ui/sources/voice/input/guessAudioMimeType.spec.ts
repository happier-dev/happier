import { describe, expect, it } from 'vitest';

import { guessAudioMimeType } from './guessAudioMimeType';

describe('guessAudioMimeType', () => {
    it('maps known audio extensions case-insensitively', () => {
        expect(guessAudioMimeType('clip.webm')).toBe('audio/webm');
        expect(guessAudioMimeType('CLIP.WAV')).toBe('audio/wav');
        expect(guessAudioMimeType('voice.mp3')).toBe('audio/mpeg');
    });

    it('falls back to audio/mp4 for unknown or missing extensions', () => {
        expect(guessAudioMimeType('recording.m4a')).toBe('audio/mp4');
        expect(guessAudioMimeType('blob:abc')).toBe('audio/mp4');
    });
});
