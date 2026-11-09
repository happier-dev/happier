// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { storage } from '@/sync/domains/state/storageStore';
import type { DiffHunkInfo, DiffViewerHunks } from '../diffViewerTypes';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { PluginSurfaceFocusEligibilityProvider, useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useDeviceType } from '@/utils/platform/responsive';
import { fixedDiffHunkNumbering } from './diffHunkNumbering';

const viewport = vi.hoisted(() => ({
  value: { width: 1200, height: 800, scale: 1, fontScale: 1 },
  listeners: new Set<() => void>(),
}));

vi.mock('react-native', async () => {
  const subscribe = (listener: () => void) => {
    viewport.listeners.add(listener);
    return () => { viewport.listeners.delete(listener); };
  };
  return (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Dimensions: {
      get: () => viewport.value,
      addEventListener: (_event: string, listener: () => void) => ({ remove: subscribe(listener) }),
    },
    useWindowDimensions: () => React.useSyncExternalStore(subscribe, () => viewport.value),
  });
});
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);

// Two change runs inside one git hunk: they are reviewed as two changes.
const PATCH =
  '--- a/a.ts\n+++ b/a.ts\n@@ -1,5 +1,5 @@\n first\n-before\n+after\n middle\n-old\n+new\n last\n';
const initialState = storage.getState();

describe('DiffHunkRow on the shared hunk contract', () => {
  let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
  beforeEach(async () => {
    viewport.value = { width: 1200, height: 800, scale: 1, fontScale: 1 };
    browser = await installBrowserRuntimeForTests({ url: 'http://localhost/' });
    storage.setState({
      settings: {
        ...storage.getState().settings,
        filesDiffRendererMode: 'happier',
      },
    });
  });
  afterEach(() => {
    standardCleanup();
    storage.setState(initialState, true);
    browser.restore();
  });

  async function render(hunks: DiffViewerHunks) {
    const { DiffViewer } = await import('../DiffViewer.web');
    return renderScreen(
      <DiffViewer
        mode="unified"
        virtualized={false}
        filePath="a.ts"
        unifiedDiff={PATCH}
        hunks={hunks}
      />,
    );
  }

  it.each(['tab', 'ancestor'] as const)('withdraws hidden %s dimension subscriptions without rendering retained Review rows', async owner => {
    const { DiffViewer } = await import('../DiffViewer.web');
    const patch = '--- a/a.ts\n+++ b/a.ts\n' + Array.from({ length: 300 }, (_, index) =>
      `@@ -${index * 3 + 1},3 +${index * 3 + 1},3 @@\n context ${index}\n-before ${index}\n+after ${index}\n tail ${index}\n`).join('');
    let hunkStateReads = 0;
    let positionRenders = 0;
    let hiddenCommits = 0;
    let backgroundResults = 0;
    let publishBackgroundResult!: () => void;
    let initializations = 0;
    function Position() {
      const deviceType = useDeviceType();
      const presented = useLayoutPresentationActive();
      React.useLayoutEffect(() => {
        if (!presented) hiddenCommits += 1;
      }, [presented]);
      positionRenders += 1;
      const [position, setPosition] = React.useState(() => { initializations += 1; return { draft: '', scrollY: 0 }; });
      const [result, setResult] = React.useState(0);
      React.useEffect(() => { publishBackgroundResult = () => setResult(value => value + 1); }, []);
      React.useEffect(() => { backgroundResults = result; }, [result]);
      return React.createElement('ReviewPosition', { ...position, deviceType, onChange: setPosition });
    }
    const hunks: DiffViewerHunks = {
      stateOf: () => { hunkStateReads += 1; return 'open'; },
      actions: { keep: vi.fn() },
    };
    const content = <><Position /><DiffViewer mode="unified" virtualized={false}
      filePath="a.ts" unifiedDiff={patch} hunks={hunks} /></>;
    const panel = (presented: boolean) => (
      <PluginSurfaceFocusEligibilityProvider active={false} presentationActive={owner === 'ancestor' ? presented : true}>
        <RetainedPanelSurface isActive={owner === 'tab' ? presented : true}>{content}</RetainedPanelSurface>
      </PluginSurfaceFocusEligibilityProvider>
    );
    const screen = await renderScreen(panel(true));
    expect(screen.findByTestId('diff-hunk-row-0')).toBeTruthy();
    expect(screen.findByTestId('diff-hunk-row-1')).toBeTruthy();
    expect(screen.tree.root.findAll(node => typeof node.type === 'string'
      && /^diff-hunk-row-\d+$/.test(String(node.props.testID)))).toHaveLength(300);
    expect(viewport.listeners.size).toBeGreaterThan(0);
    await act(async () => {
      screen.findByType('ReviewPosition').props.onChange({ draft: 'retained note', scrollY: 237 });
      screen.findByTestId('diff-hunk-row-0')!.props.onMouseEnter?.();
    });
    expect(screen.findByTestId('diff-hunk-keep-0')).toBeTruthy();
    await screen.update(panel(false));
    // The hiding commit withdraws every Dimensions listener (the presentation owner's layout effect ends it).
    expect(hiddenCommits).toBe(1);
    expect(viewport.listeners.size).toBe(0);
    hunkStateReads = 0;
    for (let index = 0; index < 20; index += 1) {
      await act(async () => {
        viewport.value = { width: index === 19 ? 390 : 900 + index, height: 844, scale: 1, fontScale: 1 };
        for (const listener of [...viewport.listeners]) listener();
      });
    }
    expect(hunkStateReads).toBe(0);
    expect(viewport.listeners.size).toBe(0);
    await act(async () => publishBackgroundResult());
    expect(backgroundResults).toBe(1);
    positionRenders = 0;
    await screen.update(panel(true));
    expect(hunkStateReads).toBeGreaterThan(0);
    expect(positionRenders).toBe(1);
    expect(screen.findByTestId('diff-hunk-keep-0')).toBeFalsy();
    expect(screen.findByType('ReviewPosition').props).toMatchObject({ draft: 'retained note', scrollY: 237, deviceType: 'phone' });
    expect(initializations).toBe(1);
    await act(async () => {
      viewport.value = { width: 1200, height: 800, scale: 1, fontScale: 1 };
      for (const listener of [...viewport.listeners]) listener();
    });
    // The actual row's hover state also survives hiding and changing device class.
    expect(screen.findByTestId('diff-hunk-keep-0')).toBeTruthy();
    await screen.unmount();
    expect(viewport.listeners.size).toBe(0);
  });

  it('draws one row per change run, keeps state per row and hands the pressed change to its action', async () => {
    const keep = vi.fn<(hunk: DiffHunkInfo) => void>();
    const discard = vi.fn<(hunk: DiffHunkInfo) => void>();
    const screen = await render({
      currentIndex: 1,
      numbering: fixedDiffHunkNumbering(2, 7),
      stateOf: (hunk) => (hunk.index === 0 ? 'kept' : 'open'),
      actions: { keep, discard },
      disabledReason: (_hunk, action) =>
        action === 'discard' ? 'Discard needs devbox' : null,
    });
    expect(screen.findByTestId('diff-hunk-row-0')).toBeTruthy();
    expect(screen.findByTestId('diff-hunk-row-1')).toBeTruthy();
    const text = screen.getTextContent();
    expect(text).toContain('hunkReview.kept');
    expect(text).toContain('Discard needs devbox');
    // The current change is "change 4 of 7" across the comparison and announces it.
    const keepButton = screen.findByTestId('diff-hunk-keep-1')!;
    expect(String(keepButton.props.accessibilityLabel)).toContain(
      'hunkReview.keepA11y',
    );
    await act(async () => {
      keepButton.props.onPress();
    });
    expect(keep).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1, rangeStart: 4, rangeEnd: 4 }),
    );
    expect(screen.findByTestId('diff-hunk-discard-1')!.props.disabled).toBe(
      true,
    );
    // A kept change offers no Discard and lets go of its tint.
    expect(screen.findByTestId('diff-hunk-discard-0')).toBeFalsy();
  });

  it('says why Discard is unavailable on any change whose buttons are showing, not only the current one', async () => {
    const screen = await render({
      currentIndex: 1,
      actions: { keep: vi.fn(), discard: vi.fn() },
      disabledReason: (_hunk, action) =>
        action === 'discard' ? 'Untracked file' : null,
    });
    const count = () => screen.getTextContent().split('Untracked file').length - 1;
    // Quiet rows stay quiet: only the current change speaks.
    expect(count()).toBe(1);
    const row = screen.findByTestId('diff-hunk-row-0')!;
    await act(async () => {
      row.props.onMouseEnter?.();
    });
    // Hovering a change reveals its buttons and, with the disabled Discard, the reason beside it.
    expect(count()).toBe(2);
    expect(screen.findByTestId('diff-hunk-discard-0')!.props.disabled).toBe(true);
    await act(async () => {
      screen.findByTestId('diff-hunk-row-0')!.props.onMouseLeave?.();
    });
    expect(count()).toBe(1);
  });

  it('leaves notes-only callers without rows', async () => {
    const screen = await render({
      renderNote: (hunk) => <>{`note-${hunk.index}`}</>,
    });
    expect(screen.findByTestId('diff-hunk-row-0')).toBeFalsy();
    expect(screen.getTextContent()).toContain('note-0');
  });
});
