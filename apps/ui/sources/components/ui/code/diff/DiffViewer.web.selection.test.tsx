import * as React from 'react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let rendererMode: 'happier' | 'pierre' = 'pierre';

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSetting: (key: string) => {
            if (key === 'filesDiffRendererMode') return rendererMode;
            return undefined;
        },
    });
});

vi.mock('@/components/ui/performance/LazyMountOnScreen', () => ({
    LazyMountOnScreen: (props: any) => React.createElement('LazyMountOnScreen', { ...props, testID: 'lazy-mount-on-screen' }),
}));

vi.mock('./pierre/PierreDiffViewer.web', () => ({
    PierreDiffViewer: (props: any) => React.createElement('PierreDiffViewer', { ...props, testID: 'pierre-diff-viewer' }),
}));

vi.mock('./happier/HappierUnifiedDiffViewer', () => ({
    HappierUnifiedDiffViewer: (props: any) => React.createElement('HappierUnifiedDiffViewer', { ...props, testID: 'happier-unified-diff-viewer' }),
}));

vi.mock('./happier/HappierTextDiffViewer', () => ({
    HappierTextDiffViewer: (props: any) => React.createElement('HappierTextDiffViewer', { ...props, testID: 'happier-text-diff-viewer' }),
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
        const { DiffViewer } = await import('./DiffViewer.web');

        const screen = await renderScreen(<DiffViewer mode="unified" unifiedDiff={'diff --git a/a.ts b/a.ts'} filePath="a.ts" />);

        expect(screen.findByTestId('pierre-diff-viewer')).toBeTruthy();
        expect(screen.findByTestId('happier-unified-diff-viewer')).toBeNull();
        expect(screen.findByTestId('lazy-mount-on-screen')).toBeNull();
    });

    it('wraps virtualized Pierre diffs in LazyMountOnScreen for lazy mounting', async () => {
        const { DiffViewer } = await import('./DiffViewer.web');

        const screen = await renderScreen(<DiffViewer mode="unified" unifiedDiff={'diff --git a/a.ts b/a.ts'} filePath="a.ts" virtualized={true} />);

        expect(screen.findByTestId('pierre-diff-viewer')).toBeTruthy();
        expect(screen.findByTestId('lazy-mount-on-screen')).toBeTruthy();
    });

    it('falls back to Happier renderer when the env kill-switch disables pierre', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_PIERRE_DIFFS__ENABLED = '0';
        const { DiffViewer } = await import('./DiffViewer.web');

        const screen = await renderScreen(<DiffViewer mode="unified" unifiedDiff={'diff --git a/a.ts b/a.ts'} filePath="a.ts" />);

        expect(screen.findByTestId('pierre-diff-viewer')).toBeNull();
        expect(screen.findByTestId('happier-unified-diff-viewer')).toBeTruthy();
    });

    it('keeps Pierre renderer even when DiffViewer needs interactivity props', async () => {
        const { DiffViewer } = await import('./DiffViewer.web');

        const screen = await renderScreen(
            <DiffViewer
                mode="unified"
                unifiedDiff={'diff --git a/a.ts b/a.ts'}
                filePath="a.ts"
                onPressLine={() => {}}
            />,
        );

        expect(screen.findByTestId('pierre-diff-viewer')).toBeTruthy();
        expect(screen.findByTestId('happier-unified-diff-viewer')).toBeNull();
    });
});
