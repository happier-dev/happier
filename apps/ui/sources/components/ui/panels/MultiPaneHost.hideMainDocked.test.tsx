import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { MultiPaneHost } from './MultiPaneHost';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('MultiPaneHost (hideMain docked)', () => {
    it('hides the main region when hideMain is true and panes are docked', () => {
        vi.useFakeTimers();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <MultiPaneHost
                    hideMain
                    main={<Main />}
                    rightPane={<Right />}
                    detailsPane={<Details />}
                    layout={{ kind: 'threePane', right: 'docked', details: 'docked' }}
                    rightDockWidthPx={360}
                    detailsDockWidthPx={520}
                    onCloseRight={() => {}}
                    onCloseDetails={() => {}}
                    onCommitRightDockWidthPx={() => {}}
                    onCommitDetailsDockWidthPx={() => {}}
                />
            );
        });

        expect(() => tree!.root.findByType('Main' as any)).toThrow();
        expect(tree!.root.findByType('Details' as any)).toBeTruthy();
        expect(tree!.root.findByType('Right' as any)).toBeTruthy();
    });
});

function Main() {
    return React.createElement('Main');
}

function Right() {
    return React.createElement('Right');
}

function Details() {
    return React.createElement('Details');
}
