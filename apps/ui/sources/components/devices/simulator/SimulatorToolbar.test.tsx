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
    canControl: false,
    canRequestKeyframe: false,
    canSetQuality: false,
    canSetFps: false,
    canSetScale: false,
    supportedInputKinds: ['tap'],
    hardwareButtons: ['home', 'back', 'recents'],
    deviceOperations: ['hardware', 'screenshot'],
};

function viewModel(controls: Partial<SimulatorPreviewControls>): SimulatorPreviewViewModel {
    return { selectedSimulatorId: 'sim_1', controls: { ...BASE_CONTROLS, ...controls } } as SimulatorPreviewViewModel;
}

async function renderRail(
    controls: Partial<SimulatorPreviewControls>,
    options: Readonly<{ actions?: Record<string, unknown>; sessionId?: string; run?: ReturnType<typeof vi.fn> }> = {},
) {
    const { SimulatorToolbar } = await import('./SimulatorToolbar');
    const run = options.run ?? vi.fn(async () => ({ ok: true }));
    const screen = await renderScreen(
        <SimulatorToolbar
            viewModel={viewModel(controls)}
            actions={options.actions ?? {}}
            operations={{ pending: null, run }}
            sessionId={options.sessionId}
            testID="rail"
        />,
    );
    return { screen, run };
}

describe('SimulatorToolbar (device controls rail)', () => {
    it('presses the advertised hardware buttons through the hardware device operation, without needing input control', async () => {
        const { screen, run } = await renderRail({});

        await screen.pressByTestIdAsync('rail-button-home');
        await screen.pressByTestIdAsync('rail-button-recent');
        expect(run).toHaveBeenCalledWith('hardware:home', 'sim_1', { operation: 'hardware', button: 'home' });
        expect(run).toHaveBeenCalledWith('hardware:recents', 'sim_1', { operation: 'hardware', button: 'recents' });
    });

    it('shows only the buttons the producer advertises', async () => {
        const { screen } = await renderRail({ hardwareButtons: ['home'] });

        expect(screen.findByTestId('rail-button-home')).toBeTruthy();
        expect(screen.findByTestId('rail-button-back')).toBeNull();
        expect(screen.findByTestId('rail-button-recent')).toBeNull();
    });

    it('offers a screenshot only when the device takes it and there is a Session to land in', async () => {
        const withSession = await renderRail({}, { sessionId: 'session_1' });
        await withSession.screen.pressByTestIdAsync('rail-screenshot');
        expect(withSession.run).toHaveBeenCalledWith('screenshot', 'sim_1', { operation: 'screenshot', sessionId: 'session_1' });

        expect((await renderRail({})).screen.findByTestId('rail-screenshot')).toBeNull();
        expect((await renderRail({ deviceOperations: ['hardware'] }, { sessionId: 'session_1' })).screen.findByTestId('rail-screenshot')).toBeNull();
    });

    it('refreshes the frame through the backed keyframe action and hides it when unbacked', async () => {
        const actions = { requestKeyframe: vi.fn() };
        const backed = await renderRail({ canRequestKeyframe: true }, { actions });
        await backed.screen.pressByTestIdAsync('rail-request-keyframe');
        expect(actions.requestKeyframe).toHaveBeenCalledTimes(1);

        expect((await renderRail({})).screen.findByTestId('rail-request-keyframe')).toBeNull();
    });

    it('renders nothing when the device offers no rail actions', async () => {
        const { screen } = await renderRail({ hardwareButtons: [], deviceOperations: [] });
        expect(screen.findAll((node) => typeof node.type === 'string' && node.props?.testID === 'rail')).toEqual([]);
    });
});
