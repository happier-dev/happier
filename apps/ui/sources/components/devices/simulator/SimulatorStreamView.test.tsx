import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import type { SimulatorDeviceResourceV1 } from '@happier-dev/protocol';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => {
            if (params && typeof params === 'object' && 'reasonCode' in params) {
                return `${key}:${String(params.reasonCode)}`;
            }
            return key;
        },
    });
});

function flattenStreamStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>(
            (acc, item) => Object.assign(acc, flattenStreamStyle(item)),
            {},
        );
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

const availableResource: SimulatorDeviceResourceV1 = {
    v: 1,
    simulatorId: 'sim_1',
    platform: 'ios',
    deviceId: 'device_1',
    displayName: 'iPhone 16',
    capture: {
        status: 'available',
        sourceId: 'source_1',
        supportedCodecs: ['image.mjpeg'],
        inputMode: 'exclusive',
        streamControls: {
            requestKeyframe: false,
            snapshot: false,
            setQuality: false,
            setFps: false,
            setScale: false,
        },
    },
};

describe('SimulatorStreamView', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('renders typed capture-unavailable diagnostics instead of a blank preview', async () => {
        const mod = await import('./SimulatorStreamView').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorStreamView');
        if (!('SimulatorStreamView' in mod)) return;

        const screen = await renderScreen(
            <mod.SimulatorStreamView
                resource={{
                    ...availableResource,
                    capture: {
                        status: 'unavailable',
                        sourceId: 'source_1',
                        reasonCode: 'capture_unavailable',
                    },
                }}
                playerState={{
                    phase: 'idle',
                    selectedCodec: null,
                    activeRenderer: null,
                    decodedFrames: 0,
                    droppedFrames: 0,
                    bufferedBytes: 0,
                }}
                lease={{ state: 'none' }}
                controls={{
                    canWatch: false,
                    canControl: false,
                    canRequestKeyframe: false,
                    canSetQuality: false,
                    supportedInputKinds: [],
                }}
                testID="simulator-stream"
            />,
        );

        expect(screen.findByTestId('simulator-stream-unavailable')).toBeTruthy();
        expect(screen.findByTestId('simulator-stream-player-frame')).toBeNull();
    });

    it('emphasizes the device name as the primary header label with platform secondary and a status dot', async () => {
        const mod = await import('./SimulatorStreamView').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorStreamView');
        if (!('SimulatorStreamView' in mod)) return;

        const screen = await renderScreen(
            <mod.SimulatorStreamView
                resource={availableResource}
                playerState={{
                    phase: 'playing',
                    selectedCodec: 'image.mjpeg',
                    activeRenderer: 'mjpeg',
                    lastFrameUrl: 'data:image/jpeg;base64,AQID',
                    lastFrameAtMs: 1_000,
                    decodedFrames: 1,
                    droppedFrames: 0,
                    bufferedBytes: 0,
                }}
                lease={{ state: 'held-by-me' }}
                controls={{
                    canWatch: true,
                    canControl: true,
                    canRequestKeyframe: false,
                    canSetQuality: false,
                    supportedInputKinds: ['tap'],
                }}
                testID="simulator-stream"
            />,
        );

        const title = screen.findByTestId('simulator-stream-title');
        const meta = screen.findByTestId('simulator-stream-meta');
        const titleStyle = flattenStreamStyle(title?.props.style);
        const metaStyle = flattenStreamStyle(meta?.props.style);
        expect(title?.props.children).toBe('iPhone 16');
        expect(meta?.props.children).toBe('ios');
        // Primary label is heavier than the secondary platform label.
        expect(titleStyle.fontFamily).toBe('Inter-SemiBold');
        expect(metaStyle.fontFamily).not.toBe('Inter-SemiBold');
        // Premium chrome: a soft-haloed status dot accompanies the device title.
        expect(screen.findByTestId('simulator-stream-header-dot')).toBeTruthy();
    });

    it('renders an intentional connecting skeleton while a watchable stream opens with no frame yet', async () => {
        const mod = await import('./SimulatorStreamView').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorStreamView');
        if (!('SimulatorStreamView' in mod)) return;

        const screen = await renderScreen(
            <mod.SimulatorStreamView
                resource={availableResource}
                playerState={{
                    phase: 'opening',
                    selectedCodec: 'image.mjpeg',
                    activeRenderer: 'mjpeg',
                    decodedFrames: 0,
                    droppedFrames: 0,
                    bufferedBytes: 0,
                }}
                lease={{ state: 'none' }}
                controls={{
                    canWatch: true,
                    canControl: false,
                    canRequestKeyframe: false,
                    canSetQuality: false,
                    supportedInputKinds: [],
                }}
                testID="simulator-stream"
            />,
        );

        // Connecting skeleton — distinct from the terminal unavailable card and never a blank rectangle.
        expect(screen.findByTestId('simulator-stream-connecting')).toBeTruthy();
        expect(screen.findByTestId('simulator-stream-unavailable')).toBeNull();
        expect(screen.findByTestId('simulator-stream-player-frame')).toBeNull();
    });

    it('renders a restoring skeleton while reconnecting without a preserved frame', async () => {
        const mod = await import('./SimulatorStreamView').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorStreamView');
        if (!('SimulatorStreamView' in mod)) return;

        const screen = await renderScreen(
            <mod.SimulatorStreamView
                resource={availableResource}
                playerState={{
                    phase: 'reconnecting',
                    selectedCodec: 'image.mjpeg',
                    activeRenderer: 'mjpeg',
                    decodedFrames: 0,
                    droppedFrames: 0,
                    bufferedBytes: 0,
                    diagnostic: { reasonCode: 'socket_reconnect' },
                }}
                lease={{ state: 'none' }}
                controls={{
                    canWatch: true,
                    canControl: false,
                    canRequestKeyframe: false,
                    canSetQuality: false,
                    supportedInputKinds: [],
                }}
                testID="simulator-stream"
            />,
        );

        expect(screen.findByTestId('simulator-stream-connecting')).toBeTruthy();
        expect(screen.findByTestId('simulator-stream-unavailable')).toBeNull();
    });

    it('does not skeleton over a preserved frame while reconnecting', async () => {
        const mod = await import('./SimulatorStreamView').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorStreamView');
        if (!('SimulatorStreamView' in mod)) return;

        const screen = await renderScreen(
            <mod.SimulatorStreamView
                resource={availableResource}
                playerState={{
                    phase: 'reconnecting',
                    selectedCodec: 'image.mjpeg',
                    activeRenderer: 'mjpeg',
                    lastFrameUrl: 'data:image/jpeg;base64,AQID',
                    lastFrameAtMs: 1_000,
                    decodedFrames: 1,
                    droppedFrames: 0,
                    bufferedBytes: 0,
                    diagnostic: { reasonCode: 'socket_reconnect' },
                }}
                lease={{ state: 'none' }}
                controls={{
                    canWatch: true,
                    canControl: false,
                    canRequestKeyframe: false,
                    canSetQuality: false,
                    supportedInputKinds: [],
                }}
                testID="simulator-stream"
            />,
        );

        // A good last frame must keep showing — no skeleton over hydrated content.
        expect(screen.findByTestId('simulator-stream-connecting')).toBeNull();
        expect(screen.findByTestId('simulator-stream-player-frame')?.props.source).toEqual({
            uri: 'data:image/jpeg;base64,AQID',
        });
    });

    it('shows the terminal unavailable card, not the connecting skeleton, when capture is unavailable', async () => {
        const mod = await import('./SimulatorStreamView').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorStreamView');
        if (!('SimulatorStreamView' in mod)) return;

        const screen = await renderScreen(
            <mod.SimulatorStreamView
                resource={{
                    ...availableResource,
                    capture: {
                        status: 'unavailable',
                        sourceId: 'source_1',
                        reasonCode: 'capture_unavailable',
                    },
                }}
                playerState={{
                    phase: 'opening',
                    selectedCodec: null,
                    activeRenderer: null,
                    decodedFrames: 0,
                    droppedFrames: 0,
                    bufferedBytes: 0,
                }}
                lease={{ state: 'none' }}
                controls={{
                    canWatch: false,
                    canControl: false,
                    canRequestKeyframe: false,
                    canSetQuality: false,
                    supportedInputKinds: [],
                }}
                testID="simulator-stream"
            />,
        );

        expect(screen.findByTestId('simulator-stream-unavailable')).toBeTruthy();
        expect(screen.findByTestId('simulator-stream-connecting')).toBeNull();
    });

    it('keeps stream recovery controls available to read-only watchers when supported', async () => {
        const mod = await import('./SimulatorStreamView').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorStreamView');
        if (!('SimulatorStreamView' in mod)) return;

        const screen = await renderScreen(
            <mod.SimulatorStreamView
                resource={availableResource}
                playerState={{
                    phase: 'reconnecting',
                    selectedCodec: 'image.mjpeg',
                    activeRenderer: 'mjpeg',
                    lastFrameUrl: 'data:image/jpeg;base64,AQID',
                    lastFrameAtMs: 1_000,
                    decodedFrames: 1,
                    droppedFrames: 0,
                    bufferedBytes: 0,
                    diagnostic: { reasonCode: 'socket_reconnect' },
                }}
                lease={{ state: 'none' }}
                controls={{
                    canWatch: true,
                    canControl: false,
                    canRequestKeyframe: true,
                    canSetQuality: true,
                    supportedInputKinds: ['tap'],
                }}
                testID="simulator-stream"
            />,
        );

        expect(screen.findByTestId('simulator-stream-player-frame')?.props.source).toEqual({
            uri: 'data:image/jpeg;base64,AQID',
        });
        expect(screen.findByTestId('simulator-stream-readonly')).toBeTruthy();
        expect(screen.findByTestId('simulator-stream-control-state')?.props.accessibilityState?.disabled).toBe(true);
        expect(screen.findByTestId('simulator-stream-player-request-keyframe')?.props.accessibilityState?.disabled).toBe(false);
        expect(screen.findByTestId('simulator-stream-player-lower-quality')?.props.accessibilityState?.disabled).toBe(false);
    });

    it('disables player stream controls when no producer-backed control support is present', async () => {
        const mod = await import('./SimulatorStreamView').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorStreamView');
        if (!('SimulatorStreamView' in mod)) return;

        const screen = await renderScreen(
            <mod.SimulatorStreamView
                resource={availableResource}
                playerState={{
                    phase: 'playing',
                    selectedCodec: 'image.mjpeg',
                    activeRenderer: 'mjpeg',
                    lastFrameUrl: 'data:image/jpeg;base64,AQID',
                    lastFrameAtMs: 1_000,
                    decodedFrames: 1,
                    droppedFrames: 0,
                    bufferedBytes: 0,
                }}
                lease={{ state: 'held-by-me' }}
                controls={{
                    canWatch: true,
                    canControl: true,
                    canRequestKeyframe: false,
                    canSetQuality: false,
                    supportedInputKinds: ['tap'],
                }}
                testID="simulator-stream"
            />,
        );

        expect(screen.findByTestId('simulator-stream-player-request-keyframe')?.props.accessibilityState?.disabled).toBe(true);
        expect(screen.findByTestId('simulator-stream-player-lower-quality')?.props.accessibilityState?.disabled).toBe(true);
    });

    it('treats capture-unavailable as authoritative over cached frames', async () => {
        const mod = await import('./SimulatorStreamView').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorStreamView');
        if (!('SimulatorStreamView' in mod)) return;

        const screen = await renderScreen(
            <mod.SimulatorStreamView
                resource={{
                    ...availableResource,
                    capture: {
                        status: 'unavailable',
                        sourceId: 'source_1',
                        reasonCode: 'capture_unavailable',
                    },
                }}
                playerState={{
                    phase: 'reconnecting',
                    selectedCodec: 'image.mjpeg',
                    activeRenderer: 'mjpeg',
                    lastFrameUrl: 'data:image/jpeg;base64,AQID',
                    lastFrameAtMs: 1_000,
                    decodedFrames: 1,
                    droppedFrames: 0,
                    bufferedBytes: 0,
                    diagnostic: { reasonCode: 'permission_expired' },
                }}
                lease={{ state: 'none' }}
                controls={{
                    canWatch: true,
                    canControl: false,
                    canRequestKeyframe: true,
                    canSetQuality: true,
                    supportedInputKinds: ['tap'],
                }}
                testID="simulator-stream"
            />,
        );

        expect(screen.findByTestId('simulator-stream-unavailable')).toBeTruthy();
        // D-RC4: visible copy is simulator-preview copy; the raw internal reason code
        // must NOT leak into product text or accessibility labels. The shared
        // `SurfaceStateCard` exposes it only through a hidden QA diagnostic testID.
        const reasonNode = screen.findByTestId('simulator-stream-unavailable-reason');
        expect(reasonNode?.props.children).toBe('simulatorPreview.availability.captureUnavailable');
        expect(String(reasonNode?.props.children)).not.toContain('capture_unavailable');
        expect(reasonNode?.props.accessibilityLabel).toBeUndefined();
        expect(screen.findByTestId('simulator-stream-unavailable-diagnostic-capture_unavailable')).toBeTruthy();
        expect(screen.findByTestId('simulator-stream-player-frame')).toBeNull();
    });

    it('does not render stale frames when the viewer cannot watch the stream', async () => {
        const mod = await import('./SimulatorStreamView').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorStreamView');
        if (!('SimulatorStreamView' in mod)) return;

        const screen = await renderScreen(
            <mod.SimulatorStreamView
                resource={availableResource}
                playerState={{
                    phase: 'reconnecting',
                    selectedCodec: 'image.mjpeg',
                    activeRenderer: 'mjpeg',
                    lastFrameUrl: 'data:image/jpeg;base64,AQID',
                    lastFrameAtMs: 1_000,
                    decodedFrames: 1,
                    droppedFrames: 0,
                    bufferedBytes: 0,
                    diagnostic: { reasonCode: 'permission_expired' },
                }}
                lease={{ state: 'none' }}
                controls={{
                    canWatch: false,
                    canControl: false,
                    canRequestKeyframe: false,
                    canSetQuality: false,
                    supportedInputKinds: [],
                }}
                testID="simulator-stream"
            />,
        );

        expect(screen.findByTestId('simulator-stream-unavailable')).toBeTruthy();
        expect(screen.findByTestId('simulator-stream-player-frame')).toBeNull();
    });

    it('passes H.264 AVCC chunks into the WebCodecs player path', async () => {
        class SupportedVideoDecoder {
            configure(): void {
                // Browser WebCodecs boundary stub.
            }

            decode(): void {
                // Browser WebCodecs boundary stub.
            }

            close(): void {
                // Browser WebCodecs boundary stub.
            }
        }
        class EncodedVideoChunkStub {
            constructor(_input: unknown) {
                // Browser WebCodecs boundary stub.
            }
        }
        vi.stubGlobal('VideoDecoder', SupportedVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', EncodedVideoChunkStub);
        const mod = await import('./SimulatorStreamView').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorStreamView');
        if (!('SimulatorStreamView' in mod)) return;

        const screen = await renderScreen(
            <mod.SimulatorStreamView
                resource={{
                    ...availableResource,
                    capture: {
                        status: 'available',
                        sourceId: 'source_1',
                        supportedCodecs: ['h264.avcc', 'image.mjpeg'],
                        inputMode: 'exclusive',
                    },
                }}
                playerState={{
                    phase: 'opening',
                    selectedCodec: 'h264.avcc',
                    activeRenderer: 'webcodecs',
                    decodedFrames: 0,
                    droppedFrames: 0,
                    bufferedBytes: 4,
                    avccChunks: [new Uint8Array([1, 2, 3, 4])],
                }}
                lease={{ state: 'held-by-me' }}
                controls={{
                    canWatch: true,
                    canControl: true,
                    canRequestKeyframe: true,
                    canSetQuality: true,
                    supportedInputKinds: ['tap'],
                }}
                testID="simulator-stream"
            />,
        );

        expect(screen.findByTestId('simulator-stream-player-webcodecs-surface')).toBeTruthy();
        expect(screen.findByTestId('simulator-stream-player-frame')).toBeNull();
        expect(screen.findByTestId('simulator-stream-player-unavailable')).toBeNull();
    });

    it('surfaces product-path WebCodecs unavailability as an explicit stream error', async () => {
        vi.stubGlobal('VideoDecoder', undefined);
        vi.stubGlobal('EncodedVideoChunk', undefined);
        const mod = await import('./SimulatorStreamView').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorStreamView');
        if (!('SimulatorStreamView' in mod)) return;

        const screen = await renderScreen(
            <mod.SimulatorStreamView
                resource={{
                    ...availableResource,
                    capture: {
                        status: 'available',
                        sourceId: 'source_1',
                        supportedCodecs: ['h264.avcc', 'image.mjpeg'],
                        inputMode: 'exclusive',
                    },
                }}
                playerState={{
                    phase: 'opening',
                    selectedCodec: 'h264.avcc',
                    activeRenderer: 'webcodecs',
                    decodedFrames: 0,
                    droppedFrames: 0,
                    bufferedBytes: 4,
                    avccChunks: [new Uint8Array([0, 0, 0, 2, 0x01, 0x64])],
                }}
                lease={{ state: 'held-by-me' }}
                controls={{
                    canWatch: true,
                    canControl: true,
                    canRequestKeyframe: true,
                    canSetQuality: true,
                    supportedInputKinds: ['tap'],
                }}
                testID="simulator-stream"
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('simulator-stream-player-webcodecs-surface')).toBeNull();
        expect(screen.findByTestId('simulator-stream-player-unavailable')).toBeTruthy();
        expect(screen.findByTestId('simulator-stream-player-status-error')).toBeTruthy();
    });

    it('does not show the previous simulator frame after switching to a device with no frame yet (C-STALE)', async () => {
        const renderer = await import('react-test-renderer');
        const mod = await import('./SimulatorStreamView');

        const simAResource: SimulatorDeviceResourceV1 = { ...availableResource, simulatorId: 'sim_a', deviceId: 'device_a', displayName: 'Sim A' };
        const simBResource: SimulatorDeviceResourceV1 = { ...availableResource, simulatorId: 'sim_b', deviceId: 'device_b', displayName: 'Sim B' };
        const controls = {
            canWatch: true,
            canControl: false,
            canRequestKeyframe: false,
            canSetQuality: false,
            supportedInputKinds: [],
        } as const;

        function frameSource(node: ReactTestInstance): string | null {
            return node.props?.testID === 'simulator-stream-player-frame'
                ? ((node.props?.source as { uri?: string } | undefined)?.uri ?? null)
                : null;
        }

        let tree!: ReactTestRenderer;
        await renderer.act(async () => {
            tree = renderer.create(
                <mod.SimulatorStreamView
                    resource={simAResource}
                    playerState={{
                        phase: 'playing',
                        selectedCodec: 'image.mjpeg',
                        activeRenderer: 'mjpeg',
                        lastFrameUrl: 'data:image/jpeg;base64,AQID',
                        lastFrameAtMs: 1_000,
                        decodedFrames: 1,
                        droppedFrames: 0,
                        bufferedBytes: 0,
                    }}
                    lease={{ state: 'none' }}
                    controls={controls}
                    testID="simulator-stream"
                />,
            );
        });
        // Sim A's frame is visible.
        expect(tree.root.findAll((node) => frameSource(node) === 'data:image/jpeg;base64,AQID')).toHaveLength(1);

        // Switch to sim B with no frame yet. The player is keyed by `resource.simulatorId`, so it
        // remounts and the previous device's held frame is discarded — the new device shows its
        // connecting skeleton, never sim A's stale frame.
        await renderer.act(async () => {
            tree.update(
                <mod.SimulatorStreamView
                    resource={simBResource}
                    playerState={{
                        phase: 'opening',
                        selectedCodec: 'image.mjpeg',
                        activeRenderer: 'mjpeg',
                        decodedFrames: 0,
                        droppedFrames: 0,
                        bufferedBytes: 0,
                    }}
                    lease={{ state: 'none' }}
                    controls={controls}
                    testID="simulator-stream"
                />,
            );
        });
        expect(tree.root.findAll((node) => frameSource(node) === 'data:image/jpeg;base64,AQID')).toHaveLength(0);

        await renderer.act(async () => {
            tree.unmount();
        });
    });
});
