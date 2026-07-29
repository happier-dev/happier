import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => {
        if (params && typeof params === 'object' && 'reasonCode' in params) {
            return `${key}:${String(params.reasonCode)}`;
        }
        return key;
    } });
});

function typeName(type: unknown): string {
    if (typeof type === 'string') return type;
    if (typeof type === 'function') {
        const named = type as { displayName?: string; name?: string };
        return named.displayName ?? named.name ?? '';
    }
    return '';
}

describe('SimulatorPreviewPane', () => {
    it('stays detect→launch: the pane exposes no free-URL / address / arbitrary-target input', async () => {
        const mod = await import('./SimulatorPreviewPane').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorPreviewPane');
        if (!('SimulatorPreviewPane' in mod)) return;

        const SimulatorPreviewPane = mod.SimulatorPreviewPane as React.ComponentType<{
            viewModel: unknown;
            actions: Record<string, unknown>;
            testID: string;
        }>;
        const screen = await renderScreen(
            <SimulatorPreviewPane
                viewModel={{
                    kind: 'selected',
                    viewerId: 'viewer_1',
                    devices: [{
                        simulatorId: 'sim_1',
                        label: 'iPhone 16',
                        platformLabel: 'ios',
                        selected: true,
                        availability: { state: 'available' },
                    }],
                    selectedSimulatorId: 'sim_1',
                    resource: {
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
                        },
                    },
                    stream: {
                        phase: 'playing',
                        selectedCodec: 'image.mjpeg',
                        activeRenderer: 'mjpeg',
                        lastFrameUrl: 'data:image/jpeg;base64,AQID',
                        decodedFrames: 1,
                        droppedFrames: 0,
                        bufferedBytes: 0,
                    },
                    lease: { state: 'held-by-me', leaseId: 'lease_1' },
                    activeLease: null,
                    controls: {
                        canWatch: true,
                        canControl: true,
                        canRequestKeyframe: false,
                        canRequestSnapshot: false,
                        canSetQuality: false,
                        canSetFps: false,
                        canSetScale: false,
                        supportedInputKinds: ['tap'],
                    },
                    sidebands: {},
                    diagnostics: [],
                    availability: { state: 'available' },
                }}
                actions={{ selectDevice: vi.fn() }}
                testID="simulator-preview"
            />,
        );

        // The only target-selection affordance is the device picker over detected
        // devices. No address bar / free-URL / arbitrary-target text input may exist
        // in the pane subtree (standing detect→launch design constraint, D4).
        const textInputs = screen.findAll((node) => /TextInput/i.test(typeName(node.type)));
        expect(textInputs).toEqual([]);
        const addressLike = screen.findAll((node) => {
            const props = node.props ?? {};
            const role = typeof props.accessibilityRole === 'string' ? props.accessibilityRole : '';
            const id = typeof props.testID === 'string' ? props.testID : '';
            return role === 'search' || /address|url|location-bar/i.test(id);
        });
        expect(addressLike).toEqual([]);
        expect(screen.findByTestId('simulator-preview-picker')).toBeTruthy();
    });

    it('renders an explicit empty picker state instead of a blank pane', async () => {
        const mod = await import('./SimulatorPreviewPane').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorPreviewPane');
        if (!('SimulatorPreviewPane' in mod)) return;

        const SimulatorPreviewPane = mod.SimulatorPreviewPane as React.ComponentType<{
            viewModel: unknown;
            actions: Record<string, unknown>;
            testID: string;
        }>;
        const screen = await renderScreen(
            <SimulatorPreviewPane
                viewModel={{
                    kind: 'empty',
                    devices: [],
                    selectedSimulatorId: null,
                    resource: null,
                    sidebands: {},
                    diagnostics: [],
                    availability: { state: 'unavailable', reasonCode: 'no_simulator_devices' },
                }}
                actions={{}}
                testID="simulator-preview"
            />,
        );

        expect(screen.findByTestId('simulator-preview-picker-empty')).toBeTruthy();
        expect(screen.findByTestId('simulator-preview-stream-unavailable')).toBeTruthy();
    });

    it('composes stream, input, toolbar, sidebands, and last-frame reconnect state for a selected device', async () => {
        const mod = await import('./SimulatorPreviewPane').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorPreviewPane');
        if (!('SimulatorPreviewPane' in mod)) return;

        const SimulatorPreviewPane = mod.SimulatorPreviewPane as React.ComponentType<{
            viewModel: unknown;
            actions: Record<string, unknown>;
            testID: string;
        }>;
        const actions = {
            selectDevice: vi.fn(),
            sendControl: vi.fn(),
            requestSideband: vi.fn(),
            requestKeyframe: vi.fn(),
            lowerQuality: vi.fn(),
        };
        const screen = await renderScreen(
            <SimulatorPreviewPane
                viewModel={{
                    kind: 'selected',
                    viewerId: 'viewer_1',
                    devices: [{
                        simulatorId: 'sim_1',
                        label: 'iPhone 16',
                        platformLabel: 'ios',
                        selected: true,
                        availability: { state: 'degraded', reasonCode: 'socket_reconnect' },
                    }],
                    selectedSimulatorId: 'sim_1',
                    resource: {
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
                        },
                    },
                    stream: {
                        phase: 'reconnecting',
                        selectedCodec: 'image.mjpeg',
                        activeRenderer: 'mjpeg',
                        lastFrameUrl: 'data:image/jpeg;base64,AQID',
                        decodedFrames: 1,
                        droppedFrames: 0,
                        bufferedBytes: 0,
                        diagnostic: { reasonCode: 'socket_reconnect' },
                    },
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
                    controls: {
                        canWatch: true,
                        canControl: true,
                        canRequestKeyframe: false,
                        canRequestSnapshot: false,
                        canSetQuality: false,
                        canSetFps: false,
                        canSetScale: false,
                        supportedInputKinds: ['tap', 'keyboard_text'],
                    },
                    sidebands: {
                        logs: {
                            v: 1,
                            simulatorId: 'sim_1',
                            emittedAtMs: 1_100,
                            kind: 'logs',
                            level: 'info',
                            message: 'booted',
                        },
                    },
                    diagnostics: [{ severity: 'info', reasonCode: 'socket_reconnect' }],
                    availability: { state: 'degraded', reasonCode: 'socket_reconnect' },
                }}
                actions={actions}
                testID="simulator-preview"
            />,
        );

        expect(screen.findByTestId('simulator-preview-stream-player-frame')?.props.source).toEqual({
            uri: 'data:image/jpeg;base64,AQID',
        });
        expect(screen.findByTestId('simulator-preview-input-capture')).toBeTruthy();
        expect(screen.findByTestId('simulator-preview-toolbar')).toBeTruthy();
        expect(screen.findByTestId('simulator-preview-sidebands-drawer')).toBeNull();
        await screen.pressByTestIdAsync('simulator-preview-sidebands-open');
        expect(screen.findByTestId('simulator-preview-sidebands-capture_health')).toBeTruthy();
        expect(screen.findByTestId('simulator-preview-sidebands-logs')).toBeTruthy();
        expect(screen.findByTestId('simulator-preview-toolbar-request-keyframe')).toBeNull();
        expect(screen.findByTestId('simulator-preview-toolbar-request-snapshot')).toBeNull();
        expect(screen.findByTestId('simulator-preview-toolbar-lower-quality')).toBeNull();
    });
});
