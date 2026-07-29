/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { lightTheme } from '@/theme';
import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Row = Readonly<{ id: string }>;
type ResizeObserverRecord = Readonly<{
    callback: ResizeObserverCallback;
    elements: Set<Element>;
}>;

const resizeObservers = new Set<ResizeObserverRecord>();
const scrollOffsets = new WeakMap<HTMLElement, number>();
let windowWidth = 390;
const testTheme = lightTheme;

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

function virtualContentHeight(element: HTMLElement): number {
    let height = 0;
    for (const descendant of element.querySelectorAll<HTMLElement>('[style]')) {
        height = Math.max(height, Number.parseFloat(descendant.style.height || '0') || 0);
    }
    return height;
}

function findDetailWrapper(element: HTMLElement): HTMLElement | null {
    return element
        .closest<HTMLElement>('[data-testid="agent-input-chip-picker.detail-pane-test-host"]')
        ?.parentElement ?? null;
}

function isBoundedDetailWrapper(element: HTMLElement | null): boolean {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    return style.flexGrow === '1' && (style.minHeight === '0px' || style.minHeight === '0');
}

function measuredRect(element: Element): DOMRectReadOnly {
    const htmlElement = element as HTMLElement;
    if (htmlElement.style.overflowY === 'auto' || htmlElement.style.overflow === 'auto') {
        const contentHeight = virtualContentHeight(htmlElement);
        if (contentHeight === 0 || isBoundedDetailWrapper(findDetailWrapper(htmlElement))) {
            return rect(windowWidth, 400);
        }
        return rect(windowWidth, contentHeight);
    }

    const row = htmlElement.querySelector<HTMLElement>('[data-row-height]');
    if (row) return rect(windowWidth, Number(row.dataset.rowHeight ?? 56));

    return rect(
        windowWidth,
        Number.parseFloat(htmlElement.style.height || '') || 400,
    );
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

function findScrollElement(container: HTMLElement): HTMLElement | null {
    return [...container.querySelectorAll<HTMLElement>('[style]')].find((element) => (
        element.style.overflowY === 'auto' || element.style.overflow === 'auto'
    )) ?? null;
}

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: unknown) => typeof factory === 'function'
            ? (factory as (theme: typeof testTheme) => unknown)(testTheme)
            : factory,
    },
    useUnistyles: () => ({ theme: testTheme }),
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/modal/components/card', () => ({ ModalCloseButton: () => null }));
vi.mock('@/components/ui/text/Text', async () => {
    const { TextInput } = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return {
        Text: (props: React.PropsWithChildren<Record<string, unknown>>) => (
            <span>{props.children}</span>
        ),
        TextInput,
    };
});
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => (
        <button
            aria-label={typeof props.accessibilityLabel === 'string' ? props.accessibilityLabel : undefined}
            aria-posinset={typeof props.accessibilityPositionInSet === 'number'
                ? props.accessibilityPositionInSet
                : undefined}
            aria-selected={props.selected === true ? 'true' : 'false'}
            aria-setsize={typeof props.accessibilitySetSize === 'number'
                ? props.accessibilitySetSize
                : undefined}
            data-testid={typeof props.testID === 'string' ? props.testID : undefined}
            disabled={props.disabled === true}
            id={typeof props.webId === 'string' ? props.webId : undefined}
            onClick={typeof props.onPress === 'function'
                ? () => (props.onPress as () => void)()
                : undefined}
            role={typeof props.webRole === 'string' ? props.webRole : undefined}
            type="button"
        >
            {props.title as React.ReactNode}
            {props.rightElement as React.ReactNode}
        </button>
    ),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: React.PropsWithChildren) => <>{props.children}</>,
}));
vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemListStatic: (props: React.PropsWithChildren) => <>{props.children}</>,
}));
vi.mock('./AgentInputChipPickerDetailPane', () => ({
    AgentInputChipPickerDetailPane: (props: {
        option: { renderDetailContent?: (context: { onRequestClose: () => void }) => React.ReactNode };
        onRequestClose: () => void;
    }) => (
        <div
            data-testid="agent-input-chip-picker.detail-pane-test-host"
            style={{ display: 'flex', flex: 1, minHeight: 0 }}
        >
            {props.option.renderDetailContent?.({ onRequestClose: props.onRequestClose })}
        </div>
    ),
}));
vi.mock('./AgentInputChipPickerOptionSelector', () => ({
    AgentInputChipPickerOptionSelector: () => <div style={{ height: 56 }} />,
}));
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({ ActivitySpinner: () => null }));
vi.mock('@/components/ui/buttons/IconButton', () => ({ IconButton: () => null }));
vi.mock('@/components/ui/forms/Switch', () => ({ Switch: () => null }));
vi.mock('@/components/ui/navigation/SegmentedTabBar', () => ({ SegmentedTabBar: () => null }));
vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: React.ReactNode) => node,
}));
vi.mock('@/keyboard/escape', () => ({
    ESCAPE_LAYER_PRIORITIES: { modal: 100 },
    useEscapeLayer: () => {},
}));

describe('AgentInputChipPickerPanel virtualized detail layout on web', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.useFakeTimers();
        resizeObservers.clear();
        windowWidth = 390;
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: windowWidth });

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
                return Math.max(element.clientHeight, virtualContentHeight(element));
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
            configurable: true,
            get() {
                return scrollOffsets.get(this) ?? 0;
            },
            set(value: number) {
                scrollOffsets.set(this, value);
            },
        });
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            writable: true,
            value(optionsOrX: ScrollToOptions | number, y?: number) {
                const element = this as HTMLElement;
                const requestedTop = typeof optionsOrX === 'number'
                    ? (y ?? 0)
                    : (optionsOrX.top ?? element.scrollTop);
                element.scrollTop = Math.max(
                    0,
                    Math.min(requestedTop, element.scrollHeight - element.clientHeight),
                );
                element.dispatchEvent(new Event('scroll', { bubbles: true }));
            },
        });
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    async function renderPanel(options?: Readonly<{
        detailContentOwnsScroll?: boolean;
        renderVirtualizedDetail?: boolean;
        width?: number;
    }>) {
        const { AgentInputChipPickerPanel } = await import('./AgentInputChipPickerPanel');
        const rows = Array.from({ length: 500 }, (_value, index): Row => ({
            id: `row-${index}`,
        }));
        windowWidth = options?.width ?? 390;
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: windowWidth });

        await act(async () => {
            window.dispatchEvent(new Event('resize'));
            root.render(
                <AgentInputChipPickerPanel
                    title=""
                    showCloseButton={false}
                    maxHeight={520}
                    detailContentOwnsScroll={options?.detailContentOwnsScroll}
                    options={[{
                        id: 'catalog',
                        label: 'Catalog',
                        renderDetailContent: () => options?.renderVirtualizedDetail === false
                            ? <div data-testid="static-detail">Static detail</div>
                            : (
                                <VirtualizedList
                                    data={rows}
                                    estimatedItemSize={56}
                                    keyExtractor={(item) => item.id}
                                    recycleItems={false}
                                    renderItem={({ item }) => (
                                        <div
                                            data-row-height="56"
                                            data-row-id={item.id}
                                            role="option"
                                            style={{ height: 56 }}
                                        >
                                            {item.id}
                                        </div>
                                    )}
                                />
                            ),
                    }]}
                    selectedOptionId="catalog"
                    onSelect={() => {}}
                    onRequestClose={() => {}}
                />,
            );
        });
        await flushLegendWork();
    }

    it('bounds and scrolls the installed Legend list in the compact own-scroll branch', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await renderPanel({ detailContentOwnsScroll: true, width: 390 });

        const scrollElement = findScrollElement(container);
        expect(scrollElement).not.toBeNull();
        expect(scrollElement!.clientHeight).toBe(400);
        expect(scrollElement!.scrollHeight).toBeGreaterThan(scrollElement!.clientHeight);

        const initialRows = [...container.querySelectorAll<HTMLElement>('[data-row-id]')]
            .map((element) => element.dataset.rowId);
        expect(initialRows.length).toBeGreaterThan(0);
        expect(initialRows.length).toBeLessThan(100);

        await act(async () => {
            scrollElement!.scrollTo({ top: 10_000 });
        });
        await flushLegendWork();

        const scrolledRows = [...container.querySelectorAll<HTMLElement>('[data-row-id]')]
            .map((element) => element.dataset.rowId);
        expect(scrollElement!.scrollTop).toBeGreaterThan(0);
        expect(scrolledRows.length).toBeGreaterThan(0);
        expect(scrolledRows.length).toBeLessThan(100);
        expect(scrolledRows).not.toEqual(initialRows);

        const diagnostics = [...consoleError.mock.calls, ...consoleWarn.mock.calls]
            .flat()
            .map(String)
            .join('\n');
        expect(diagnostics).not.toContain('unbounded outer height');
    });

    it('keeps the wide own-scroll branch bounded', async () => {
        await renderPanel({ detailContentOwnsScroll: true, width: 1280 });

        const scrollElement = findScrollElement(container);
        expect(scrollElement).not.toBeNull();
        expect(scrollElement!.scrollHeight).toBeGreaterThan(scrollElement!.clientHeight);
    });

    it('does not force a compact non-list detail into the own-scroll fill contract', async () => {
        await renderPanel({
            detailContentOwnsScroll: false,
            renderVirtualizedDetail: false,
            width: 390,
        });

        const detailHost = container.querySelector<HTMLElement>(
            '[data-testid="agent-input-chip-picker.detail-pane-test-host"]',
        );
        expect(detailHost).not.toBeNull();
        expect(isBoundedDetailWrapper(detailHost!.parentElement)).toBe(false);
    });

    it('restores the full catalog after search selection and clear through the compact picker composition', async () => {
        const { AgentInputChipPickerPanel } = await import('./AgentInputChipPickerPanel');
        const { OptionPickerOverlay } = await import('@/components/sessions/pickers/OptionPickerOverlay');
        const modelOptions = Array.from({ length: 500 }, (_value, index) => {
            const position = String(index + 1).padStart(5, '0');
            return {
                value: `q24-model-${position}`,
                label: `Q24 Catalog Model ${position}`,
            };
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        function CatalogPicker(): React.ReactElement {
            const [selectedModel, setSelectedModel] = React.useState(modelOptions[0]!.value);
            return (
                <AgentInputChipPickerPanel
                    title=""
                    showCloseButton={false}
                    maxHeight={520}
                    detailContentOwnsScroll
                    options={[{
                        id: 'codex',
                        label: 'Codex',
                        renderDetailContent: () => (
                            <OptionPickerOverlay
                                fillAvailableSpace
                                title="Model"
                                options={modelOptions}
                                selectedValue={selectedModel}
                                emptyText="No models"
                                canEnterCustomValue={false}
                                onSelect={setSelectedModel}
                            />
                        ),
                    }]}
                    selectedOptionId="codex"
                    onSelect={() => {}}
                    onRequestClose={() => {}}
                />
            );
        }

        windowWidth = 390;
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: windowWidth });
        await act(async () => {
            window.dispatchEvent(new Event('resize'));
            root.render(<CatalogPicker />);
        });
        await flushLegendWork();

        const input = container.querySelector<HTMLInputElement>(
            '[data-testid="model-picker-overlay-search"]',
        );
        expect(input).not.toBeNull();
        expect(container.querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe('Model');
        expect(container.querySelectorAll('[role="option"]').length).toBeGreaterThan(1);

        const setInputValue = (value: string) => {
            const setter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                'value',
            )?.set;
            setter?.call(input, value);
            input!.dispatchEvent(new Event('input', { bubbles: true }));
        };
        await act(async () => setInputValue('00484'));
        await flushLegendWork();

        const filteredRows = container.querySelectorAll<HTMLElement>('[role="option"]');
        expect(filteredRows).toHaveLength(1);
        expect(filteredRows[0]?.textContent).toContain('00484');

        await act(async () => {
            input!.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'ArrowDown',
                code: 'ArrowDown',
                bubbles: true,
                cancelable: true,
            }));
            input!.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                bubbles: true,
                cancelable: true,
            }));
        });
        await flushLegendWork();
        expect(container.querySelector(
            '[data-testid="model-picker-overlay-option:q24-model-00484"][aria-selected="true"]',
        )).not.toBeNull();

        await act(async () => setInputValue(''));
        await flushLegendWork();

        const restoredRows = container.querySelectorAll<HTMLElement>('[role="option"]');
        expect(input!.value).toBe('');
        expect(restoredRows.length).toBeGreaterThan(1);
        expect(restoredRows.length).toBeLessThan(100);
        expect(restoredRows[0]?.getAttribute('aria-setsize')).toBe('500');
        expect(container.querySelector(
            '[data-testid="model-picker-overlay-option:q24-model-00484"][aria-selected="true"]',
        )).not.toBeNull();

        const scrollElement = findScrollElement(container);
        expect(scrollElement).not.toBeNull();
        expect(scrollElement!.scrollHeight).toBeGreaterThan(scrollElement!.clientHeight);

        const diagnostics = [...consoleError.mock.calls, ...consoleWarn.mock.calls]
            .flat()
            .map(String)
            .join('\n');
        expect(diagnostics).not.toContain('unbounded outer height');
        expect(diagnostics).not.toContain('webScrollH');
    });
});
