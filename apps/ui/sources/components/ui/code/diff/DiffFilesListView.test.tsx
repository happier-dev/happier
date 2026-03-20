import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const diffViewerSpy = vi.fn();

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    FlashList: (props: any) => React.createElement('FlashList', props),
}));

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    FlatList: (props: any) => React.createElement('FlatList', props),
    Platform: { OS: 'web', select: (value: any) => value?.web ?? value?.default ?? null },
    useWindowDimensions: () => ({ width: 1200, height: 800 }),
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (fn: any) => fn({ colors: { divider: '#ddd', surfaceHigh: '#fff', surface: '#fff', accent: { indigo: '#00f' }, success: '#0f0', warning: '#f00', text: '#111', textSecondary: '#666', surfaceHighest: '#fff', textLink: '#00f', warningCritical: '#f00' } }),
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
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

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <DiffFilesListView
                    files={files}
                    expandedKeys={new Set()}
                    onToggleExpanded={() => {}}
                    canRenderInlineDiffs={true}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    virtualizeFileList
                />,
            );
        });

        expect(tree.root.findAllByType('FlashList' as any)).toHaveLength(1);
    });

	    it('configures FlashList with stable virtualization defaults', async () => {
	        const { DiffFilesListView } = await import('./DiffFilesListView');

	        let tree!: renderer.ReactTestRenderer;
	        await act(async () => {
            tree = renderer.create(
                <DiffFilesListView
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
                />,
            );
	        });

	        const list = tree.root.findByType('FlashList' as any);
	        expect(typeof list.props.drawDistance).toBe('number');
	        expect(Number.isFinite(list.props.drawDistance)).toBe(true);
	        expect(list.props.drawDistance).toBeGreaterThan(0);
	        expect(list.props.drawDistance).toBe(1600);
	        expect(typeof list.props.overrideItemLayout).toBe('function');
	        expect(typeof list.props.getItemType).toBe('function');
	    });

    it('forwards scroll handlers to the underlying list when virtualized', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');

        const onScroll = vi.fn();
        const onLayout = vi.fn();
        const onContentSizeChange = vi.fn();

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
	            tree = renderer.create(
	                <DiffFilesListView
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
                />,
            );
        });

        const list = tree.root.findByType('FlashList' as any);
        expect(list.props.onScroll).toBe(onScroll);
        expect(list.props.onLayout).toBe(onLayout);
        expect(list.props.onContentSizeChange).toBe(onContentSizeChange);
    });

    it('passes a flat style object to FlashList when virtualized', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <DiffFilesListView
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
                />
            );
        });

        const list = tree.root.findByType('FlashList' as any);
        expect(Array.isArray(list.props.style)).toBe(false);
        expect(typeof list.props.style).toBe('object');
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

        await act(async () => {
            renderer.create(
                <DiffFilesListView
                    files={files}
                    expandedKeys={new Set(['k1'])}
                    onToggleExpanded={() => {}}
                    canRenderInlineDiffs={true}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                />,
            );
        });

        expect(diffViewerSpy).toHaveBeenCalledWith(expect.objectContaining({ virtualized: true }));
    });

    it('uses renderInlineUnifiedDiff override when provided', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');

        diffViewerSpy.mockClear();
        const renderInlineUnifiedDiff = vi.fn(() => React.createElement('CustomInlineDiff'));

        await act(async () => {
            renderer.create(
                <DiffFilesListView
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
                />,
            );
        });

        expect(renderInlineUnifiedDiff).toHaveBeenCalledTimes(1);
        expect(diffViewerSpy).toHaveBeenCalledTimes(0);
    });

    it('renders renderInlineUnifiedDiff override even when unifiedDiff is missing', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');

        diffViewerSpy.mockClear();
        const renderInlineUnifiedDiff = vi.fn(() => React.createElement('CustomInlineDiff'));

        await act(async () => {
            renderer.create(
                <DiffFilesListView
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
                />,
            );
        });

        expect(renderInlineUnifiedDiff).toHaveBeenCalledTimes(1);
        expect(diffViewerSpy).toHaveBeenCalledTimes(0);
    });

    it('uses renderFileRow override when provided', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <DiffFilesListView
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
                />,
            );
        });

        expect(tree.root.findAllByProps({ testID: 'custom-row:k1' })).toHaveLength(1);
    });

    it('forces unified presentation for new files to avoid empty split columns', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');

        diffViewerSpy.mockClear();

        await act(async () => {
            renderer.create(
                <DiffFilesListView
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
                />,
            );
        });

        expect(diffViewerSpy).toHaveBeenCalledWith(expect.objectContaining({ presentationStyleOverride: 'unified' }));
    });

    it('calls onOpenFile when pressing the open-file action', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');

        const onOpenFile = vi.fn();
        const onOpenFilePinned = vi.fn();

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <DiffFilesListView
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
                />,
            );
        });

        const openButton = tree.root.findByProps({ testID: 'diff-files-open:k1' });
        await act(async () => {
            openButton.props.onPress?.();
        });

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

            let tree!: renderer.ReactTestRenderer;
            await act(async () => {
                tree = renderer.create(
                    <DiffFilesListView
                        files={files}
                        expandedKeys={new Set()}
                        onToggleExpanded={() => {}}
                        canRenderInlineDiffs={true}
                        wrapLines={true}
                        showLineNumbers={true}
                        showPrefix={true}
                        virtualizeFileList
                    />,
                );
            });

            expect(tree.root.findAllByType('FlashList' as any)).toHaveLength(1);
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

            expect(tree.root.findAllByType('FlatList' as any).length).toBeGreaterThan(0);
            expect(tree.root.findAllByType('FlashList' as any)).toHaveLength(0);
        } finally {
            globalWindowContainer.window = prevWindow;
        }
    });
});
