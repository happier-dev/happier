/** @vitest-environment jsdom */
import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { installCodeDiffCommonModuleMocks } from './codeDiffTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Legend's native recycler is the list boundary; its ref hands over the platform scroll node.
const legend = vi.hoisted(() => ({
  scrollNode: { kind: 'files-list-scroller' },
}));
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
  const { createCapturingLegendListMock } =
    await import('@/dev/testkit/mocks/legendList');
  return createCapturingLegendListMock({
    original: await importOriginal<Record<string, unknown>>(),
    refHandle: { getScrollableNode: vi.fn(() => legend.scrollNode) },
  }).module;
});
installCodeDiffCommonModuleMocks({
  reactNative: async () =>
    (
      await import('@/dev/testkit/mocks/reactNative')
    ).createReactNativeWebMock(),
  text: async () =>
    (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
});
// Vitest's generic extension resolution needs the web projections Metro serves for the scroll owner.
vi.mock(
  '@/components/ui/code/diff/inlineDiffScrollOwner',
  async () => import('./inlineDiffScrollOwner.web'),
);
vi.mock(
  '@/components/ui/code/diff/pierre/PierreScrollRootVirtualizerProvider',
  async () => import('./pierre/PierreScrollRootVirtualizerProvider.web'),
);
// The diff body itself is covered by PierreDiffViewer.web.test ("windows a large diff against the list scroller").
vi.mock('@/components/ui/code/diff/DiffViewer', () => ({
  DiffViewer: (props: object) => React.createElement('DiffViewer', props),
}));

const { DiffFilesListView } = await import('./DiffFilesListView');
const { PierreScrollRootVirtualizerProvider } =
  await import('./pierre/PierreScrollRootVirtualizerProvider.web');
const initialSettings = storage.getState().settings;
afterEach(() => {
  storage.setState({ settings: initialSettings });
  vi.unstubAllGlobals();
});

const LARGE_DIFF = [
  '@@ -0,0 +1,400 @@',
  ...Array.from({ length: 400 }, (_, index) => `+line ${index + 1}`),
  '',
].join('\n');

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style && typeof style === 'object'
    ? (style as Record<string, unknown>)
    : {};
}

it.each([
  ['pierre', false],
  ['happier', true],
] as const)(
  'with the %s renderer, a large expanded diff in the virtualized list is capped: %s (QB-81)',
  async (renderer, capped) => {
    // A browser with workers; Pierre draws the diff only with the "pierre" renderer setting.
    vi.stubGlobal('Worker', class {});
    // 400 lines are large for a 100-line threshold: the body is virtualized.
    storage.setState({
      settings: {
        ...initialSettings,
        filesDiffRendererMode: renderer,
        filesDiffInlineVirtualizationLineThreshold: 100,
      },
    });
    const screen = await renderScreen(
      <DiffFilesListView
        virtualizeFileList
        canRenderInlineDiffs
        files={[
          {
            key: 'long',
            filePath: 'long.txt',
            unifiedDiff: LARGE_DIFF,
            added: 400,
            removed: 0,
            kind: 'new',
          },
        ]}
        expandedKeys={new Set(['long'])}
        onToggleExpanded={() => {}}
        wrapLines
        showLineNumbers
        showPrefix
      />,
    );
    try {
      const viewer = screen.findByType('DiffViewer' as never);
      expect(viewer.props).toMatchObject({
        unifiedDiff: LARGE_DIFF,
        virtualized: true,
      });
      // One vertical scroller: with Pierre the diff's frame has no capped viewport of its own; the line renderer
      // keeps its bounded list (the documented limitation).
      let frame = viewer.parent;
      while (frame && frame.props.style === undefined) frame = frame.parent;
      expect(frame).toBeTruthy();
      expect('maxHeight' in flatten(frame!.props.style)).toBe(capped);
      // The list hands its own scroll node to the scroll root its diffs window against.
      const scope = screen.findByType(PierreScrollRootVirtualizerProvider);
      expect(scope.props.getScrollRoot?.()).toBe(legend.scrollNode);
    } finally {
      await screen.unmount();
    }
  },
);
