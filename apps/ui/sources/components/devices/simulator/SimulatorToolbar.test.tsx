import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { SimulatorPreviewControls, SimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/types';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const BASE_CONTROLS: SimulatorPreviewControls = {
    canWatch: true,
    canControl: true,
    canRequestKeyframe: false,
    canSetQuality: false,
    canSetFps: false,
    canSetScale: false,
    supportedInputKinds: ['tap', 'hardware_button'],
    hardwareButtons: ['home', 'back', 'recents'],
};

function viewModel(controls: Partial<SimulatorPreviewControls>): SimulatorPreviewViewModel {
    return { controls: { ...BASE_CONTROLS, ...controls } } as SimulatorPreviewViewModel;
}

async function renderRail(controls: Partial<SimulatorPreviewControls>, actions: Record<string, unknown> = {}) {
    const { SimulatorToolbar } = await import('./SimulatorToolbar');
    return renderScreen(<SimulatorToolbar viewModel={viewModel(controls)} actions={actions} testID="rail" />);
}

describe('SimulatorToolbar (device controls rail)', () => {
    it('offers the platform hardware buttons and presses each through its action', async () => {
        const actions = { pressHome: vi.fn(), pressBack: vi.fn(), pressRecent: vi.fn() };
        const screen = await renderRail({}, actions);

        await screen.pressByTestIdAsync('rail-button-home');
        await screen.pressByTestIdAsync('rail-button-back');
        await screen.pressByTestIdAsync('rail-button-recent');
        expect(actions.pressHome).toHaveBeenCalledTimes(1);
        expect(actions.pressBack).toHaveBeenCalledTimes(1);
        expect(actions.pressRecent).toHaveBeenCalledTimes(1);
    });

    it('shows only the buttons the producer advertises', async () => {
        const screen = await renderRail({ hardwareButtons: ['home'] });

        expect(screen.findByTestId('rail-button-home')).toBeTruthy();
        expect(screen.findByTestId('rail-button-back')).toBeNull();
        expect(screen.findByTestId('rail-button-recent')).toBeNull();
    });

    it('keeps input buttons in place but inert until the viewer holds control', async () => {
        const actions = { pressHome: vi.fn() };
        const screen = await renderRail({ canControl: false }, actions);

        expect(screen.findByTestId('rail-button-home')).toBeTruthy();
        await screen.pressByTestIdAsync('rail-button-home');
        expect(actions.pressHome).not.toHaveBeenCalled();
    });

    it('refreshes the frame through the backed keyframe action and hides it when unbacked', async () => {
        const actions = { requestKeyframe: vi.fn() };
        const backed = await renderRail({ canRequestKeyframe: true }, actions);
        await backed.pressByTestIdAsync('rail-request-keyframe');
        expect(actions.requestKeyframe).toHaveBeenCalledTimes(1);

        const unbacked = await renderRail({});
        expect(unbacked.findByTestId('rail-request-keyframe')).toBeNull();
    });

    it('renders nothing when the device offers no rail actions', async () => {
        const screen = await renderRail({ hardwareButtons: [], supportedInputKinds: ['tap'] });
        expect(screen.findAll((node) => typeof node.type === 'string' && node.props?.testID === 'rail')).toEqual([]);
    });
});
