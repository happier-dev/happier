// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StyleSheet } from 'react-native';

import { VirtualizedList } from '../VirtualizedList';
import { CollectionList } from '../../collection/CollectionList';

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
        // Legend implements row gaps as cell padding. Include that real box
        // geometry when its ResizeObserver measures the rendered row wrapper.
        const style = window.getComputedStyle(htmlElement);
        const padding = (Number.parseFloat(style.paddingTop) || 0)
            + (Number.parseFloat(style.paddingBottom) || 0);
        return rect(800, Number(row.dataset.rowHeight ?? 56) + padding);
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
            writable: true,
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

    it('applies content padding with React Native array order and explicit-side precedence', async () => {
        const listRef = React.createRef<import('../virtualizedListTypes').VirtualizedListRef>();
        const styles = StyleSheet.create({
            content: { padding: 4, paddingHorizontal: 12, paddingVertical: 18, paddingLeft: 7, paddingBottom: 0 },
        });
        await act(async () => {
            root.render(
                <div id="virtualized-list-host" style={{ display: 'flex', flexDirection: 'column', height: 400 }}>
                    <VirtualizedList
                        ref={listRef}
                        backendPreference="legend"
                        data={[{ id: 'padded' }]}
                        estimatedItemSize={56}
                        getFixedItemSize={() => 56}
                        contentContainerStyle={[
                            styles.content,
                            false,
                            [{ paddingHorizontal: 24, paddingVertical: 30, paddingRight: 9, gap: 6 }],
                        ]}
                        keyExtractor={(item) => item.id}
                        recycleItems={false}
                        renderItem={({ item }) => <div data-row-height="56">{item.id}</div>}
                    />
                </div>,
            );
        });
        await flushLegendWork();

        const content = container.querySelector<HTMLElement>('.legend-list-content-container');
        expect(content).not.toBeNull();
        const style = window.getComputedStyle(content!);
        expect(style.paddingTop).toBe('30px');
        expect(style.paddingRight).toBe('9px');
        expect(style.paddingBottom).toBe('0px');
        expect(style.paddingLeft).toBe('7px');
        const state = listRef.current?.getState?.() as Readonly<{
            contentLength: number;
            sizeAtIndex: (index: number) => number | undefined;
        }>;
        expect(state).toMatchObject({ contentLength: expect.any(Number) });
        expect(Number.isFinite(state.contentLength)).toBe(true);
        // Legend includes its numeric row gap in fixed-item geometry.
        expect(state.sizeAtIndex(0)).toBe(62);
    });

    it.each(['standalone', 'collection-rail'] as const)('fills a bounded %s host and mounts only a virtualized window', async (surface) => {
        const rows = Array.from({ length: 500 }, (_value, index): Row => ({
            id: `row-${index}`,
        }));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const list = <VirtualizedList
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
                    />;
        await act(async () => {
            root.render(
                <div
                    id="virtualized-list-host"
                    style={{ display: 'flex', flexDirection: 'column', height: 400 }}
                >
                    {surface === 'collection-rail' ? (
                        <CollectionList
                            title="Teams"
                            search={{ value: '', placeholder: 'Search Teams', onChangeText: () => {} }}
                            scrollContent={list}
                        />
                    ) : list}
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
        expect(container.querySelectorAll('[style*="overflow-y: auto"]').length).toBe(1);
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

    // The stable ref promises `scrollToIndex` on every backend. React Native's FlatList throws an
    // invariant for an index outside its rendered window unless the caller supplies getItemLayout or
    // onScrollToIndexFailed; the session list (flat on web) supplies neither, and a scroll-retention
    // restore crashed the app shell ("scrollToIndex should be used in conjunction with ...").
    it('scrolls a flat-backend list to an index outside its rendered window without a layout callback', async () => {
        const rows = Array.from({ length: 500 }, (_value, index): Row => ({ id: `row-${index}` }));
        const { VirtualizedList: List } = await import('../VirtualizedList');
        const listRef = React.createRef<import('../virtualizedListTypes').VirtualizedListRef>();
        await act(async () => {
            root.render(
                <div id="virtualized-list-host" style={{ display: 'flex', height: 400 }}>
                    <List
                        ref={listRef}
                        backendPreference="flat"
                        data={rows}
                        keyExtractor={(item) => item.id}
                        initialNumToRender={12}
                        renderItem={({ item }) => <div data-row-height="56">{item.id}</div>}
                    />
                </div>,
            );
        });
        await flushLegendWork();

        expect(listRef.current).not.toBeNull();
        let thrown: unknown = null;
        await act(async () => {
            try {
                await listRef.current!.scrollToIndex({ index: 400, animated: false, viewPosition: 0 });
            } catch (error) {
                thrown = error;
            }
        });
        expect(thrown).toBeNull();
    });

});
