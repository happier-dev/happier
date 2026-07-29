import React from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { lightTheme } from '@/theme';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const dimensionsRef = vi.hoisted(() => ({ width: 1000, height: 800 }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: dimensionsRef.width, height: dimensionsRef.height }),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>(
            (accumulator, entry) => Object.assign(accumulator, flattenStyle(entry)),
            {},
        );
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

describe('ItemSection', () => {
    it('renders the caption as an uppercase eyebrow', async () => {
        dimensionsRef.width = 1000;
        dimensionsRef.height = 800;
        const { ItemSection } = await import('./ItemSection');
        const { ItemGroupColumn } = await import('./ItemGroupColumns');
        const { Text } = await import('@/components/ui/text/Text');

        const screen = await renderScreen(
            <ItemSection testID="usage" caption="Usage">
                <ItemGroupColumn>
                    <Text testID="cell">Body</Text>
                </ItemGroupColumn>
            </ItemSection>,
        );

        expect(screen.getTextContent()).toContain('Usage');
    });

    it('lays cells out in 2 columns at/above the medium viewport', async () => {
        dimensionsRef.width = 1000;
        dimensionsRef.height = 800;
        const { ItemSection } = await import('./ItemSection');
        const { ItemGroupColumn } = await import('./ItemGroupColumns');

        const screen = await renderScreen(
            <ItemSection testID="usage" caption="Usage" columns={2} collapseBelow="medium">
                <ItemGroupColumn>
                    <View testID="cell-1" />
                </ItemGroupColumn>
                <ItemGroupColumn>
                    <View testID="cell-2" />
                </ItemGroupColumn>
            </ItemSection>,
        );

        const columnStyle = flattenStyle(screen.findByTestId('cell-1')?.parent?.props.style);
        // Two active columns -> flexible (not full-width) cells.
        expect(columnStyle.width).not.toBe('100%');
        expect(columnStyle.flexBasis).toBe(0);
    });

    it('collapses to a single column below the medium viewport', async () => {
        dimensionsRef.width = 480;
        dimensionsRef.height = 900;
        const { ItemSection } = await import('./ItemSection');
        const { ItemGroupColumn } = await import('./ItemGroupColumns');

        const screen = await renderScreen(
            <ItemSection testID="usage" caption="Usage" columns={2} collapseBelow="medium">
                <ItemGroupColumn>
                    <View testID="cell-1" />
                </ItemGroupColumn>
                <ItemGroupColumn>
                    <View testID="cell-2" />
                </ItemGroupColumn>
            </ItemSection>,
        );

        const columnStyle = flattenStyle(screen.findByTestId('cell-1')?.parent?.props.style);
        expect(columnStyle.width).toBe('100%');
    });

    it('applies a barely-there section tint by default and stays plain when tone="plain"', async () => {
        dimensionsRef.width = 1000;
        dimensionsRef.height = 800;
        const { ItemSection } = await import('./ItemSection');
        const { ItemGroupColumn } = await import('./ItemGroupColumns');
        const { Text } = await import('@/components/ui/text/Text');

        const tinted = await renderScreen(
            <ItemSection testID="tinted" caption="Usage">
                <ItemGroupColumn>
                    <Text testID="cell">A</Text>
                </ItemGroupColumn>
            </ItemSection>,
        );
        expect(flattenStyle(tinted.findByTestId('tinted')?.props.style).backgroundColor)
            .toBe(lightTheme.colors.surface.sectionTint);
        // The tint must be subtler than the heavier elevated surface and the recessed inset.
        expect(flattenStyle(tinted.findByTestId('tinted')?.props.style).backgroundColor)
            .not.toBe(lightTheme.colors.surface.elevated);
        expect(flattenStyle(tinted.findByTestId('tinted')?.props.style).backgroundColor)
            .not.toBe(lightTheme.colors.surface.inset);

        const plain = await renderScreen(
            <ItemSection testID="plain" caption="Usage" tone="plain">
                <ItemGroupColumn>
                    <Text testID="cell">A</Text>
                </ItemGroupColumn>
            </ItemSection>,
        );
        expect(flattenStyle(plain.findByTestId('plain')?.props.style).backgroundColor)
            .not.toBe(lightTheme.colors.surface.sectionTint);
    });
});
