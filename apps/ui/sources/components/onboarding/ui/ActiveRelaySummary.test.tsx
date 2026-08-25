import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

describe('ActiveRelaySummary', () => {
    it('distinguishes the active relay from a not-yet-active selection', async () => {
        const { ActiveRelaySummary } = await import('./ActiveRelaySummary');
        const active = await renderScreen(
            <ActiveRelaySummary relayUrl="https://active.example.test" status="active" idPrefix="relay" />,
        );
        expect(active.getTextContent()).toContain('setupOnboarding.activeRelaySummaryTitle');
        expect(active.findByTestId('relay-line')?.props.numberOfLines).toBe(1);

        const selected = await renderScreen(
            <ActiveRelaySummary relayUrl="https://selected.example.test" status="selected" idPrefix="relay" />,
        );
        expect(selected.getTextContent()).toContain('setupOnboarding.selectedRelaySummaryTitle');
    });
});
