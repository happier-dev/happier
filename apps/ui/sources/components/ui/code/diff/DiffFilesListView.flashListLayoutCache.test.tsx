import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeContainingText, pressTestInstance, renderScreen } from '@/dev/testkit';
import { installCodeDiffCommonModuleMocks } from './codeDiffTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const clearLayoutCacheOnUpdateSpy = vi.fn();

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
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    },
});

vi.mock('@shopify/flash-list', () => ({
    FlashList: React.forwardRef((props: any, ref: any) => {
        if (ref) {
            ref.current = {
                clearLayoutCacheOnUpdate: clearLayoutCacheOnUpdateSpy,
            };
        }
        const data = Array.isArray(props.data) ? props.data : [];
        return React.createElement(
            'FlashList',
            props,
            data.map((item: any, index: number) => {
                const child = typeof props.renderItem === 'function' ? props.renderItem({ item, index }) : null;
                return React.createElement('FlashListItem', { key: item?.key ?? String(index) }, child);
            }),
        );
    }),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/code/diff/pierre/PierreScrollRootVirtualizerProvider', () => ({
    PierreScrollRootVirtualizerProvider: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/code/diff/DiffViewer', () => ({
    DiffViewer: () => React.createElement('DiffViewer'),
}));

vi.mock('@/components/ui/code/diff/useInlineDiffVirtualizationThresholds', () => ({
    useInlineDiffVirtualizationThresholds: () => ({ lineThreshold: 50_000, byteThreshold: 100 }),
}));

describe('DiffFilesListView (FlashList layout cache)', () => {
    it('clears FlashList layout cache before toggling expansion (prevents blank buffers on web)', async () => {
        clearLayoutCacheOnUpdateSpy.mockClear();
        const onToggleExpanded = vi.fn();

        const { DiffFilesListView } = await import('./DiffFilesListView');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<DiffFilesListView
                    files={[
                        { key: 'k1', filePath: 'src/a.ts', unifiedDiff: 'diff\n', oldText: null, newText: null },
                        { key: 'k2', filePath: 'src/b.ts', unifiedDiff: 'diff\n', oldText: null, newText: null },
                    ] as any}
                    expandedKeys={new Set()}
                    onToggleExpanded={onToggleExpanded}
                    canRenderInlineDiffs={true}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    virtualizeFileList
                />)).tree;

        const pressable = findTestInstanceByTypeContainingText(tree, 'Pressable', 'src/a.ts');
        expect(pressable).toBeTruthy();

        pressTestInstance(pressable, 'DiffFilesListView file row');

        expect(clearLayoutCacheOnUpdateSpy).toHaveBeenCalledTimes(1);
        expect(onToggleExpanded).toHaveBeenCalledWith('k1');
    });

    it('does not clear FlashList layout cache from effects when expandedKeys changes (avoids scroll jumps)', async () => {
        clearLayoutCacheOnUpdateSpy.mockClear();

        const { DiffFilesListView } = await import('./DiffFilesListView');

        const files = [
            { key: 'k1', filePath: 'src/a.ts', unifiedDiff: 'diff\n', oldText: null, newText: null },
            { key: 'k2', filePath: 'src/b.ts', unifiedDiff: 'diff\n', oldText: null, newText: null },
        ] as any;

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<DiffFilesListView
                    files={files}
                    expandedKeys={new Set()}
                    onToggleExpanded={vi.fn()}
                    canRenderInlineDiffs={true}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    virtualizeFileList
                />)).tree;

        clearLayoutCacheOnUpdateSpy.mockClear();

        await act(async () => {
            tree.update(
                <DiffFilesListView
                    files={files}
                    expandedKeys={new Set(['k1'])}
                    onToggleExpanded={vi.fn()}
                    canRenderInlineDiffs={true}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    virtualizeFileList
                />,
            );
        });

        expect(clearLayoutCacheOnUpdateSpy).toHaveBeenCalledTimes(0);
    });

    it('keeps FlashList extraData stable and changes only the expanded row item when expandedKeys changes', async () => {
        const { DiffFilesListView } = await import('./DiffFilesListView');

        const files = [
            { key: 'k1', filePath: 'src/a.ts', unifiedDiff: 'diff\n', oldText: null, newText: null },
            { key: 'k2', filePath: 'src/b.ts', unifiedDiff: 'diff\n', oldText: null, newText: null },
        ] as any;
        const onToggleExpanded = vi.fn();

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<DiffFilesListView
                    files={files}
                    expandedKeys={new Set()}
                    onToggleExpanded={onToggleExpanded}
                    canRenderInlineDiffs={true}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    virtualizeFileList
                />)).tree;

        const beforeList = tree.root.findByType('FlashList' as any);
        const renderItemBefore = beforeList.props.renderItem;
        const extraDataBefore = beforeList.props.extraData;
        const dataBefore = beforeList.props.data;

        await act(async () => {
            tree.update(
                <DiffFilesListView
                    files={files}
                    expandedKeys={new Set(['k1'])}
                    onToggleExpanded={onToggleExpanded}
                    canRenderInlineDiffs={true}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    virtualizeFileList
                />,
            );
        });

        const afterList = tree.root.findByType('FlashList' as any);
        expect(afterList.props.renderItem).toBe(renderItemBefore);
        expect(afterList.props.extraData).toBe(extraDataBefore);
        expect(afterList.props.data).not.toBe(dataBefore);
        expect(afterList.props.data[0]).not.toBe(dataBefore[0]);
        expect(afterList.props.data[1]).toBe(dataBefore[1]);
    });

    it('exposes an imperative handle to clear FlashList layout cache (for programmatic expansion)', async () => {
        clearLayoutCacheOnUpdateSpy.mockClear();

        const { DiffFilesListView } = await import('./DiffFilesListView');

        const ref = React.createRef<any>();

        await renderScreen(<DiffFilesListView
                    ref={ref}
                    files={[
                        { key: 'k1', filePath: 'src/a.ts', unifiedDiff: 'diff\n', oldText: null, newText: null },
                    ] as any}
                    expandedKeys={new Set()}
                    onToggleExpanded={vi.fn()}
                    canRenderInlineDiffs={true}
                    wrapLines={true}
                    showLineNumbers={true}
                    showPrefix={true}
                    virtualizeFileList
                />);

        expect(ref.current).toBeTruthy();

        act(() => {
            ref.current.clearLayoutCacheOnUpdate();
        });

        expect(clearLayoutCacheOnUpdateSpy).toHaveBeenCalledTimes(1);
    });
});
