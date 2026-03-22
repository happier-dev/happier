import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const clearLayoutCacheOnUpdateSpy = vi.fn();

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            View: 'View',
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
            FlatList: (props: any) => React.createElement('FlatList', props),
            Platform: {
                OS: 'web',
                select: (value: any) => value?.web ?? value?.default ?? null,
            },
            useWindowDimensions: () => ({ width: 1200, height: 800 }),
        }
    );
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

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                divider: '#ddd',
                surfaceHigh: '#fff',
                surface: '#fff',
                surfaceHighest: '#fff',
                text: '#111',
                textSecondary: '#666',
                textLink: '#00f',
                warning: '#f00',
                accent: { indigo: '#00f' },
                success: '#0f0',
                warningCritical: '#f00',
            },
        },
    });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

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

        const pressables = tree.root.findAllByType('Pressable' as any);
        expect(pressables.length).toBeGreaterThan(0);

        act(() => {
            pressables[0]!.props.onPress();
        });

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
