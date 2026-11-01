import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks({
    reactNative: () =>
        createReactNativeWebMock({
            Platform: { OS: 'android' },
        }),
});

type NativeContextMenuItem = Readonly<{
    text: string;
    onPress: (event: Readonly<{ text: string; selection: Readonly<{ start: number; end: number }> }>) => void;
}>;

describe('MarkdownView (native selection actions)', () => {
    it('offers each selection action in the native text-selection menu of every prose run', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const onQuote = vi.fn();

        const screen = await renderScreen(
            <MarkdownView
                markdown={['Intro **text**.', '', '```ts', 'const a = 1;', '```', '', '> quoted', '', '- item'].join('\n')}
                selectionActions={[{ label: 'Quote', onPress: onQuote }]}
            />,
        );

        const runs = screen.findAllByType('EnrichedMarkdownText');
        expect(runs.length).toBeGreaterThanOrEqual(2);
        for (const run of runs) {
            const items = run.props.contextMenuItems as readonly NativeContextMenuItem[] | undefined;
            expect(items?.map((item) => item.text)).toEqual(['Quote']);
        }

        const lastItems = runs[runs.length - 1]!.props.contextMenuItems as readonly NativeContextMenuItem[];
        lastItems[0]!.onPress({ text: 'item', selection: { start: 0, end: 4 } });
        expect(onQuote).toHaveBeenCalledWith({ text: 'item' });
    });

    it('adds no selection menu items when no action is supplied', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        const screen = await renderScreen(<MarkdownView markdown="Plain prose" />);

        expect(screen.findByType('EnrichedMarkdownText').props.contextMenuItems).toBeUndefined();
    });
});
