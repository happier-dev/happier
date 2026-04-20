import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { MultiPaneHost } from './MultiPaneHost';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('MultiPaneHost (docked main region)', () => {
    it('allows the main region to shrink beside a docked right pane on web', async () => {
        const screen = await renderScreen(
            <MultiPaneHost
                main={<Main />}
                rightPane={<Right />}
                detailsPane={null}
                layout={{ kind: 'twoPane', right: 'docked', details: 'hidden' }}
                rightDockWidthPx={360}
                detailsDockWidthPx={520}
                onCloseRight={() => {}}
                onCloseDetails={() => {}}
                onCommitRightDockWidthPx={() => {}}
                onCommitDetailsDockWidthPx={() => {}}
            />,
        );

        const mainNode = screen.tree.root.findByType('Main');
        const mainRegion = findAncestorWithStyle(mainNode, (style) => {
            return style != null && typeof style === 'object' && 'flex' in style;
        });
        expect(mainRegion?.props?.style).toEqual(
            expect.objectContaining({
                flex: 1,
                minWidth: 0,
            }),
        );
    });
});

function Main() {
    return React.createElement('Main');
}

function Right() {
    return React.createElement('Right');
}

function findAncestorWithStyle(
    node: { parent?: { parent?: unknown; props?: { style?: unknown } } | null } | null | undefined,
    predicate: (style: unknown) => boolean,
) {
    let current = node?.parent ?? null;
    while (current) {
        if (predicate(current.props?.style)) return current;
        current = current.parent ?? null;
    }
    return null;
}
