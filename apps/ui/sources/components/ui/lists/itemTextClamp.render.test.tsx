import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

/**
 * F-2 (2026-08-11). `itemTextClamp` is the single owner of `Item`'s title/subtitle clamps precisely
 * so a consumer that reasons about the painted height — `resolvePluginTranscriptActivityHeightBearingPaint`,
 * which feeds the transcript row's Legend size version — never hand-copies them. That ownership is
 * only worth anything while the rule and the RENDER agree, so this asserts the rule's output against
 * the `numberOfLines` the real `Item` actually paints, for each branch of both clamps.
 *
 * A change to `Item`'s JSX that bypasses the rule fails here; a change to the rule that `Item` does
 * not paint fails here too.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            ActivityIndicator: 'ActivityIndicator',
            AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
            Platform: {
                OS: 'web',
                select: (values: Record<string, unknown>) => values?.default ?? values?.web,
            },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => {}) }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: React.createContext(null),
}));
vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    useItemGroupRowPosition: () => 'middle',
}));
vi.mock('@/components/ui/lists/itemGroupRowCorners', () => ({
    getItemGroupRowCornerRadii: () => ({}),
}));

async function paintedLines(
    element: React.ReactElement,
    text: string,
): Promise<number | null> {
    const screen = await renderScreen(element);
    const node = screen.tree
        .findAllByType('Text' as never)
        .find((candidate: { props: Record<string, unknown> }) => candidate.props.children === text);
    if (!node) throw new Error(`Expected the Item to paint "${text}".`);
    const painted = (node.props as { numberOfLines?: number }).numberOfLines;
    return painted === undefined ? null : painted;
}

describe('itemTextClamp is the clamp Item actually paints', () => {
    it('paints the title clamp the rule reports, with and without a subtitle', async () => {
        const { Item } = await import('./Item');
        const { resolveItemTitleMaxLines } = await import('./itemTextClamp');

        expect(await paintedLines(<Item title="Title" showChevron={false} />, 'Title'))
            .toBe(resolveItemTitleMaxLines(false));
        expect(await paintedLines(<Item title="Title" subtitle="Detail" showChevron={false} />, 'Title'))
            .toBe(resolveItemTitleMaxLines(true));
    });

    it('paints the subtitle clamp the rule reports for each of its branches', async () => {
        const { Item } = await import('./Item');
        const { resolveItemSubtitleMaxLines } = await import('./itemTextClamp');

        const flat = 'One line of detail';
        expect(await paintedLines(<Item title="Title" subtitle={flat} showChevron={false} />, flat))
            .toBe(resolveItemSubtitleMaxLines({ text: flat, subtitleLines: undefined }));

        const broken = 'First line\nsecond line';
        expect(await paintedLines(<Item title="Title" subtitle={broken} showChevron={false} />, broken))
            .toBe(resolveItemSubtitleMaxLines({ text: broken, subtitleLines: undefined }));

        expect(await paintedLines(
            <Item title="Title" subtitle={flat} subtitleLines={3} showChevron={false} />,
            flat,
        )).toBe(resolveItemSubtitleMaxLines({ text: flat, subtitleLines: 3 }));

        expect(await paintedLines(
            <Item title="Title" subtitle={flat} subtitleLines={0} showChevron={false} />,
            flat,
        )).toBe(resolveItemSubtitleMaxLines({ text: flat, subtitleLines: 0 }));
    });
});
