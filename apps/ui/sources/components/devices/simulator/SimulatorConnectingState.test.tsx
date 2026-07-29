import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('SimulatorConnectingState', () => {
    it('renders the connecting copy, a status dot, and a skeleton placeholder', async () => {
        const mod = await import('./SimulatorConnectingState').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorConnectingState');
        if (!('SimulatorConnectingState' in mod)) return;

        const screen = await renderScreen(
            <mod.SimulatorConnectingState mode="connecting" testID="simulator-stream" />,
        );

        expect(screen.findByTestId('simulator-stream-connecting')).toBeTruthy();
        expect(screen.findByTestId('simulator-stream-connecting-dot')).toBeTruthy();
        expect(screen.findByTestId('simulator-stream-connecting-skeleton')).toBeTruthy();
        expect(screen.getTextContent()).toContain('simulatorPreview.status.connecting');
    });

    it('renders the restoring copy when re-hydrating an established stream', async () => {
        const mod = await import('./SimulatorConnectingState').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('SimulatorConnectingState');
        if (!('SimulatorConnectingState' in mod)) return;

        const screen = await renderScreen(
            <mod.SimulatorConnectingState mode="restoring" testID="simulator-stream" />,
        );

        expect(screen.getTextContent()).toContain('simulatorPreview.status.restoring');
        expect(screen.getTextContent()).not.toContain('simulatorPreview.status.connecting');
    });
});
