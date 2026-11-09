// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import { resolveMainTranscriptListShellFrame } from '../transcriptListShellCapabilities';
import { legendListRenderer } from './legendListRenderer';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

type Row = Readonly<{ id: string; height: number }>;
type ResizeObserverRecord = Readonly<{ callback: ResizeObserverCallback; elements: Set<Element> }>;

const resizeObservers = new Set<ResizeObserverRecord>();

function rect(width: number, height: number): DOMRectReadOnly {
    return { bottom: height, height, left: 0, right: width, top: 0, width, x: 0, y: 0, toJSON: () => ({}) };
}

function isInsideDisplayNone(element: Element): boolean {
    for (let node: Element | null = element; node; node = node.parentElement) {
        if (window.getComputedStyle(node).display === 'none') return true;
    }
    return false;
}

function measuredRect(element: Element): DOMRectReadOnly {
    const html = element as HTMLElement;
    // A browser lays out nothing under `display: none`: every box there reads 0 x 0.
    if (isInsideDisplayNone(element)) return rect(0, 0);
    if (html.id === 'transcript-host' || html.style.overflowY === 'auto' || html.style.overflow === 'auto') {
        return rect(800, 600);
    }
    const row = html.querySelector<HTMLElement>('[data-height]');
    if (row) return rect(800, Number(row.dataset.height ?? 72));
    return rect(800, Number.parseFloat(html.style.height || '0') || 0);
}

function flushResizeObservers(): void {
    for (const observer of resizeObservers) {
        const entries = [...observer.elements].map((element) => ({
            borderBoxSize: [], contentBoxSize: [], contentRect: measuredRect(element),
            devicePixelContentBoxSize: [], target: element,
        })) as ResizeObserverEntry[];
        if (entries.length > 0) observer.callback(entries, {} as ResizeObserver);
    }
}

async function flushLegendWork(): Promise<void> {
    for (let pass = 0; pass < 8; pass += 1) {
        await act(async () => {
            flushResizeObservers();
            await vi.runOnlyPendingTimersAsync();
        });
    }
}

let rowMounts = 0;
let settleFirstRow: (() => void) | undefined;

function RowBody(props: Readonly<{ item: Row }>): React.ReactElement {
    const [settled, setSettled] = React.useState(false);
    React.useLayoutEffect(() => { rowMounts += 1; }, []);
    if (props.item.id === 'msg-1999') settleFirstRow = () => setSettled(true);
    const height = settled ? props.item.height + 40 : props.item.height;
    return <div data-height={height} data-testid={`row:${props.item.id}`} style={{ height }}>{props.item.id}</div>;
}

const renderRow = ({ item }: Readonly<{ item: Row }>) => <RowBody item={item} />;

function messages(count: number): Row[] {
    return Array.from({ length: count }, (_value, index) => ({ id: `msg-${index}`, height: index % 5 === 0 ? 180 : 72 }));
}

describe('transcript renderer inside a hidden retained surface (0 x 0 layout)', () => {
    let container: HTMLDivElement;
    let root: Root;
    let initialScrollBy: PropertyDescriptor | undefined;

    beforeEach(() => {
        vi.useFakeTimers();
        rowMounts = 0;
        settleFirstRow = undefined;
        resizeObservers.clear();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        class TestResizeObserver implements ResizeObserver {
            private readonly record: ResizeObserverRecord;
            constructor(callback: ResizeObserverCallback) {
                this.record = { callback, elements: new Set() };
                resizeObservers.add(this.record);
            }
            disconnect(): void { this.record.elements.clear(); resizeObservers.delete(this.record); }
            observe(target: Element): void { resizeObservers.add(this.record); this.record.elements.add(target); }
            unobserve(target: Element): void { this.record.elements.delete(target); }
        }
        vi.stubGlobal('ResizeObserver', TestResizeObserver);
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            return measuredRect(this);
        });
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => (
            setTimeout(() => callback(Date.now()), 0) as unknown as number
        ));
        vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return measuredRect(this).height; } });
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return measuredRect(this).width; } });
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
            configurable: true,
            get() {
                const element = this as HTMLElement;
                let content = 0;
                for (const descendant of element.querySelectorAll<HTMLElement>('[style]')) {
                    content = Math.max(content, Number.parseFloat(descendant.style.height || '0') || 0);
                }
                return Math.max(element.clientHeight, content);
            },
        });
        initialScrollBy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollBy');
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, writable: true, value() {} });
        Object.defineProperty(HTMLElement.prototype, 'scrollBy', { configurable: true, writable: true, value() {} });
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.restoreAllMocks();
        if (initialScrollBy) Object.defineProperty(HTMLElement.prototype, 'scrollBy', initialScrollBy);
        else Reflect.deleteProperty(HTMLElement.prototype, 'scrollBy');
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('mounts no rows while hidden when messages arrive, rows re-render or a row settles, and shows a window on reveal', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const Renderer = legendListRenderer.Component;
        const frame = resolveMainTranscriptListShellFrame({ platformOS: 'web' });
        const webDomObservation = createWebDomScrollObservation();
        const render = async (presented: boolean, data: readonly Row[], extraData: unknown) => {
            await act(async () => root.render(
                <RetainedPanelSurface isActive={presented}>
                    <div id="transcript-host" style={{ display: 'flex', flexDirection: 'column', height: 600 }}>
                        <Renderer data={data} dataKey="session:long" extraData={extraData} frame={frame}
                            keyExtractor={(item: Row) => item.id} renderItem={renderRow}
                            webDomObservation={webDomObservation} />
                    </div>
                </RetainedPanelSurface>,
            ));
            await flushLegendWork();
        };
        const mountedRows = () => container.querySelectorAll('[data-testid^="row:"]').length;

        let data = messages(2_000);
        await render(true, data, { revision: 1 });
        const presentedWindow = mountedRows();
        expect(presentedWindow).toBeGreaterThan(0);
        expect(presentedWindow).toBeLessThan(80);

        rowMounts = 0;
        await render(false, data, { revision: 1 });
        // A hidden Session keeps streaming: new messages, a row-revision bump and a settled row.
        data = [...data, { id: 'msg-2000', height: 72 }];
        await render(false, data, { revision: 2 });
        data = [...data, { id: 'msg-2001', height: 72 }];
        await render(false, data, { revision: 3 });
        if (settleFirstRow) await act(async () => settleFirstRow!());
        await flushLegendWork();
        const hiddenMounts = rowMounts;
        const hiddenRows = mountedRows();

        rowMounts = 0;
        await render(true, data, { revision: 3 });
        const revealMounts = rowMounts;

        expect({ hiddenMounts, hiddenRowsAtMost: hiddenRows <= presentedWindow }).toEqual({ hiddenMounts: 0, hiddenRowsAtMost: true });
        expect(revealMounts).toBeLessThan(80);
        expect(mountedRows()).toBeLessThan(80);
        expect(container.querySelector('[data-testid="row:msg-2001"]')).not.toBeNull();
        expect(consoleError.mock.calls.flat().map(String).join('\n')).not.toContain('Maximum update depth');
    });

});
