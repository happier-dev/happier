import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('SimulatorSidebandPanel', () => {
    it('keeps diagnostics closed by default and renders structured data after opt-in', async () => {
        const mod = await import('./SimulatorSidebandPanel').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorSidebandPanel');
        if (!('SimulatorSidebandPanel' in mod)) return;

        const SimulatorSidebandPanel = mod.SimulatorSidebandPanel as React.ComponentType<{
            sidebands: Record<string, unknown>;
            diagnostics: readonly unknown[];
            onRequestSideband: (kind: string) => void;
            testID: string;
        }>;
        const screen = await renderScreen(
            <SimulatorSidebandPanel
                sidebands={{
                    capture_health: {
                        v: 1,
                        simulatorId: 'sim_1',
                        emittedAtMs: 1_400,
                        kind: 'capture_health',
                        status: 'degraded',
                        reasonCode: 'slow_consumer',
                    },
                    accessibility_tree: {
                        v: 1,
                        simulatorId: 'sim_1',
                        emittedAtMs: 1_100,
                        kind: 'accessibility_tree',
                        tree: { role: 'root' },
                    },
                }}
                diagnostics={[{ severity: 'warning', reasonCode: 'slow_consumer' }]}
                onRequestSideband={vi.fn()}
                testID="simulator-sidebands"
            />,
        );

        expect(screen.findByTestId('simulator-sidebands-drawer')).toBeNull();
        expect(screen.getTextContent()).not.toContain('{"role":"root"}');
        expect(screen.getTextContent()).not.toContain('slow_consumer');

        await screen.pressByTestIdAsync('simulator-sidebands-open');

        expect(screen.findByTestId('simulator-sidebands-drawer')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('{"role":"root"}');
        expect(screen.getTextContent()).toContain('role');
        expect(screen.getTextContent()).toContain('root');
    });

    it('renders and refreshes only producer-backed sidebands', async () => {
        const mod = await import('./SimulatorSidebandPanel').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorSidebandPanel');
        if (!('SimulatorSidebandPanel' in mod)) return;

        const SimulatorSidebandPanel = mod.SimulatorSidebandPanel as React.ComponentType<{
            sidebands: Record<string, unknown>;
            diagnostics: readonly unknown[];
            onRequestSideband: (kind: string) => void;
            testID: string;
        }>;
        const onRequestSideband = vi.fn();
        const screen = await renderScreen(
            <SimulatorSidebandPanel
                sidebands={{
                    logs: {
                        v: 1,
                        simulatorId: 'sim_1',
                        emittedAtMs: 1_000,
                        kind: 'logs',
                        level: 'info',
                        message: 'booted',
                    },
                    accessibility_tree: {
                        v: 1,
                        simulatorId: 'sim_1',
                        emittedAtMs: 1_100,
                        kind: 'accessibility_tree',
                        tree: { role: 'root' },
                    },
                    app_metadata: {
                        v: 1,
                        simulatorId: 'sim_1',
                        emittedAtMs: 1_200,
                        kind: 'app_metadata',
                        metadata: { bundleId: 'com.example.app' },
                    },
                    device_config: {
                        v: 1,
                        simulatorId: 'sim_1',
                        emittedAtMs: 1_300,
                        kind: 'device_config',
                        config: { locale: 'en-US' },
                    },
                    capture_health: {
                        v: 1,
                        simulatorId: 'sim_1',
                        emittedAtMs: 1_400,
                        kind: 'capture_health',
                        status: 'degraded',
                        reasonCode: 'slow_consumer',
                    },
                    network_diagnostics: {
                        v: 1,
                        simulatorId: 'sim_1',
                        emittedAtMs: 1_500,
                        kind: 'network_diagnostics',
                        diagnostics: { ws: 'connected' },
                    },
                    route: {
                        v: 1,
                        simulatorId: 'sim_1',
                        emittedAtMs: 1_600,
                        kind: 'route',
                        route: 'Home',
                    },
                }}
                diagnostics={[{ severity: 'warning', reasonCode: 'slow_consumer' }]}
                onRequestSideband={onRequestSideband}
                testID="simulator-sidebands"
            />,
        );

        await screen.pressByTestIdAsync('simulator-sidebands-open');

        expect(screen.findByTestId('simulator-sidebands-capture_health')).toBeTruthy();
        expect(screen.findByTestId('simulator-sidebands-logs')).toBeTruthy();
        expect(screen.findByTestId('simulator-sidebands-accessibility_tree')).toBeTruthy();
        expect(screen.findByTestId('simulator-sidebands-app_metadata')).toBeTruthy();
        expect(screen.findByTestId('simulator-sidebands-device_config')).toBeTruthy();
        expect(screen.findByTestId('simulator-sidebands-network_diagnostics')).toBeTruthy();
        expect(screen.findByTestId('simulator-sidebands-route')).toBeTruthy();
        expect(screen.findByTestId('simulator-sidebands-diagnostic:slow_consumer')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('slow_consumer');
        expect(screen.getTextContent()).toContain('simulatorPreview.availability.degraded');
        expect(screen.getTextContent()).toContain('simulatorPreview.availability.unavailableGeneric');

        screen.pressByTestId('simulator-sidebands-refresh:capture_health');
        expect(onRequestSideband).toHaveBeenCalledTimes(1);
        expect(onRequestSideband).toHaveBeenCalledWith('capture_health');
    });
});
