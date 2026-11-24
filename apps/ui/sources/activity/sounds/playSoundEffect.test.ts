import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});

type StatusListener = (status: Record<string, unknown>) => void;

// expo-audio is the native playback boundary: it owns the player and reports its status.
const audio = vi.hoisted(() => ({
    listener: null as StatusListener | null,
    removed: 0,
}));
vi.mock('expo-audio', () => ({
    AudioModule: { setAudioModeAsync: async () => {} },
    createAudioPlayer: () => ({
        play: () => {},
        remove: () => { audio.removed += 1; },
        addListener: (_event: string, listener: StatusListener) => {
            audio.listener = listener;
            return { remove() {} };
        },
    }),
}));

describe('playSoundEffect', () => {
    beforeEach(() => {
        audio.listener = null;
        audio.removed = 0;
    });

    it.each([
        ['ios', { playbackState: 'failed' }],
        ['android', { playbackState: 'idle' }],
    ] as const)('frees the player once when playback fails before finishing on %s', async (platform, failure) => {
        Platform.OS = platform;
        const { playSoundEffect } = await import('./playSoundEffect');
        if (platform === 'android') {
            const core = await import('expo-modules-core');
            vi.spyOn(core, 'requireOptionalNativeModule').mockReturnValue({ isQuietModeActive: () => false });
        }

        await playSoundEffect('sound_electro_pop1');
        audio.listener?.({ playbackState: 'buffering' });
        expect(audio.removed).toBe(0);

        audio.listener?.(failure);
        expect(audio.removed).toBe(1);
        // A later terminal status does not free it again.
        audio.listener?.({ didJustFinish: true });
        expect(audio.removed).toBe(1);
    });
});
