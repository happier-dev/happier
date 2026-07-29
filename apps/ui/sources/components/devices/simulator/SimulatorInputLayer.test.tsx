import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('SimulatorInputLayer', () => {
    it('maps in-device pointer geometry to a lease-scoped tap and ignores outside-device input', async () => {
        const mod = await import('./SimulatorInputLayer').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorInputLayer');
        if (!('SimulatorInputLayer' in mod)) return;

        const SimulatorInputLayer = mod.SimulatorInputLayer as React.ComponentType<{
            viewModel: unknown;
            viewport: { width: number; height: number };
            content: { x: number; y: number; width: number; height: number };
            orientation: 'portrait';
            onSendControl: (control: unknown) => void;
            testID: string;
        }>;
        const onSendControl = vi.fn();
        const screen = await renderScreen(
            <SimulatorInputLayer
                viewModel={{
                    kind: 'selected',
                    resource: { capture: { sourceId: 'source_1' } },
                    stream: { streamId: 'stream_1' },
                    viewerId: 'viewer_1',
                    lease: { state: 'held-by-me', leaseId: 'lease_1' },
                    activeLease: {
                        v: 1,
                        leaseId: 'lease_1',
                        streamId: 'stream_1',
                        sourceId: 'source_1',
                        holderId: 'viewer_1',
                        mode: 'exclusive',
                        acquiredAtMs: 1_000,
                        expiresAtMs: 2_000,
                    },
                    controls: { canControl: true, supportedInputKinds: ['tap', 'keyboard_text', 'keyboard_key'] },
                }}
                viewport={{ width: 400, height: 400 }}
                content={{ x: 100, y: 0, width: 200, height: 400 }}
                orientation="portrait"
                onSendControl={onSendControl}
                testID="simulator-input"
            />,
        );

        invokeTestInstanceHandler(screen.findByTestId('simulator-input-capture'), 'onResponderRelease', {
            nativeEvent: { locationX: 200, locationY: 200 },
        });
        invokeTestInstanceHandler(screen.findByTestId('simulator-input-capture'), 'onResponderRelease', {
            nativeEvent: { locationX: 50, locationY: 200 },
        });

        expect(onSendControl).toHaveBeenCalledTimes(1);
        expect(onSendControl).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'tap',
            leaseId: 'lease_1',
            x: 0.5,
            y: 0.5,
        }));
    });

    it('captures keyboard input only while focused and stops host shortcut propagation', async () => {
        const mod = await import('./SimulatorInputLayer').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorInputLayer');
        if (!('SimulatorInputLayer' in mod)) return;

        const SimulatorInputLayer = mod.SimulatorInputLayer as React.ComponentType<{
            viewModel: unknown;
            viewport: { width: number; height: number };
            content: { x: number; y: number; width: number; height: number };
            orientation: 'portrait';
            onSendControl: (control: unknown) => void;
            testID: string;
        }>;
        const onSendControl = vi.fn();
        const stopPropagation = vi.fn();
        const preventDefault = vi.fn();
        const screen = await renderScreen(
            <SimulatorInputLayer
                viewModel={{
                    kind: 'selected',
                    resource: { capture: { sourceId: 'source_1' } },
                    stream: { streamId: 'stream_1' },
                    viewerId: 'viewer_1',
                    lease: { state: 'held-by-me', leaseId: 'lease_1' },
                    activeLease: {
                        v: 1,
                        leaseId: 'lease_1',
                        streamId: 'stream_1',
                        sourceId: 'source_1',
                        holderId: 'viewer_1',
                        mode: 'exclusive',
                        acquiredAtMs: 1_000,
                        expiresAtMs: 2_000,
                    },
                    controls: { canControl: true, supportedInputKinds: ['keyboard_text', 'keyboard_key'] },
                }}
                viewport={{ width: 400, height: 400 }}
                content={{ x: 0, y: 0, width: 400, height: 400 }}
                orientation="portrait"
                onSendControl={onSendControl}
                testID="simulator-input"
            />,
        );

        const capture = screen.findByTestId('simulator-input-capture');
        invokeTestInstanceHandler(capture, 'onKeyDown', { key: 'a', preventDefault, stopPropagation });
        expect(onSendControl).not.toHaveBeenCalled();

        invokeTestInstanceHandler(capture, 'onFocus');
        invokeTestInstanceHandler(capture, 'onKeyDown', { key: 'a', preventDefault, stopPropagation });

        expect(onSendControl).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'keyboard_text',
            text: 'a',
            leaseId: 'lease_1',
        }));
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(stopPropagation).toHaveBeenCalledTimes(1);
    });

    it('does not capture pointer or keyboard input when the resource advertises inputMode none', async () => {
        const mod = await import('./SimulatorInputLayer').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorInputLayer');
        if (!('SimulatorInputLayer' in mod)) return;

        const SimulatorInputLayer = mod.SimulatorInputLayer as React.ComponentType<{
            viewModel: unknown;
            viewport: { width: number; height: number };
            content: { x: number; y: number; width: number; height: number };
            orientation: 'portrait';
            onSendControl: (control: unknown) => void;
            testID: string;
        }>;
        const onSendControl = vi.fn();
        const stopPropagation = vi.fn();
        const preventDefault = vi.fn();
        const screen = await renderScreen(
            <SimulatorInputLayer
                viewModel={{
                    kind: 'selected',
                    resource: {
                        capture: {
                            status: 'available',
                            sourceId: 'source_1',
                            supportedCodecs: ['image.mjpeg'],
                            inputMode: 'none',
                        },
                    },
                    stream: { streamId: 'stream_1' },
                    viewerId: 'viewer_1',
                    activeLease: {
                        v: 1,
                        leaseId: 'lease_1',
                        streamId: 'stream_1',
                        sourceId: 'source_1',
                        holderId: 'viewer_1',
                        mode: 'exclusive',
                        acquiredAtMs: 1_000,
                        expiresAtMs: 2_000,
                    },
                    controls: { canControl: true, supportedInputKinds: ['tap', 'keyboard_text', 'keyboard_key'] },
                }}
                viewport={{ width: 400, height: 400 }}
                content={{ x: 0, y: 0, width: 400, height: 400 }}
                orientation="portrait"
                onSendControl={onSendControl}
                testID="simulator-input"
            />,
        );

        const capture = screen.findByTestId('simulator-input-capture');
        expect(capture?.props.onStartShouldSetResponder()).toBe(false);

        invokeTestInstanceHandler(capture, 'onResponderRelease', {
            nativeEvent: { locationX: 200, locationY: 200 },
        });
        invokeTestInstanceHandler(capture, 'onFocus');
        invokeTestInstanceHandler(capture, 'onKeyDown', { key: 'a', preventDefault, stopPropagation });

        expect(onSendControl).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
        expect(stopPropagation).not.toHaveBeenCalled();
    });

    it('maps long press and swipe gestures through the central simulator control builder', async () => {
        const mod = await import('./SimulatorInputLayer').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorInputLayer');
        if (!('SimulatorInputLayer' in mod)) return;

        const SimulatorInputLayer = mod.SimulatorInputLayer as React.ComponentType<{
            viewModel: unknown;
            viewport: { width: number; height: number };
            content: { x: number; y: number; width: number; height: number };
            orientation: 'portrait';
            onSendControl: (control: unknown) => void;
            testID: string;
        }>;
        const onSendControl = vi.fn();
        const screen = await renderScreen(
            <SimulatorInputLayer
                viewModel={{
                    kind: 'selected',
                    resource: { capture: { sourceId: 'source_1' } },
                    stream: { streamId: 'stream_1' },
                    viewerId: 'viewer_1',
                    activeLease: {
                        v: 1,
                        leaseId: 'lease_1',
                        streamId: 'stream_1',
                        sourceId: 'source_1',
                        holderId: 'viewer_1',
                        mode: 'exclusive',
                        acquiredAtMs: 1_000,
                        expiresAtMs: 3_000,
                    },
                    controls: { canControl: true, supportedInputKinds: ['long_press', 'swipe'] },
                }}
                viewport={{ width: 400, height: 400 }}
                content={{ x: 0, y: 0, width: 400, height: 400 }}
                orientation="portrait"
                onSendControl={onSendControl}
                testID="simulator-input"
            />,
        );

        const capture = screen.findByTestId('simulator-input-capture');
        invokeTestInstanceHandler(capture, 'onResponderGrant', {
            nativeEvent: { locationX: 200, locationY: 200, timestamp: 1_000 },
        });
        invokeTestInstanceHandler(capture, 'onResponderRelease', {
            nativeEvent: { locationX: 200, locationY: 200, timestamp: 1_700 },
        });
        invokeTestInstanceHandler(capture, 'onResponderGrant', {
            nativeEvent: { locationX: 40, locationY: 200, timestamp: 2_000 },
        });
        invokeTestInstanceHandler(capture, 'onResponderMove', {
            nativeEvent: { locationX: 360, locationY: 200, timestamp: 2_100 },
        });
        invokeTestInstanceHandler(capture, 'onResponderRelease', {
            nativeEvent: { locationX: 360, locationY: 200, timestamp: 2_200 },
        });

        expect(onSendControl).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'long_press',
            leaseId: 'lease_1',
            x: 0.5,
            y: 0.5,
        }));
        expect(onSendControl).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'swipe',
            leaseId: 'lease_1',
            fromX: 0.1,
            fromY: 0.5,
            toX: 0.9,
            toY: 0.5,
        }));
    });

    it('maps two-touch pinch and rotate gestures when supported', async () => {
        const mod = await import('./SimulatorInputLayer').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorInputLayer');
        if (!('SimulatorInputLayer' in mod)) return;

        const SimulatorInputLayer = mod.SimulatorInputLayer as React.ComponentType<{
            viewModel: unknown;
            viewport: { width: number; height: number };
            content: { x: number; y: number; width: number; height: number };
            orientation: 'portrait';
            onSendControl: (control: unknown) => void;
            testID: string;
        }>;
        const onSendControl = vi.fn();
        const screen = await renderScreen(
            <SimulatorInputLayer
                viewModel={{
                    kind: 'selected',
                    resource: { capture: { sourceId: 'source_1' } },
                    stream: { streamId: 'stream_1' },
                    viewerId: 'viewer_1',
                    activeLease: {
                        v: 1,
                        leaseId: 'lease_1',
                        streamId: 'stream_1',
                        sourceId: 'source_1',
                        holderId: 'viewer_1',
                        mode: 'exclusive',
                        acquiredAtMs: 1_000,
                        expiresAtMs: 3_000,
                    },
                    controls: { canControl: true, supportedInputKinds: ['pinch', 'rotate'] },
                }}
                viewport={{ width: 400, height: 400 }}
                content={{ x: 0, y: 0, width: 400, height: 400 }}
                orientation="portrait"
                onSendControl={onSendControl}
                testID="simulator-input"
            />,
        );

        const capture = screen.findByTestId('simulator-input-capture');
        invokeTestInstanceHandler(capture, 'onResponderGrant', {
            nativeEvent: {
                locationX: 200,
                locationY: 200,
                timestamp: 1_000,
                touches: [
                    { locationX: 180, locationY: 200 },
                    { locationX: 220, locationY: 200 },
                ],
            },
        });
        invokeTestInstanceHandler(capture, 'onResponderMove', {
            nativeEvent: {
                locationX: 200,
                locationY: 200,
                timestamp: 1_100,
                touches: [
                    { locationX: 150, locationY: 200 },
                    { locationX: 250, locationY: 200 },
                ],
            },
        });
        invokeTestInstanceHandler(capture, 'onResponderRelease', {
            nativeEvent: { locationX: 200, locationY: 200, timestamp: 1_200 },
        });

        invokeTestInstanceHandler(capture, 'onResponderGrant', {
            nativeEvent: {
                locationX: 200,
                locationY: 200,
                timestamp: 2_000,
                touches: [
                    { locationX: 180, locationY: 200 },
                    { locationX: 220, locationY: 200 },
                ],
            },
        });
        invokeTestInstanceHandler(capture, 'onResponderMove', {
            nativeEvent: {
                locationX: 200,
                locationY: 200,
                timestamp: 2_100,
                touches: [
                    { locationX: 200, locationY: 180 },
                    { locationX: 200, locationY: 220 },
                ],
            },
        });
        invokeTestInstanceHandler(capture, 'onResponderRelease', {
            nativeEvent: { locationX: 200, locationY: 200, timestamp: 2_200 },
        });

        expect(onSendControl).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'pinch',
            leaseId: 'lease_1',
            centerX: 0.5,
            centerY: 0.5,
            startDistance: 40,
            endDistance: 100,
        }));
        expect(onSendControl).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'rotate',
            leaseId: 'lease_1',
            centerX: 0.5,
            centerY: 0.5,
            radius: 20,
            startAngle: 0,
            endAngle: expect.closeTo(Math.PI / 2, 6),
        }));
    });
});
