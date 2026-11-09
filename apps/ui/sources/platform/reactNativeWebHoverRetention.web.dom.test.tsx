// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Pressable } from 'react-native-web';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

setFlagsFromString('--expose-gc');
const collectGarbage = runInNewContext('gc') as () => void;

async function settleAndCollect(): Promise<void> {
    // WeakRef targets stay alive for the current job; leave it before each collection.
    for (let pass = 0; pass < 3; pass += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        collectGarbage();
    }
}

describe('react-native-web hover listener registry', () => {
    // A mounted Pressable whose host element is replaced (here: its role changes the rendered tag)
    // must not keep the replaced element alive through useHover's per-target listener map.
    it('releases a replaced host element while the Pressable stays mounted', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        let hoverIns = 0;
        const onHoverIn = () => { hoverIns += 1; };
        await act(async () => {
            root.render(<Pressable testID="row" role="button" onHoverIn={onHoverIn}><span>row</span></Pressable>);
        });
        let replaced: Element | null = container.querySelector('[data-testid="row"]');
        expect(replaced?.tagName).toBe('BUTTON');
        const replacedRef = new WeakRef(replaced!);
        await act(async () => {
            root.render(<Pressable testID="row" role={undefined} onHoverIn={onHoverIn}><span>row</span></Pressable>);
        });
        const current = container.querySelector('[data-testid="row"]');
        expect(current).not.toBe(replacedRef.deref());
        replaced = null;
        await settleAndCollect();
        expect(replacedRef.deref()).toBeUndefined();
        // The replacement element is the live hover target.
        await act(async () => { current!.dispatchEvent(new MouseEvent('mouseenter')); });
        expect(hoverIns).toBe(1);
        await act(async () => root.unmount());
        container.remove();
    });

    // A hover that has ended must not keep its entering event: that event's relatedTarget is
    // where the pointer came from (in the app, a pane that was then closed), and a still-mounted
    // row would keep that whole detached pane alive until the row is hovered again.
    it('releases the element the pointer came from after the hover ends', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        let hovered = false;
        await act(async () => {
            root.render(<Pressable testID="row" onHoverIn={() => { hovered = true; }} onHoverOut={() => { hovered = false; }}>
                <span>row</span></Pressable>);
        });
        const row = container.querySelector('[data-testid="row"]')!;
        let pane: HTMLElement | null = document.createElement('section');
        pane.appendChild(document.createElement('p'));
        document.body.appendChild(pane);
        const paneRef = new WeakRef(pane);
        await act(async () => { row.dispatchEvent(new MouseEvent('mouseenter', { relatedTarget: pane!.firstChild })); });
        expect(hovered).toBe(true);
        await act(async () => { row.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: document.body })); });
        expect(hovered).toBe(false);
        pane.remove();
        pane = null;
        await settleAndCollect();
        expect(paneRef.deref()).toBeUndefined();
        await act(async () => root.unmount());
        container.remove();
    });
});
