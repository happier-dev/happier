import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { SimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/types';

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

function selectedViewModel(overrides: Partial<SimulatorPreviewViewModel> = {}): SimulatorPreviewViewModel {
    return {
        kind: 'selected',
        viewerId: 'viewer_1',
        devices: [
            { simulatorId: 'sim_1', label: 'iPhone 16', platformLabel: 'iOS', selected: true, availability: { state: 'available' } },
            { simulatorId: 'sim_2', label: 'Pixel 9', platformLabel: 'Android', selected: false, availability: { state: 'available' } },
        ],
        selectedSimulatorId: 'sim_1',
        resource: {
            v: 1,
            simulatorId: 'sim_1',
            platform: 'ios',
            deviceId: 'device_1',
            displayName: 'iPhone 16',
            capture: { status: 'available', sourceId: 'source_1', supportedCodecs: ['image.mjpeg'], inputMode: 'exclusive' },
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
        codec: { selected: 'image.mjpeg' },
        lease: { state: 'held-by-me', leaseId: 'lease_1' },
        activeLease: null,
        controls: {
            canWatch: true,
            canControl: true,
            canRequestKeyframe: false,
            canSetQuality: false,
            canSetFps: false,
            canSetScale: false,
            supportedInputKinds: ['tap', 'hardware_button'],
            hardwareButtons: ['home'],
        },
        sidebands: {},
        diagnostics: [],
        availability: { state: 'available' },
        ...overrides,
    };
}

async function renderPane(viewModel: SimulatorPreviewViewModel, actions: Record<string, unknown> = {}) {
    const { SimulatorPreviewPane } = await import('./SimulatorPreviewPane');
    return renderScreen(<SimulatorPreviewPane viewModel={viewModel} actions={actions} testID="simulator-preview" />);
}

describe('SimulatorPreviewPane', () => {
    it('stays detect→launch: no free-URL, address or arbitrary-target input anywhere in the pane', async () => {
        const screen = await renderPane(selectedViewModel(), { selectDevice: vi.fn() });

        // Targets come only from detected devices (standing detect→launch design constraint, D4).
        expect(screen.findAll((node) => /TextInput/i.test(typeName(node.type)))).toEqual([]);
        expect(screen.findAll((node) => {
            const props = node.props ?? {};
            const role = typeof props.accessibilityRole === 'string' ? props.accessibilityRole : '';
            const id = typeof props.testID === 'string' ? props.testID : '';
            return role === 'search' || /address|url|location-bar/i.test(id);
        })).toEqual([]);
    });

    it('explains an empty Machine with one cause instead of a blank pane', async () => {
        const screen = await renderPane({
            ...selectedViewModel(),
            kind: 'empty',
            devices: [],
            selectedSimulatorId: null,
            resource: null,
            availability: { state: 'unavailable', reasonCode: 'no_simulator_devices' },
        });

        expect(screen.findByTestId('simulator-preview-picker-empty')).toBeTruthy();
        expect(screen.findByTestId('simulator-preview-bar')).toBeNull();
    });

    it('lists running devices with their platform and opens the one pressed', async () => {
        const selectDevice = vi.fn();
        const screen = await renderPane({
            ...selectedViewModel(),
            kind: 'empty',
            selectedSimulatorId: null,
            resource: null,
        }, { selectDevice });

        await screen.pressByTestIdAsync('simulator-preview-picker-device:sim_2');
        expect(selectDevice).toHaveBeenCalledWith('sim_2');
    });

    it('names the device in the bar, keeps the last picture while reconnecting, and keeps tools on demand', async () => {
        const requestSideband = vi.fn();
        const screen = await renderPane(selectedViewModel({
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
            sidebands: {
                logs: { v: 1, simulatorId: 'sim_1', emittedAtMs: 1_100, kind: 'logs', level: 'info', message: 'booted' },
            },
            diagnostics: [{ severity: 'info', reasonCode: 'socket_reconnect' }],
        }), { requestSideband, sendControl: vi.fn() });

        expect(screen.findByTestId('simulator-preview-bar-title')?.props.children).toBe('iPhone 16');
        // The reconnect is said once, over the held picture; the bar adds no second copy and no Take control.
        expect(screen.findByTestId('simulator-preview-bar-status')).toBeNull();
        expect(screen.findByTestId('simulator-preview-stream-player-frame')?.props.source).toEqual({ uri: 'data:image/jpeg;base64,AQID' });
        expect(screen.findByTestId('simulator-preview-stream-held-scrim')).toBeTruthy();
        expect(screen.findByTestId('simulator-preview-input-capture')).toBeTruthy();
        expect(screen.findByTestId('simulator-preview-toolbar-button-home')).toBeTruthy();
        expect(screen.findByTestId('simulator-preview-sidebands')).toBeNull();

        await screen.pressByTestIdAsync('simulator-preview-bar-tools');
        expect(screen.findByTestId('simulator-preview-sidebands-capture_health')).toBeTruthy();
        expect(screen.findByTestId('simulator-preview-sidebands-logs')).toBeTruthy();
        await screen.pressByTestIdAsync('simulator-preview-sidebands-refresh:capture_health');
        expect(requestSideband).toHaveBeenCalledWith('capture_health');
        await screen.pressByTestIdAsync('simulator-preview-sidebands-close');
        expect(screen.findByTestId('simulator-preview-sidebands')).toBeNull();
    });

    it('keeps one owner per control: control in the bar, device actions on the rail, presets in Tools', async () => {
        const actions = { requestKeyframe: vi.fn(), lowerQuality: vi.fn(), releaseLease: vi.fn() };
        const screen = await renderPane(selectedViewModel({
            controls: { ...selectedViewModel().controls, canRequestKeyframe: true, canSetQuality: true },
        }), actions);

        expect(screen.findAll((node) => (
            typeof node.type === 'string' && node.props?.children === 'streamPlayer.controls.controlling'
        ))).toHaveLength(1);
        await screen.pressByTestIdAsync('simulator-preview-bar-release-lease');
        expect(actions.releaseLease).toHaveBeenCalledTimes(1);
        await screen.pressByTestIdAsync('simulator-preview-toolbar-request-keyframe');
        expect(actions.requestKeyframe).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('simulator-preview-sidebands-lower-quality')).toBeNull();
        await screen.pressByTestIdAsync('simulator-preview-bar-tools');
        await screen.pressByTestIdAsync('simulator-preview-sidebands-lower-quality');
        expect(actions.lowerQuality).toHaveBeenCalledTimes(1);
    });

    it('offers a retry on a failed stream and none on a capture setup problem', async () => {
        const openStream = vi.fn();
        const failed = await renderPane(selectedViewModel({
            stream: {
                phase: 'error',
                selectedCodec: 'image.mjpeg',
                activeRenderer: null,
                decodedFrames: 0,
                droppedFrames: 0,
                bufferedBytes: 0,
                diagnostic: { reasonCode: 'stream_failed' },
            },
        }), { openStream });
        expect(failed.findByTestId('simulator-preview-stream-unavailable')).toBeTruthy();
        expect(failed.findByTestId('simulator-preview-stream-player-frame')).toBeNull();
        await failed.pressByTestIdAsync('simulator-preview-stream-unavailable-action');
        expect(openStream).toHaveBeenCalledTimes(1);

        const setup = await renderPane(selectedViewModel({
            resource: {
                ...selectedViewModel().resource!,
                capture: { status: 'unavailable', sourceId: 'source_1', reasonCode: 'capture_unavailable' },
            },
            controls: { ...selectedViewModel().controls, canWatch: false, canControl: false },
        }), { openStream });
        expect(setup.findByTestId('simulator-preview-stream-unavailable')).toBeTruthy();
        expect(setup.findByTestId('simulator-preview-stream-unavailable-action')).toBeNull();
        // A device that cannot be watched never reads as live and offers no control to take.
        expect(setup.findByTestId('simulator-preview-bar-status')).toBeNull();
        expect(setup.findByTestId('simulator-preview-bar-acquire-lease')).toBeNull();
    });
});
