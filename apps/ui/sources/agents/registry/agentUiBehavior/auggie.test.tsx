import * as React from 'react';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Pressable', props, props.children),
    });
});

vi.mock('@expo/vector-icons', () => ({
    Octicons: (props: Record<string, unknown>) => React.createElement('Octicons', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('createAuggieAllowIndexingChip', () => {
    it('adds button accessibility metadata when the label is hidden', async () => {
        const nodeRequire = createRequire(import.meta.url);
        const Module = nodeRequire('node:module') as {
            _load: (request: string, parent: unknown, isMain: boolean) => unknown;
        };
        const originalLoad = Module._load;

        Module._load = ((request: string, parent: unknown, isMain: boolean) => {
            if (request === '@/components/ui/text/Text') {
                return {
                    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                        React.createElement('Text', props, props.children),
                };
            }
            return originalLoad.call(Module, request, parent, isMain);
        }) as typeof Module._load;

        try {
            const { createAuggieAllowIndexingChip } = await import('./auggie');

            const chip = createAuggieAllowIndexingChip({
                allowIndexing: true,
                setAllowIndexing: vi.fn(),
            });

            const screen = await renderScreen(
                <>
                    {chip.render({
                        chipStyle: () => ({}),
                        showLabel: false,
                        iconColor: '#000',
                        textStyle: {},
                        countTextStyle: {},
                        popoverAnchorRef: { current: null },
                    })}
                </>,
            );

            const pressable = screen.tree.root.findByType('Pressable');
            expect(pressable.props.accessibilityRole).toBe('button');
            expect(pressable.props.accessibilityLabel).toBe('agentInput.auggieIndexingChip.on');
        } finally {
            Module._load = originalLoad;
        }
    });
});
