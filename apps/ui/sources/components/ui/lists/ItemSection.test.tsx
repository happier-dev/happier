import React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
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

type Screen = Awaited<ReturnType<typeof renderScreen>>;

/** Reports the width the section's grid actually got, the way a real layout would. */
async function measureSection(screen: Screen, widthPx: number): Promise<void> {
    const hosts = screen.root.findAll((node) => (
        typeof node.type === 'string' && typeof node.props.onLayout === 'function'
    ), { deep: true });
    if (hosts.length !== 1) {
        throw new Error(`expected exactly one measuring host, found ${hosts.length}`);
    }
    await act(async () => {
        (hosts[0]!.props.onLayout as (event: unknown) => void)({
            nativeEvent: { layout: { x: 0, y: 0, width: widthPx, height: 200 } },
        });
    });
}

async function renderTwoCellSection(props: Record<string, unknown> = {}) {
    const { ItemSection } = await import('./ItemSection');
    const { ItemGroupColumn } = await import('./ItemGroupColumns');
    return await renderScreen(
        <ItemSection testID="usage" caption="Usage" columns={2} {...props}>
            <ItemGroupColumn>
                <View testID="cell-1" />
            </ItemGroupColumn>
            <ItemGroupColumn>
                <View testID="cell-2" />
            </ItemGroupColumn>
        </ItemSection>,
    );
}

function readCellIsFullWidth(screen: Screen): boolean {
    return flattenStyle(screen.findByTestId('cell-1')?.parent?.props.style).width === '100%';
}

describe('ItemSection', () => {
    it('renders the caption as an uppercase eyebrow', async () => {
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

    it('lays cells out in 2 columns once the section itself is wide enough', async () => {
        // A hostile window: narrow, while the section has plenty of room.
        dimensionsRef.width = 360;
        dimensionsRef.height = 640;
        const screen = await renderTwoCellSection();

        // Two 240px cells plus the 12px gutter need 492px between the grid's
        // 16px paddings, so a 524px box is the first that fits them.
        await measureSection(screen, 524);

        expect(readCellIsFullWidth(screen)).toBe(false);
    });

    it('collapses a narrow section to one column inside a wide window', async () => {
        // The defect this owns: a viewport-class rule would deal a 500px section
        // inside a 1600px desktop window two ~230px columns.
        dimensionsRef.width = 1600;
        dimensionsRef.height = 1200;
        const screen = await renderTwoCellSection();

        await measureSection(screen, 460);

        expect(readCellIsFullWidth(screen)).toBe(true);
    });

    it('stays at one column until the section has actually been measured', async () => {
        dimensionsRef.width = 1600;
        dimensionsRef.height = 1200;
        const screen = await renderTwoCellSection();

        expect(readCellIsFullWidth(screen)).toBe(true);
    });

    it('lets a section raise its own cell floor', async () => {
        dimensionsRef.width = 1600;
        dimensionsRef.height = 1200;
        const screen = await renderTwoCellSection({ minColumnWidthPx: 320 });

        // 524px cleared the default 240px floor; two 320px cells need 684px.
        await measureSection(screen, 524);

        expect(readCellIsFullWidth(screen)).toBe(true);
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
