import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('SimulatorDevicePicker', () => {
    it('renders explicit empty, degraded, and unavailable device states', async () => {
        const mod = await import('./SimulatorDevicePicker').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorDevicePicker');
        if (!('SimulatorDevicePicker' in mod)) return;

        const SimulatorDevicePicker = mod.SimulatorDevicePicker as React.ComponentType<{
            devices: readonly unknown[];
            selectedSimulatorId: string | null;
            onSelectDevice: (simulatorId: string) => void;
            testID: string;
        }>;
        const onSelectDevice = vi.fn();

        const empty = await renderScreen(
            <SimulatorDevicePicker
                devices={[]}
                selectedSimulatorId={null}
                onSelectDevice={onSelectDevice}
                testID="simulator-picker"
            />,
        );
        expect(empty.findByTestId('simulator-picker-empty')).toBeTruthy();

        const screen = await renderScreen(
            <SimulatorDevicePicker
                devices={[
                    {
                        simulatorId: 'sim_1',
                        label: 'iPhone 16',
                        platformLabel: 'ios',
                        selected: true,
                        availability: { state: 'degraded', reasonCode: 'slow_consumer' },
                    },
                    {
                        simulatorId: 'sim_2',
                        label: 'Pixel 9',
                        platformLabel: 'android',
                        selected: false,
                        availability: { state: 'unavailable', reasonCode: 'android_emulator_missing' },
                    },
                ]}
                selectedSimulatorId="sim_1"
                onSelectDevice={onSelectDevice}
                testID="simulator-picker"
            />,
        );

        expect(screen.findByTestId('simulator-picker-device:sim_1-degraded')).toBeTruthy();
        expect(screen.findByTestId('simulator-picker-device:sim_2-unavailable')).toBeTruthy();

        screen.pressByTestId('simulator-picker-device:sim_2');
        expect(onSelectDevice).toHaveBeenCalledWith('sim_2');
    });
});
