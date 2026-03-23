import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const diffViewerSpy = vi.fn();
let flashListMockState: { props: any | null } | null = null;

function getFlashListProps() {
    expect(flashListMockState?.props).toBeTruthy();
    return flashListMockState!.props;
}

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    FlashList: (props: any) => {
        flashListMockState = flashListMockState ?? { props: null };
        flashListMockState.props = props;
        return React.createElement('FlashList', props);
    },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 1200, height: 800 }),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

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

        await renderScreen(<DiffFilesListView
                    files={files}
                    expandedKeys={new Set(['k1'])}
                    onToggleExpanded={() => {}}
                    canRenderInlineDiffs={true}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />);

        expect(diffViewerSpy).toHaveBeenCalledWith(expect.objectContaining({ virtualized: true }));
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
});
