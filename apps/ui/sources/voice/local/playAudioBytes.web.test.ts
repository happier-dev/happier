import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

describe('playAudioBytes', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    it('creates a blob URL, plays it via Audio, and does not throw', async () => {
        const createObjectURL = vi.fn(() => 'blob:test-audio');
        const revokeObjectURL = vi.fn();

        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

        const play = vi.fn(async () => {});
        const addEventListener = vi.fn((event: string, cb: () => void) => {
            if (event === 'ended') cb();
        });

        const AudioCtor = vi.fn().mockImplementation(() => ({
            play,
            addEventListener,
        }));

        vi.stubGlobal('Audio', AudioCtor);

        const { playAudioBytes } = await import('./playAudioBytes');

        const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
        await expect(playAudioBytes({ bytes, format: 'mp3' })).resolves.toBeUndefined();

        expect(createObjectURL).toHaveBeenCalledTimes(1);
        expect(AudioCtor).toHaveBeenCalledWith('blob:test-audio');
        expect(addEventListener).toHaveBeenCalled();
        expect(play).toHaveBeenCalledTimes(1);
        expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    });
});
