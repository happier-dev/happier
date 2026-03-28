import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '@/components/sessions/agentInput/agentInputTestHelpers';

installAgentInputCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    icons: async () => ({
        Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
    }),
});

describe('createPathActionChip', () => {
    it('always renders a visible text label for the selected or empty path', async () => {
        const { createPathActionChip } = await import('./createPathActionChip');

        const chip = createPathActionChip({
            anchorRef: { current: null },
            currentPath: '/Users/leeroy/Development/happier/dev',
            tint: '#000',
            showLabel: false,
            chipStyle: () => ({}),
            textStyle: {},
            onPress: () => {},
        });

        const screen = await renderScreen(<>{chip}</>);
        const pathChip = screen.findByTestId('agent-input-path-chip');
        if (!pathChip) {
            throw new Error('Expected path chip to render');
        }

        const textValues = pathChip
            .findAll((node: { type?: unknown }) => node?.type === 'Text')
            .map((node) => (node.props as { children?: unknown })?.children);

        expect(textValues).toEqual(
            expect.arrayContaining(['/Users/leeroy/Development/happier/dev']),
        );
    });

    it('falls back to the select-path label when no path is selected', async () => {
        const { createPathActionChip } = await import('./createPathActionChip');

        const chip = createPathActionChip({
            anchorRef: { current: null },
            currentPath: '',
            tint: '#000',
            showLabel: false,
            chipStyle: () => ({}),
            textStyle: {},
            onPress: () => {},
        });

        const screen = await renderScreen(<>{chip}</>);
        const pathChip = screen.findByTestId('agent-input-path-chip');
        if (!pathChip) {
            throw new Error('Expected path chip to render');
        }

        const textValues = pathChip
            .findAll((node: { type?: unknown }) => node?.type === 'Text')
            .map((node) => (node.props as { children?: unknown })?.children);

        expect(textValues).toEqual(
            expect.arrayContaining(['newSession.selectPathTitle']),
        );
    });
});
