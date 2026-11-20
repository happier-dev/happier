import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

describe('ActiveRelaySummary', () => {
    it('presents the complete accessible address while allowing its middle to give way', async () => {
        const { HomeContextLine } = await import('./ActiveRelaySummary');
        const address = 'https://long-hostname.example.test:8443';
        const screen = await renderScreen(<HomeContextLine
            address={address} testID="home-context" lineTestID="home-address"
        />);
        expect(screen.findByTestId('home-context')?.props.accessibilityLabel).toBe(address);
        expect(screen.findByTestId('home-address')?.props).toMatchObject({ numberOfLines: 1, ellipsizeMode: 'middle' });
    });

    it('distinguishes the active relay from a not-yet-active selection', async () => {
        const { ActiveRelaySummary } = await import('./ActiveRelaySummary');
        const active = await renderScreen(
            <ActiveRelaySummary relayUrl="http://happier-agent-qa-config-surfaces-c.localhost:3014" status="active" idPrefix="relay" />,
        );
        expect(active.getTextContent()).toContain('setupOnboarding.activeRelaySummaryTitle');
        // A Home with no name is titled "this Home"; its address is never offered as its name.
        expect(active.findByTestId('relay-line')?.props.numberOfLines).toBeUndefined();
        expect(active.findByTestId('relay-line')?.props.ellipsizeMode).toBeUndefined();
        expect(active.getTextContent()).toContain('settingsAccount.thisHomeTitle');
        expect(active.getTextContent()).not.toContain('happier-agent-qa-config-surfaces-c.localhost');

        const selected = await renderScreen(
            <ActiveRelaySummary relayUrl="https://selected.example.test" status="selected" idPrefix="relay" />,
        );
        expect(selected.getTextContent()).toContain('setupOnboarding.selectedRelaySummaryTitle');
    });
});
