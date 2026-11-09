import * as React from 'react';
import { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { DetailsTabHeader } from '@/components/appShell/panes/details/header/DetailsTabHeader';
import { PaneMainColumnContext, type PaneMainColumnState } from '@/components/appShell/panes/mainColumn/usePaneMainColumn';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { PaneRegionProvider } from '@/components/appShell/panes/paneRegion';
import { PanePresentationProvider, type PanePresentation, type PanePresentationIntent } from '@/components/appShell/panes/panePresentation';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionScmReviewDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { createWorkspaceFileDetailsTab } from '@/components/appShell/panes/details/fileDetailsTab';
import { storage } from '@/sync/domains/state/storage';
import { paneUiState } from '@/sync/domains/state/filePaneUiState';
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import { renderPluginNavigationActions } from '@/components/plugins/surfaces/pluginPageHeaderActions';
import { PageHeader } from '@/components/ui/layout/PageHeader';

import { DetailsTabGroupPanel } from './DetailsTabGroupPanel';
import type {
  DetailsTabState,
  DetailsWorkspaceGroupView,
} from './detailsWorkspaceTypes';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
  const { createExpoVectorIconsMock } =
    await import('@/dev/testkit/mocks/icons');
  return createExpoVectorIconsMock();
});

const pane = {
  setActiveDetailsTab: vi.fn(),
  pinDetailsTab: vi.fn(),
  unpinDetailsTab: vi.fn(),
  closeDetailsTab: vi.fn(),
} as unknown as AppPaneScopeApi;

function tab(key: string, title: string): DetailsTabState {
  return {
    key,
    kind: 'file',
    title,
    isPinned: false,
    isPreview: false,
    resource: { kind: 'file', path: title },
  } as DetailsTabState;
}

function group(tabs: readonly DetailsTabState[]): DetailsWorkspaceGroupView {
  return {
    id: 'group:1',
    tabKeys: tabs.map((entry) => entry.key),
    activeTabKey: tabs[0]!.key,
    tabs: [...tabs],
    isFocused: true,
  };
}

const testIds = { tab: (key: string) => `strip-tab-${key}` };
const renderPaneActions = () => <View testID="pane-close" />;

describe('DetailsTabGroupPanel with one tab (lab session-D)', () => {
  it('keeps the enclosing page navigation title chrome out of a tab: the tab is not the navigation page', async () => {
    // Live READY162 (390): a PR opened in a Session's details tab published its title and way back into the
    // Session's own band, a second header above the Session header.
    const { NavigationTitleChromeProvider, useNavigationTitleChromePublisher, useNavigationTitleChromeShowsTitle } =
      await import('@/components/ui/layout/navigationTitleChrome');
    const seen: Array<Readonly<{ showsTitle: boolean; publisher: boolean }>> = [];
    function ChromeReader() {
      seen.push({ showsTitle: useNavigationTitleChromeShowsTitle(), publisher: useNavigationTitleChromePublisher() !== null });
      return <View testID="chrome-reader" />;
    }
    await renderScreen(
      <NavigationTitleChromeProvider showsTitle publisher={{ setTitle: vi.fn(), setPageTitle: vi.fn(), setBack: vi.fn() }}>
        <DetailsTabGroupPanel
          pane={pane}
          group={group([tab('pr', 'Pull request')])}
          testIds={testIds}
          renderTabContent={() => <ChromeReader />}
        />
      </NavigationTitleChromeProvider>,
    );
    expect(seen.at(-1)).toEqual({ showsTitle: false, publisher: false });
  });

  it("drops its tab strip and lends the pane controls to the tab's own header", async () => {
    const screen = await renderScreen(
      <DetailsTabGroupPanel
        pane={pane}
        group={group([tab('peek', 'Checkout UI retry states')])}
        collapseSingleTabStrip
        testIds={testIds}
        renderHeaderActions={renderPaneActions}
        renderTabContent={() => (
          <DetailsTabHeader
            testID="peek-header"
            title="Checkout UI retry states"
          />
        )}
      />,
    );

    expect(screen.findAllHostsByTestId('strip-tab-peek')).toHaveLength(0);
    const header = screen.findHostByTestId('peek-header.root');
    expect(header).not.toBeNull();
    expect(
      header!.findAll(
        (node) =>
          node.props?.testID === 'pane-close' && typeof node.type === 'string',
      ),
    ).toHaveLength(1);
    expect(screen.findAllHostsByTestId('pane-close')).toHaveLength(1);
  });

  it('keeps the strip, with the pane controls, when the tab draws no header of its own', async () => {
    const screen = await renderScreen(
      <DetailsTabGroupPanel
        pane={pane}
        group={group([tab('term', 'Terminal')])}
        collapseSingleTabStrip
        testIds={testIds}
        renderHeaderActions={renderPaneActions}
        renderTabContent={() => <View testID="terminal-body" />}
      />,
    );

    expect(screen.findAllHostsByTestId('strip-tab-term')).toHaveLength(1);
    expect(screen.findAllHostsByTestId('pane-close')).toHaveLength(1);
  });

  it('keeps the strip whenever there is more than one tab to choose between', async () => {
    const screen = await renderScreen(
      <DetailsTabGroupPanel
        pane={pane}
        group={group([tab('a', 'a.txt'), tab('b', 'b.txt')])}
        collapseSingleTabStrip
        testIds={testIds}
        renderHeaderActions={renderPaneActions}
        renderTabContent={(entry) => (
          <DetailsTabHeader
            testID={`header-${entry.key}`}
            title={entry.title}
          />
        )}
      />,
    );

    expect(screen.findAllHostsByTestId('strip-tab-a')).toHaveLength(1);
    expect(screen.findAllHostsByTestId('strip-tab-b')).toHaveLength(1);
    expect(screen.findAllHostsByTestId('pane-close')).toHaveLength(1);
  });
  it('lends only the pane’s own controls: what opens another tab stays with the strip', async () => {
    const renderStripActions = () => <View testID="open-browser" />;
    const collapsed = await renderScreen(
      <DetailsTabGroupPanel
        pane={pane}
        group={group([tab('peek', 'Checkout UI retry states')])}
        collapseSingleTabStrip
        testIds={testIds}
        renderStripActions={renderStripActions}
        renderHeaderActions={renderPaneActions}
        renderTabContent={() => (
          <DetailsTabHeader
            testID="peek-header"
            title="Checkout UI retry states"
          />
        )}
      />,
    );
    // The single tab's header carries the pane's close; a launcher for another tab has no strip to sit on.
    expect(collapsed.findAllHostsByTestId('pane-close')).toHaveLength(1);
    expect(collapsed.findAllHostsByTestId('open-browser')).toHaveLength(0);

    const withStrip = await renderScreen(
      <DetailsTabGroupPanel
        pane={pane}
        group={group([tab('a', 'a.txt'), tab('b', 'b.txt')])}
        collapseSingleTabStrip
        testIds={testIds}
        renderStripActions={renderStripActions}
        renderHeaderActions={renderPaneActions}
        renderTabContent={(entry) => (
          <DetailsTabHeader testID={`header-${entry.key}`} title={entry.title} />
        )}
      />,
    );
    expect(withStrip.findAllHostsByTestId('open-browser')).toHaveLength(1);
    expect(withStrip.findAllHostsByTestId('pane-close')).toHaveLength(1);
  });
  it('keeps a live control (Track) reachable: it moves into the one tab’s header with the pane controls, and stays on the strip with several tabs', async () => {
    const renderLiveActions = () => <View testID="track" />;
    const renderStripActions = () => <View testID="open-browser" />;
    const collapsed = await renderScreen(
      <DetailsTabGroupPanel
        pane={pane}
        group={group([tab('peek', 'retry.ts')])}
        collapseSingleTabStrip
        testIds={testIds}
        renderLiveActions={renderLiveActions}
        renderStripActions={renderStripActions}
        renderHeaderActions={renderPaneActions}
        renderTabContent={() => <DetailsTabHeader testID="peek-header" title="retry.ts" />}
      />,
    );
    expect(collapsed.findAllHostsByTestId('strip-tab-peek')).toHaveLength(0);
    const header = collapsed.findHostByTestId('peek-header.root');
    expect(header!.findAll((node) => node.props?.testID === 'track' && typeof node.type === 'string')).toHaveLength(1);
    expect(collapsed.findAllHostsByTestId('track')).toHaveLength(1);
    expect(collapsed.findAllHostsByTestId('open-browser')).toHaveLength(0);

    const withStrip = await renderScreen(
      <DetailsTabGroupPanel
        pane={pane}
        group={group([tab('a', 'a.txt'), tab('b', 'b.txt')])}
        collapseSingleTabStrip
        testIds={testIds}
        renderLiveActions={renderLiveActions}
        renderStripActions={renderStripActions}
        renderHeaderActions={renderPaneActions}
        renderTabContent={(entry) => <DetailsTabHeader testID={`header-${entry.key}`} title={entry.title} />}
      />,
    );
    expect(withStrip.findAllHostsByTestId('track')).toHaveLength(1);
    expect(withStrip.findAllHostsByTestId('open-browser')).toHaveLength(1);
  });
  it('still offers Close in a phone tab’s ⋯ when the pane lends only a live control, not a close of its own', async () => {
    const screen = await renderScreen(
      <SurfaceStateSizeProvider size="phone">
        <DetailsTabGroupPanel
          pane={pane}
          group={group([tab('file', 'retry.ts')])}
          collapseSingleTabStrip
          testIds={testIds}
          renderLiveActions={() => <View testID="track" />}
          renderTabContent={() => <DetailsTabHeader testID="file-header" title="retry.ts" />}
        />
      </SurfaceStateSizeProvider>,
    );
    expect(screen.findAllHostsByTestId('track')).toHaveLength(1);
    const rows = screen.root.find((node) => node.props?.testID === 'file-header.menu' && Array.isArray(node.props.actions))
      .props.actions as { title: string }[];
    expect(rows.map((row) => row.title)).toContain('session.detailsPanel.closeTabA11y');
  });
  it('keeps the strip while the main column is hidden, so its restore chip has the strip edge to sit on (lab H1/H3)', async () => {
    const hiddenMain: PaneMainColumnState = {
      hidden: true,
      canHide: true,
      folded: false,
      labels: { hideLabel: 'Hide project', showLabel: 'Show project' },
      identity: { name: 'files-editor-demo' },
      setHidden: vi.fn(),
      requestHidden: vi.fn(),
      toggle: vi.fn(),
    };
    const screen = await renderScreen(
      <PaneMainColumnContext.Provider value={hiddenMain}>
        <DetailsTabGroupPanel
          pane={pane}
          group={group([tab('peek', 'retry.ts')])}
          collapseSingleTabStrip
          testIds={testIds}
          renderHeaderActions={renderPaneActions}
          renderTabContent={() => <DetailsTabHeader testID="peek-header" title="retry.ts" />}
        />
      </PaneMainColumnContext.Provider>,
    );

    expect(screen.findAllHostsByTestId('pane-main-restore-chip')).toHaveLength(1);
    expect(screen.findAllHostsByTestId('strip-tab-peek')).toHaveLength(1);
    expect(screen.findAllHostsByTestId('pane-close')).toHaveLength(1);
  });
  it('drops the one-tab strip on a phone too when the screen bar above already carries Back (lab FV1p)', async () => {
    const screen = await renderScreen(
      <SurfaceStateSizeProvider size="phone">
        <DetailsTabGroupPanel
          pane={pane}
          group={group([tab('peek', 'retry.ts')])}
          collapseSingleTabStrip
          testIds={testIds}
          renderTabContent={() => <DetailsTabHeader testID="peek-header" title="retry.ts" />}
        />
      </SurfaceStateSizeProvider>,
    );
    expect(screen.findAllHostsByTestId('strip-tab-peek')).toHaveLength(0);
    expect(screen.findHostByTestId('peek-header.root')).not.toBeNull();
  });

  it('lends nothing when the pane has no controls to lend, so a phone header still folds a lone quiet button into ⋯ (lab FV2bp)', async () => {
    // A phone pane's launchers live in the screen bar: its own controls render nothing here.
    const screen = await renderScreen(
      <SurfaceStateSizeProvider size="phone">
        <DetailsTabGroupPanel
          pane={pane}
          group={group([tab('bin', 'firmware.bin')])}
          collapseSingleTabStrip
          testIds={testIds}
          renderHeaderActions={() => null}
          renderTabContent={() => (
            <DetailsTabHeader testID="bin-header" title="firmware.bin"
              buttons={[{ label: 'Add to commit', onPress: () => {}, testID: 'bin-stage' }]} />
          )}
        />
      </SurfaceStateSizeProvider>,
    );
    expect(screen.findAllHostsByTestId('strip-tab-bin')).toHaveLength(0);
    expect(screen.findAllHostsByTestId('bin-stage')).toHaveLength(0);
    expect(screen.findAllHostsByTestId('bin-header.menu')).not.toHaveLength(0);
  });

  it('drops the one-tab phone strip when the pane withholds its leading control (the Session header keeps Back)', async () => {
    const screen = await renderScreen(
      <SurfaceStateSizeProvider size="phone">
        <DetailsTabGroupPanel
          pane={pane}
          group={group([{ ...tab('walk', 'Walkthrough'), isPreview: true }])}
          collapseSingleTabStrip
          testIds={testIds}
          renderHeaderLeadingActions={() => null}
          renderHeaderActions={() => null}
          renderTabContent={() => <DetailsTabHeader testID="walk-header" title="Walkthrough" />}
        />
      </SurfaceStateSizeProvider>,
    );
    expect(screen.findAllHostsByTestId('strip-tab-walk')).toHaveLength(0);
    expect(screen.findHostByTestId('walk-header.root')).not.toBeNull();
    // The chip's own actions (keep open, close) move into the header's ⋯ rather than leaving with the strip.
    const menu = screen.root.find((node) => node.props?.testID === 'walk-header.menu' && Array.isArray(node.props.actions));
    const rows = menu.props.actions as { title: string; onSelect: () => void }[];
    expect(rows.map((row) => row.title)).toEqual(['session.detailsPanel.pinTabA11y', 'session.detailsPanel.closeTabA11y']);
    rows[0]!.onSelect();
    expect(pane.pinDetailsTab).toHaveBeenCalledWith('walk');
  });

  it('closes the pane, not just its tab, from the one tab’s ⋯ when the pane ends with its last tab (a phone Session)', async () => {
    const closeLastTab = vi.fn();
    const screen = await renderScreen(
      <SurfaceStateSizeProvider size="phone">
        <DetailsTabGroupPanel
          pane={pane}
          group={group([tab('file', 'retry.ts')])}
          collapseSingleTabStrip
          testIds={testIds}
          closeLastTab={closeLastTab}
          renderTabContent={() => <DetailsTabHeader testID="file-header" title="retry.ts" />}
        />
      </SurfaceStateSizeProvider>,
    );
    const rows = screen.root.find((node) => node.props?.testID === 'file-header.menu' && Array.isArray(node.props.actions))
      .props.actions as { title: string; onSelect: () => void }[];
    rows.find((row) => row.title === 'session.detailsPanel.closeTabA11y')!.onSelect();
    await vi.waitFor(() => expect(closeLastTab).toHaveBeenCalledOnce());
  });

  it('keeps a wide one-tab header’s ⋯ to the page’s own rows (the strip ruling is phone-only)', async () => {
    const screen = await renderScreen(
      <DetailsTabGroupPanel
        pane={pane}
        group={group([tab('peek', 'retry.ts')])}
        collapseSingleTabStrip
        testIds={testIds}
        renderHeaderActions={renderPaneActions}
        renderTabContent={() => <DetailsTabHeader testID="peek-header" title="retry.ts" />}
      />,
    );
    expect(screen.findAllHostsByTestId('strip-tab-peek')).toHaveLength(0);
    expect(screen.findAllHostsByTestId('peek-header.menu')).toHaveLength(0);
  });

  it('keeps the phone strip when it carries the screen’s own leading control', async () => {
    const screen = await renderScreen(
      <SurfaceStateSizeProvider size="phone">
        <DetailsTabGroupPanel
          pane={pane}
          group={group([tab('peek', 'retry.ts')])}
          collapseSingleTabStrip
          testIds={testIds}
          renderHeaderLeadingActions={() => <View testID="screen-back" />}
          renderTabContent={() => <DetailsTabHeader testID="peek-header" title="retry.ts" />}
        />
      </SurfaceStateSizeProvider>,
    );
    expect(screen.findAllHostsByTestId('strip-tab-peek')).toHaveLength(1);
    expect(screen.findAllHostsByTestId('screen-back')).toHaveLength(1);
  });
});

describe('DetailsTabGroupPanel on a phone: every page header that takes the lent controls offers the other pages', () => {
  // A plugin page's header row (the plugin-ui chrome calls the host's navigation actions) and a core page header
  // (a workflow run page): neither draws the strip's rows itself, yet on a phone they are the page's only chrome.
  const headers: ReadonlyArray<readonly [string, (entry: DetailsTabState) => React.ReactNode]> = [
    ['a plugin page header', (entry) => <View testID={`plugin-header-${entry.key}`}>{renderPluginNavigationActions(null, 'page')}</View>],
    ['a core page header (workflow run)', (entry) => <PageHeader testID={`page-header-${entry.key}`} title={entry.title} />],
  ];
  it.each(headers)('%s in a multi-page group on a phone lists the sibling pages in its ⋯', async (_name, renderHeader) => {
    const screen = await renderScreen(
      <SurfaceStateSizeProvider size="phone">
        <DetailsTabGroupPanel
          pane={pane}
          group={group([tab('plugin', 'Deploys'), tab('run', 'Nightly checks')])}
          collapseSingleTabStrip
          testIds={testIds}
          renderHeaderLeadingActions={() => null}
          renderHeaderActions={() => null}
          renderTabContent={renderHeader}
        />
      </SurfaceStateSizeProvider>,
    );
    try {
      // One tab bar on a phone: the strip folds, and the page on screen draws the lent ⋯ with its sibling.
      expect(stripTabIds(screen)).toEqual([]);
      const menus = screen.root.findAll((node) => node.props?.testID === 'lent-header-menu' && Array.isArray(node.props.actions));
      expect(menus).toHaveLength(1);
      const rows = menus[0]!.props.actions as { title: string; onSelect: () => void }[];
      expect(rows.map((row) => row.title)).toEqual(['Nightly checks', 'session.detailsPanel.closeTabA11y']);
      rows[0]!.onSelect();
      expect(pane.setActiveDetailsTab).toHaveBeenCalledWith('run');
    } finally {
      await screen.unmount();
    }
  });

  it('keeps one ⋯ on a Details header: its own menu carries the rows, the lent controls add none', async () => {
    const screen = await renderScreen(
      <SurfaceStateSizeProvider size="phone">
        <DetailsTabGroupPanel
          pane={pane}
          group={group([tab('a', 'a.txt'), tab('b', 'b.txt')])}
          collapseSingleTabStrip
          testIds={testIds}
          renderHeaderLeadingActions={() => null}
          renderHeaderActions={() => null}
          renderTabContent={(entry) => <DetailsTabHeader testID={`header-${entry.key}`} title={entry.title} />}
        />
      </SurfaceStateSizeProvider>,
    );
    try {
      expect(screen.root.findAll((node) => node.props?.testID === 'lent-header-menu')).toHaveLength(0);
      const rows = screen.root.find((node) => node.props?.testID === 'header-a.menu' && Array.isArray(node.props.actions))
        .props.actions as { title: string }[];
      expect(rows.map((row) => row.title)).toContain('b.txt');
    } finally {
      await screen.unmount();
    }
  });
});

/** The strip's tabs on screen, by test id (tab keys are made test-id safe on the way). */
function stripTabIds(screen: Awaited<ReturnType<typeof renderScreen>>): readonly string[] {
  return [...new Set(screen.findAll((node) => typeof node.type === 'string'
    && typeof node.props?.testID === 'string' && node.props.testID.startsWith('strip-tab-')).map((node) => node.props.testID as string))];
}

describe('DetailsTabGroupPanel on a phone holding several pages (a wide tab group after a resize)', () => {
  const initialStorageState = storage.getState();
  beforeEach(() => {
    storage.setState(initialStorageState, true);
    replacePersistentUiStateForTest(paneUiState, {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    storage.setState(initialStorageState, true);
    replacePersistentUiStateForTest(paneUiState, {});
  });

  it('shows one tab bar on a phone and writes no tab state on a 1440→390→1440 crossing; the other page stays one tap away', async () => {
    const scopeId = 'session:phone-group';
    // The phone layout's tab owner: anything it receives would become a synced tab in the Session tabs rail.
    const presented: PanePresentationIntent[] = [];
    const phoneRail: PanePresentation = (intent) => {
      presented.push(intent);
      return intent.pane === 'details' && intent.fromDetails ? 'ownTab' : undefined;
    };
    const handles: { pane?: AppPaneScopeApi; setPhone?: (phone: boolean) => void } = {};
    function Pane(props: Readonly<{ phone: boolean }>) {
      const scope = useAppPaneScope(scopeId);
      handles.pane = scope;
      const group = scope.scopeState?.details.groups?.[0];
      if (!group) return null;
      return (
        <SurfaceStateSizeProvider size={props.phone ? 'phone' : 'details'}>
          <DetailsTabGroupPanel
            pane={scope}
            group={group}
            collapseSingleTabStrip
            testIds={testIds}
            renderHeaderLeadingActions={() => null}
            renderHeaderActions={() => null}
            renderTabContent={(entry) => <DetailsTabHeader testID={`header-${entry.key}`} title={entry.title} />}
          />
        </SurfaceStateSizeProvider>
      );
    }
    function Layout() {
      const [phone, setPhone] = React.useState(false);
      handles.setPhone = setPhone;
      return (
        <PanePresentationProvider value={phone ? phoneRail : null}>
          <PluginSurfaceFocusEligibilityProvider active>
            <PaneRegionProvider region="details"><Pane phone={phone} /></PaneRegionProvider>
          </PluginSurfaceFocusEligibilityProvider>
        </PanePresentationProvider>
      );
    }
    const screen = await renderScreen(<AppPaneProvider><Layout /></AppPaneProvider>);
    const { act } = await import('react-test-renderer');
    const menuRows = (key: string) => screen.root.find((node) => node.props?.testID === `header-${key}.menu`
      && Array.isArray(node.props.actions)).props.actions as { title: string; onSelect: () => void }[];
    try {
      // Wide: the walkthrough and the file it opened share one pane, under one strip.
      const walkthrough = createSessionScmReviewDetailsTab({ comparison: { kind: 'workingTree' } });
      const file = createWorkspaceFileDetailsTab('file-000.js');
      await act(async () => handles.pane!.openDetailsTab(walkthrough, { intent: 'pinned' }));
      await act(async () => handles.pane!.openDetailsTab(file));
      expect(stripTabIds(screen)).toHaveLength(2);
      const wideScope = handles.pane!.scopeState;
      const paneWrites = vi.spyOn(paneUiState, 'set');

      await act(async () => handles.setPhone!(true));

      // One tab bar: the file stays on screen under its own header, with no strip.
      expect(stripTabIds(screen)).toEqual([]);
      expect(screen.findHostByTestId(`header-${file.key}.root`)).not.toBeNull();
      // The walkthrough the strip offered is in that header's ⋯.
      expect(menuRows(file.key).map((row) => row.title)).toContain(walkthrough.title);

      await act(async () => handles.setPhone!(false));

      // Nothing moved: no tab reached the rail's owner, the pane wrote nothing, and the wide group is intact.
      expect(presented).toEqual([]);
      expect(paneWrites).not.toHaveBeenCalled();
      expect(handles.pane!.scopeState).toBe(wideScope);
      expect(stripTabIds(screen)).toHaveLength(2);

      // On the phone again, choosing the walkthrough from ⋯ shows it, still with one tab bar.
      await act(async () => handles.setPhone!(true));
      await act(async () => menuRows(file.key).find((row) => row.title === walkthrough.title)!.onSelect());
      expect(handles.pane!.scopeState?.details.activeTabKey).toBe(walkthrough.key);
      expect(stripTabIds(screen)).toEqual([]);
      expect(menuRows(walkthrough.key).map((row) => row.title)).toContain(file.title);
      expect(presented).toEqual([]);
    } finally {
      await screen.unmount();
    }
  });
});
