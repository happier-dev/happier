/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
    const { createRequire } = getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>('node:module');
    // The package-name RNW request has a Node shim; its absolute entry is the real DOM boundary.
    return await vi.importActual(createRequire(import.meta.url).resolve('react-native-web'));
});

const { PluginUiScrollActivityProvider } = await import('@happier-dev/plugin-ui/advanced');
const { NearViewportWindow } = await import('./NearViewportWindow');

/** A host whose one row sits at the page's top; scrolling moves the viewport far past it. */
function scrollingTracker() {
    let window = { top: 0, bottom: 1000 };
    const listeners = new Set<() => void>();
    return {
        onScroll: () => {}, onLayout: () => {}, onContentSizeChange: () => {},
        subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
        getWindow: () => window,
        measureSpan: async () => ({ top: 0, height: 40 }),
        invalidateLayout: () => {}, getLayoutRevision: () => 0,
        scrollFarAway: () => { window = { top: 50_000, bottom: 51_000 }; for (const listener of [...listeners]) listener(); },
    };
}

const mounted: Array<() => void> = [];
afterEach(() => { for (const unmount of mounted.splice(0)) unmount(); });

async function renderRow() {
    const tracker = scrollingTracker();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(() => { act(() => root.unmount()); container.remove(); });
    await act(async () => {
        root.render(<PluginUiScrollActivityProvider tracker={tracker}>
            <NearViewportWindow id="row" testID="window" pinned={false} estimatedTop={0} estimatedHeight={40}>
                <button data-testid="row">Row</button>
            </NearViewportWindow>
            <button data-testid="elsewhere">Elsewhere</button>
        </PluginUiScrollActivityProvider>);
    });
    await act(async () => {});
    const row = () => container.querySelector<HTMLElement>('[data-testid="row"]');
    const elsewhere = container.querySelector<HTMLElement>('[data-testid="elsewhere"]')!;
    if (!row()) throw new Error('The near row must be built');
    return { tracker, row, elsewhere };
}

describe('NearViewportWindow held rows', () => {
    it('unbuilds an untouched row scrolled off the viewport', async () => {
        const { tracker, row } = await renderRow();
        await act(async () => { tracker.scrollFarAway(); });
        expect(row()).toBeNull();
    });

    it('keeps the keyboard-focused row built and focused off the viewport, and releases it when focus leaves', async () => {
        const { tracker, row, elsewhere } = await renderRow();
        const node = row()!;
        await act(async () => { node.focus(); });
        await act(async () => { tracker.scrollFarAway(); });
        expect(row()).toBe(node);
        expect(document.activeElement).toBe(node);
        await act(async () => { elsewhere.focus(); });
        expect(row()).toBeNull();
    });

    it('keeps a row being dragged built off the viewport until its drag ends', async () => {
        const { tracker, row } = await renderRow();
        const node = row()!;
        // The entity drag binding stops its dragstart from bubbling, so only capture sees it.
        node.addEventListener('dragstart', event => event.stopPropagation());
        await act(async () => { node.dispatchEvent(new Event('dragstart', { bubbles: true })); });
        await act(async () => { tracker.scrollFarAway(); });
        expect(row()).toBe(node);
        await act(async () => { node.dispatchEvent(new Event('dragend', { bubbles: true })); });
        expect(row()).toBeNull();
    });
});
