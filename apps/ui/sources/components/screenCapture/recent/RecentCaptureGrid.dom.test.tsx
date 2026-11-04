// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeRecentCaptureEntry } from '@/desktop/capture/nativeCapture';
import { installClampedWebScrollGeometry } from '@/dev/testkit/legend/webScrollGeometry';
import { RecentCaptureGridView } from './RecentCaptureGrid';

const pictures = vi.hoisted(() => ({ renders: new Map<string, number>() }));
vi.mock('react-native', async () => {
    const native = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    const React = await import('react');
    return { ...native, Image: (props: React.ComponentProps<typeof native.Image>) => {
        const uri = (props.source as { uri?: string })?.uri ?? '';
        pictures.renders.set(uri, (pictures.renders.get(uri) ?? 0) + 1);
        return React.createElement(native.Image, props);
    } };
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

type Observer = { callback: ResizeObserverCallback; elements: Set<Element> };
const observers = new Set<Observer>();
const box = (height: number): DOMRect => ({ width: 800, height, top: 0, left: 0, right: 800, bottom: height, x: 0, y: 0, toJSON: () => ({}) });
const measure = (element: Element) => box(element.querySelectorAll('[data-testid^="recent-capture-"]').length <= 3
    && element.querySelector('[data-testid^="recent-capture-"]') ? 150 : 300);

describe('recent grid real virtualized web owner', () => {
    let host: HTMLDivElement;
    let root: Root;
    let scrollBy: PropertyDescriptor | undefined;
    let scrollTo: PropertyDescriptor | undefined;
    beforeEach(() => {
        vi.useFakeTimers(); pictures.renders.clear(); observers.clear();
        host = document.createElement('div'); document.body.append(host); root = createRoot(host);
        vi.stubGlobal('ResizeObserver', class implements ResizeObserver {
            record: Observer;
            constructor(callback: ResizeObserverCallback) { this.record = { callback, elements: new Set() }; observers.add(this.record); }
            observe(element: Element) { this.record.elements.add(element); }
            unobserve(element: Element) { this.record.elements.delete(element); }
            disconnect() { observers.delete(this.record); }
        });
        vi.stubGlobal('IntersectionObserver', class {
            constructor(private callback: IntersectionObserverCallback) {}
            observe(target: Element) { this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
            disconnect() {}
        });
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) { return measure(this); });
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
        vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
        scrollBy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollBy');
        scrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
        vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
            return Math.max(300, ...[...this.querySelectorAll<HTMLElement>('[style]')].map(node => Number.parseFloat(node.style.height) || 0));
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, writable: true, value() {} });
        installClampedWebScrollGeometry();
    });
    afterEach(async () => {
        await act(async () => root.unmount()); host.remove();
        if (scrollBy) Object.defineProperty(HTMLElement.prototype, 'scrollBy', scrollBy);
        else Reflect.deleteProperty(HTMLElement.prototype, 'scrollBy');
        vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
        if (scrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollTo);
        else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
    });
    const settle = async () => {
        for (let pass = 0; pass < 8; pass++) await act(async () => {
            for (const observer of observers) observer.callback([...observer.elements].map(target => ({ target, contentRect: measure(target), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] })), {} as ResizeObserver);
            await vi.runOnlyPendingTimersAsync();
        });
    };

    it('mounts viewport rows for 1000 files, isolates hover and changed paths, and scrolls keyboard focus into view', async () => {
        const entries: NativeRecentCaptureEntry[] = Array.from({ length: 1000 }, (_, index) => ({
            path: `/library/${index}.png`, name: `${index}.png`, kind: 'still', byteSize: 4, modifiedAt: index, modifiedAtNanos: String(index),
        }));
        const read = vi.fn(async (entry: NativeRecentCaptureEntry) => ({ uri: `data:image/png;base64,${entry.path}-${entry.byteSize}` }));
        const choose = vi.fn();
        const render = async () => { await act(async () => root.render(<RecentCaptureGridView maxHeight={300} entries={entries} folders={[{ path: 'library', issue: null }]} readThumbnail={read} onChoose={choose} />)); await settle(); };
        await render();
        const mounted = () => host.querySelectorAll('[data-testid^="recent-capture-"]');
        expect(mounted().length).toBeGreaterThan(0);
        expect(mounted().length).toBeLessThan(entries.length / 10);
        expect(read.mock.calls.length).toBe(mounted().length);
        const initialMounted = mounted().length;
        pictures.renders.clear();
        await act(async () => mounted()[1]!.querySelector('div')!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
        const hoverRenders = [...pictures.renders.values()].reduce((sum, count) => sum + count, 0);
        expect(hoverRenders).toBeGreaterThan(0);
        expect(hoverRenders).toBeLessThanOrEqual(2);
        const previousReads = read.mock.calls.length;
        entries[0] = { ...entries[0]!, byteSize: 8 };
        // A fresh wire snapshot retains other entry objects at the hook owner.
        await act(async () => root.render(<RecentCaptureGridView maxHeight={300} entries={[...entries]} folders={[{ path: 'library', issue: null }]} readThumbnail={read} onChoose={choose} />));
        await settle();
        expect(read.mock.calls.length - previousReads).toBe(1);
        const changedPathReads = read.mock.calls.length - previousReads;
        const grid = host.querySelector('[data-testid="recent-captures-grid"]')!;
        for (let step = 0; step < 25; step++) await act(async () => grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
        await settle();
        await act(async () => grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
        expect(choose.mock.calls[0]?.[0].path).toBe('/library/76.png');
        expect(host.querySelector('[data-testid="recent-capture-76.png"]')).not.toBeNull();
        expect(mounted().length).toBeLessThan(entries.length / 10);
        console.info('recent-grid-cost', { files: entries.length, initialMounted, hoverRenders, changedPathReads, scrolledMounted: mounted().length });
    });

    it('says an operation failure over retained captures without blaming the folder read', async () => {
        const { NativeCaptureError } = await import('@/desktop/capture/nativeCapture');
        const { t } = await import('@/text');
        const entries: NativeRecentCaptureEntry[] = [0, 1].map(index => ({
            path: `/library/${index}.png`, name: `${index}.png`, kind: 'still', byteSize: 4, modifiedAt: index, modifiedAtNanos: String(index),
        }));
        const read = vi.fn(async (entry: NativeRecentCaptureEntry) => ({ uri: `data:image/png;base64,${entry.path}` }));
        const refresh = vi.fn();
        await act(async () => root.render(<RecentCaptureGridView maxHeight={300} entries={entries} folders={[{ path: 'library', issue: null }]}
            status="error" error={new NativeCaptureError('file_io')} readThumbnail={read} onChoose={() => {}} onRefresh={refresh} />));
        await settle();
        expect(host.textContent).toContain(t('screenCapture.recent.operationFailed'));
        expect(host.textContent).not.toContain(t('screenCapture.recent.loadFailed'));
        expect(host.querySelectorAll('[data-testid^="recent-capture-"]').length).toBe(2);
        // With nothing listed, the first folder read is what failed, and the card says so.
        await act(async () => root.render(<RecentCaptureGridView maxHeight={300} entries={[]} folders={[{ path: 'library', issue: null }]}
            status="error" error={new NativeCaptureError('file_io')} readThumbnail={read} onChoose={() => {}} onRefresh={refresh} />));
        expect(host.textContent).toContain(t('screenCapture.recent.loadFailed'));
    });
});
