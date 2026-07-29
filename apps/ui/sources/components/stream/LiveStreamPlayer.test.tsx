import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

vi.mock('react-native-unistyles', () => {
    // Keep this stream test isolated from unrelated theme module evaluation; the canonical
    // Unistyles helper imports the active app theme.
    const theme = {
        colors: {
            border: { default: '#d0d0d0' },
            surface: { base: '#ffffff', inset: '#f4f4f4' },
            text: { primary: '#111111', secondary: '#555555', disabled: '#999999' },
            state: {
                success: { foreground: '#34C759' },
                warning: { foreground: '#FF9500' },
                danger: { foreground: '#FF3B30' },
                neutral: { foreground: '#8E8E93' },
            },
        },
    };
    return {
        StyleSheet: {
            create: (input: unknown) => (
                typeof input === 'function'
                    ? (input as (themeInput: typeof theme) => unknown)(theme)
                    : input
            ),
            flatten: (value: unknown) => value,
        },
        useUnistyles: () => ({ theme }),
        UnistylesRuntime: {},
    };
});

const reconnectingState = {
    phase: 'reconnecting',
    selectedCodec: 'image.mjpeg',
    activeRenderer: 'mjpeg',
    lastFrameUrl: 'data:image/jpeg;base64,AQID',
    lastFrameAtMs: 1_000,
    decodedFrames: 1,
    droppedFrames: 0,
    bufferedBytes: 0,
    diagnostic: { reasonCode: 'socket_reconnect' },
} as const;

async function loadLiveStreamPlayer(): Promise<typeof import('./LiveStreamPlayer')> {
    return await import('./LiveStreamPlayer');
}

function avccEnvelope(tag: number, payload: readonly number[]): Uint8Array {
    const length = payload.length + 1;
    const bytes = new Uint8Array(4 + length);
    new DataView(bytes.buffer).setUint32(0, length, false);
    bytes[4] = tag;
    bytes.set(payload, 5);
    return bytes;
}

describe('LiveStreamPlayer', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('keeps the last frame visible while surfacing reconnect state and disabled controls', async () => {
        const mod = await loadLiveStreamPlayer();

        const screen = await renderScreen(
            <mod.LiveStreamPlayer
                state={reconnectingState}
                controls={{
                    canRequestKeyframe: false,
                    canSetQuality: false,
                }}
                testID="live-stream"
            />,
        );

        expect(screen.findByTestId('live-stream-frame')?.props.source).toEqual({
            uri: 'data:image/jpeg;base64,AQID',
        });
        expect(screen.findByTestId('live-stream-status-reconnecting')).toBeTruthy();
        expect(screen.findByTestId('live-stream-last-frame')).toBeTruthy();
        expect(screen.findByTestId('live-stream-request-keyframe')?.props.accessibilityState?.disabled).toBe(true);
        expect(screen.findByTestId('live-stream-lower-quality')?.props.accessibilityState?.disabled).toBe(true);
    });

    it('renders an explicit unavailable state when no renderer can show a frame', async () => {
        const mod = await loadLiveStreamPlayer();

        const screen = await renderScreen(
            <mod.LiveStreamPlayer
                state={{
                    phase: 'error',
                    selectedCodec: 'h264.avcc',
                    activeRenderer: 'fallback',
                    decodedFrames: 0,
                    droppedFrames: 0,
                    bufferedBytes: 0,
                    diagnostic: { reasonCode: 'h264_renderer_unavailable' },
                }}
                controls={{
                    canRequestKeyframe: true,
                    canSetQuality: false,
                }}
                testID="live-stream"
            />,
        );

        expect(screen.findByTestId('live-stream-unavailable')).toBeTruthy();
        expect(screen.findByTestId('live-stream-frame')).toBeNull();
        expect(screen.findByTestId('live-stream-request-keyframe')?.props.accessibilityState?.disabled).toBe(false);
        expect(screen.findByTestId('live-stream-lower-quality')?.props.accessibilityState?.disabled).toBe(true);
    });

    it('does not route H.264 renderer output through the MJPEG image renderer', async () => {
        const mod = await loadLiveStreamPlayer();

        const screen = await renderScreen(
            <mod.LiveStreamPlayer
                state={{
                    phase: 'degraded',
                    selectedCodec: 'h264.avcc',
                    activeRenderer: 'webcodecs',
                    lastFrameUrl: 'blob:h264-frame',
                    lastFrameAtMs: 1_000,
                    decodedFrames: 1,
                    droppedFrames: 0,
                    bufferedBytes: 0,
                    diagnostic: { reasonCode: 'webcodecs_renderer_unavailable' },
                }}
                controls={{
                    canRequestKeyframe: true,
                    canSetQuality: true,
                }}
                testID="live-stream"
            />,
        );

        expect(screen.findByTestId('live-stream-frame')).toBeNull();
        expect(screen.findByTestId('live-stream-unavailable')).toBeTruthy();
        expect(screen.findByTestId('live-stream-status-degraded')).toBeTruthy();
    });

    it('shows unsupported H.264 playing frames as unavailable instead of loading', async () => {
        const mod = await loadLiveStreamPlayer();

        const screen = await renderScreen(
            <mod.LiveStreamPlayer
                state={{
                    phase: 'playing',
                    selectedCodec: 'h264.avcc',
                    activeRenderer: 'webcodecs',
                    lastFrameUrl: 'blob:h264-frame',
                    lastFrameAtMs: 1_000,
                    decodedFrames: 1,
                    droppedFrames: 0,
                    bufferedBytes: 0,
                    diagnostic: { reasonCode: 'h264_renderer_unavailable' },
                }}
                controls={{
                    canRequestKeyframe: true,
                    canSetQuality: true,
                }}
                testID="live-stream"
            />,
        );

        expect(screen.findByTestId('live-stream-frame')).toBeNull();
        expect(screen.findByTestId('live-stream-unavailable')).toBeTruthy();
        expect(screen.findByTestId('live-stream-loading')).toBeNull();
    });

    it('selects the WebCodecs renderer for H.264 when AVCC input is provided', async () => {
        const mod = await loadLiveStreamPlayer();

        const screen = await renderScreen(
            <mod.LiveStreamPlayer
                avcc={{
                    chunks: [],
                    adapter: {
                        isSupported: () => ({ ok: true }),
                        configure: async () => ({}),
                        decode: async () => undefined,
                        close: () => undefined,
                    },
                }}
                state={{
                    phase: 'opening',
                    selectedCodec: 'h264.avcc',
                    activeRenderer: 'webcodecs',
                    decodedFrames: 0,
                    droppedFrames: 0,
                    bufferedBytes: 0,
                }}
                testID="live-stream"
            />,
        );

        expect(screen.findByTestId('live-stream-webcodecs-surface')).toBeTruthy();
        expect(screen.findByTestId('live-stream-unavailable')).toBeNull();
    });

    it('renders errored WebCodecs startup timeout as unavailable even when AVCC input remains mounted', async () => {
        const mod = await loadLiveStreamPlayer();

        const screen = await renderScreen(
            <mod.LiveStreamPlayer
                avcc={{
                    chunks: [new Uint8Array([0, 0, 0, 2, 0x02, 0x65])],
                    adapter: {
                        isSupported: () => ({ ok: true }),
                        configure: async () => ({}),
                        decode: async () => undefined,
                        close: () => undefined,
                    },
                }}
                controls={{
                    canRequestKeyframe: true,
                    canSetQuality: false,
                }}
                state={{
                    phase: 'error',
                    selectedCodec: 'h264.avcc',
                    activeRenderer: 'webcodecs',
                    decodedFrames: 0,
                    droppedFrames: 0,
                    bufferedBytes: 0,
                    diagnostic: { reasonCode: 'decoder_startup_timeout' },
                }}
                testID="live-stream"
            />,
        );

        expect(screen.findByTestId('live-stream-webcodecs-surface')).toBeNull();
        expect(screen.findByTestId('live-stream-unavailable')).toBeTruthy();
        expect(screen.findByTestId('live-stream-status-error')).toBeTruthy();
        expect(screen.findByTestId('live-stream-request-keyframe')?.props.accessibilityState?.disabled).toBe(false);
    });

    it('propagates unsupported WebCodecs diagnostics from product-style AVCC input into player state', async () => {
        vi.stubGlobal('VideoDecoder', undefined);
        vi.stubGlobal('EncodedVideoChunk', undefined);
        const mod = await loadLiveStreamPlayer();

        const screen = await renderScreen(
            <mod.LiveStreamPlayer
                avcc={{
                    chunks: [avccEnvelope(0x01, [1, 0x64, 0, 0x28])],
                }}
                state={{
                    phase: 'opening',
                    selectedCodec: 'h264.avcc',
                    activeRenderer: 'webcodecs',
                    decodedFrames: 0,
                    droppedFrames: 0,
                    bufferedBytes: 4,
                }}
                testID="live-stream"
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('live-stream-webcodecs-surface')).toBeNull();
        expect(screen.findByTestId('live-stream-unavailable')).toBeTruthy();
        expect(screen.findByTestId('live-stream-status-error')).toBeTruthy();
    });

    it('propagates WebCodecs startup timeout from product-style AVCC input into player state', async () => {
        vi.useFakeTimers();
        class HangingVideoDecoder {
            configure(): void {
                // Supported decoder that never produces an output frame.
            }

            decode(): void {
                // Supported decoder that never produces an output frame.
            }

            close(): void {
                // Supported decoder cleanup.
            }
        }
        class EncodedVideoChunkStub {
            constructor(_input: unknown) {
                // EncodedVideoChunk is a browser boundary object.
            }
        }
        vi.stubGlobal('VideoDecoder', HangingVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', EncodedVideoChunkStub);
        const mod = await loadLiveStreamPlayer();

        const screen = await renderScreen(
            <mod.LiveStreamPlayer
                avcc={{
                    chunks: [
                        avccEnvelope(0x01, [1, 0x64, 0, 0x28]),
                        avccEnvelope(0x02, [0x65, 1]),
                    ],
                }}
                state={{
                    phase: 'opening',
                    selectedCodec: 'h264.avcc',
                    activeRenderer: 'webcodecs',
                    decodedFrames: 0,
                    droppedFrames: 0,
                    bufferedBytes: 8,
                }}
                testID="live-stream"
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });
        await flushHookEffects({ cycles: 1, runOnlyPendingTimers: true, turns: 1 });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('live-stream-webcodecs-surface')).toBeNull();
        expect(screen.findByTestId('live-stream-unavailable')).toBeTruthy();
        expect(screen.findByTestId('live-stream-status-error')).toBeTruthy();
    });
});
