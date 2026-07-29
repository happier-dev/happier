import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('SessionSimulatorPreviewPane', () => {
    it('is a thin session wrapper around the simulator product pane', async () => {
        const mod = await import('./SessionSimulatorPreviewPane').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SessionSimulatorPreviewPane');
        if (!('SessionSimulatorPreviewPane' in mod)) return;

        const SessionSimulatorPreviewPane = mod.SessionSimulatorPreviewPane as React.ComponentType<{
            sessionId: string;
            viewModel: unknown;
            actions: Record<string, unknown>;
            testID: string;
        }>;
        const screen = await renderScreen(
            <SessionSimulatorPreviewPane
                sessionId="session_1"
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
                testID="session-simulator"
            />,
        );

        expect(screen.findByTestId('session-simulator')).toBeTruthy();
        expect(screen.findByTestId('session-simulator-preview-picker-empty')).toBeTruthy();
    });
});
