import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installCodeDiffCommonModuleMocks } from './codeDiffTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const diffViewerSpy = vi.fn();
let flashListMockState: { props: any | null } | null = null;

function getFlashListProps() {
    expect(flashListMockState?.props).toBeTruthy();
    return flashListMockState!.props;
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    FlashList: (props: any) => {
        flashListMockState = flashListMockState ?? { props: null };
        flashListMockState.props = props;
        return React.createElement('FlashList', props);
    },
}));

installCodeDiffCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({ width: 1200, height: 800 }),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/code/diff/pierre/PierreScrollRootVirtualizerProvider', () => ({
    PierreScrollRootVirtualizerProvider: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/code/diff/DiffViewer', () => ({
    DiffViewer: (props: any) => {
        diffViewerSpy(props);
        return React.createElement('DiffViewer', props);
    },
}));

vi.mock('@/components/ui/code/diff/useInlineDiffVirtualizationThresholds', () => ({
    useInlineDiffVirtualizationThresholds: () => ({ lineThreshold: 50_000, byteThreshold: 100 }),
}));

describe('DiffFilesListView', () => {
    it('renders a virtualized file list when requested', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');
        flashListMockState = null;

        const files: any[] = [
            {
                key: 'k1',
                filePath: 'src/a.ts',
                added: 1,
                removed: 0,
                unifiedDiff: 'a\n',
                oldText: null,
                newText: null,
                kind: null,
            },
        ];

        await renderScreen(<DiffFilesListView
                    files={files}
                    expandedKeys={new Set()}
                    onToggleExpanded={() => {}}
                    canRenderInlineDiffs={true}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    virtualizeFileList
                />);

        expect(getFlashListProps()).toBeTruthy();
    });

    it('renders intrinsic native diff file lists without mounting a bounded virtualized list', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');
        const { Platform } = await import('react-native');
        const previousOS = Platform.OS;
        const previousSelect = Platform.select;
        flashListMockState = null;

        try {
            (Platform as unknown as { OS: string; select: (options: any) => unknown }).OS = 'ios';
            (Platform as unknown as { OS: string; select: (options: any) => unknown }).select = (options: any) => (
                options?.ios ?? options?.native ?? options?.default ?? options?.web ?? options?.android
            );

            const screen = await renderScreen(<DiffFilesListView
                        files={[
                            {
                                key: 'k1',
                                filePath: 'src/a.ts',
                                added: 1,
                                removed: 0,
                                unifiedDiff: 'a\n',
                                oldText: null,
                                newText: null,
                                kind: null,
                            },
                            {
                                key: 'k2',
                                filePath: 'src/b.ts',
                                added: 2,
                                removed: 1,
                                unifiedDiff: 'b\n',
                                oldText: null,
                                newText: null,
                                kind: null,
                            },
                        ] as any}
                        expandedKeys={new Set()}
                        onToggleExpanded={() => {}}
                        canRenderInlineDiffs={true}
                        wrapLines={true}
                        showLineNumbers={true}
                        showPrefix={true}
                        virtualizeFileList
                        virtualizedListLayout="intrinsic"
                    />);

            expect(screen.findAllByType('FlashList' as any)).toHaveLength(0);
            expect(screen.findAllByType('FlatList' as any)).toHaveLength(0);
            expect(screen.getTextContent()).toContain('src/a.ts');
            expect(screen.getTextContent()).toContain('src/b.ts');
        } finally {
            (Platform as unknown as { OS: string; select: (options: any) => unknown }).OS = previousOS;
            (Platform as unknown as { OS: string; select: (options: any) => unknown }).select = previousSelect;
        }
    });

    it('configures FlashList with stable virtualization defaults', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');
        flashListMockState = null;

        await renderScreen(<DiffFilesListView
                files={[{
                    key: 'k1',
                    filePath: 'src/a.ts',
                    added: 1,
                    removed: 0,
                    unifiedDiff: 'a\n',
                } as any]}
                expandedKeys={new Set()}
                onToggleExpanded={() => {}}
                canRenderInlineDiffs={true}
                wrapLines={true}
                showLineNumbers={true}
                showPrefix={true}
                virtualizeFileList
            />);

        const listProps = getFlashListProps();
        expect(typeof listProps.drawDistance).toBe('number');
        expect(Number.isFinite(listProps.drawDistance)).toBe(true);
        expect(listProps.drawDistance).toBeGreaterThan(0);
        expect(listProps.drawDistance).toBe(1600);
        expect(typeof listProps.overrideItemLayout).toBe('function');
        expect(typeof listProps.getItemType).toBe('function');
        expect(typeof listProps.estimatedItemSize).toBe('number');
        expect(Number.isFinite(listProps.estimatedItemSize)).toBe(true);
        expect(listProps.estimatedItemSize).toBeGreaterThan(0);
    });

    it('allows callers to reduce FlashList draw distance for dense review lists', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');
        flashListMockState = null;

        await renderScreen(<DiffFilesListView
                files={[{
                    key: 'k1',
                    filePath: 'src/a.ts',
                    added: 1,
                    removed: 0,
                    unifiedDiff: 'a\n',
                } as any]}
                expandedKeys={new Set()}
                onToggleExpanded={() => {}}
                canRenderInlineDiffs={true}
                wrapLines={true}
                showLineNumbers={true}
                showPrefix={true}
                virtualizeFileList
                drawDistanceMultiplier={0.75}
            />);

        expect(getFlashListProps().drawDistance).toBe(600);
    });

    it('forwards scroll handlers to the underlying list when virtualized', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');
        flashListMockState = null;

        const onScroll = vi.fn();
        const onLayout = vi.fn();
        const onContentSizeChange = vi.fn();

        await renderScreen(<DiffFilesListView
                files={[{
                    key: 'k1',
                    filePath: 'src/a.ts',
                    added: 1,
                    removed: 0,
                    unifiedDiff: 'a\n',
                }]}
                expandedKeys={new Set()}
                onToggleExpanded={() => {}}
                canRenderInlineDiffs={true}
                wrapLines={true}
                showLineNumbers={true}
                showPrefix={true}
                virtualizeFileList
                onScroll={onScroll}
                onLayout={onLayout}
                onContentSizeChange={onContentSizeChange}
            />);

        const listProps = getFlashListProps();
        expect(listProps.onScroll).toBe(onScroll);
        expect(listProps.onLayout).toBe(onLayout);
        expect(listProps.onContentSizeChange).toBe(onContentSizeChange);
    });

    it('passes a flat style object to FlashList when virtualized', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');
        flashListMockState = null;

        await renderScreen(<DiffFilesListView
                files={[{
                    key: 'k1',
                    filePath: 'src/a.ts',
                    added: 1,
                    removed: 0,
                    unifiedDiff: 'a\n',
                } as any]}
                expandedKeys={new Set()}
                onToggleExpanded={() => {}}
                canRenderInlineDiffs={true}
                wrapLines={true}
                showLineNumbers={true}
                showPrefix={true}
                virtualizeFileList
            />);

        const listProps = getFlashListProps();
        expect(Array.isArray(listProps.style)).toBe(false);
        expect(typeof listProps.style).toBe('object');
    });

    it('keeps virtualized list row plumbing stable across equivalent parent rerenders', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');
        flashListMockState = null;
        const files = [{
            key: 'k1',
            filePath: 'src/a.ts',
            added: 1,
            removed: 0,
            unifiedDiff: 'a\n',
        } as any];
        const expandedKeys = new Set<string>();
        const onToggleExpanded = vi.fn();

        function Wrapper(props: Readonly<{ tick: number }>) {
            return (
                <>
                    {React.createElement('TickMarker', { value: props.tick })}
                    <DiffFilesListView
                        files={files}
                        expandedKeys={expandedKeys}
                        onToggleExpanded={onToggleExpanded}
                        canRenderInlineDiffs={true}
                        wrapLines={true}
                        showLineNumbers={true}
                        showPrefix={true}
                        virtualizeFileList
                    />
                </>
            );
        }

        const { tree } = await renderScreen(<Wrapper tick={0} />);
        const before = getFlashListProps();

        await act(async () => {
            tree.update(<Wrapper tick={1} />);
        });
        const after = getFlashListProps();

        expect(after.keyExtractor).toBe(before.keyExtractor);
        expect(after.renderItem).toBe(before.renderItem);
        expect(after.contentContainerStyle).toBe(before.contentContainerStyle);
        expect(after.style).toBe(before.style);
    });

    it('enables virtualization when the diff exceeds the byte threshold', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');

        diffViewerSpy.mockClear();

        const files: any[] = [
            {
                key: 'k1',
                filePath: 'src/minified.js',
                added: 1,
                removed: 1,
                unifiedDiff: 'a'.repeat(2_000),
                oldText: null,
                newText: null,
                kind: null,
            },
        ];

        const screen = await renderScreen(<DiffFilesListView
                    files={files}
                    expandedKeys={new Set(['k1'])}
                    onToggleExpanded={() => {}}
                    canRenderInlineDiffs={true}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />);

        expect(diffViewerSpy).toHaveBeenCalledWith(expect.objectContaining({ virtualized: true }));
        const virtualizedContainerStyles = screen.findAll((node) => {
            const style = flattenStyle(node.props?.style);
            return String(node.type) === 'View' && typeof style.maxHeight === 'number' && style.maxHeight > 0;
        }).map((node) => flattenStyle(node.props?.style));
        expect(virtualizedContainerStyles).toHaveLength(1);
        expect(virtualizedContainerStyles[0].height).toBe(virtualizedContainerStyles[0].maxHeight);
    });

    it('uses renderInlineUnifiedDiff override when provided', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');

        diffViewerSpy.mockClear();
        const renderInlineUnifiedDiff = vi.fn(() => React.createElement('CustomInlineDiff'));

        await renderScreen(<DiffFilesListView
                    files={[{
                        key: 'k1',
                        filePath: 'src/a.ts',
                        added: 1,
                        removed: 0,
                        unifiedDiff: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-foo\n+bar\n',
                        oldText: null,
                        newText: null,
                        kind: null,
                    } as any]}
                    expandedKeys={new Set(['k1'])}
                    onToggleExpanded={() => {}}
                    canRenderInlineDiffs={true}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    renderInlineUnifiedDiff={renderInlineUnifiedDiff}
                />);

        expect(renderInlineUnifiedDiff).toHaveBeenCalledTimes(1);
        expect(diffViewerSpy).toHaveBeenCalledTimes(0);
    });

    it('renders renderInlineUnifiedDiff override even when unifiedDiff is missing', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');

        diffViewerSpy.mockClear();
        const renderInlineUnifiedDiff = vi.fn(() => React.createElement('CustomInlineDiff'));

        await renderScreen(<DiffFilesListView
                    files={[{
                        key: 'k1',
                        filePath: 'src/empty.ts',
                        added: 0,
                        removed: 0,
                        unifiedDiff: undefined,
                        oldText: null,
                        newText: null,
                        kind: null,
                    } as any]}
                    expandedKeys={new Set(['k1'])}
                    onToggleExpanded={() => {}}
                    canRenderInlineDiffs={true}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    renderInlineUnifiedDiff={renderInlineUnifiedDiff}
                />);

        expect(renderInlineUnifiedDiff).toHaveBeenCalledTimes(1);
        expect(diffViewerSpy).toHaveBeenCalledTimes(0);
    });

    it('uses renderFileRow override when provided', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');

        const screen = await renderScreen(<DiffFilesListView
                    files={[{
                        key: 'k1',
                        filePath: 'src/a.ts',
                        added: 1,
                        removed: 0,
                        unifiedDiff: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-foo\n+bar\n',
                    } as any]}
                    expandedKeys={new Set()}
                    onToggleExpanded={() => {}}
                    canRenderInlineDiffs={true}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    renderFileRow={({ file }: any) => React.createElement('CustomRow', { testID: `custom-row:${file.key}` })}
                />);

        expect(screen.findByTestId('custom-row:k1')).toBeTruthy();
    });

    it('forces unified presentation for new files to avoid empty split columns', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');

        diffViewerSpy.mockClear();

        await renderScreen(<DiffFilesListView
                    files={[{
                        key: 'k1',
                        filePath: 'src/new.ts',
                        added: 10,
                        removed: 0,
                        unifiedDiff: 'diff --git a/src/new.ts b/src/new.ts\n@@ -0,0 +1 @@\n+export const x = 1;\n',
                        oldText: null,
                        newText: null,
                        kind: 'new',
                    } as any]}
                    expandedKeys={new Set(['k1'])}
                    onToggleExpanded={() => {}}
                    canRenderInlineDiffs={true}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />);

        expect(diffViewerSpy).toHaveBeenCalledWith(expect.objectContaining({ presentationStyleOverride: 'unified' }));
    });

    it('calls onOpenFile when pressing the open-file action', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');

        const onOpenFile = vi.fn();
        const onOpenFilePinned = vi.fn();

        const screen = await renderScreen(<DiffFilesListView
                    files={[{
                        key: 'k1',
                        filePath: 'src/a.ts',
                        added: 1,
                        removed: 0,
                        unifiedDiff: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-foo\n+bar\n',
                        oldText: null,
                        newText: null,
                        kind: null,
                    } as any]}
                    expandedKeys={new Set(['k1'])}
                    onToggleExpanded={() => {}}
                    canRenderInlineDiffs={true}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    onOpenFile={onOpenFile}
                    onOpenFilePinned={onOpenFilePinned}
                />);

        screen.pressByTestId('diff-files-open:k1');

        expect(onOpenFile).toHaveBeenCalledWith('src/a.ts');
        expect(onOpenFilePinned).toHaveBeenCalledTimes(0);
    });

    it('renders the open-file action when callers add the handler after first render', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');

        const files = [{
            key: 'k1',
            filePath: 'src/a.ts',
            added: 1,
            removed: 0,
            unifiedDiff: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-foo\n+bar\n',
            oldText: null,
            newText: null,
            kind: null,
        } as any];
        const onOpenFile = vi.fn();

        function Wrapper() {
            const [openEnabled, setOpenEnabled] = React.useState(false);
            return (
                <>
                    <DiffFilesListView
                        files={files}
                        expandedKeys={new Set()}
                        onToggleExpanded={() => {}}
                        canRenderInlineDiffs={true}
                        wrapLines={true}
                        showLineNumbers={true}
                        showPrefix={true}
                        onOpenFile={openEnabled ? onOpenFile : undefined}
                    />
                    {React.createElement('Pressable' as any, {
                        testID: 'enable-open-file',
                        onPress: () => setOpenEnabled(true),
                    })}
                </>
            );
        }

        const screen = await renderScreen(<Wrapper />);

        expect(screen.findAllByTestId('diff-files-open:k1')).toHaveLength(0);

        await act(async () => {
            screen.pressByTestId('enable-open-file');
        });

        screen.pressByTestId('diff-files-open:k1');

        expect(onOpenFile).toHaveBeenCalledWith('src/a.ts');
    });

    it('falls back to FlatList on web when FlashList throws "not enough layouts"', async () => {
        const globalWindowContainer = globalThis as unknown as { window?: unknown };
        const prevWindow = globalWindowContainer.window;
        const listeners = new Map<string, EventListenerOrEventListenerObject[]>();
        try {
            globalWindowContainer.window = {
                addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
                    const arr = listeners.get(type) ?? [];
                    arr.push(fn);
                    listeners.set(type, arr);
                },
                removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
                    const arr = listeners.get(type) ?? [];
                    listeners.set(type, arr.filter((f) => f !== fn));
                },
            };

            const { DiffFilesListView } = await import('./DiffFilesListView');

            const files: any[] = [
                { key: 'k1', filePath: 'src/a.ts', added: 1, removed: 0, unifiedDiff: 'a\n', kind: null },
            ];

            const screen = await renderScreen(<DiffFilesListView
                        files={files}
                        expandedKeys={new Set()}
                        onToggleExpanded={() => {}}
                        canRenderInlineDiffs={true}
                        wrapLines={true}
                        showLineNumbers={true}
                        showPrefix={true}
                        virtualizeFileList
                    />);

            expect(screen.findAllByType('FlashList' as any)).toHaveLength(1);
            expect(listeners.get('error')?.length ?? 0).toBeGreaterThan(0);

            const errorMessage = 'index out of bounds, not enough layouts';
            const handler = (listeners.get('error') ?? [])[0];
            const fakeEvent = {
                message: errorMessage,
                error: new Error(errorMessage),
                preventDefault: vi.fn(),
                stopImmediatePropagation: vi.fn(),
            } as unknown as ErrorEvent;

            await act(async () => {
                (handler as EventListener)(fakeEvent);
            });

            expect(screen.findAllByType('FlatList' as any).length).toBeGreaterThan(0);
            expect(screen.findAllByType('FlashList' as any)).toHaveLength(0);
        } finally {
            globalWindowContainer.window = prevWindow;
        }
    });

    it('falls back to FlatList on web when FlashList hits a recycler commit layout update loop', async () => {
        const globalWindowContainer = globalThis as unknown as { window?: unknown };
        const prevWindow = globalWindowContainer.window;
        const listeners = new Map<string, EventListenerOrEventListenerObject[]>();
        try {
            globalWindowContainer.window = {
                addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
                    const arr = listeners.get(type) ?? [];
                    arr.push(fn);
                    listeners.set(type, arr);
                },
                removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
                    const arr = listeners.get(type) ?? [];
                    listeners.set(type, arr.filter((f) => f !== fn));
                },
            };

            const { DiffFilesListView } = await import('./DiffFilesListView');

            const files: any[] = [
                { key: 'k1', filePath: 'src/a.ts', added: 1, removed: 0, unifiedDiff: 'a\n', kind: null },
            ];

            const screen = await renderScreen(<DiffFilesListView
                        files={files}
                        expandedKeys={new Set()}
                        onToggleExpanded={() => {}}
                        canRenderInlineDiffs={true}
                        wrapLines={true}
                        showLineNumbers={true}
                        showPrefix={true}
                        virtualizeFileList
                    />);

            expect(screen.findAllByType('FlashList' as any)).toHaveLength(1);
            expect(listeners.get('error')?.length ?? 0).toBeGreaterThan(0);

            const errorMessage = 'Maximum update depth exceeded. This can happen when a component repeatedly calls setState inside componentWillUpdate or componentDidUpdate. React limits the number of nested updates to prevent infinite loops.';
            const handler = (listeners.get('error') ?? [])[0];
            const fakeEvent = {
                message: errorMessage,
                error: {
                    message: errorMessage,
                    stack: [
                        'Error: Maximum update depth exceeded',
                        '    at getRootForUpdatedFiber (bundle:15941:169)',
                        '    at dispatchSetState (bundle:17871:7)',
                        '    at Object.commitLayout (bundle:594088:11)',
                        '    at commitHookLayoutEffects (bundle:19716:58)',
                    ].join('\n'),
                },
                preventDefault: vi.fn(),
                stopImmediatePropagation: vi.fn(),
            } as unknown as ErrorEvent;

            await act(async () => {
                (handler as EventListener)(fakeEvent);
            });

            expect(screen.findAllByType('FlatList' as any).length).toBeGreaterThan(0);
            expect(screen.findAllByType('FlashList' as any)).toHaveLength(0);
        } finally {
            globalWindowContainer.window = prevWindow;
        }
    });
});
