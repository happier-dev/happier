import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { StoryDeckListCard as ListCardData } from '@/changelog/releaseNotes/types';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native-gesture-handler', async () => {
    const ReactModule = await import('react');
    return {
        ScrollView: ReactModule.forwardRef((
            props: React.PropsWithChildren<Record<string, unknown>>,
            _ref: React.ForwardedRef<unknown>,
        ) => {
            const { children, ...rest } = props;
            return ReactModule.createElement('GestureHandlerScrollView', rest, children);
        }),
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
}));

function createListCard(rowCount: number): ListCardData {
    return {
        kind: 'list',
        titleKey: 'releaseNotes.test.title',
        rows: Array.from({ length: rowCount }, (_, index) => ({
            iconId: 'sparkles',
            titleKey: `releaseNotes.test.rows.${index}.title`,
            bodyKey: `releaseNotes.test.rows.${index}.body`,
        })),
    };
}

describe('StoryDeckListCard', () => {
    it('keeps short list cards non-scrollable to preserve the Notelet-style composition', async () => {
        const { StoryDeckListCard } = await import('./StoryDeckListCard');
        const screen = await renderScreen(<StoryDeckListCard card={createListCard(6)} testID="story-list" />);

        expect(screen.findAllByType('GestureHandlerScrollView')).toHaveLength(0);
        const staticRows = screen.findByTestId('story-list-rows-static');
        expect(staticRows).toBeTruthy();
        expect(staticRows?.props.style).toContainEqual({ rowGap: 25 });
    });

    it('uses two columns for static list rows in wide story-deck layouts', async () => {
        const { StoryDeckListCard } = await import('./StoryDeckListCard');
        const screen = await renderScreen(<StoryDeckListCard card={createListCard(6)} layout="wide" testID="story-list" />);

        const staticRows = screen.findByTestId('story-list-rows-static');
        expect(staticRows?.props.style).toContainEqual({
            width: '100%',
            alignSelf: 'center',
            flexDirection: 'row',
            flexWrap: 'wrap',
            columnGap: 25,
            rowGap: 25,
        });
    });

    it('uses two columns for scrollable list rows in wide story-deck layouts', async () => {
        const { StoryDeckListCard } = await import('./StoryDeckListCard');
        const screen = await renderScreen(<StoryDeckListCard card={createListCard(9)} layout="wide" testID="story-list" />);

        const scrollView = screen.findByTestId('story-list-rows-scroll');
        expect(scrollView?.props.contentContainerStyle).toMatchObject({ paddingBottom: 8 });
        const rowsGrid = screen.findByTestId('story-list-rows-grid');
        expect(rowsGrid).toBeTruthy();
        expect(rowsGrid?.props.style).toContainEqual({
            width: '100%',
            alignSelf: 'center',
            flexDirection: 'row',
            flexWrap: 'wrap',
            columnGap: 25,
            rowGap: 25,
        });
        const wideRows = screen.tree.root.findAll((node) => (
            Array.isArray(node.props.style)
            && node.props.style.some((style: unknown) => (
                style != null
                && typeof style === 'object'
                && 'flexBasis' in style
                && style.flexBasis === '47%'
            ))
        ));
        expect(wideRows.length).toBeGreaterThan(0);
    });

    it('adds vertical scrolling, edge fades, and chevron indicators for long list cards', async () => {
        const { StoryDeckListCard } = await import('./StoryDeckListCard');
        const screen = await renderScreen(<StoryDeckListCard card={createListCard(7)} testID="story-list" />);

        const scrollView = screen.findByTestId('story-list-rows-scroll');
        expect(scrollView?.type).toBe('GestureHandlerScrollView');
        expect(scrollView?.props.contentContainerStyle).toMatchObject({ paddingBottom: 8 });
        expect(screen.findByTestId('story-list-rows-grid')?.props.style).toContainEqual({ rowGap: 25 });

        act(() => {
            scrollView?.props.onLayout?.({ nativeEvent: { layout: { width: 320, height: 240 } } });
            scrollView?.props.onContentSizeChange?.(320, 520);
        });

        expect(screen.findByTestId('story-list-rows-scroll-fades')).toBeTruthy();
        expect(screen.findByTestId('story-list-rows-scroll-indicators')).toBeTruthy();
    });
});
