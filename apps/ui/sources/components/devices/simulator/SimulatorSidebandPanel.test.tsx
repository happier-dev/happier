import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { SimulatorPreviewControls, SimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/types';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const CONTROLS: SimulatorPreviewControls = {
    canWatch: true,
    canControl: false,
    canRequestKeyframe: false,
    canSetQuality: false,
    canSetFps: false,
    canSetScale: false,
    supportedInputKinds: [],
    hardwareButtons: [],
    deviceOperations: [],
};

function viewModel(overrides: Partial<Pick<SimulatorPreviewViewModel, 'controls' | 'sidebands' | 'diagnostics'>>): SimulatorPreviewViewModel {
    return { controls: CONTROLS, sidebands: {}, diagnostics: [], ...overrides } as SimulatorPreviewViewModel;
}

async function renderTools(model: SimulatorPreviewViewModel, actions: Record<string, unknown> = {}) {
    const { SimulatorSidebandPanel } = await import('./SimulatorSidebandPanel');
    return renderScreen(<SimulatorSidebandPanel viewModel={model} actions={actions} onClose={vi.fn()} testID="tools" />);
}

describe('SimulatorSidebandPanel (Tools)', () => {
    it('lists backed and delivered sidebands with structured rows and refreshes them through the sideband action', async () => {
        const requestSideband = vi.fn();
        const screen = await renderTools(viewModel({
            sidebands: {
                capture_health: { v: 1, simulatorId: 'sim_1', emittedAtMs: 1, kind: 'capture_health', status: 'degraded', reasonCode: 'slow_consumer' },
                logs: { v: 1, simulatorId: 'sim_1', emittedAtMs: 2, kind: 'logs', level: 'info', message: 'booted' },
                device_config: { v: 1, simulatorId: 'sim_1', emittedAtMs: 3, kind: 'device_config', config: { locale: 'en_US', display: { scale: 3 } } },
            },
            diagnostics: [{ severity: 'warning', reasonCode: 'slow_consumer' }],
        }), { requestSideband });

        expect(screen.findByTestId('tools-capture_health')).toBeTruthy();
        expect(screen.findByTestId('tools-logs')).toBeTruthy();
        expect(screen.findByTestId('tools-device_config-field:display.scale')).toBeTruthy();
        expect(screen.findByTestId('tools-diagnostic:slow_consumer')).toBeTruthy();
        // A schema the producer does not back and did not deliver is never listed as a feature.
        expect(screen.findByTestId('tools-accessibility_tree')).toBeNull();

        await screen.pressByTestIdAsync('tools-refresh:capture_health');
        expect(requestSideband).toHaveBeenCalledWith('capture_health');
    });

    it('offers only the stream presets the producer backs', async () => {
        const actions = { lowerQuality: vi.fn(), setFps: vi.fn(), setScale: vi.fn() };
        const screen = await renderTools(viewModel({ controls: { ...CONTROLS, canSetQuality: true, canSetFps: true } }), actions);

        await screen.pressByTestIdAsync('tools-lower-quality');
        await screen.pressByTestIdAsync('tools-set-fps');
        expect(actions.lowerQuality).toHaveBeenCalledTimes(1);
        expect(actions.setFps).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('tools-set-scale')).toBeNull();
    });

});
