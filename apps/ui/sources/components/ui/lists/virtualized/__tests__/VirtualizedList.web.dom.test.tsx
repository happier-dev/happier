// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VirtualizedList } from '../VirtualizedList';

vi.mock('react-native', async () => vi.importActual('react-native-web'));

type Row = Readonly<{
    id: string;
}>;

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
    return style.flexGrow === '1'
        && (style.minHeight === '0px' || style.minHeight === '0');
}

function measuredRect(element: Element): DOMRectReadOnly {
    const htmlElement = element as HTMLElement;
    if (htmlElement.id === 'virtualized-list-host') {
        return rect(800, 400);
    }
    if (
        htmlElement.style.overflowY === 'auto'
        || htmlElement.style.overflow === 'auto'
    ) {
        return isFillSized(htmlElement) ? rect(800, 400) : rect(800, 0);
    }
    const row = htmlElement.querySelector<HTMLElement>('[data-row-height]');
    if (row) {
        return rect(800, Number(row.dataset.rowHeight ?? 56));
    }
    return rect(800, Number.parseFloat(htmlElement.style.height || '0') || 0);
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

describe('VirtualizedList web DOM integration', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
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
            value() {},
        });
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('fills a bounded host and mounts only a virtualized window', async () => {
        const rows = Array.from({ length: 500 }, (_value, index): Row => ({
            id: `row-${index}`,
        }));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await act(async () => {
            root.render(
                <div
                    id="virtualized-list-host"
                    style={{ display: 'flex', flexDirection: 'column', height: 400 }}
                >
                    <VirtualizedList
                        data={rows}
                        estimatedItemSize={56}
                        extraData={{ version: 1 }}
                        getItemLayout={(_item, index) => ({
                            index,
                            length: 56,
                            offset: index * 56,
                        })}
                        initialNumToRender={12}
                        keyboardShouldPersistTaps="handled"
                        keyExtractor={(item) => item.id}
                        maxToRenderPerBatch={12}
                        nativeID="virtualized-list-native"
                        onContentSizeChange={() => {}}
                        onMomentumScrollEnd={() => {}}
                        onMomentumScrollBegin={() => {}}
                        onScrollBeginDrag={() => {}}
                        onScrollEndDrag={() => {}}
                        onScrollToIndexFailed={() => {}}
                        removeClippedSubviews
                        recycleItems={false}
                        testID="virtualized-list-test"
                        windowSize={10}
                        renderItem={({ item }) => (
                            <div
                                data-row-height="56"
                                data-testid={`row-${item.id}`}
                                role="option"
                                style={{ height: 56 }}
                            >
                                {item.id}
                            </div>
                        )}
                        style={{ backgroundColor: 'rgb(1, 2, 3)' }}
                        webScrollHandlers={{ onWheel: () => {} }}
                    />
                </div>,
            );
        });
        await flushLegendWork();

        const mountedRows = container.querySelectorAll('[role="option"]');
        expect(mountedRows.length).toBeGreaterThan(0);
        expect(mountedRows.length).toBeLessThan(100);
        const scrollElement = container.querySelector<HTMLElement>('[style*="overflow"]');
        expect(scrollElement).not.toBeNull();
        expect(scrollElement?.dataset.testid).toBe('virtualized-list-test');
        expect(scrollElement?.id).toBe('virtualized-list-native');
        expect(window.getComputedStyle(scrollElement!).backgroundColor).toBe('rgb(1, 2, 3)');

        const diagnostics = [...consoleError.mock.calls, ...consoleWarn.mock.calls]
            .flat()
            .map(String)
            .join('\n');
        expect(diagnostics).not.toContain('webScrollH');
        expect(diagnostics).not.toContain('getItemLayout');
        expect(diagnostics).not.toContain('initialNumToRender');
        expect(diagnostics).not.toContain('keyboardShouldPersistTaps');
        expect(diagnostics).not.toContain('maxToRenderPerBatch');
        expect(diagnostics).not.toContain('nativeID');
        expect(diagnostics).not.toContain('onContentSizeChange');
        expect(diagnostics).not.toContain('onMomentumScrollBegin');
        expect(diagnostics).not.toContain('onScrollEndDrag');
        expect(diagnostics).not.toContain('onScrollToIndexFailed');
        expect(diagnostics).not.toContain('removeClippedSubviews');
        expect(diagnostics).not.toContain('testID');
        expect(diagnostics).not.toContain('windowSize');
    });

});
