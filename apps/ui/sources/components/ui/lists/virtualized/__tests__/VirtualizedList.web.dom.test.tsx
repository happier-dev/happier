// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StyleSheet, type ViewToken } from 'react-native';

import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';

import { VirtualizedList } from '../VirtualizedList';
import { CollectionList } from '../../collection/CollectionList';
import { DiffFilesListView } from '@/components/ui/code/diff/DiffFilesListView';
import { installClampedWebScrollGeometry } from '@/dev/testkit/legend/webScrollGeometry';
import { useScmDiffExpandedKeys } from '@/components/workspaces/scm/review/useScmDiffExpandedKeys';

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
    let initialScrollBy: PropertyDescriptor | undefined;

    beforeEach(() => {
        initialScrollBy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollBy');
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
        if (initialScrollBy) Object.defineProperty(HTMLElement.prototype, 'scrollBy', initialScrollBy);
        else Reflect.deleteProperty(HTMLElement.prototype, 'scrollBy');
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

    it('counts content padding inside the content container\'s full-height minimum, so a short list never scrolls', async () => {
        await act(async () => {
            root.render(
                <div id="virtualized-list-host" style={{ display: 'flex', flexDirection: 'column', height: 400 }}>
                    <VirtualizedList
                        data={[{ id: 'only' }]}
                        estimatedItemSize={56}
                        getFixedItemSize={() => 56}
                        contentContainerStyle={{ paddingBottom: 16 }}
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
        // Legend sizes this plain element `min-height: 100%`; content-box would add the padding on top of
        // the viewport and leave a short rail scrollable by exactly its padding.
        expect(window.getComputedStyle(content!).boxSizing).toBe('border-box');
    });

    it('publishes measured content and viewport dimensions with a real web scroll event', async () => {
        const onScroll = vi.fn();
        const onContentSizeChange = vi.fn();
        await act(async () => {
            root.render(<div id="virtualized-list-host" style={{ display: 'flex', flexDirection: 'column', height: 400 }}>
                <VirtualizedList
                    data={Array.from({ length: 100 }, (_, index) => ({ id: `row-${index}` }))}
                    estimatedItemSize={56}
                    getFixedItemSize={() => 56}
                    keyExtractor={item => item.id}
                    renderItem={({ item }) => <div data-row-height="56">{item.id}</div>}
                    onScroll={onScroll}
                    onContentSizeChange={onContentSizeChange}
                    recycleItems={false}
                />
            </div>);
        });
        await flushLegendWork();
        const scrollElement = container.querySelector<HTMLElement>('[style*="overflow-y: auto"]');
        expect(scrollElement).not.toBeNull();
        await act(async () => {
            scrollElement!.scrollTop = 250;
            scrollElement!.dispatchEvent(new Event('scroll'));
            await vi.runOnlyPendingTimersAsync();
        });
        expect(onScroll).toHaveBeenCalled();
        const event = onScroll.mock.calls.at(-1)?.[0];
        expect(event.nativeEvent.contentOffset.y).toBe(250);
        expect(event.nativeEvent.layoutMeasurement.height).toBe(400);
        expect(event.nativeEvent.contentSize.height).toBeGreaterThan(400);
        // The web backend deliberately omits this native-only DOM prop;
        // scroll consumers use the metrics the real event already publishes.
        expect(onContentSizeChange).not.toHaveBeenCalled();
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

    // A retained surface that is not being presented is `display: none`, so every row the list renders
    // there measures 0 x 0. Legend accepts a 0 x 0 row (its own viewport ignores 0 x 0, its row
    // coordinator does not), so a data change under a hidden surface made every row "fit": the pool
    // grew a batch per layout pass until React's nested-update limit threw (Settings -> Actions, DF33).
    it('does not relayout a list inside a hidden retained surface, and shows current data once presented', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const makeRows = (prefix: string, count: number): Row[] => Array.from({ length: count }, (_value, index) => ({ id: `${prefix}-${index}` }));
        const Surface = (props: Readonly<{ presented: boolean; rows: readonly Row[] }>) => (
            <RetainedPanelSurface isActive={props.presented}>
                <div id="virtualized-list-host" style={{ display: 'flex', flexDirection: 'column', height: 400 }}>
                    <VirtualizedList
                        data={props.rows}
                        estimatedItemSize={560}
                        keyExtractor={(item) => item.id}
                        recycleItems
                        renderItem={({ item }) => <div data-row-height="56" data-testid={`row:${item.id}`} role="option">{item.id}</div>}
                    />
                </div>
            </RetainedPanelSurface>
        );
        const render = async (presented: boolean, rows: readonly Row[]) => {
            await act(async () => { root.render(<Surface presented={presented} rows={rows} />); });
            await flushLegendWork();
        };
        const mountedRows = () => container.querySelectorAll('[role="option"]').length;

        await render(true, makeRows('first', 200));
        const presentedWindow = mountedRows();
        expect(presentedWindow).toBeGreaterThan(0);
        expect(presentedWindow).toBeLessThan(40);

        await render(false, makeRows('second', 180));
        expect(mountedRows()).toBeLessThanOrEqual(presentedWindow);
        expect(consoleError.mock.calls.flat().map(String).join('\n')).not.toContain('Maximum update depth');

        await render(true, makeRows('second', 180));
        expect(container.querySelector('[data-testid="row:second-0"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="row:first-0"]')).toBeNull();
        expect(mountedRows()).toBeLessThan(40);
    });

    it('keeps unchanged Review rows mounted and quiet when 59,165 files gain two entries', async () => {
        installClampedWebScrollGeometry();
        const initialFiles = Array.from({ length: 59_165 }, (_, index) => ({ key: `count-${index}`, added: 1, removed: 0 }));
        const renders: string[] = [];
        const mounts: string[] = [];
        const unmounts: string[] = [];
        let toggle: (key: string) => void;
        function RowBody({ file, expanded }: { file: (typeof initialFiles)[number]; expanded: boolean }) {
            renders.push(file.key);
            React.useLayoutEffect(() => {
                mounts.push(file.key);
                return () => { unmounts.push(file.key); };
            }, [file.key]);
            return <div data-row-height={expanded ? '120' : '84'} data-file-id={file.key}>{file.added}</div>;
        }
        const renderFileRow = ({ file, expanded }: { file: (typeof initialFiles)[number]; expanded: boolean }) => <RowBody file={file} expanded={expanded} />;
        function Review({ files }: { files: typeof initialFiles }) {
            const allKeys = React.useMemo(() => files.map(file => file.key), [files]);
            const [viewableIndices, setViewableIndices] = React.useState<readonly number[]>([]);
            const expansion = useScmDiffExpandedKeys({ allKeys, viewableIndices, tooLarge: true,
                aheadCount: 14, behindCount: 8, resetKey: 'same-review' });
            toggle = expansion.toggleCollapsed;
            return <DiffFilesListView files={files} virtualizeFileList expandedKeys={expansion.expandedKeys}
                onViewableItemsChanged={({ viewableItems }: { viewableItems: ViewToken[] }) => setViewableIndices(viewableItems.flatMap(token => typeof token.index === 'number' ? [token.index] : []))}
                onToggleExpanded={expansion.toggleCollapsed} canRenderInlineDiffs={false} wrapLines showLineNumbers showPrefix
                renderFileRow={renderFileRow} />;
        }
        const render = (files: typeof initialFiles) => act(async () => root.render(
            <div id="virtualized-list-host" style={{ display: 'flex', flexDirection: 'column', height: 400 }}><Review files={files} /></div>,
        ));
        await render(initialFiles);
        await flushLegendWork();
        await act(async () => toggle!(initialFiles[0]!.key));
        await flushLegendWork();
        expect(container.querySelector('[data-file-id="count-0"]')?.getAttribute('data-row-height')).toBe('84');
        const mountedCount = container.querySelectorAll('[data-file-id]').length;
        expect(mountedCount).toBeGreaterThan(0);
        expect(mountedCount).toBeLessThan(40);
        renders.length = mounts.length = unmounts.length = 0;
        await render([...initialFiles, { key: 'count-new-a', added: 1, removed: 0 }, { key: 'count-new-b', added: 1, removed: 0 }]);
        await flushLegendWork();
        expect.soft(renders, 'an append preserves the folds and identities of existing rows').toEqual([]);
        expect.soft(mounts).toEqual([]);
        expect.soft(unmounts).toEqual([]);
        expect(container.querySelectorAll('[data-file-id]').length).toBeLessThan(40);
        // A real visible data change must still reach its row.
        renders.length = mounts.length = unmounts.length = 0;
        await render([{ ...initialFiles[0]!, added: 2 }, ...initialFiles.slice(1)]);
        await flushLegendWork();
        expect(new Set(renders)).toEqual(new Set(['count-0']));
        expect(container.querySelector('[data-file-id="count-0"]')?.textContent).toBe('2');
        expect(mounts).toEqual([]);
        expect(unmounts).toEqual([]);
    });


});
