import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let rendererMode: 'happier' | 'pierre' = 'pierre';

const lazyMountSpy = vi.fn();

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'filesDiffRendererMode') return rendererMode;
        return undefined;
    },
}));

vi.mock('@/components/ui/performance/LazyMountOnScreen', () => ({
    LazyMountOnScreen: (props: any) => {
        lazyMountSpy(props);
        return React.createElement('LazyMountOnScreen', props);
    },
}));

vi.mock('./pierre/PierreDiffViewer.web', () => ({
    PierreDiffViewer: (props: any) => React.createElement('PierreDiffViewer', props),
}));

vi.mock('./happier/HappierUnifiedDiffViewer', () => ({
    HappierUnifiedDiffViewer: (props: any) => React.createElement('HappierUnifiedDiffViewer', props),
}));

vi.mock('./happier/HappierTextDiffViewer', () => ({
    HappierTextDiffViewer: (props: any) => React.createElement('HappierTextDiffViewer', props),
}));

describe('DiffViewer (web renderer selection)', () => {
    const previousEnv = process.env.EXPO_PUBLIC_HAPPIER_PIERRE_DIFFS__ENABLED;
    const previousWindow = (globalThis as any).window;
    const previousDocument = (globalThis as any).document;
    const previousWorker = (globalThis as any).Worker;

    beforeEach(() => {
        rendererMode = 'pierre';
        process.env.EXPO_PUBLIC_HAPPIER_PIERRE_DIFFS__ENABLED = previousEnv;

        (globalThis as any).Worker = function Worker() {} as any;
        (globalThis as any).window = {};
        (globalThis as any).document = {
            baseURI: 'http://localhost/',
            createElement: () => ({ attachShadow: () => ({}) }),
        };
    });

    afterAll(() => {
        if (previousEnv === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_PIERRE_DIFFS__ENABLED;
        else process.env.EXPO_PUBLIC_HAPPIER_PIERRE_DIFFS__ENABLED = previousEnv;

        (globalThis as any).window = previousWindow;
        (globalThis as any).document = previousDocument;
        (globalThis as any).Worker = previousWorker;
    });

    it('uses Pierre when enabled by setting + env and runtime supports it', async () => {
        lazyMountSpy.mockClear();
        const { DiffViewer } = await import('./DiffViewer.web');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <DiffViewer mode="unified" unifiedDiff={'diff --git a/a.ts b/a.ts'} filePath="a.ts" />,
            );
        });

        expect(tree.root.findAllByType('PierreDiffViewer' as any)).toHaveLength(1);
        expect(tree.root.findAllByType('HappierUnifiedDiffViewer' as any)).toHaveLength(0);
        expect(tree.root.findAllByType('LazyMountOnScreen' as any)).toHaveLength(0);
    });

    it('wraps virtualized Pierre diffs in LazyMountOnScreen for lazy mounting', async () => {
        lazyMountSpy.mockClear();
        const { DiffViewer } = await import('./DiffViewer.web');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <DiffViewer mode="unified" unifiedDiff={'diff --git a/a.ts b/a.ts'} filePath="a.ts" virtualized={true} />,
            );
        });

        expect(tree.root.findAllByType('PierreDiffViewer' as any)).toHaveLength(1);
        expect(tree.root.findAllByType('LazyMountOnScreen' as any)).toHaveLength(1);
    });

    it('falls back to Happier renderer when the env kill-switch disables pierre', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_PIERRE_DIFFS__ENABLED = '0';
        const { DiffViewer } = await import('./DiffViewer.web');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <DiffViewer mode="unified" unifiedDiff={'diff --git a/a.ts b/a.ts'} filePath="a.ts" />,
            );
        });

        expect(tree.root.findAllByType('PierreDiffViewer' as any)).toHaveLength(0);
        expect(tree.root.findAllByType('HappierUnifiedDiffViewer' as any)).toHaveLength(1);
    });

    it('keeps Pierre renderer even when DiffViewer needs interactivity props', async () => {
        const { DiffViewer } = await import('./DiffViewer.web');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <DiffViewer
                    mode="unified"
                    unifiedDiff={'diff --git a/a.ts b/a.ts'}
                    filePath="a.ts"
                    onPressLine={() => {}}
                />,
            );
        });

        expect(tree.root.findAllByType('PierreDiffViewer' as any)).toHaveLength(1);
        expect(tree.root.findAllByType('HappierUnifiedDiffViewer' as any)).toHaveLength(0);
    });
});
