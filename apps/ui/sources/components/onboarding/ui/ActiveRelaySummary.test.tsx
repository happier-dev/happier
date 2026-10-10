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
            <ActiveRelaySummary relayUrl="http://happier-agent-qa-config-surfaces-c.localhost:3014" status="active" idPrefix="relay" />,
        );
        expect(active.getTextContent()).toContain('setupOnboarding.activeRelaySummaryTitle');
        // The exact destination stays readable even when a Home address exceeds a phone row.
        expect(active.findByTestId('relay-line')?.props.numberOfLines).toBeUndefined();
        expect(active.findByTestId('relay-line')?.props.ellipsizeMode).toBeUndefined();
        expect(active.getTextContent()).toContain('http://happier-agent-qa-config-surfaces-c.localhost:3014');

        const selected = await renderScreen(
            <ActiveRelaySummary relayUrl="https://selected.example.test" status="selected" idPrefix="relay" />,
        );
        expect(selected.getTextContent()).toContain('setupOnboarding.selectedRelaySummaryTitle');
    });
});
