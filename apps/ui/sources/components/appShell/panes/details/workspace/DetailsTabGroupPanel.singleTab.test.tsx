import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { DetailsTabHeader } from '@/components/appShell/panes/details/header/DetailsTabHeader';
import { PaneMainColumnContext, type PaneMainColumnState } from '@/components/appShell/panes/mainColumn/usePaneMainColumn';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';

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
  it('keeps the strip while the main column is hidden, so its restore chip has the strip edge to sit on (lab H1/H3)', async () => {
    const hiddenMain: PaneMainColumnState = {
      hidden: true,
      canHide: true,
      folded: false,
      labels: { hideLabel: 'Hide project', showLabel: 'Show project' },
      identity: { name: 'files-editor-demo' },
      setHidden: vi.fn(),
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
