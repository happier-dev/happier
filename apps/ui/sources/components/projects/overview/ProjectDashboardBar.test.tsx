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

describe('ProjectDashboardBar', () => {
  it('switches dashboards through the one selector without acting on any document', async () => {
    const { ProjectDashboardBar } = await import('./ProjectDashboardBar');
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const screen = await renderScreen(
      <ProjectDashboardBar
        dashboards={DASHBOARDS}
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
    const { ProjectDashboardBar } = await import('./ProjectDashboardBar');
    const { DropdownMenu } =
      await import('@/components/ui/forms/dropdown/DropdownMenu');
    const share = vi.fn();
    const rename = vi.fn();
    const moveAfter = vi.fn();
    const attach = vi.fn();
    const screen = await renderScreen(
      <ProjectDashboardBar
        dashboards={DASHBOARDS}
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
    const { ProjectDashboardBar } = await import('./ProjectDashboardBar');
    const { DropdownMenu } =
      await import('@/components/ui/forms/dropdown/DropdownMenu');
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const screen = await renderScreen(
      <ProjectDashboardBar
        dashboards={DASHBOARDS}
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
