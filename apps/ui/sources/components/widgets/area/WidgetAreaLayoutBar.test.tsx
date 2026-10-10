import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installNavigationCommonModuleMocks();

const DASHBOARDS = [
  { id: 'overview', name: 'Overview', isDefault: true },
  { id: 'release', name: 'Release', isDefault: false },
  { id: 'growth', name: 'Growth', isDefault: false },
] as const;
const LABELS = {
  list: 'Dashboards', current: (name: string) => `Dashboard: ${name}`, create: 'Create dashboard', createEllipsis: 'Create dashboard…',
  defaultLayout: 'Default', actions: (name: string) => `${name} actions`, rename: 'Rename', moveBefore: (name: string) => `Move before ${name}`,
  moveAfter: (name: string) => `Move after ${name}`, delete: 'Delete', deleteLabel: 'Delete',
};

describe('WidgetAreaLayoutBar', () => {
  it('draws one underlined tab strip for every area owner: a Project\'s dashboards and a core page\'s icon views are the same tabs', async () => {
    const { WidgetAreaLayoutBar } = await import('./WidgetAreaLayoutBar');
    const { HappierTabs } = await import('@happier-dev/plugin-ui/presentation');
    const shared = { selectedId: 'overview', onSelect: () => {}, onCreate: () => {}, actions: null, labels: LABELS, narrow: false };
    const project = await renderScreen(<WidgetAreaLayoutBar {...shared} layouts={DASHBOARDS} testID="project" />);
    const usage = await renderScreen(<WidgetAreaLayoutBar {...shared} testID="usage"
      layouts={[{ id: 'overview', name: 'Overview', icon: 'squares-four', edited: true }, { id: 'costs', name: 'Costs', icon: 'currency-dollar' }]} />);
    expect(project.findAllByType(HappierTabs)).toHaveLength(1);
    expect(usage.findAllByType(HappierTabs)).toHaveLength(1);
    expect(project.findByTestId('project.tabs:overview')?.props.accessibilityRole ?? project.findByTestId('project.tabs:overview')?.props.role).toBe('tab');
    expect(usage.findHostByTestId('usage.tabs:overview:marker')).not.toBeNull();
    expect(usage.findHostByTestId('usage.tabs:costs:marker')).toBeNull();
    // Create sits on the strip for both owners.
    expect(project.findByTestId('project.create')).not.toBeNull();
    expect(usage.findByTestId('usage.create')).not.toBeNull();
  });
  it('keeps the edited dot and accessible status in wide tabs, the compact trigger and its menu, then clears them after Reset', async () => {
    const { WidgetAreaLayoutBar } = await import('./WidgetAreaLayoutBar');
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const props = { labels: LABELS, layouts: DASHBOARDS.map(dashboard => ({ ...dashboard, edited: dashboard.id === 'overview' })),
      selectedId: 'overview', onSelect: () => {}, onCreate: null, actions: null, testID: 'bar' };
    const wide = await renderScreen(<WidgetAreaLayoutBar {...props} narrow={false} />);
    expect(wide.findHostByTestId('bar.tabs:overview:marker')).not.toBeNull();
    const compact = await renderScreen(<WidgetAreaLayoutBar {...props} narrow />);
    expect(compact.findHostByTestId('bar.current:marker')).not.toBeNull();
    expect(compact.findByTestId('bar.current')?.props.accessibilityLabel).toContain('widgetFrame.presetEdited');
    const menu = compact.findAllByType(DropdownMenu)[0]!;
    const overview = menu.props.items.find((item: { id: string }) => item.id === 'overview');
    expect(overview.accessibilityLabel).toContain('widgetFrame.presetEdited');
    expect(overview.rightElement).toBeTruthy();
    expect(menu.props.items.find((item: { id: string }) => item.id === 'release').rightElement).toBeUndefined();
    await compact.update(<WidgetAreaLayoutBar {...props} layouts={DASHBOARDS}
        labels={LABELS} narrow />);
    expect(compact.findHostByTestId('bar.current:marker')).toBeNull();
    expect(compact.findByTestId('bar.current')).not.toBeNull();
    expect(compact.findByTestId('bar.current')?.props.accessibilityLabel).not.toContain('widgetFrame.presetEdited');
    expect(compact.findAllByType(DropdownMenu)[0]!.props.items[0].rightElement).toBeUndefined();
  });
  it('switches dashboards through the one selector without acting on any document', async () => {
    const { WidgetAreaLayoutBar } = await import('./WidgetAreaLayoutBar');
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const screen = await renderScreen(
      <WidgetAreaLayoutBar
        layouts={DASHBOARDS}
        labels={LABELS}
        selectedId="overview"
        onSelect={onSelect}
        narrow={false}
        onCreate={onCreate}
        actions={null}
        testID="bar"
      />,
    );
    screen.pressByTestId('bar.tabs:release');
    expect(onSelect).toHaveBeenCalledWith('release');
    screen.pressByTestId('bar.create');
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('acts on the exact selected document and refuses the default delete with the owner reason', async () => {
    const { WidgetAreaLayoutBar } = await import('./WidgetAreaLayoutBar');
    const { DropdownMenu } =
      await import('@/components/ui/forms/dropdown/DropdownMenu');
    const share = vi.fn();
    const rename = vi.fn();
    const moveAfter = vi.fn();
    const attach = vi.fn();
    const screen = await renderScreen(
      <WidgetAreaLayoutBar
        layouts={DASHBOARDS}
        labels={LABELS}
        selectedId="overview"
        onSelect={() => {}}
        narrow={false}
        onCreate={() => {}}
        actions={{
          share,
          rename,
          moveAfter: { name: 'Release', onPress: moveAfter },
          attach: {
            header: 'Acme sources you manage',
            sources: [
              {
                id: 'happier',
                name: 'happier',
                address: 'github.com/happier-dev/happier',
                attached: false,
              },
            ],
            onToggle: attach,
          },
          delete: { disabledReason: 'projects.dashboard.defaultProtected' },
        }}
        testID="bar"
      />,
    );
    const menu = screen.root
      .findAllByType(DropdownMenu)
      .find((node) =>
        node.props.items.some((item: { id: string }) => item.id === 'share'),
      )!;
    const del = menu.props.items.find(
      (item: { id: string }) => item.id === 'delete',
    );
    expect(del).toMatchObject({
      disabled: true,
      subtitle: 'projects.dashboard.defaultProtected',
    });
    expect(menu.props.items.map((item: { id: string }) => item.id)).toEqual([
      'share',
      'attach',
      'rename',
      'moveAfter',
      'delete',
    ]);
    act(() => {
      menu.props.onSelect('delete');
    });
    act(() => {
      menu.props.onSelect('moveAfter');
    });
    act(() => {
      menu.props.onSelect('source:happier');
    });
    expect(moveAfter).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith('happier');
    expect(share).not.toHaveBeenCalled();
  });

  it('becomes the current-name menu on a narrow pane, with Create at its end', async () => {
    const { WidgetAreaLayoutBar } = await import('./WidgetAreaLayoutBar');
    const { DropdownMenu } =
      await import('@/components/ui/forms/dropdown/DropdownMenu');
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const screen = await renderScreen(
      <WidgetAreaLayoutBar
        layouts={DASHBOARDS}
        labels={LABELS}
        selectedId="release"
        onSelect={onSelect}
        narrow
        onCreate={onCreate}
        actions={null}
        testID="bar"
      />,
    );
    expect(screen.findHostByTestId('bar.tabs:release')).toBeNull();
    const menu = screen.root.findAllByType(DropdownMenu)[0]!;
    expect(menu.props.selectedId).toBe('release');
    const ids = menu.props.items.map((item: { id: string }) => item.id);
    expect(ids.slice(0, 3)).toEqual(['overview', 'release', 'growth']);
    act(() => {
      menu.props.onSelect('growth');
    });
    act(() => {
      menu.props.onSelect(ids[3]);
    });
    expect(onSelect).toHaveBeenCalledWith('growth');
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});
