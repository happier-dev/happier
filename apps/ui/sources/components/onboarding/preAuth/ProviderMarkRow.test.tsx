import * as React from 'react';
import { Animated } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));

import { AGENT_IDS } from '@/agents/catalog/catalog';
import { ProviderMarkRow } from './ProviderMarkRow';

// AgentIcon is mocked above to render as a host element with the string type 'AgentIcon'.
// ReactTestInstance#type is typed as `string | ComponentType<any>`, so narrowing to the
// literal string via `typeof === 'string'` keeps the comparison TS-valid (avoids TS2367).
function isAgentIconNode(node: { type: unknown }): boolean {
    return typeof node.type === 'string' && node.type === 'AgentIcon';
}

describe('ProviderMarkRow', () => {
    it('renders one AgentIcon per AGENT_IDS entry with stable testIDs', async () => {
        const screen = await renderScreen(<ProviderMarkRow />);

        const root = screen.findByTestId('provider-mark-row');
        expect(root).toBeTruthy();

        for (const agentId of AGENT_IDS) {
            const cell = screen.findByTestId(`provider-mark-${agentId}`);
            expect(cell).toBeTruthy();
        }
    });

    it('exposes an accessibility label sourced from translations', async () => {
        const screen = await renderScreen(<ProviderMarkRow />);
        const root = screen.findByTestId('provider-mark-row');

        // We use a localized accessibility label; the value comes from the welcome.* key.
        // The translation mock in this test env returns the English string by default.
        expect(typeof root?.props.accessibilityLabel).toBe('string');
        expect((root?.props.accessibilityLabel as string).length).toBeGreaterThan(0);
    });

    it('does not render any Animated.View (no drift / no animation)', async () => {
        const screen = await renderScreen(<ProviderMarkRow />);
        expect(screen.findAllByType(Animated.View).length).toBe(0);
    });

    it('tone="on-dark" tints AgentIcon with a white-ish rgba color', async () => {
        const screen = await renderScreen(<ProviderMarkRow tone="on-dark" />);
        const icons = screen.findAll(isAgentIconNode);
        expect(icons.length).toBe(AGENT_IDS.length);
        for (const icon of icons) {
            const color = String(icon.props.color ?? '');
            expect(color.startsWith('rgba(255')).toBe(true);
        }
    });

    it('tone="on-light" tints AgentIcon with a theme-derived secondary color (non-white)', async () => {
        const screen = await renderScreen(<ProviderMarkRow tone="on-light" />);
        const icons = screen.findAll(isAgentIconNode);
        expect(icons.length).toBe(AGENT_IDS.length);
        for (const icon of icons) {
            const color = String(icon.props.color ?? '');
            // Must not be a white-ish rgba; must be a theme token color (resolved string).
            expect(color.startsWith('rgba(255')).toBe(false);
            expect(color.length).toBeGreaterThan(0);
        }
    });

    it('passes the explicit size prop down to every AgentIcon', async () => {
        const screen = await renderScreen(<ProviderMarkRow size={22} />);
        const icons = screen.findAll(isAgentIconNode);
        expect(icons.length).toBe(AGENT_IDS.length);
        for (const icon of icons) {
            expect(icon.props.size).toBe(22);
        }
    });
});
