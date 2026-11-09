// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { installCodeViewCommonModuleMocks } from './codeViewTestHelpers';
import { buildCodeLinesFromFile } from '../model/buildCodeLinesFromFile';
import { installClampedWebScrollGeometry, readVirtualizedWebRowTop } from '@/dev/testkit/legend/webScrollGeometry';

installCodeViewCommonModuleMocks({ reactNative: async () => import('react-native-web'), realVirtualizer: true });
const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
const { createFileViewerFindModel } = await import('@/components/workspaces/files/details/useFileViewerFind');

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('reveals a Find match beyond the mounted wrapped rows through the real virtualizer', async () => {
    vi.useFakeTimers();
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    const text = Array.from({ length: 600 }, (_, index) => index === 349 ? 'needle' : `line ${index + 1}`).join('\n');
    const lines = buildCodeLinesFromFile({ text });
    const find = createFileViewerFindModel(() => ({ path: 'long.ts', mode: 'file', text }));
    const contentSize = vi.fn();
    // Substitute browser geometry only; the recycler and its index navigation stay real.
    const rect = (node: Element) => new DOMRect(0, 0, 390,
        node.getAttribute('data-testid') === 'long-file' ? 220
            : node.querySelector('[data-code-text]') && !node.classList.contains('legend-list-content-container') ? 22
                : Number.parseFloat((node as HTMLElement).style.height) || 0);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) { return rect(this); });
    for (const property of ['clientHeight', 'offsetHeight'] as const) {
        vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(function (this: HTMLElement) { return rect(this).height; });
    }
    for (const property of ['clientWidth', 'offsetWidth'] as const) vi.spyOn(HTMLElement.prototype, property, 'get').mockReturnValue(390);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return Math.max(this.clientHeight, ...Array.from(this.querySelectorAll<HTMLElement>('[style]'), node => Number.parseFloat(node.style.height) || 0));
    });
    const previousScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
    const previousScrollBy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollBy');
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, writable: true, value() {} });
    installClampedWebScrollGeometry();
    const observers = new Set<{ callback: ResizeObserverCallback; nodes: Set<Element> }>();
    class LayoutObserver {
        nodes = new Set<Element>();
        constructor(public callback: ResizeObserverCallback) { observers.add(this); }
        observe(node: Element) { this.nodes.add(node); }
        unobserve(node: Element) { this.nodes.delete(node); }
        disconnect() { observers.delete(this); }
    }
    vi.stubGlobal('ResizeObserver', LayoutObserver);
    const layout = async () => {
        for (let pass = 0; pass < 8; pass++) await act(async () => {
            for (const observer of [...observers]) observer.callback([...observer.nodes].map(target => ({ target,
                contentRect: rect(target), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [],
            })), observer as unknown as ResizeObserver);
            await vi.runOnlyPendingTimersAsync();
        });
    };
    const render = () => {
        const snapshot = find.getSnapshot();
        root.render(<CodeLinesViewCore lines={lines} wrapLines virtualized testID="long-file"
            onContentSizeChange={contentSize}
            scrollToLineId={snapshot.lineTarget ?? undefined} findRangesByLineId={snapshot.lineRanges} />);
    };
    try {
        await act(async () => render());
        await layout();
        expect(host.querySelectorAll('[data-code-text]').length).toBeLessThan(50);
        expect(host.querySelector('[data-code-text="f:350"]')).toBeNull();
        expect(contentSize.mock.calls.at(-1)?.[1] ?? 0).toBeGreaterThan(220);
        await act(async () => { find.open(); find.setQuery('needle'); render(); });
        await layout();
        const scroller = host.querySelector<HTMLElement>('[data-testid="long-file"]')!;
        expect(scroller.scrollTop).toBeGreaterThan(0);
        const target = host.querySelector<HTMLElement>('[data-code-text="f:350"]');
        expect(target).not.toBeNull();
        expect(readVirtualizedWebRowTop(target!, scroller)).toBeGreaterThanOrEqual(0);
        expect(readVirtualizedWebRowTop(target!, scroller)).toBeLessThan(scroller.clientHeight);
    } finally {
        await act(async () => root.unmount()); host.remove();
        vi.restoreAllMocks();
        if (previousScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', previousScrollTo);
        else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
        if (previousScrollBy) Object.defineProperty(HTMLElement.prototype, 'scrollBy', previousScrollBy);
        else Reflect.deleteProperty(HTMLElement.prototype, 'scrollBy');
    }
});
