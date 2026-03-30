import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { MultiPaneHost } from './MultiPaneHost';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('MultiPaneHost (Escape closes docked panes)', () => {
    it('closes docked details first on Escape (web)', async () => {
        const onCloseRight = vi.fn();
        const onCloseDetails = vi.fn();

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        (globalThis as any).KeyboardEvent = class KeyboardEvent extends Event {
            key: string;
            target: any;
            defaultPrevented = false;
            constructor(type: string, init: { key: string; target?: any }) {
                super(type);
                this.key = init.key;
                this.target = init.target;
            }
        };

        await renderScreen(<MultiPaneHost
                main={<Main />}
                rightPane={<Right />}
                detailsPane={<Details />}
                layout={{ kind: 'threePane', right: 'docked', details: 'docked' }}
                rightDockWidthPx={360}
                detailsDockWidthPx={520}
                onCloseRight={onCloseRight}
                onCloseDetails={onCloseDetails}
                onCommitRightDockWidthPx={() => {}}
                onCommitDetailsDockWidthPx={() => {}}
            />);

        act(() => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).KeyboardEvent('keydown', { key: 'Escape' }));
        });

        expect(onCloseDetails).toHaveBeenCalledTimes(1);
        expect(onCloseRight).toHaveBeenCalledTimes(0);
    });

    it('does not close panes on Escape when event target is a text input', async () => {
        const onCloseRight = vi.fn();
        const onCloseDetails = vi.fn();

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        (globalThis as any).KeyboardEvent = class KeyboardEvent extends Event {
            key: string;
            target: any;
            defaultPrevented = false;
            constructor(type: string, init: { key: string; target?: any }) {
                super(type);
                this.key = init.key;
                this.target = init.target;
            }
        };

        await renderScreen(<MultiPaneHost
                    main={<Main />}
                    rightPane={<Right />}
                    detailsPane={<Details />}
                    layout={{ kind: 'threePane', right: 'docked', details: 'docked' }}
                    rightDockWidthPx={360}
                    detailsDockWidthPx={520}
                    onCloseRight={onCloseRight}
                    onCloseDetails={onCloseDetails}
                    onCommitRightDockWidthPx={() => {}}
                    onCommitDetailsDockWidthPx={() => {}}
                />);

        act(() => {
            (globalThis as any).window.dispatchEvent(
                new (globalThis as any).KeyboardEvent('keydown', { key: 'Escape', target: { tagName: 'INPUT' } })
            );
        });

        expect(onCloseDetails).toHaveBeenCalledTimes(0);
        expect(onCloseRight).toHaveBeenCalledTimes(0);
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
