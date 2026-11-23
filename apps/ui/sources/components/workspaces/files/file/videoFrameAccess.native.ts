import { ImageFormat, Skia, type SkImage, type Video } from '@shopify/react-native-skia';

import type { MediaPlayerFrame, MediaPlayerFrameOptions, MediaPlayerVideoControls } from './videoFrameAccess.types';

export type { MediaPlayerFrame, MediaPlayerFrameOptions, MediaPlayerPlayback, MediaPlayerVideoControls } from './videoFrameAccess.types';

// iOS and Android have no DOM video element or canvas. Skia's platform decoder (AVFoundation,
// MediaCodec) serves the same frame contract; a frame is ready once its seek settles.

function namedError(name: 'AbortError' | 'NotSupportedError', message: string): Error {
    return Object.assign(new Error(message), { name });
}

const cancelled = () => namedError('AbortError', 'The player frame read was cancelled.');

function nextDecodedImage(video: Video, signals: readonly AbortSignal[]): Promise<SkImage> {
    return new Promise((resolve, reject) => {
        let frame: ReturnType<typeof requestAnimationFrame> | undefined;
        const cleanup = () => {
            if (frame !== undefined) cancelAnimationFrame(frame);
            for (const signal of signals) signal.removeEventListener('abort', aborted);
        };
        const aborted = () => { cleanup(); reject(cancelled()); };
        const poll = () => {
            frame = undefined;
            let image: SkImage | null;
            try { image = video.nextImage(); } catch (error) { cleanup(); reject(error); return; }
            if (image) { cleanup(); resolve(image); return; }
            frame = requestAnimationFrame(poll);
        };
        if (signals.some(signal => signal.aborted)) { aborted(); return; }
        for (const signal of signals) signal.addEventListener('abort', aborted);
        poll();
    });
}

/** Draw the decoded frame upright (the container's rotation applied) at the demanded width, then encode a PNG. */
function encodeUprightFrame(image: SkImage, rotation: number, width?: number): Pick<MediaPlayerFrame, 'uri' | 'width' | 'height'> {
    const quarterTurn = rotation === 90 || rotation === 270;
    const naturalWidth = quarterTurn ? image.height() : image.width();
    const naturalHeight = quarterTurn ? image.width() : image.height();
    const outWidth = width === undefined ? naturalWidth : Math.max(1, Math.min(naturalWidth, Math.round(width)));
    const outHeight = Math.max(1, Math.round(naturalHeight * outWidth / naturalWidth));
    const surface = Skia.Surface.Make(outWidth, outHeight);
    if (!surface) throw namedError('NotSupportedError', 'Frame drawing is unavailable.');
    // A decoder frame can live in GPU memory; the raster surface draws its CPU copy.
    const pixels = image.makeNonTextureImage();
    try {
        const canvas = surface.getCanvas();
        canvas.scale(outWidth / naturalWidth, outHeight / naturalHeight);
        canvas.translate(naturalWidth / 2, naturalHeight / 2);
        canvas.rotate(rotation, 0, 0);
        canvas.translate(-image.width() / 2, -image.height() / 2);
        canvas.drawImage(pixels, 0, 0);
        surface.flush();
        return { uri: `data:image/png;base64,${surface.makeImageSnapshot().encodeToBase64(ImageFormat.PNG)}`, width: outWidth, height: outHeight };
    } finally {
        pixels.dispose();
    }
}

/** Hold one platform decoder for a finite operation; the caller owns the source URI's lifetime. */
export async function withVideoFrameSource<Result>(
    uri: string,
    operation: (controls: MediaPlayerVideoControls) => Promise<Result>,
    signal?: AbortSignal,
): Promise<Result> {
    if (signal?.aborted) throw cancelled();
    const video = await Skia.Video(uri);
    const lifetime = new AbortController();
    const release = () => {
        if (lifetime.signal.aborted) return;
        lifetime.abort();
        video.dispose();
    };
    signal?.addEventListener('abort', release);
    const durationMs = video.duration();
    const durationSeconds = Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : undefined;
    let positionSeconds = 0;
    const seek = (timeSeconds: number) => {
        if (lifetime.signal.aborted) throw cancelled();
        positionSeconds = Math.max(0, durationSeconds === undefined ? timeSeconds : Math.min(timeSeconds, durationSeconds));
        video.seek(positionSeconds * 1000);
    };
    const readFrame = async (options: MediaPlayerFrameOptions = {}): Promise<MediaPlayerFrame> => {
        if (options.timeSeconds !== undefined) seek(options.timeSeconds);
        const image = await nextDecodedImage(video, options.signal ? [lifetime.signal, options.signal] : [lifetime.signal]);
        try {
            return { ...encodeUprightFrame(image, video.rotation(), options.width), timeSeconds: positionSeconds,
                ...(durationSeconds === undefined ? {} : { durationSeconds }) };
        } finally {
            image.dispose();
        }
    };
    try {
        const result = await operation({ seekTo: seek, readFrame });
        if (lifetime.signal.aborted) throw cancelled();
        return result;
    } finally {
        signal?.removeEventListener('abort', release);
        release();
    }
}

/** expo-video's native view exposes no pixels: decode the held source at the player's position. */
export function readHeldPlayerFrame(params: Readonly<{
    element: unknown;
    uri: string;
    currentTimeSeconds: number;
    options: MediaPlayerFrameOptions;
    lifetime: AbortSignal;
    restorePlayback?: () => void;
}>): Promise<MediaPlayerFrame> {
    return withVideoFrameSource(params.uri, controls => controls.readFrame({ ...params.options,
        timeSeconds: params.options.timeSeconds ?? params.currentTimeSeconds }), params.lifetime);
}
