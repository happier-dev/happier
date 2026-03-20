import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { MultiPaneHostWithBottom } from './MultiPaneHostWithBottom';

describe('MultiPaneHostWithBottom (overlayBottom)', () => {
    it('renders a scrim for overlay bottom and closes on scrim press', () => {
        vi.useFakeTimers();
        const onCloseBottom = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <MultiPaneHostWithBottom
                    main={<Main />}
                    rightPane={null}
                    detailsPane={null}
                    layout={{ kind: 'single', right: 'hidden', details: 'hidden' }}
                    rightDockWidthPx={360}
                    detailsDockWidthPx={520}
                    onCloseRight={() => {}}
                    onCloseDetails={() => {}}
                    onCommitRightDockWidthPx={() => {}}
                    onCommitDetailsDockWidthPx={() => {}}
                    bottomPane={<Bottom />}
                    bottomPresentation="overlay"
                    bottomDockHeightPx={320}
                    bottomDockMinHeightPx={200}
                    bottomDockMaxHeightPx={600}
                    onCloseBottom={onCloseBottom}
                    onCommitBottomDockHeightPx={() => {}}
                />
            );
        });

        const scrim = tree!.root.findByProps({ testID: 'multi-pane-bottom-scrim' });

        act(() => {
            scrim.props.onPress();
        });
        expect(onCloseBottom).toHaveBeenCalledTimes(0);
        act(() => {
            vi.runAllTimers();
        });
        expect(onCloseBottom).toHaveBeenCalledTimes(1);
    });

    it('closes overlay bottom on Escape key press and prevents inner pane closures', () => {
        vi.useFakeTimers();
        const onCloseBottom = vi.fn();
        const onCloseRight = vi.fn();

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        (globalThis as any).KeyboardEvent = class KeyboardEvent extends Event {
            key: string;
            constructor(type: string, init: { key: string }) {
                super(type);
                this.key = init.key;
            }
        };

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <MultiPaneHostWithBottom
                    main={<Main />}
                    rightPane={<Right />}
                    detailsPane={null}
                    layout={{ kind: 'overlayStack', right: 'overlay', details: 'hidden' }}
                    rightDockWidthPx={360}
                    detailsDockWidthPx={520}
                    onCloseRight={onCloseRight}
                    onCloseDetails={() => {}}
                    onCommitRightDockWidthPx={() => {}}
                    onCommitDetailsDockWidthPx={() => {}}
                    bottomPane={<Bottom />}
                    bottomPresentation="overlay"
                    bottomDockHeightPx={320}
                    bottomDockMinHeightPx={200}
                    bottomDockMaxHeightPx={600}
                    onCloseBottom={onCloseBottom}
                    onCommitBottomDockHeightPx={() => {}}
                />
            );
        });

        expect(tree!.root.findByProps({ testID: 'multi-pane-bottom-scrim' })).toBeTruthy();
        act(() => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).KeyboardEvent('keydown', { key: 'Escape' }));
        });
        expect(onCloseBottom).toHaveBeenCalledTimes(0);
        expect(onCloseRight).toHaveBeenCalledTimes(0);
        act(() => {
            vi.runAllTimers();
        });
        expect(onCloseBottom).toHaveBeenCalledTimes(1);
        expect(onCloseRight).toHaveBeenCalledTimes(0);
    });

    it('keeps the overlay bottom resizable', () => {
        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <MultiPaneHostWithBottom
                    main={<Main />}
                    rightPane={null}
                    detailsPane={null}
                    layout={{ kind: 'single', right: 'hidden', details: 'hidden' }}
                    rightDockWidthPx={360}
                    detailsDockWidthPx={520}
                    onCloseRight={() => {}}
                    onCloseDetails={() => {}}
                    onCommitRightDockWidthPx={() => {}}
                    onCommitDetailsDockWidthPx={() => {}}
                    bottomPane={<Bottom />}
                    bottomPresentation="overlay"
                    bottomDockHeightPx={320}
                    bottomDockMinHeightPx={200}
                    bottomDockMaxHeightPx={600}
                    onCloseBottom={() => {}}
                    onCommitBottomDockHeightPx={() => {}}
                />
            );
        });

        expect(tree!.root.findAllByProps({ testID: 'multi-pane-bottom-overlay-pane' }).length).toBeGreaterThan(0);
        expect(tree!.root.findAllByProps({ testID: 'multi-pane-bottom-overlay-resize-handle' }).length).toBeGreaterThan(0);
    });
});

function Main() {
    return React.createElement('Main');
}

function Right() {
    return React.createElement('Right');
}

function Bottom() {
    return React.createElement('Bottom');
}
