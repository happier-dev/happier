import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
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

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => `en:${key}` });
});

function textOf(node: { children: unknown[] } | null): string {
  if (!node) return '';
  return node.children
    .map((child) =>
      typeof child === 'string'
        ? child
        : textOf(child as { children: unknown[] }),
    )
    .join('');
}

describe('RightSidebarPaneHeader', { timeout: 240_000 }, () => {
  it('shows the live line and next step of the active tab only, from what each tab publishes', async () => {
    const { RightSidebarPaneHeader } = await import('./RightSidebarPaneHeader');
    const { resolveRightSidebarTabs } =
      await import('./rightSidebarTabRegistry');
    const {
      PaneHeaderSlotProvider,
      PaneHeaderSlotScope,
      usePaneHeaderSlotContent,
    } = await import('@/components/appShell/panes/paneHeaderSlot');
    const tabs = resolveRightSidebarTabs({
      scope: 'session',
      presentation: 'desktop',
    });

    function GitBody() {
      const action = React.useMemo(
        () => <React.Fragment key="push">Push 2</React.Fragment>,
        [],
      );
      usePaneHeaderSlotContent({
        line: {
          segments: [
            { text: 'v0.3', emphasis: true },
            '14 changed',
            '2 to push',
          ],
        },
        action,
      });
      return null;
    }
    function FilesBody() {
      usePaneHeaderSlotContent({
        line: { segments: ['happier on MacBook Pro', '14 changed'] },
      });
      return null;
    }
    let selectTab: (tabId: string) => void = () => {};
    function Panel() {
      const [active, setActive] = React.useState('git');
      selectTab = setActive;
      return (
        <PaneHeaderSlotProvider>
          <RightSidebarPaneHeader
            tabs={tabs}
            activeTabId={active}
            testID="pane"
          />
          <PaneHeaderSlotScope slotKey="git">
            <GitBody />
          </PaneHeaderSlotScope>
          <PaneHeaderSlotScope slotKey="files">
            <FilesBody />
          </PaneHeaderSlotScope>
        </PaneHeaderSlotProvider>
      );
    }

    const screen = await renderScreen(<Panel />);
    expect(textOf(screen.findHostByTestId('pane.subtitle') as never)).toBe(
      'v0.3 · 14 changed · 2 to push',
    );
    expect(textOf(screen.findHostByTestId('pane') as never)).toContain(
      'Push 2',
    );

    await act(async () => {
      selectTab('files');
    });
    expect(textOf(screen.findHostByTestId('pane.subtitle') as never)).toBe(
      'happier on MacBook Pro · 14 changed',
    );
    expect(textOf(screen.findHostByTestId('pane') as never)).not.toContain(
      'Push 2',
    );
  });

  it("folds the pane's and the tab's rare operations into one ⋯ after the tab's action", async () => {
    const { RightSidebarPaneHeader } = await import('./RightSidebarPaneHeader');
    const { resolveRightSidebarTabs } =
      await import('./rightSidebarTabRegistry');
    const {
      PaneHeaderSlotProvider,
      PaneHeaderSlotScope,
      usePaneHeaderSlotContent,
    } = await import('@/components/appShell/panes/paneHeaderSlot');
    const tabs = resolveRightSidebarTabs({
      scope: 'session',
      presentation: 'desktop',
    });
    const tabMenu = [
      {
        id: 'roles.useDefaults',
        title: 'Use defaults',
        icon: 'arrow-arc-left' as const,
        onPress: () => {},
      },
    ];

    function WorkBody() {
      const action = React.useMemo(
        () => <React.Fragment key="plus">Add</React.Fragment>,
        [],
      );
      usePaneHeaderSlotContent({ action, menuActions: tabMenu });
      return null;
    }

    const screen = await renderScreen(
      <PaneHeaderSlotProvider>
        <RightSidebarPaneHeader
          tabs={tabs}
          activeTabId="files"
          testID="pane"
          menuActions={[
            {
              id: 'companion',
              title: 'Add to Companion',
              icon: 'plus',
              onPress: () => {},
            },
          ]}
        />
        <PaneHeaderSlotScope slotKey="files">
          <WorkBody />
        </PaneHeaderSlotScope>
      </PaneHeaderSlotProvider>,
    );
    const triggers = screen.findAll(
      (node) =>
        node.props.testID === 'pane.menu' && typeof node.type === 'string',
    );
    expect(triggers).toHaveLength(1);
    expect(textOf(screen.findHostByTestId('pane') as never)).toContain('Add');

    // A tab's operations reach the ⋯ even when the pane has none of its own.
    const tabOnly = await renderScreen(
      <PaneHeaderSlotProvider>
        <RightSidebarPaneHeader tabs={tabs} activeTabId="files" testID="pane" />
        <PaneHeaderSlotScope slotKey="files">
          <WorkBody />
        </PaneHeaderSlotScope>
      </PaneHeaderSlotProvider>,
    );
    expect(
      tabOnly.findAll(
        (node) =>
          node.props.testID === 'pane.menu' && typeof node.type === 'string',
      ),
    ).toHaveLength(1);
  });

  it("opens the pane's ⋯ as a light menu over the window, never a blurred one, and runs the chosen operation", async () => {
    const { RightSidebarPaneHeader } = await import('./RightSidebarPaneHeader');
    const { resolveRightSidebarTabs } =
      await import('./rightSidebarTabRegistry');
    const {
      PaneHeaderSlotProvider,
      PaneHeaderSlotScope,
      usePaneHeaderSlotContent,
    } = await import('@/components/appShell/panes/paneHeaderSlot');
    const tabs = resolveRightSidebarTabs({
      scope: 'session',
      presentation: 'desktop',
    });
    const expandMap = vi.fn();
    const tabMenu = [
      {
        id: 'work.expandMap',
        title: 'Open the map beside the session',
        icon: 'arrows-out' as const,
        onPress: expandMap,
      },
    ];

    function WorkBody() {
      usePaneHeaderSlotContent({ menuActions: tabMenu });
      return null;
    }

    const screen = await renderScreen(
      <PaneHeaderSlotProvider>
        <RightSidebarPaneHeader tabs={tabs} activeTabId="files" testID="pane" />
        <PaneHeaderSlotScope slotKey="files">
          <WorkBody />
        </PaneHeaderSlotScope>
      </PaneHeaderSlotProvider>,
    );
    const { DropdownMenu } =
      await import('@/components/ui/forms/dropdown/DropdownMenu');
    const { ItemRowActions } =
      await import('@/components/ui/lists/ItemRowActions');
    // The ⋯ is the header's chrome dropdown (like the "+" beside it), not a row's blurred spotlight menu.
    expect(screen.findAll((node) => node.type === ItemRowActions)).toHaveLength(0);
    expect(
      screen.findAll(
        (node) => node.props.testID === 'pane.menu' && typeof node.type === 'string',
      ),
    ).toHaveLength(1);
    // Opening draws through the shared Popover (covered by its DOM suites); here the menu's contract.
    const menu = screen.findAll((node) => node.type === DropdownMenu)[0];
    expect(menu?.props.open).toBe(false);
    expect(
      menu?.props.items.map((item: { id: string; title: string }) => [item.id, item.title]),
    ).toEqual([['work.expandMap', 'Open the map beside the session']]);
    await act(async () => {
      menu!.props.onSelect('work.expandMap');
    });
    expect(expandMap).toHaveBeenCalledTimes(1);
  });

  it('draws no live line for a tab that publishes nothing', async () => {
    const { RightSidebarPaneHeader } = await import('./RightSidebarPaneHeader');
    const { resolveRightSidebarTabs } =
      await import('./rightSidebarTabRegistry');
    const { PaneHeaderSlotProvider } =
      await import('@/components/appShell/panes/paneHeaderSlot');
    const tabs = resolveRightSidebarTabs({
      scope: 'session',
      presentation: 'desktop',
    });

    const screen = await renderScreen(
      <PaneHeaderSlotProvider>
        <RightSidebarPaneHeader tabs={tabs} activeTabId="files" testID="pane" />
      </PaneHeaderSlotProvider>,
    );
    expect(screen.findHostByTestId('pane.title')).not.toBeNull();
    expect(screen.findHostByTestId('pane.subtitle')).toBeNull();
  });

  it('shows what a plugin tab publishes through the plugin-ui pane header binding, and nothing outside a header', async () => {
    const { RightSidebarPaneHeader } = await import('./RightSidebarPaneHeader');
    const { resolveRightSidebarTabs } =
      await import('./rightSidebarTabRegistry');
    const {
      PaneHeaderSlotProvider,
      PaneHeaderSlotScope,
      usePaneHeaderSlotBinding,
    } = await import('@/components/appShell/panes/paneHeaderSlot');
    const { View } = await import('react-native');
    const tabs = resolveRightSidebarTabs({
      scope: 'session',
      presentation: 'desktop',
    });

    // The binding a plugin mount receives: what `PaneHeaderContent` calls from inside the plugin tree.
    function PluginTab() {
      const binding = usePaneHeaderSlotBinding();
      if (binding === null) return <View testID="no-binding" />;
      return (
        <>
          {binding.renderPaneHeader({
            line: ['1 needs you'],
            actions: <React.Fragment key="plus">Link a PR</React.Fragment>,
          })}
        </>
      );
    }

    const screen = await renderScreen(
      <PaneHeaderSlotProvider>
        <RightSidebarPaneHeader tabs={tabs} activeTabId="files" testID="pane" />
        <PaneHeaderSlotScope slotKey="files">
          <PluginTab />
        </PaneHeaderSlotScope>
      </PaneHeaderSlotProvider>,
    );
    expect(textOf(screen.findHostByTestId('pane.subtitle') as never)).toBe(
      '1 needs you',
    );
    expect(textOf(screen.findHostByTestId('pane') as never)).toContain(
      'Link a PR',
    );

    const bare = await renderScreen(<PluginTab />);
    expect(bare.findHostByTestId('no-binding')).not.toBeNull();
  });
});
