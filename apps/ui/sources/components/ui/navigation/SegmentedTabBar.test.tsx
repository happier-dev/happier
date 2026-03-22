import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { SegmentedTab } from './SegmentedTabBar';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            View: 'View',
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        }
    );
});

const theme = {
    colors: {
        surface: '#ffffff',
        surfaceHigh: '#F8F8F8',
        text: '#000000',
        textSecondary: '#49454F',
    },
};

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

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

type RenderedScreen = Awaited<ReturnType<typeof renderScreen>>;

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!Array.isArray(style)) {
        return (style ?? {}) as Record<string, unknown>;
    }

    return style.reduce<Record<string, unknown>>((acc, entry) => ({
        ...acc,
        ...(entry ?? {}),
    }), {});
}

function requireTab(screen: RenderedScreen, testID: string) {
    const tab = screen.findByTestId(testID);
    expect(tab).toBeTruthy();
    return tab!;
}

describe('SegmentedTabBar', () => {
    it('renders all tab labels', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="seg" />,
        );

        expect(requireTab(screen, 'seg:alpha').findByType('Text' as never).props.children).toBe('Alpha');
        expect(requireTab(screen, 'seg:beta').findByType('Text' as never).props.children).toBe('Beta');
        expect(requireTab(screen, 'seg:gamma').findByType('Text' as never).props.children).toBe('Gamma');
    });

    it('calls onSelectTab with the tab id when a tab is pressed', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const onSelectTab = vi.fn();

        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={onSelectTab} testIDPrefix="seg" />,
        );

        screen.pressByTestId('seg:beta');
        expect(onSelectTab).toHaveBeenCalledTimes(1);
        expect(onSelectTab).toHaveBeenCalledWith('beta');

        screen.pressByTestId('seg:gamma');
        expect(onSelectTab).toHaveBeenCalledTimes(2);
        expect(onSelectTab).toHaveBeenCalledWith('gamma');
    });

    it('sets testIDs when testIDPrefix is provided', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="seg" />,
        );

        expect(screen.findByTestId('seg:alpha')?.props.testID).toBe('seg:alpha');
        expect(screen.findByTestId('seg:beta')?.props.testID).toBe('seg:beta');
        expect(screen.findByTestId('seg:gamma')?.props.testID).toBe('seg:gamma');
    });

    it('does not set testIDs when testIDPrefix is omitted', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(<SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} />);

        const pressables = screen.findAllByType('Pressable' as never);
        for (const pressable of pressables) {
            expect(pressable.props.testID).toBeUndefined();
        }
    });

    it('applies active styles only to the active tab', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="beta" onSelectTab={() => {}} testIDPrefix="seg" />,
        );

        // The active tab ("beta") should include the tabActive background color.
        const activeFlat = flattenStyle(screen.findByTestId('seg:beta')?.props.style);
        expect(activeFlat.backgroundColor).toBe(theme.colors.surface);

        // Inactive tabs should NOT have the active background color.
        for (const testID of ['seg:alpha', 'seg:gamma'] as const) {
            expect(flattenStyle(screen.findByTestId(testID)?.props.style).backgroundColor).not.toBe(theme.colors.surface);
        }

        // The active tab's label should use the active text color.
        const activeLabelFlat = flattenStyle(screen.findByTestId('seg:beta')?.findByType('Text' as never).props.style);
        expect(activeLabelFlat.color).toBe(theme.colors.text);
        expect(activeLabelFlat.fontWeight).toBe('600');

        // Inactive labels should use the secondary text color.
        for (const testID of ['seg:alpha', 'seg:gamma'] as const) {
            expect(flattenStyle(screen.findByTestId(testID)?.findByType('Text' as never).props.style).color).toBe(
                theme.colors.textSecondary,
            );
        }
    });
});
