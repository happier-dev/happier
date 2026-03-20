import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { SegmentedTab } from './SegmentedTabBar';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        View: 'View',
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    };
});

const theme = {
    colors: {
        surface: '#ffffff',
        surfaceHigh: '#F8F8F8',
        divider: '#eaeaea',
        text: '#000000',
        textSecondary: '#666666',
    },
};

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme }),
    StyleSheet: {
        create: (input: any) => (typeof input === 'function' ? input(theme) : input),
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

const TABS: ReadonlyArray<SegmentedTab<'alpha' | 'beta' | 'gamma'>> = [
    { id: 'alpha', label: 'Alpha' },
    { id: 'beta', label: 'Beta' },
    { id: 'gamma', label: 'Gamma' },
];

describe('SegmentedTabBar', () => {
    it('renders all tab labels', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} />,
            );
        });

        const textNodes = tree.root.findAllByType('Text' as any);
        const labels = textNodes.map((node) => node.props.children);
        expect(labels).toEqual(['Alpha', 'Beta', 'Gamma']);
    });

    it('calls onSelectTab with the tab id when a tab is pressed', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const onSelectTab = vi.fn();

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={onSelectTab} />,
            );
        });

        const pressables = tree.root.findAllByType('Pressable' as any);
        expect(pressables).toHaveLength(3);

        // Press the second tab ("beta").
        pressables[1].props.onPress();
        expect(onSelectTab).toHaveBeenCalledTimes(1);
        expect(onSelectTab).toHaveBeenCalledWith('beta');

        // Press the third tab ("gamma").
        pressables[2].props.onPress();
        expect(onSelectTab).toHaveBeenCalledTimes(2);
        expect(onSelectTab).toHaveBeenCalledWith('gamma');
    });

    it('sets testIDs when testIDPrefix is provided', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SegmentedTabBar
                    tabs={TABS}
                    activeTabId="alpha"
                    onSelectTab={() => {}}
                    testIDPrefix="seg"
                />,
            );
        });

        const pressables = tree.root.findAllByType('Pressable' as any);
        expect(pressables[0].props.testID).toBe('seg:alpha');
        expect(pressables[1].props.testID).toBe('seg:beta');
        expect(pressables[2].props.testID).toBe('seg:gamma');
    });

    it('does not set testIDs when testIDPrefix is omitted', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} />,
            );
        });

        const pressables = tree.root.findAllByType('Pressable' as any);
        for (const pressable of pressables) {
            expect(pressable.props.testID).toBeUndefined();
        }
    });

    it('applies active styles only to the active tab', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SegmentedTabBar tabs={TABS} activeTabId="beta" onSelectTab={() => {}} />,
            );
        });

        const pressables = tree.root.findAllByType('Pressable' as any);

        // The active tab ("beta") should include the tabActive background color.
        const activeStyle = pressables[1].props.style;
        const activeFlat = Array.isArray(activeStyle)
            ? activeStyle.reduce(
                  (acc: Record<string, unknown>, s: Record<string, unknown> | null) => ({
                      ...acc,
                      ...(s ?? {}),
                  }),
                  {},
              )
            : activeStyle;
        expect(activeFlat.backgroundColor).toBe(theme.colors.surface);

        // Inactive tabs should NOT have the active background color.
        for (const idx of [0, 2]) {
            const inactiveStyle = pressables[idx].props.style;
            const inactiveFlat = Array.isArray(inactiveStyle)
                ? inactiveStyle.reduce(
                      (acc: Record<string, unknown>, s: Record<string, unknown> | null) => ({
                          ...acc,
                          ...(s ?? {}),
                      }),
                      {},
                  )
                : inactiveStyle;
            expect(inactiveFlat.backgroundColor).not.toBe(theme.colors.surface);
        }

        // The active tab's label should use the active text color.
        const textNodes = tree.root.findAllByType('Text' as any);
        const activeLabelStyle = textNodes[1].props.style;
        const activeLabelFlat = Array.isArray(activeLabelStyle)
            ? activeLabelStyle.reduce(
                  (acc: Record<string, unknown>, s: Record<string, unknown> | null) => ({
                      ...acc,
                      ...(s ?? {}),
                  }),
                  {},
              )
            : activeLabelStyle;
        expect(activeLabelFlat.color).toBe(theme.colors.text);

        // Inactive labels should use the secondary text color.
        for (const idx of [0, 2]) {
            const inactiveLabelStyle = textNodes[idx].props.style;
            const inactiveLabelFlat = Array.isArray(inactiveLabelStyle)
                ? inactiveLabelStyle.reduce(
                      (acc: Record<string, unknown>, s: Record<string, unknown> | null) => ({
                          ...acc,
                          ...(s ?? {}),
                      }),
                      {},
                  )
                : inactiveLabelStyle;
            expect(inactiveLabelFlat.color).toBe(theme.colors.textSecondary);
        }
    });
});
