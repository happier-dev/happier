// @vitest-environment jsdom
import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';

installUiListsCommonModuleMocks();
vi.mock('@/utils/web/reactDomCjs', () => ({
  // ReactTestRenderer cannot mount DOM portals; keep the real popover/menu beneath this boundary.
  requireReactDOM: () => ({
    createPortal: (children: React.ReactNode) => children,
  }),
}));

const { ProjectShellHeader } = await import('./ProjectShellHeader');
const { PageActionsLendScope } =
  await import('@/components/navigation/stackHeaderActions');
const { renderPluginNavigationActions } =
  await import('@/components/plugins/surfaces/pluginPageHeaderActions');

const KEY = 'project-page-actions:test';

function inside(node: ReactTestInstance, testID: string): boolean {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (parent.props.testID === testID) return true;
  return false;
}

/** A plugin page's toolbar row: its primary (Run workflow) and its ⋯, handed to the host as a Collection toolbar does. */
function toolbarRow(selected: string[]) {
  return (
    <View testID="plugin-toolbar-row">
      {renderPluginNavigationActions(
        React.createElement('RunWorkflowPrimary'),
        'navigation',
        {
          menu: React.createElement('PluginMoreMenu'),
          items: [
            { id: 'github', label: 'Open Actions on GitHub', icon: 'external' },
          ],
          onSelect: (id: string) => {
            selected.push(id);
          },
          // Run workflow needs one choice first: its label and its menu cross, and the header draws them.
          primary: {
            label: 'Run workflow',
            menu: {
              items: [{ id: 'deploy', label: 'Deploy' }],
              onSelect: (id: string) => {
                selected.push(`run:${id}`);
              },
            },
          },
        },
      )}
    </View>
  );
}

function header(newSessions: { count: number }) {
  return (
    <ProjectShellHeader
      projectName="Project"
      checkout={null}
      pages={[]}
      activePage="actions"
      onSelectPage={() => {}}
      onNewSession={() => {
        newSessions.count += 1;
      }}
      pageActionsKey={KEY}
      menuActions={[{ id: 'terminal', title: 'Terminal', onSelect: () => {} }]}
    />
  );
}

describe('Project header and its plugin page actions (D11)', () => {
  afterEach(standardCleanup);

  it("draws the shown page's primary as its own + with the page's menu, and the page's ⋯ rows in its own ⋯ with New session there; the page row draws neither", async () => {
    const selected: string[] = [];
    const newSessions = { count: 0 };
    const screen = await renderScreen(
      <PageActionsLendScope scopeKey={KEY}>
        {header(newSessions)}
        {toolbarRow(selected)}
      </PageActionsLendScope>,
    );
    // The header draws its own +, the same control as New session, named by the page's label; the plugin's node is
    // drawn nowhere.
    expect(screen.root.findAllByType('RunWorkflowPrimary' as never)).toHaveLength(0);
    const plus = screen.root.findAll((node) => node.props.testID === 'project-shell-header.pagePrimary'
      && typeof node.type !== 'string');
    expect(plus.length).toBeGreaterThan(0);
    expect([plus[0]!.props.title, plus[0]!.props.accessibilityLabel]).toContain('Run workflow');
    const primaryMenu = screen.root.findAll((node) => node.props.testID === 'project-shell-header.pagePrimary.menu'
      && typeof node.type !== 'string' && Array.isArray(node.props.items))[0]!;
    expect(primaryMenu.props.items.map((item: { title: string }) => item.title)).toEqual(['Deploy']);
    await React.act(async () => {
      primaryMenu.props.onSelect(primaryMenu.props.items[0].id);
    });
    expect(screen.root.findAllByType('PluginMoreMenu' as never)).toHaveLength(
      0,
    );
    expect(
      screen.findHostByTestId('project-shell-header.newSession'),
    ).toBeFalsy();

    // The header's one ⋯ (its PageHeaderMenu, found by the header's menu id: a memo type is not matched by type).
    const menus = screen.root.findAll((node) => node.props.testID === 'project-shell-header.menu'
      && typeof node.type !== 'string' && Array.isArray(node.props.actions));
    expect(menus.length).toBeGreaterThan(0);
    const rows = menus[0]!.props.actions as readonly {
      id: string;
      title: string;
      onSelect: () => void;
    }[];
    expect(rows.map((row) => row.title)).toEqual(
      expect.arrayContaining(['Open Actions on GitHub', 'Terminal']),
    );
    await React.act(async () => {
      rows.find((row) => row.title === 'Open Actions on GitHub')!.onSelect();
    });
    await React.act(async () => {
      rows.find((row) => row.id === 'newSession')!.onSelect();
    });
    expect(selected).toEqual(['run:deploy', 'github']);
    expect(newSessions.count).toBe(1);
  });

  it('leaves a page with no claiming header drawing its own ⋯ and primary in its row', async () => {
    const screen = await renderScreen(
      <PageActionsLendScope scopeKey={KEY}>
        {toolbarRow([])}
      </PageActionsLendScope>,
    );
    const primary = screen.root.findByType('RunWorkflowPrimary' as never);
    const more = screen.root.findByType('PluginMoreMenu' as never);
    expect(inside(primary, 'plugin-toolbar-row')).toBe(true);
    expect(inside(more, 'plugin-toolbar-row')).toBe(true);
  });
});
