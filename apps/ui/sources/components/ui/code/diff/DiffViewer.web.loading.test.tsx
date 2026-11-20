import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { storage } from '@/sync/domains/state/storageStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

// Hold the external renderer SDK's chunk import, not Happier's renderer or
// Suspense owner. The real inline code renderer remains mounted underneath it.
vi.mock('@pierre/diffs', () => new Promise(() => {}));
const { HappierUnifiedDiffViewer } = await import('./happier/HappierUnifiedDiffViewer');
const unifiedViewerType = Reflect.get(HappierUnifiedDiffViewer, 'type') ?? HappierUnifiedDiffViewer;
const initialState = storage.getState();

const DIFF =
  'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n';

describe('DiffViewer (web) while the Pierre renderer loads', () => {
  let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;

  beforeEach(async () => {
    browser = await installBrowserRuntimeForTests({ url: 'http://localhost/' });
    vi.stubGlobal('Worker', class Worker {});
    storage.setState({ settings: { ...storage.getState().settings, filesDiffRendererMode: 'pierre' } });
  });

  afterEach(() => {
    standardCleanup();
    storage.setState(initialState, true);
    browser?.restore();
  });

  it('shows the code itself, not an empty or loading body, for an inline unified diff', async () => {
    const { DiffViewer } = await import('./DiffViewer.web');

    const screen = await renderScreen(
      <DiffViewer
        mode="unified"
        unifiedDiff={DIFF}
        filePath="a.ts"
        showLineNumbers
        wrapLines={false}
      />,
    );

    const code = screen.findByType(unifiedViewerType);
    expect(code?.props.unifiedDiff).toBe(DIFF);
    expect(code?.props.showLineNumbers).toBe(true);
    expect(screen.findByTestId('pierre-diff-loading')).toBeNull();
  });

  it('keeps the pane loading state for a virtualized list diff', async () => {
    const { DiffViewer } = await import('./DiffViewer.web');

    const screen = await renderScreen(
      <DiffViewer
        mode="unified"
        unifiedDiff={DIFF}
        filePath="a.ts"
        virtualized
      />,
    );

    expect(screen.findAllByType(unifiedViewerType)).toHaveLength(0);
  });

  it('lets an inline diff share the list scroller it sits in only when Pierre draws it (QB-81)', async () => {
    const { useInlineDiffSharesEnclosingScroller } = await import('./DiffViewer.web');
    const { PierreScrollRootVirtualizerProvider } = await import('./pierre/PierreScrollRootVirtualizerProvider.web');
    const seen = new Map<string, boolean>();
    function Probe({ phase }: Readonly<{ phase: string }>) { seen.set(phase, useInlineDiffSharesEnclosingScroller()); return null; }
    const listScroller = () => document.createElement('div');

    const inList = await renderScreen(<PierreScrollRootVirtualizerProvider getScrollRoot={listScroller}><Probe phase="in list" /></PierreScrollRootVirtualizerProvider>);
    await inList.unmount();
    const alone = await renderScreen(<Probe phase="alone" />);
    await alone.unmount();
    // The canonical line renderer cannot window against another scroller: it keeps its own bounded list.
    storage.setState({ settings: { ...storage.getState().settings, filesDiffRendererMode: 'happier' } });
    const lineRenderer = await renderScreen(<PierreScrollRootVirtualizerProvider getScrollRoot={listScroller}><Probe phase="line renderer" /></PierreScrollRootVirtualizerProvider>);
    await lineRenderer.unmount();

    expect(Object.fromEntries(seen)).toEqual({ 'in list': true, alone: false, 'line renderer': false });
  });
});
