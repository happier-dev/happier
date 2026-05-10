import { vi } from 'vitest';

type StatusChangeListener = (payload: { status: string; error?: Error }) => void;

export type VideoPlayer = {
    loop: boolean;
    muted: boolean;
    allowsExternalPlayback: boolean;
    timeUpdateEventInterval: number;
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    addListener: ReturnType<typeof vi.fn>;
};

export function useVideoPlayer(_source: unknown, setup?: (player: VideoPlayer) => void): VideoPlayer {
    const listeners: StatusChangeListener[] = [];
    const player: VideoPlayer = {
        loop: false,
        muted: true,
        allowsExternalPlayback: false,
        timeUpdateEventInterval: 0,
        play: vi.fn(),
        pause: vi.fn(),
        addListener: vi.fn((_event: string, listener: StatusChangeListener) => {
            listeners.push(listener);
            return { remove: vi.fn() };
        }),
    };
    setup?.(player);
    return player;
}

export const VideoView = 'VideoView';
