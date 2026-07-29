import {
    buildMachineLiveStreamAvcCodecStringV1,
    type SimulatorOrientationV1,
} from '@happier-dev/protocol';

export type LiveStreamWebCodecsUnsupportedReasonCode =
    | 'webcodecs_unavailable'
    | 'webcodecs_decoder_unavailable'
    | 'webcodecs_chunk_unavailable';

export type LiveStreamWebCodecsSupport =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reasonCode: LiveStreamWebCodecsUnsupportedReasonCode }>;

export type LiveStreamWebCodecsReconfiguration = Readonly<{
    width?: number;
    height?: number;
    orientation?: SimulatorOrientationV1;
}>;

export type LiveStreamWebCodecsAdapter = Readonly<{
    isSupported: () => LiveStreamWebCodecsSupport;
    configure: (input: Readonly<{ description: Uint8Array }>) => Promise<LiveStreamWebCodecsReconfiguration>;
    decode: (input: Readonly<{
        type: 'keyframe' | 'delta';
        payload: Uint8Array;
        timestampUs?: number;
    }>) => Promise<void>;
    close: () => void;
}>;

type BrowserVideoFrame = Readonly<{
    codedWidth?: number;
    codedHeight?: number;
    displayWidth?: number;
    displayHeight?: number;
    close?: () => void;
}>;

type BrowserVideoDecoder = Readonly<{
    configure: (config: Readonly<{ codec: string; description?: Uint8Array }>) => void;
    decode: (chunk: unknown) => void;
    close: () => void;
}>;

type BrowserVideoDecoderConstructor = new (init: Readonly<{
    output: (frame: BrowserVideoFrame) => void;
    error: (error: unknown) => void;
}>) => BrowserVideoDecoder;

type BrowserEncodedVideoChunkConstructor = new (init: Readonly<{
    type: 'key' | 'delta';
    timestamp: number;
    data: Uint8Array;
}>) => unknown;

type BrowserWebCodecsScope = Readonly<{
    VideoDecoder?: unknown;
    EncodedVideoChunk?: unknown;
}>;

type BrowserCanvasSurface = {
    width?: number;
    height?: number;
    getContext?: (contextId: '2d') => CanvasRenderingContext2D | null;
};

type PendingDecode = {
    resolve: () => void;
    reject: (error: Error) => void;
};

function getWebCodecsScope(scope: unknown): BrowserWebCodecsScope {
    return scope && typeof scope === 'object' ? scope as BrowserWebCodecsScope : {};
}

export function resolveBrowserLiveStreamWebCodecsSupport(scope: unknown = globalThis): LiveStreamWebCodecsSupport {
    const webCodecsScope = getWebCodecsScope(scope);
    if (!webCodecsScope || typeof webCodecsScope !== 'object') {
        return { ok: false, reasonCode: 'webcodecs_unavailable' };
    }
    if (typeof webCodecsScope.VideoDecoder !== 'function') {
        return { ok: false, reasonCode: 'webcodecs_decoder_unavailable' };
    }
    if (typeof webCodecsScope.EncodedVideoChunk !== 'function') {
        return { ok: false, reasonCode: 'webcodecs_chunk_unavailable' };
    }
    return { ok: true };
}

export function createBrowserLiveStreamWebCodecsAdapter(input: Readonly<{
    scope?: unknown;
    getCanvas?: () => BrowserCanvasSurface | null;
    onDecoderError?: (reasonCode: 'webcodecs_decoder_error') => void;
}> = {}): LiveStreamWebCodecsAdapter {
    const scope = input.scope ?? globalThis;
    let decoder: BrowserVideoDecoder | null = null;
    const pendingDecodes: PendingDecode[] = [];

    const rejectPendingDecodes = (error: Error): void => {
        const pending = pendingDecodes.splice(0);
        for (const decode of pending) {
            decode.reject(error);
        }
    };

    const close = (): void => {
        if (!decoder) return;
        try {
            decoder.close();
        } finally {
            decoder = null;
            rejectPendingDecodes(new Error('webcodecs_decoder_closed'));
        }
    };

    const drawFrame = (frame: BrowserVideoFrame): void => {
        const canvas = input.getCanvas?.();
        const context = canvas?.getContext?.('2d');
        if (!canvas || !context) return;

        const width = Math.max(1, Math.floor(frame.displayWidth ?? frame.codedWidth ?? 1));
        const height = Math.max(1, Math.floor(frame.displayHeight ?? frame.codedHeight ?? 1));
        canvas.width = width;
        canvas.height = height;
        context.drawImage(frame as unknown as CanvasImageSource, 0, 0, width, height);
    };

    const handleOutputFrame = (frame: BrowserVideoFrame): void => {
        try {
            drawFrame(frame);
        } finally {
            frame.close?.();
        }
        const pending = pendingDecodes.shift();
        pending?.resolve();
    };

    const handleDecoderError = (): void => {
        input.onDecoderError?.('webcodecs_decoder_error');
        rejectPendingDecodes(new Error('webcodecs_decoder_error'));
    };

    return {
        isSupported: () => resolveBrowserLiveStreamWebCodecsSupport(scope),
        configure: async ({ description }) => {
            const support = resolveBrowserLiveStreamWebCodecsSupport(scope);
            if (!support.ok) return {};

            const webCodecsScope = getWebCodecsScope(scope);
            const VideoDecoderCtor = webCodecsScope.VideoDecoder as BrowserVideoDecoderConstructor;
            close();
            decoder = new VideoDecoderCtor({
                output: handleOutputFrame,
                error: handleDecoderError,
            });
            decoder.configure({
                codec: buildMachineLiveStreamAvcCodecStringV1(description),
                description,
            });
            return {};
        },
        decode: async ({ type, payload, timestampUs }) => {
            const support = resolveBrowserLiveStreamWebCodecsSupport(scope);
            if (!support.ok || decoder === null) return;

            const webCodecsScope = getWebCodecsScope(scope);
            const EncodedVideoChunkCtor = webCodecsScope.EncodedVideoChunk as BrowserEncodedVideoChunkConstructor;
            await new Promise<void>((resolveDecode, rejectDecode) => {
                const pending: PendingDecode = {
                    resolve: resolveDecode,
                    reject: rejectDecode,
                };
                pendingDecodes.push(pending);
                try {
                    decoder?.decode(new EncodedVideoChunkCtor({
                        type: type === 'keyframe' ? 'key' : 'delta',
                        timestamp: timestampUs ?? 0,
                        data: payload,
                    }));
                } catch (error) {
                    const index = pendingDecodes.indexOf(pending);
                    if (index >= 0) {
                        pendingDecodes.splice(index, 1);
                    }
                    rejectDecode(error instanceof Error ? error : new Error('webcodecs_decode_failed'));
                }
            });
        },
        close,
    };
}
