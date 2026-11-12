import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function renderSelectableTextInScroller(
    os: 'android' | 'ios' | 'web',
    props: Readonly<{ keepNativeTextSelection?: boolean }> = {},
): Promise<unknown> {
    vi.resetModules();
    vi.doMock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: os },
            Text: (textProps: any) => React.createElement('RNText', textProps, textProps.children),
        });
    });
    const { HorizontalOverflowScrollView } = await import('./HorizontalOverflowScrollView');
    const { Text } = await import('@/components/ui/text/Text');

    const screen = await renderScreen(
        <HorizontalOverflowScrollView {...props}>
            <Text selectable>wide content</Text>
        </HorizontalOverflowScrollView>,
    );
    return {
        selectable: screen.findByType('RNText' as any).props.selectable,
        wrapped: screen.findAllByType('HappierHorizontalOverflowContainer' as any).length === 1,
    };
}

describe('HorizontalOverflowScrollView (native text selection)', () => {
    it('suppresses native selection of descendant text on Android, where it fights the horizontal drag', async () => {
        const result = await renderSelectableTextInScroller('android');
        expect(result).toEqual({ selectable: false, wrapped: true });
    });

    it('keeps descendant text selectable on iOS and web', async () => {
        expect(await renderSelectableTextInScroller('ios')).toEqual({ selectable: true, wrapped: false });
        expect(await renderSelectableTextInScroller('web')).toEqual({ selectable: true, wrapped: false });
    });

    it('keeps descendant text selectable on Android when the owner opts out of suppression', async () => {
        expect(await renderSelectableTextInScroller('android', { keepNativeTextSelection: true })).toEqual({ selectable: true, wrapped: true });
    });
});
