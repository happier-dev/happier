export type MediaPlayerFrame = Readonly<{
    /** A decoded PNG (web canvas or native Skia), safe for the shared annotator without another media load. */
    uri: string;
    width: number;
    height: number;
    timeSeconds: number;
    /** Absent while the container doesn't state its length. */
    durationSeconds?: number;
}>;

export type MediaPlayerFrameOptions = Readonly<{
    timeSeconds?: number;
    /** A visible thumbnail's demanded width; omit to retain the source pixels. */
    width?: number;
    signal?: AbortSignal;
}>;

/** The mounted player's transport, for a host that draws its own timeline. A finite decoder has none. */
export type MediaPlayerPlayback = Readonly<{
    play: () => void;
    pause: () => void;
    readTime: () => number;
    subscribe: (listener: (playing: boolean) => void) => () => void;
}>;

export type MediaPlayerVideoControls = Readonly<{
    seekTo: (timeSeconds: number) => void;
    readFrame: (options?: MediaPlayerFrameOptions) => Promise<MediaPlayerFrame>;
    playback?: MediaPlayerPlayback;
}>;
