export type MediaPlayerFrame = Readonly<{
    /** Canvas-produced PNG, safe for the shared annotator without another media load. */
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

function waitForDecodedFrame(video: HTMLVideoElement, signals: readonly AbortSignal[], timeSeconds?: number, presentFrame = false,
    restorePlayback?: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
        const readyEvents = ['loadeddata', 'seeked', 'canplay'] as const;
        const failedEvents = ['error', 'emptied', 'abort'] as const;
        const ownerDocument = video.ownerDocument;
        const seeks = video.seeking || (timeSeconds !== undefined && video.currentTime !== timeSeconds);
        let seekCompleted = !seeks;
        let presenting = false;
        let settled = false;
        let animationFrame: number | undefined;
        const cleanup = () => {
            settled = true;
            for (const event of readyEvents) video.removeEventListener(event, ready);
            for (const event of failedEvents) video.removeEventListener(event, failed);
            ownerDocument.removeEventListener('visibilitychange', ready);
            for (const signal of signals) signal.removeEventListener('abort', aborted);
            if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
        };
        const presented = () => {
            video.pause();
            if (ownerDocument.visibilityState === 'hidden') { presenting = false; return; }
            cleanup();
            resolve();
        };
        const paint = () => {
            animationFrame = requestAnimationFrame(() => { animationFrame = undefined; presented(); });
        };
        const prime = () => {
            // A paused same-time seek need not submit a frame. Prime this player
            // silently; readVideoFrame restores its transport and mute state.
            void video.play().then(() => {
                if (settled) return restorePlayback?.();
                paint();
            }).catch(error => {
                if (settled) return;
                cleanup();
                reject(error);
            });
        };
        const ready = (event?: Event) => {
            if (event?.type === 'seeked') seekCompleted = true;
            if (settled || !seekCompleted || video.readyState < 2 || video.seeking || presenting) return;
            if (!presentFrame) { cleanup(); resolve(); return; }
            // WebKit does not present hidden-page pixels. Keep this demand
            // pending until visibility resumes, or its existing signal retires it.
            if (ownerDocument.visibilityState === 'hidden') return;
            presenting = true;
            if (video.currentTime >= video.duration) {
                // The decoder has already settled on its final frame. Playing
                // here can rewind to the beginning or wait for a frame past EOF.
                paint();
            } else {
                // A held track may supply neither another frame callback nor
                // ended before the longer movie timeline finishes. Playing
                // through one paint presents its pixels, then stops the decoder.
                prime();
            }
        };
        const failed = () => {
            cleanup();
            reject(new DOMException('The player could not decode the requested frame.', 'NotSupportedError'));
        };
        const aborted = () => {
            cleanup();
            reject(new DOMException('The player frame read was cancelled.', 'AbortError'));
        };
        if (signals.some((signal) => signal.aborted)) { aborted(); return; }
        for (const event of readyEvents) video.addEventListener(event, ready);
        for (const event of failedEvents) video.addEventListener(event, failed);
        ownerDocument.addEventListener('visibilitychange', ready);
        for (const signal of signals) signal.addEventListener('abort', aborted);
        try {
            if (timeSeconds !== undefined && video.currentTime !== timeSeconds) video.currentTime = timeSeconds;
            if (video.error) failed();
            else ready();
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
}

/** Read the held web player; callers request frames sequentially, never load a second decoder. */
export async function readVideoFrame(
    video: HTMLVideoElement,
    options: MediaPlayerFrameOptions,
    lifetime: AbortSignal,
    /** A mounted host restores its current intent; decoder playback is not that intent. */
    restorePlayback?: () => void,
): Promise<MediaPlayerFrame> {
    const signals = options.signal ? [lifetime, options.signal] : [lifetime];
    const originalTime = video.currentTime;
    const wasPlaying = !video.paused;
    const originalMuted = video.muted;
    const restore = async () => {
        video.pause();
        video.muted = originalMuted;
        if (lifetime.aborted) return;
        if (restorePlayback) restorePlayback();
        else {
            if (video.currentTime !== originalTime) video.currentTime = originalTime;
            if (wasPlaying) await video.play();
        }
    };
    video.pause();
    video.muted = true;
    try {
        await waitForDecodedFrame(video, signals, options.timeSeconds, true, restore);
        for (const signal of signals) signal.throwIfAborted();
        const canvas = video.ownerDocument.createElement('canvas');
        canvas.width = options.width === undefined ? video.videoWidth : Math.min(video.videoWidth, options.width);
        canvas.height = Math.max(1, Math.round(video.videoHeight * canvas.width / video.videoWidth));
        const context = canvas.getContext('2d');
        if (!context) throw new DOMException('Canvas drawing is unavailable.', 'NotSupportedError');
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        return { uri: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, timeSeconds: video.currentTime,
            ...(Number.isFinite(video.duration) ? { durationSeconds: video.duration } : {}) };
    } finally {
        await restore();
    }
}

/** Hold one web decoder for a finite operation; the caller owns the source URI's lifetime. */
export async function withVideoFrameSource<Result>(
    uri: string,
    operation: (controls: MediaPlayerVideoControls) => Promise<Result>,
    signal?: AbortSignal,
): Promise<Result> {
    signal?.throwIfAborted();
    const video = document.createElement('video');
    const lifetime = new AbortController();
    const release = () => {
        if (lifetime.signal.aborted) return;
        lifetime.abort();
        video.pause();
        video.removeAttribute('src');
        video.load();
    };
    signal?.addEventListener('abort', release);
    try {
        video.preload = 'auto';
        video.muted = true;
        video.playsInline = true;
        video.src = uri;
        await waitForDecodedFrame(video, [lifetime.signal]);
        lifetime.signal.throwIfAborted();
        const result = await operation({
            seekTo: (timeSeconds) => {
                lifetime.signal.throwIfAborted();
                video.currentTime = timeSeconds;
            },
            readFrame: (options = {}) => readVideoFrame(video, options, lifetime.signal),
        });
        lifetime.signal.throwIfAborted();
        return result;
    } finally {
        signal?.removeEventListener('abort', release);
        release();
    }
}
