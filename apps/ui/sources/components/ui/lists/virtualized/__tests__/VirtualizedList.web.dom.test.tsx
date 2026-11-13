// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StyleSheet, type ViewStyle, type ViewToken } from 'react-native';

import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

import { VirtualizedList } from '../VirtualizedList';
import { VirtualizedItemList } from '../../VirtualizedItemList';
import { CollectionList } from '../../collection/CollectionList';
import { DiffFilesListView, type DiffFilesListViewHandle } from '@/components/ui/code/diff/DiffFilesListView';
import { installClampedWebScrollGeometry, readVirtualizedWebRowTop } from '@/dev/testkit/legend/webScrollGeometry';
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

    it.each([VirtualizedList, VirtualizedItemList])('preserves Unistyles bounds and content padding through %s', async (List) => {
        // Unistyles 3 web create/removeInlineStyles stores values as non-enumerable own properties.
        // Model that external style boundary; keep RNW and the recycler real.
        const entry = (values: ViewStyle): ViewStyle => Object.defineProperties({}, {
            unistyles_test: { value: {}, enumerable: true },
            ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, enumerable: false }])),
        });
        await act(async () => root.render(
            <List data={[{ id: 'bounded' }]} testID="bounded-list"
                style={[entry({ maxHeight: 240, flexGrow: 0 }), false, [{ minHeight: 0 }]]}
                contentContainerStyle={[entry({ paddingHorizontal: 18, paddingVertical: 12 }), [{ paddingBottom: 8 }]]}
                estimatedItemSize={56} keyExtractor={item => item.id}
                renderItem={({ item }) => <div data-row-height="56">{item.id}</div>} />,
        ));
        await flushLegendWork();
        const scroller = container.querySelector<HTMLElement>('[data-testid="bounded-list"]')!;
        expect(window.getComputedStyle(scroller).maxHeight).toBe('240px');
        expect(window.getComputedStyle(scroller).flexGrow).toBe('0');
        const content = container.querySelector<HTMLElement>('.legend-list-content-container')!;
        expect(window.getComputedStyle(content).paddingTop).toBe('12px');
        expect(window.getComputedStyle(content).paddingLeft).toBe('18px');
        expect(window.getComputedStyle(content).paddingBottom).toBe('8px');
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
        // The backend adapts Legend's pushed virtual extent to the shared content-size contract.
        expect(onContentSizeChange).toHaveBeenLastCalledWith(800, event.nativeEvent.contentSize.height);
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

    it.each([Number.POSITIVE_INFINITY, Math.floor((2 ** 31 - 1) / 64)])('DiffFilesListView reveals exact first, middle and last identities in a 55,507-row variable-height inventory after membership changes (physical extent %s)', async (physicalExtent) => {
        const listRef = React.createRef<DiffFilesListViewHandle>();
        // Blink LayoutUnit stores CSS pixels in signed 32-bit units of 1/64 px:
        // https://chromium.googlesource.com/chromium/src/+/96b04b8744c3300c980cd87bc41cc3444d463fb0/third_party/blink/renderer/platform/geometry/layout_unit.h
        // Model the browser scroll boundary, including its content-height clamp. The real
        // virtualizer owns estimates, measurements, position correction and target settlement.
        installClampedWebScrollGeometry(physicalExtent);
        let rows = Array.from({ length: 55_507 }, (_, index) => ({ key: `file-${index}`, added: 1, removed: 0 }));
        let expandedId = rows[0]!.key;
        const render = async () => {
            await act(async () => root.render(
                <div id="virtualized-list-host" style={{ display: 'flex', flexDirection: 'column', height: 400 }}>
                    <DiffFilesListView ref={listRef} files={rows} virtualizeFileList
                        expandedKeys={new Set([...rows.slice(0, 20).map(row => row.key), expandedId])}
                        onToggleExpanded={() => {}} canRenderInlineDiffs={false} wrapLines showLineNumbers showPrefix
                        renderFileRow={({ file, expanded }) => <div data-row-height={expanded ? '1200' : '84'} data-file-id={file.key}>{file.key}</div>} />
                </div>,
            ));
            await flushLegendWork();
        };
        const reveal = async (index: number) => {
            expandedId = rows[index]!.key;
            await render();
            await act(async () => { listRef.current!.scrollToIndex({ index, animated: false, viewPosition: 0 }); });
            await flushLegendWork();
            const row = container.querySelector<HTMLElement>(`[data-file-id="${rows[index]!.key}"]`);
            const scroller = container.querySelector<HTMLElement>('[style*="overflow-y: auto"]')!;
            expect(row).not.toBeNull();
            // jsdom supplies no layout: read the real virtualizer's DOM placement at
            // the geometry boundary, rather than treating a pinned mounted row as visible.
            expect(readVirtualizedWebRowTop(row!, scroller), rows[index]!.key).toBeGreaterThanOrEqual(-1);
            expect(readVirtualizedWebRowTop(row!, scroller), rows[index]!.key).toBeLessThan(scroller.clientHeight);
        };
        await render();
        await reveal(0);
        await reveal(Math.floor(rows.length / 2));
        await reveal(rows.length - 1);
        rows = [{ key: 'added-file', added: 1, removed: 0 }, ...rows];
        await render();
        await reveal(0);
        await reveal(Math.floor(rows.length / 2));
        await reveal(rows.length - 1);
        rows = rows.filter(row => row.key !== 'file-2');
        await render();
        await reveal(0);
        await reveal(Math.floor(rows.length / 2));
        await reveal(rows.length - 1);
    });

    it('keeps a revealed final file on screen while the Review expansion window grows the 55,919-file list around it', async () => {
        // Production Review composition: the expansion window follows the list's own viewability. The
        // final file cannot reach the top, so files shown above it expand after the reveal settles.
        installClampedWebScrollGeometry();
        const files = Array.from({ length: 55_919 }, (_, index) => ({ key: `file-${index}`, added: 1, removed: 0 }));
        const keys = files.map(file => file.key);
        const listRef = React.createRef<DiffFilesListViewHandle>();
        let revealFile: (index: number) => void = () => {};
        function Review() {
            const [viewableIndices, setViewableIndices] = React.useState<readonly number[]>([]);
            const [reveal, setReveal] = React.useState<Readonly<{ key: string; index: number }> | null>(null);
            const { expandedKeys } = useScmDiffExpandedKeys({ allKeys: keys, viewableIndices, tooLarge: true, aheadCount: 14, behindCount: 8, resetKey: 'review', reveal });
            revealFile = (index) => {
                setReveal({ key: keys[index]!, index });
                listRef.current!.scrollToIndex({ index, animated: false, viewPosition: 0 });
            };
            return <DiffFilesListView ref={listRef} files={files} virtualizeFileList expandedKeys={expandedKeys}
                onViewableItemsChanged={({ viewableItems }: { viewableItems: ViewToken[] }) => setViewableIndices(viewableItems.flatMap(token => typeof token.index === 'number' ? [token.index] : []))}
                onToggleExpanded={() => {}} canRenderInlineDiffs={false} wrapLines showLineNumbers showPrefix
                renderFileRow={({ file, expanded }) => <div data-row-height={expanded ? '1200' : '84'} data-file-id={file.key}>{file.key}</div>} />;
        }
        await act(async () => root.render(
            <div id="virtualized-list-host" style={{ display: 'flex', flexDirection: 'column', height: 400 }}><Review /></div>,
        ));
        await flushLegendWork();
        const last = files.length - 1;
        await act(async () => { revealFile(last); });
        await flushLegendWork();
        await flushLegendWork();
        const row = container.querySelector<HTMLElement>(`[data-file-id="${keys[last]}"]`);
        const scroller = container.querySelector<HTMLElement>('[style*="overflow-y: auto"]')!;
        expect(row).not.toBeNull();
        expect(readVirtualizedWebRowTop(row!, scroller)).toBeGreaterThanOrEqual(-1);
        expect(readVirtualizedWebRowTop(row!, scroller)).toBeLessThan(scroller.clientHeight);
    });

    it('DiffFilesListView mounts only nearby leading rows of 55,000 and restores a scroll offset past them onto the same file', async () => {
        // The Review index draws as the list's leading rows (28px each); a remounted Review restores its
        // last scroll offset before any of them is measured. The offset must land on the file it left.
        installClampedWebScrollGeometry();
        const leadingKeys = Array.from({ length: 55_000 }, (_, index) => `index-${index}`);
        const files = Array.from({ length: 2_000 }, (_, index) => ({ key: `file-${index}`, added: 1, removed: 0 }));
        const listRef = React.createRef<DiffFilesListViewHandle>();
        await act(async () => root.render(
            <div id="virtualized-list-host" style={{ display: 'flex', flexDirection: 'column', height: 400 }}>
                <DiffFilesListView ref={listRef} files={files} virtualizeFileList expandedKeys={new Set()}
                    onToggleExpanded={() => {}} canRenderInlineDiffs={false} wrapLines showLineNumbers showPrefix
                    leadingRows={{ keys: leadingKeys, render: (index) => <div data-row-height="28">{leadingKeys[index]}</div>, estimatedSize: () => 28 }}
                    renderFileRow={({ file }) => <div data-row-height="84" data-file-id={file.key}>{file.key}</div>} />
            </div>,
        ));
        await flushLegendWork();
        // Only the rows near the viewport mount, never the 55,000-row inventory.
        expect(container.querySelectorAll('[data-row-height="28"]').length).toBeLessThan(500);
        // The first file sits right after the leading rows; file rows' own estimates are not under test.
        const target = 0;
        await act(async () => { listRef.current!.scrollToOffset({ offset: leadingKeys.length * 28, animated: false }); });
        await flushLegendWork();
        const scroller = container.querySelector<HTMLElement>('[style*="overflow-y: auto"]')!;
        const row = container.querySelector<HTMLElement>(`[data-file-id="file-${target}"]`);
        expect(row).not.toBeNull();
        expect(Math.abs(readVirtualizedWebRowTop(row!, scroller))).toBeLessThan(84);
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

    it('does not revisit offscreen item sizes on an unchanged retained return at 59,445 rows', async () => {
        const rows = Array.from({ length: 59_445 }, (_, index) => ({ id: `return-${index}` }));
        const mounted = new Set<string>();
        let countReads = false;
        let offscreenSizeReads = 0;
        let resizeFirst: (() => void) | undefined;
        function RowBody({ id }: Row) {
            const [height, setHeight] = React.useState(56);
            React.useLayoutEffect(() => {
                mounted.add(id);
                return () => { mounted.delete(id); };
            }, [id]);
            if (id === rows[0]!.id) resizeFirst = () => setHeight(84);
            return <div data-row-height={height} role="option">{id}</div>;
        }
        const content = <div id="virtualized-list-host" style={{ display: 'flex', flexDirection: 'column', height: 400 }}>
            <VirtualizedList data={rows} estimatedItemSize={56} keyExtractor={item => item.id}
                getItemType={item => {
                    if (countReads && !mounted.has(item.id)) offscreenSizeReads += 1;
                    return 'row';
                }}
                renderItem={({ item }) => <RowBody id={item.id} />} />
        </div>;
        const render = async (active: boolean) => {
            await act(async () => root.render(<RetainedPanelSurface isActive={active}>{content}</RetainedPanelSurface>));
            await flushLegendWork();
        };
        await render(true);
        expect(mounted.size).toBeGreaterThan(0);
        expect(mounted.size).toBeLessThan(40);
        countReads = true;
        await render(false);
        expect(offscreenSizeReads).toBe(0);
        await render(true);
        expect(offscreenSizeReads).toBe(0);
        // A genuine geometry change still reaches the list after the quiet return.
        await act(async () => resizeFirst!());
        await flushLegendWork();
        expect(container.querySelector('[role="option"]')?.getAttribute('data-row-height')).toBe('84');
    });

    it('parks 55,919 rows without mounting the inventory when a retained row settles while hidden', async () => {
        const rows = Array.from({ length: 55_919 }, (_, index) => ({ id: `park-${index}` }));
        let mounts = 0;
        let settle: (() => void) | undefined;
        function RowBody({ id }: { id: string }) {
            const [loaded, setLoaded] = React.useState(false);
            React.useLayoutEffect(() => { mounts += 1; }, []);
            if (id === 'park-0') settle = () => setLoaded(true);
            return <div data-row-height={loaded ? '84' : '56'} role="option">{id}</div>;
        }
        const content = <div id="virtualized-list-host" style={{ display: 'flex', flexDirection: 'column', height: 400 }}>
            <VirtualizedList data={rows} estimatedItemSize={56} keyExtractor={item => item.id}
                renderItem={({ item }) => <RowBody id={item.id} />} />
        </div>;
        const render = async (active: boolean) => {
            await act(async () => root.render(<RetainedPanelSurface isActive={active}>{content}</RetainedPanelSurface>));
            await flushLegendWork();
        };
        await render(true);
        const presentedMounts = mounts;
        expect(presentedMounts).toBeGreaterThan(0);
        expect(presentedMounts).toBeLessThan(40);
        mounts = 0;
        await render(false);
        await act(async () => settle!());
        await flushLegendWork();
        expect(mounts).toBe(0);
        await render(true);
        expect(mounts).toBeLessThan(40);
        expect(container.querySelector('[role="option"]')?.getAttribute('data-row-height')).toBe('84');
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

    it('keeps measured type averages accurate while toggling 55,919 diff files', async () => {
        installClampedWebScrollGeometry();
        const files = Array.from({ length: 55_919 }, (_, index) => ({ key: `file-${index}`, added: 1, removed: 0 }));
        const keys = files.map(file => file.key);
        const listRef = React.createRef<DiffFilesListViewHandle>();
        let toggleCollapsed: (key: string) => void;
        let revealFile: (index: number) => void;
        let commits = 0;
        const samples: Array<Record<string, { average: number; count: number }>> = [];
        const commitCounts: number[] = [];
        const errors: string[] = [];
        const onError = (event: ErrorEvent) => { errors.push(event.error instanceof Error ? event.error.message : event.message); };
        window.addEventListener('error', onError);
        function Review() {
            const [viewableIndices, setViewableIndices] = React.useState<readonly number[]>([]);
            const [reveal, setReveal] = React.useState<Readonly<{ key: string; index: number }> | null>(null);
            const window = useScmDiffExpandedKeys({ allKeys: keys, viewableIndices, tooLarge: true, aheadCount: 14, behindCount: 8, resetKey: 'legend-loop', reveal });
            toggleCollapsed = window.toggleCollapsed;
            revealFile = (index) => {
                setReveal({ key: keys[index]!, index });
                listRef.current!.scrollToIndex({ index, animated: false, viewPosition: 0 });
            };
            const expandedKeys = window.expandedKeys;
            return <DiffFilesListView ref={listRef} files={files} virtualizeFileList expandedKeys={expandedKeys}
                onViewableItemsChanged={({ viewableItems }: { viewableItems: ViewToken[] }) => setViewableIndices(viewableItems.flatMap(token => typeof token.index === 'number' ? [token.index] : []))}
                onToggleExpanded={window.toggleCollapsed} canRenderInlineDiffs={false} wrapLines showLineNumbers showPrefix
                renderFileRow={({ file, expanded }) => <div data-row-height={expanded ? '1200' : '84'} data-file-id={file.key}>{file.key}</div>} />;
        }
        function readAverages() {
            // Inspect Legend's public state through its mounted ref; the host intentionally
            // exposes only scroll commands. Keep sizing and the recycler real.
            const row = container.querySelector<HTMLElement>('[data-file-id]')!;
            const fiberKey = Object.keys(row).find(key => key.startsWith('__reactFiber$'))!;
            type Fiber = { return: Fiber | null; ref?: { current?: { getState?: () => { getAverageItemSizes: () => Record<string, { average: number; count: number }> } } } };
            let fiber = (row as unknown as Record<string, Fiber>)[fiberKey];
            for (; fiber; fiber = fiber.return!) {
                if (fiber.ref && typeof fiber.ref !== 'function' && fiber.ref.current?.getState) {
                    return fiber.ref.current.getState().getAverageItemSizes();
                }
            }
            throw new Error('Mounted Legend public getState ref not found');
        }
        try {
            await act(async () => root.render(<React.Profiler id="legend-loop" onRender={() => { commits += 1; }}>
                <div id="virtualized-list-host" style={{ display: 'flex', flexDirection: 'column', height: 400 }}><Review /></div>
            </React.Profiler>));
            await flushLegendWork();
            for (const index of [0]) {
                await act(async () => { revealFile!(index); });
                await flushLegendWork();
                for (let toggle = 0; toggle < 36; toggle += 1) {
                    commits = 0;
                    const key = keys[index]!;
                    const before = container.querySelector<HTMLElement>(`[data-file-id="${key}"]`)?.dataset.rowHeight;
                    await act(async () => { toggleCollapsed!(key); });
                    await flushLegendWork();
                    const after = container.querySelector<HTMLElement>(`[data-file-id="${key}"]`)?.dataset.rowHeight;
                    expect(after, "real row changes expanded/collapsed type").not.toBe(before);
                    const averages = readAverages();
                    // This is the only file ever measured collapsed. Expanding it must
                    // remove that contribution, including the now-empty type bucket.
                    expect.soft(averages.file?.count ?? 0, 'collapsed measurements follow their current type')
                        .toBe(after === '84' ? 1 : 0);
                    samples.push(averages);
                    commitCounts.push(commits);
                }
            }
            const beforeIdle = commits;
            await flushLegendWork();
            expect.soft(samples.flatMap(sample => Object.values(sample).filter(value => value.average < 0)),
                'per-type average sizes must remain non-negative').toEqual([]);
            for (const [type, height] of [['expanded-file', 1_200], ['file', 84]] as const) {
                const measurements = samples.flatMap(sample => sample[type] ? [sample[type]!.average] : []);
                expect(measurements.length).toBeGreaterThan(0);
                expect.soft(measurements.every(average => Math.abs(average - height) < 0.001),
                    `${type} average reflects only measurements of that type`).toBe(true);
            }
            // React's nested-update failure threshold is 50; this diagnostic distinguishes a settling
            // interaction from that failure class. It adds no product limit or scheduling guard.
            expect.soft(Math.max(...commitCounts), 'commits per toggle below nested-update threshold').toBeLessThan(50);
            expect.soft(commits - beforeIdle, 'settled list has no idle commits').toBe(0);
            expect.soft(errors.filter(error => /Maximum update depth/.test(error))).toEqual([]);
        } finally {
            window.removeEventListener('error', onError);
        }
    });
    it.each([
        ['the same commit hides it before presentation is withdrawn', 'same-commit'],
        ['list work scheduled while presented settles after the hide', 'pending-work'],
    ] as const)('parks 55,919 Review rows without mounting the inventory when %s', async (_label, order) => {
        // Live (agent-qa-perf #69, Project → Inbox): the parked Review list took new data while its
        // presentation was still true, was then hidden, and Legend kept measuring its containers at 0 x 0
        // until React's nested-update limit crashed the app after ~50k mounts.
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const errors: string[] = [];
        const onError = (event: ErrorEvent) => { errors.push(event.error instanceof Error ? event.error.message : event.message); };
        window.addEventListener('error', onError);
        let mounts = 0;
        function RowBody({ id }: { id: string }) {
            React.useLayoutEffect(() => { mounts += 1; }, []);
            return <div data-row-height="84" role="option">{id}</div>;
        }
        const makeRows = (revision: number) => Array.from({ length: 55_919 }, (_, index) => ({ id: `review-${index}`, revision }));
        const Surface = (props: Readonly<{ hidden: boolean; presented: boolean; rows: readonly (Row & { revision: number })[] }>) => (
            <div style={{ display: props.hidden ? 'none' : 'flex', flexDirection: 'column' }}>
                <PluginSurfaceFocusEligibilityProvider active={props.presented}>
                    <div id="virtualized-list-host" style={{ display: 'flex', flexDirection: 'column', height: 400 }}>
                        <VirtualizedList data={props.rows} estimatedItemSize={84} keyExtractor={item => item.id}
                            extraData={props.rows[0]?.revision} renderItem={({ item }) => <RowBody id={item.id} />} />
                    </div>
                </PluginSurfaceFocusEligibilityProvider>
            </div>
        );
        const render = (hidden: boolean, presented: boolean, rows: readonly (Row & { revision: number })[]) =>
            act(async () => { root.render(<Surface hidden={hidden} presented={presented} rows={rows} />); });
        try {
            await render(false, true, makeRows(1));
            await flushLegendWork();
            const presentedMounts = mounts;
            expect(presentedMounts).toBeGreaterThan(0);
            expect(presentedMounts).toBeLessThan(40);

            mounts = 0;
            if (order === 'same-commit') {
                await render(true, true, makeRows(2));
            } else {
                await render(false, true, makeRows(2));
                await render(true, true, makeRows(2));
            }
            await render(true, false, makeRows(3));
            await flushLegendWork();
            const hiddenMounts = mounts;

            mounts = 0;
            await render(false, true, makeRows(3));
            await flushLegendWork();
            expect({ hiddenMounts, crashed: errors.some(error => /Maximum update depth/.test(error)) })
                .toEqual({ hiddenMounts: 0, crashed: false });
            expect(mounts).toBeLessThan(40);
            expect(container.querySelectorAll('[role="option"]').length).toBeLessThan(40);
            expect(consoleError.mock.calls.flat().map(String).join('\n')).not.toContain('Maximum update depth');
        } finally {
            window.removeEventListener('error', onError);
        }
    });
});
