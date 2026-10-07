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
    it('lets page preference labels and consequences grow with their content, including compact density', async () => {
        const { Item } = await import('./Item');
        const { ListPresentationProvider } = await import('./listPresentation');
        const title = 'Automatically include sessions started outside Happier on this machine';
        const detail = 'Only session metadata is discovered. Session contents stay on your machine until you open a session.';
        const page = (text: string) => paintedLines(
            <ListPresentationProvider value="page">
                <Item title={title} subtitle={detail} mode="info" density="compact" />
            </ListPresentationProvider>,
            text,
        );

        // numberOfLines is the native Text boundary's truncation contract; absence lets the
        // complete label and consequence remain visible as text scaling/narrow widths grow them.
        expect(await page(title)).toBeNull();
        expect(await page(detail)).toBeNull();
    });

    it('does not hide page copy when a title has a badge or the description is a primitive fragment', async () => {
        const { Item } = await import('./Item');
        const { ListPresentationProvider } = await import('./listPresentation');
        const { View } = await import('react-native');
        const title = 'Include sessions started outside Happier automatically';
        const detail = 'Discovery reads metadata only and leaves session contents on this computer.';
        const page = (text: string) => paintedLines(
            <ListPresentationProvider value="page">
                <Item title={title} titleAccessory={<View testID="badge" />} subtitle={<>{detail}</>} mode="info" />
            </ListPresentationProvider>,
            text,
        );

        expect(await page(title)).toBeNull();
        expect(await page(detail)).toBeNull();
    });

    it('keeps explicit page line limits and compact grouped rows authoritative', async () => {
        const { Item } = await import('./Item');
        const { ListPresentationProvider } = await import('./listPresentation');
        const { View } = await import('react-native');
        const title = 'A deliberately summarized collection row';
        const detail = 'A detail that its caller deliberately summarizes';

        expect(await paintedLines(
            <ListPresentationProvider value="page">
                <Item title={title} titleAccessory={<View testID="badge" />} subtitle={detail} titleLines={2} subtitleLines={3} />
            </ListPresentationProvider>, title,
        )).toBe(2);
        expect(await paintedLines(
            <ListPresentationProvider value="page">
                <Item title={title} subtitle={detail} titleLines={2} subtitleLines={3} />
            </ListPresentationProvider>, detail,
        )).toBe(3);
        expect(await paintedLines(
            <ListPresentationProvider value="page">
                <ListPresentationProvider value="grouped">
                    <Item title={title} subtitle={detail} titleAccessory={<View testID="badge" />} />
                </ListPresentationProvider>
            </ListPresentationProvider>, title,
        )).toBe(1);
        expect(await paintedLines(
            <ListPresentationProvider value="page">
                <ListPresentationProvider value="grouped">
                    <Item title={title} subtitle={detail} />
                </ListPresentationProvider>
            </ListPresentationProvider>, detail,
        )).toBe(1);
        expect(await paintedLines(
            <ListPresentationProvider value="page">
                <Item title={title} subtitle={detail} rowRole="menu" />
            </ListPresentationProvider>, detail,
        )).toBe(1);
    });

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

    it('lets a status subtitle (one led by a status mark) wrap to two lines instead of cutting it', async () => {
        const { Item } = await import('./Item');
        const { resolveItemSubtitleMaxLines, ITEM_STATUS_SUBTITLE_MAX_LINES } = await import('./itemTextClamp');
        const { View } = await import('react-native');
        const status = 'Happier 0.2.10 on this machine · 0.2.12 available';
        const dot = <View testID="presence" style={{ width: 7, height: 7 }} />;

        const painted = await paintedLines(<Item title="devbox" subtitle={status} subtitleLeading={dot} showChevron={false} />, status);
        expect(painted).toBe(resolveItemSubtitleMaxLines({ text: status, subtitleLines: undefined, status: true }));
        expect(painted).toBe(ITEM_STATUS_SUBTITLE_MAX_LINES);
        expect(ITEM_STATUS_SUBTITLE_MAX_LINES).toBe(2);
        // A plain description keeps its single line, so index rows stay compact.
        expect(await paintedLines(<Item title="devbox" subtitle={status} showChevron={false} />, status)).toBe(1);
    });

    it('keeps the status mark on the first line of a wrapped status subtitle', async () => {
        const { Item } = await import('./Item');
        const { View } = await import('react-native');
        const { flattenTestStyle } = await import('@/dev/testkit');
        const status = 'Happier 0.2.10 on this machine · 0.2.12 available';
        const screen = await renderScreen(
            <Item title="devbox" subtitle={status} subtitleLeading={<View testID="presence" style={{ width: 7, height: 7 }} />} showChevron={false} />,
        );
        const text = screen.tree.findAllByType('Text' as never).find((node: { props: Record<string, unknown> }) => node.props.children === status)!;
        const lineHeight = flattenTestStyle(text.props.style).lineHeight as number;
        const mark = screen.tree.findAll((node: { props: Record<string, unknown> }) => node.props.testID === 'presence')[0]!;
        // The mark's slot is one subtitle line tall and sits at the top of the text, whatever the line count.
        const slot = flattenTestStyle(mark.parent!.props.style);
        const row = flattenTestStyle(mark.parent!.parent!.props.style);
        expect(slot.height).toBe(lineHeight);
        expect(row.alignItems).toBe('flex-start');
    });
});
