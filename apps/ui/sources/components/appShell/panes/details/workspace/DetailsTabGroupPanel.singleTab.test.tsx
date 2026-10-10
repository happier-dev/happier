import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { DetailsTabHeader } from '@/components/appShell/panes/details/header/DetailsTabHeader';

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

vi.mock('@/components/sessions/shell/sessionPinIcons', () => ({
  PinIcon: (props: Record<string, unknown>) =>
    React.createElement('PinIcon', props),
  PinSlashIcon: (props: Record<string, unknown>) =>
    React.createElement('PinSlashIcon', props),
}));

vi.mock('@/components/ui/media/FileIcon', () => ({
  FileIcon: (props: Record<string, unknown>) =>
    React.createElement('FileIcon', props),
}));

vi.mock('@/components/ui/scroll/useWebScrollLockBypass', () => ({
  useWebScrollLockBypass: () => {},
}));

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
});
