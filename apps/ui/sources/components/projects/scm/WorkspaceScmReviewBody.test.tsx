import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const windowSize = vi.hoisted(() => ({ width: 1200 }));
// The window size is the platform boundary the pre-measure layout reads. The file-level mock serves
// the static imports; the helper re-registers react-native for later imports, so it gets the same one.
const mockReactNativeWithWindow = vi.hoisted(() => async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    useWindowDimensions: () => ({ width: windowSize.width, height: 844, scale: 1, fontScale: 1 }),
  });
});
vi.mock('react-native', () => mockReactNativeWithWindow());
installNavigationCommonModuleMocks({ reactNative: mockReactNativeWithWindow, storage: importOriginal => importOriginal() });
// Install the navigation factory before either consumer loads react-native. A static
// import resolves the helper's default factory before its options have been configured.
const { Text } = await import('react-native');
const { renderScreen } = await import('@/dev/testkit');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { WorkspaceScmReviewBody } = await import('./WorkspaceScmReviewBody');

describe('WorkspaceScmReviewBody', () => {
  it('keeps mounted file rows quiet when only the host render function changes', async () => {
    let rowRenders = 0;
    const Row = React.memo(function Row({ chrome }: { chrome: Parameters<React.ComponentProps<typeof WorkspaceScmReviewBody>['renderFiles']>[0] }) {
      rowRenders += 1;
      return <Text testID="quiet-row-root">{chrome.rootPath}</Text>;
    });
    const props = {
      comparison: { kind: 'workingTree' as const }, view: 'files' as const,
      scopeLabel: 'Pending changes', scopeOptions: [], rootPath: '/repo',
      onSelectComparison() {}, onSelectView() {}, explain: false, onExplainChange() {},
      renderWalkthrough: () => null,
    };
    const view = (rootPath = '/repo') => <WorkspaceScmReviewBody {...props} rootPath={rootPath}
      renderFiles={chrome => <Row chrome={chrome} />} />;
    const screen = await renderScreen(view());
    rowRenders = 0;
    for (let i = 0; i < 5; i += 1) await screen.update(view());
    expect(rowRenders).toBe(0);
    await screen.update(view('/other-checkout'));
    expect(rowRenders).toBe(1);
    expect(screen.findHostByTestId('quiet-row-root')?.props.children).toBe('/other-checkout');
    await screen.unmount();
  });

  it('keeps each tab’s comparison while another retained review restores across a phone resize', async () => {
    const { useScmReviewActiveFileSelection } = await import('@/components/sessions/files/comparison/useSessionScmReviewTabState');
    const { scmComparisonKey } = await import('@/components/sessions/files/comparison/filesComparison');
    const { activeReviewFileKeyForSession, requestActiveReviewFileForComparison, resetActiveReviewFilesForTests } = await import('@/components/workspaces/scm/review/activeReviewFile');
    type Comparison = NonNullable<React.ComponentProps<typeof WorkspaceScmReviewBody>['comparison']>;
    const key = activeReviewFileKeyForSession('resize-session', 'home');
    const branch = { kind: 'branch', head: 'master', base: '0968584' } as const;
    function Review({ id, initial, presented }: { id: string; initial: Comparison; presented: boolean }) {
      const pane = useAppPaneScope(`session:resize-${id}`);
      const [comparison, setComparison] = React.useState(initial);
      const activeReviewFile = useScmReviewActiveFileSelection({ pane, hostKey: 'host', activeFileKey: key,
        comparison, view: 'files', presented,
        persistedSelection: { selectionKey: JSON.stringify(['host', scmComparisonKey(initial)]), path: `${id}.txt` } });
      return <WorkspaceScmReviewBody activeReviewFile={activeReviewFile} comparison={comparison} view="files"
        scopeLabel={scmComparisonKey(comparison)} scopeOptions={[]} onSelectComparison={setComparison}
        onSelectView={() => {}} explain={false} onExplainChange={() => {}}
        renderFiles={() => <Text testID={id}>{scmComparisonKey(comparison)}</Text>} renderWalkthrough={() => null} />;
    }
    function Reviews({ retainedPresented }: { retainedPresented: boolean }) {
      return <><Review id="branch" initial={branch} presented />
        <Review id="session" initial={{ kind: 'session' }} presented={retainedPresented} /></>;
    }
    resetActiveReviewFilesForTests();
    const screen = await renderScreen(<AppPaneProvider><Reviews retainedPresented={false} /></AppPaneProvider>);
    try {
      for (const width of [390, 1440, 390]) {
        windowSize.width = width;
        await screen.update(<AppPaneProvider><Reviews retainedPresented={width === 390} /></AppPaneProvider>);
        expect(screen.findHostByTestId('branch')?.props.children).toBe('branch:master:0968584');
        expect(screen.findHostByTestId('session')?.props.children).toBe('session');
      }
      // A deliberate outside navigation still chooses its requested comparison.
      await screen.update(<AppPaneProvider><Reviews retainedPresented={false} /></AppPaneProvider>);
      await act(async () => {
        requestActiveReviewFileForComparison(key, 'pending.txt', { kind: 'workingTree' });
      });
      expect(screen.findHostByTestId('branch')?.props.children).toBe('workingTree');
      expect(screen.findHostByTestId('session')?.props.children).toBe('session');
    } finally {
      await act(async () => screen.unmount());
      resetActiveReviewFilesForTests();
      windowSize.width = 1200;
    }
  });

  it('offers no review actions while a state stands in for the files (not a repository, unreachable)', async () => {
    const { WorkspaceScmReviewBody } = await import('./WorkspaceScmReviewBody');
    const props = {
      comparison: null,
      view: 'files' as const,
      scopeLabel: 'Pending changes',
      scopeOptions: [],
      onSelectComparison: vi.fn(),
      onSelectView: vi.fn(),
      explain: false,
      onExplainChange: vi.fn(),
      onStartReview: vi.fn(),
      proposeCommits: <Text testID="propose">Propose commits</Text>,
      renderFiles: () => <Text testID="files">files</Text>,
      renderWalkthrough: () => null,
    };
    const withState = await renderScreen(
      <WorkspaceScmReviewBody
        {...props}
        filesState={<Text testID="not-a-repo">Not a repository</Text>}
      />,
    );
    expect(withState.findHostByTestId('not-a-repo')).not.toBeNull();
    // The bar keeps its place and its views; acting on files that are not there is not offered.
    expect(withState.findHostByTestId('scm-comparison-bar')).not.toBeNull();
    expect(
      withState.findHostByTestId('scm-comparison-start-review'),
    ).toBeNull();
    expect(withState.findHostByTestId('propose')).toBeNull();
  });

  it('offers no review actions when the comparison has no changes, and offers them again once it has some', async () => {
    const { WorkspaceScmReviewBody } = await import('./WorkspaceScmReviewBody');
    const props = {
      comparison: null,
      view: 'files' as const,
      scopeLabel: 'Pending changes',
      scopeOptions: [],
      onSelectComparison: vi.fn(),
      onSelectView: vi.fn(),
      explain: false,
      onExplainChange: vi.fn(),
      onStartReview: vi.fn(),
      onProposeCommits: vi.fn(),
      proposeCommits: <Text testID="propose">Propose commits</Text>,
      renderFiles: ({ renderBarLeading, barTrailing }: { renderBarLeading: (coverage: { fileCount: number; added: number; removed: number; linesKnown: boolean }) => React.ReactNode; barTrailing?: React.ReactNode }) => (
        <>{renderBarLeading({ fileCount: 0, added: 0, removed: 0, linesKnown: false })}{barTrailing}</>
      ),
      renderWalkthrough: () => null,
    };
    const empty = await renderScreen(<WorkspaceScmReviewBody {...props} fileCount={0} />);
    expect(empty.findHostByTestId('scm-comparison-start-review')).toBeNull();
    expect(empty.findHostByTestId('propose')).toBeNull();

    const changed = await renderScreen(<WorkspaceScmReviewBody {...props} fileCount={3} />);
    expect(changed.findHostByTestId('scm-comparison-start-review')).not.toBeNull();
    expect(changed.findHostByTestId('propose')).not.toBeNull();
  });

  it('puts a review\'s status in Start review\'s place on the wide bar and keeps Start review one choice away in the menu', async () => {
    const { WorkspaceScmReviewBody } = await import('./WorkspaceScmReviewBody');
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const onStartReview = vi.fn();
    const props = {
      comparison: null,
      view: 'walkthrough' as const,
      scopeLabel: 'Pending changes',
      scopeOptions: [],
      onSelectComparison: vi.fn(),
      onSelectView: vi.fn(),
      explain: false,
      onExplainChange: vi.fn(),
      onStartReview,
      proposeCommits: <Text testID="propose">Propose commits</Text>,
      renderFiles: () => null,
    };
    const unreviewed = await renderScreen(
      <WorkspaceScmReviewBody {...props} renderWalkthrough={({ renderBar }) => renderBar(null)} />,
    );
    expect(unreviewed.findHostByTestId('scm-comparison-start-review')).not.toBeNull();

    const reviewed = await renderScreen(
      <WorkspaceScmReviewBody {...props}
        renderWalkthrough={({ renderBar }) => renderBar(null, undefined, <Text testID="review-status">Reviewed · 6 findings</Text>)} />,
    );
    expect(reviewed.findHostByTestId('review-status')).not.toBeNull();
    expect(reviewed.findHostByTestId('propose')).not.toBeNull();
    expect(reviewed.findHostByTestId('scm-comparison-start-review')).toBeNull();
    const menu = reviewed.root.find((node) => node.type === DropdownMenu && node.props.testID === 'scm-comparison-more-menu');
    const row = (menu.props.items as Array<{ id: string; testID?: string }>).find((item) => item.testID === 'scm-comparison-start-review');
    expect(row).toBeDefined();
    await act(async () => { menu.props.onSelect(row!.id); });
    expect(onStartReview).toHaveBeenCalledTimes(1);
  });

  it.each([1440, 390])('hosted in a page that names the comparison (a Review), says its views once at %s px: no scope, count, review status or second header', async (width) => {
    windowSize.width = width;
    try {
      const contexts: Array<{ hosted?: boolean }> = [];
      const coverage = { fileCount: 6, added: 3, removed: 1, linesKnown: true };
      const viewedFacts = { viewed: <Text testID="viewed-fact">0 of 6 viewed</Text>, changedSinceViewedCount: 0 };
      const props = {
        comparison: { kind: 'workingTree' as const }, scopeLabel: 'Pending changes', scopeOptions: [], hosted: true,
        fileCount: 6, onSelectComparison: vi.fn(), onSelectView: vi.fn(), explain: false, onExplainChange: vi.fn(),
        renderFiles: (chrome: Parameters<React.ComponentProps<typeof WorkspaceScmReviewBody>['renderFiles']>[0]) => <>
          {chrome.renderBar ? chrome.renderBar(coverage, null) : chrome.renderBarLeading(coverage)}
          {chrome.renderHeader?.(coverage, viewedFacts)}</>,
        renderWalkthrough: (context: { hosted?: boolean; renderBar: (a?: React.ReactNode, s?: undefined, r?: React.ReactNode) => React.ReactNode }) => {
          contexts.push(context);
          return context.renderBar(null, undefined, <Text testID="review-status">Partial · 1 finding</Text>);
        },
      };
      const files = await renderScreen(<WorkspaceScmReviewBody {...props} view="files" />);
      // The page owns the scope ("Changes", its round): the bar is the view switch, the header only the person's marks.
      expect(files.findHostByTestId('scm-comparison-scope')).toBeNull();
      expect(files.findHostByTestId('scm-comparison-phone-header')).toBeNull();
      expect(files.findHostByTestId('scm-comparison-header-source')).toBeNull();
      expect(files.findHostByTestId('viewed-fact')).not.toBeNull();
      const walk = await renderScreen(<WorkspaceScmReviewBody {...props} view="walkthrough" />);
      expect(walk.findHostByTestId('scm-comparison-scope')).toBeNull();
      expect(walk.findHostByTestId('scm-comparison-phone-header')).toBeNull();
      // The Review's own state line already says how its reviewers did.
      expect(walk.findHostByTestId('review-status')).toBeNull();
      expect(contexts.at(-1)?.hosted).toBe(true);
    } finally {
      windowSize.width = 1200;
    }
  });

  it('states the phone Files file count once: the header names the scope, the coverage line counts the files', async () => {
    windowSize.width = 390;
    try {
      const { t } = await import('@/text');
      const coverage = { fileCount: 59814, added: 0, removed: 0, linesKnown: false };
      const screen = await renderScreen(
        <WorkspaceScmReviewBody comparison={{ kind: 'workingTree' }} view="files" scopeLabel="Pending changes" scopeOptions={[]}
          fileCount={59814} onSelectComparison={vi.fn()} onSelectView={vi.fn()} explain={false} onExplainChange={vi.fn()}
          renderFiles={(chrome) => <>{chrome.renderBar?.(coverage, null)}{chrome.renderHeader?.(coverage)}</>}
          renderWalkthrough={() => null} />,
      );
      type Node = { children: ReadonlyArray<Node | string> };
      const textOf = (node: Node | null): string => node
        ? node.children.map((child) => typeof child === 'string' ? child : textOf(child)).join('') : '';
      const count = t('scmComparison.fileCount', { count: 59814 });
      const phoneHeader = textOf(screen.findHostByTestId('scm-comparison-phone-header'));
      expect(phoneHeader).toContain('Pending changes');
      expect(phoneHeader).not.toContain(count);
      expect(textOf(screen.findHostByTestId('scm-comparison-header-source'))).toContain(count);
    } finally {
      windowSize.width = 1200;
    }
  });

  it.each([
    { window: 390, expected: 'phone' },
    { window: 1440, expected: 'narrow' },
  ])('lays a $window px window out as $expected before the body is measured', async ({ window, expected }) => {
    windowSize.width = window;
    try {
      const { WorkspaceScmReviewBody } = await import('./WorkspaceScmReviewBody');
      const layouts: string[] = [];
      await renderScreen(
        <WorkspaceScmReviewBody comparison={null} view="walkthrough" scopeLabel="Pending changes" scopeOptions={[]}
          onSelectComparison={vi.fn()} onSelectView={vi.fn()} explain={false} onExplainChange={vi.fn()}
          renderFiles={() => null}
          renderWalkthrough={({ layout }) => { layouts.push(layout); return null; }} />,
      );
      // A phone never draws the wide reading first (it did after Retry at 390); a wide window waits for its measure.
      expect(layouts.length).toBeGreaterThan(0);
      expect(new Set(layouts)).toEqual(new Set([expected]));
    } finally {
      windowSize.width = 1200;
    }
  });
  it('follows the window to the phone layout when it narrows after the body was measured wide', async () => {
    // A resized window reaches the body before its own layout event does (a heavy reading delays that event),
    // and a body cannot be wider than its window: the wide measure must not keep the rail beside a phone.
    windowSize.width = 1440;
    try {
      const { WorkspaceScmReviewBody } = await import('./WorkspaceScmReviewBody');
      const layouts: string[] = [];
      const element = () => (
        <WorkspaceScmReviewBody comparison={null} view="walkthrough" scopeLabel="Pending changes" scopeOptions={[]}
          onSelectComparison={vi.fn()} onSelectView={vi.fn()} explain={false} onExplainChange={vi.fn()}
          renderFiles={() => null}
          renderWalkthrough={({ layout }) => { layouts.push(layout); return null; }} />
      );
      const screen = await renderScreen(element());
      const measured = screen.root.find((node) => typeof node.type === 'string' && typeof node.props.onLayout === 'function');
      await act(async () => { measured.props.onLayout({ nativeEvent: { layout: { width: 1200 } } }); });
      expect(layouts.at(-1)).toBe('wide');
      windowSize.width = 390;
      await act(async () => { screen.update(element()); });
      expect(layouts.at(-1)).toBe('phone');
    } finally {
      windowSize.width = 1200;
    }
  });
});
