import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, vi } from 'vitest';

/** Physical layout/ResizeObserver boundary for the real Legend DOM recycler; its engine stays real. */
export function createWebListDomHarness(options: Readonly<{ rowSelector: string; rowHeight: number; width?: number; height?: number }>) {
    const width = options.width ?? 800;
    const height = options.height ?? 400;
    type ResizeObserverRecord = Readonly<{
        callback: ResizeObserverCallback;
        elements: Set<Element>;
    }>;

    const resizeObservers = new Set<ResizeObserverRecord>();

    function rect(width: number, height: number): DOMRectReadOnly {
        return {
            bottom: height,
            height,
            left: 0,
            right: width,
            top: 0,
            width,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        };
    }

    function isFillSized(element: HTMLElement): boolean {
        const style = window.getComputedStyle(element);
        return (style.flexGrow === '1' || Number.parseFloat(style.height) > 0)
            && (style.minHeight === '0px' || style.minHeight === '0');
    }

    function isInsideDisplayNone(element: Element): boolean {
        for (let node: Element | null = element; node; node = node.parentElement) {
            if (window.getComputedStyle(node).display === 'none') return true;
        }
        return false;
    }

    function measuredRect(element: Element): DOMRectReadOnly {
        const htmlElement = element as HTMLElement;
        // A browser lays out nothing under `display: none`: every box there reads 0 x 0.
        if (isInsideDisplayNone(element)) return rect(0, 0);
        if (htmlElement.id === 'virtualized-list-host') {
            return rect(width, height);
        }
        if (
            htmlElement.style.overflowY === 'auto'
            || htmlElement.style.overflow === 'auto'
        ) {
            return isFillSized(htmlElement) ? rect(width, Math.min(height, Number.parseFloat(htmlElement.style.height) || height)) : rect(width, 0);
        }
        const row = htmlElement.matches(options.rowSelector) ? htmlElement : htmlElement.querySelector<HTMLElement>(options.rowSelector);
        if (row) {
            // Legend implements row gaps as cell padding. Include that real box
            // geometry when its ResizeObserver measures the rendered row wrapper.
            let padding = 0;
            for (let node = row.parentElement; node && htmlElement.contains(node); node = node.parentElement) {
                const style = window.getComputedStyle(node);
                padding += (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
                if (node === htmlElement) break;
            }
            return rect(width, options.rowHeight + padding);
        }
        return rect(width, Number.parseFloat(htmlElement.style.height || '0') || 0);
    }

    function flushResizeObservers(): void {
        for (const observer of resizeObservers) {
            const entries = [...observer.elements].map((element) => ({
                borderBoxSize: [],
                contentBoxSize: [],
                contentRect: measuredRect(element),
                devicePixelContentBoxSize: [],
                target: element,
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


    let container: HTMLDivElement;
    let root: Root;
    const geometryProperties = ['clientHeight', 'clientWidth', 'scrollHeight', 'scrollTo', 'scrollBy'] as const;
    let originalDescriptors: PropertyDescriptorMap;

    beforeEach(() => {
        originalDescriptors = Object.getOwnPropertyDescriptors(HTMLElement.prototype);
        vi.useFakeTimers();
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

            disconnect(): void {
                this.record.elements.clear();
                resizeObservers.delete(this.record);
            }

            observe(target: Element): void {
                resizeObservers.add(this.record);
                this.record.elements.add(target);
            }

            unobserve(target: Element): void {
                this.record.elements.delete(target);
            }
        }

        vi.stubGlobal('ResizeObserver', TestResizeObserver);
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
            function getBoundingClientRect(this: HTMLElement) {
                return measuredRect(this);
            },
        );
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => (
            setTimeout(() => callback(Date.now()), 0) as unknown as number
        ));
        vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
            configurable: true,
            get() {
                return measuredRect(this).height;
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
            configurable: true,
            get() {
                return measuredRect(this).width;
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
            configurable: true,
            get() {
                const element = this as HTMLElement;
                let virtualContentHeight = 0;
                for (const descendant of element.querySelectorAll<HTMLElement>('[style]')) {
                    virtualContentHeight = Math.max(
                        virtualContentHeight,
                        Number.parseFloat(descendant.style.height || '0') || 0,
                    );
                }
                return Math.max(element.clientHeight, virtualContentHeight);
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            writable: true,
            value() {},
        });
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.restoreAllMocks();
        for (const key of geometryProperties) {
            const descriptor = originalDescriptors[key];
            if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
            else Reflect.deleteProperty(HTMLElement.prototype, key);
        }
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    return { get container() { return container; }, get root() { return root; }, flush: flushLegendWork };
}
