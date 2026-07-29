import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

// Mirror the production `t(...)` interpolation shape so a raw reason code would
// surface as `key:reasonCode` if the component ever interpolated it again.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => {
            if (params && typeof params === 'object' && 'reasonCode' in params) {
                return `${key}:${String((params as { reasonCode: unknown }).reasonCode)}`;
            }
            return key;
        },
    });
});

describe('SimulatorUnavailableState (D-RC4: no internal reason codes in product UI)', () => {
    it('resolves the reason through resolveReasonCopy and never shows the raw code in text', async () => {
        const mod = await import('./SimulatorUnavailableState').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorUnavailableState');
        if (!('SimulatorUnavailableState' in mod)) return;

        const screen = await renderScreen(
            <mod.SimulatorUnavailableState reasonCode="external_url_unavailable" testID="simulator-stream" />,
        );

        const reasonNode = screen.findByTestId('simulator-stream-unavailable-reason');
        expect(reasonNode).toBeTruthy();
        // Unknown codes fall back to the simulator-preview generic copy; the raw
        // code is NOT in the visible text.
        expect(screen.getTextContent()).toContain('simulatorPreview.availability.unavailableGeneric');
        expect(screen.getTextContent()).not.toContain('external_url_unavailable');
        // The raw code remains available for diagnostics only, via the testID channel
        // (never as an accessibility label — XS-4 inversion guard).
        expect(screen.findByTestId('simulator-stream-unavailable-diagnostic-external_url_unavailable')).toBeTruthy();
        const rawLabelled = screen.findAll((node) => node.props?.accessibilityLabel === 'external_url_unavailable');
        expect(rawLabelled).toHaveLength(0);
    });

    it('maps a known availability code to its dedicated remediation copy', async () => {
        const mod = await import('./SimulatorUnavailableState');
        const screen = await renderScreen(
            <mod.SimulatorUnavailableState reasonCode="no_simulator_devices" testID="simulator-stream" />,
        );
        expect(screen.getTextContent()).toContain('simulatorPreview.availability.noDevices');
        expect(screen.getTextContent()).not.toContain('no_simulator_devices');
    });

    it('omits the reason row entirely when no reason code is present', async () => {
        const mod = await import('./SimulatorUnavailableState').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorUnavailableState');
        if (!('SimulatorUnavailableState' in mod)) return;

        const screen = await renderScreen(
            <mod.SimulatorUnavailableState testID="simulator-stream" />,
        );

        expect(screen.findByTestId('simulator-stream-unavailable')).toBeTruthy();
        expect(screen.findByTestId('simulator-stream-unavailable-reason')).toBeNull();
    });
});
