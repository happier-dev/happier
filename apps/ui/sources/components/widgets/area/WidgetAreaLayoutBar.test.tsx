import * as React from 'react';
import { StyleSheet } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installNavigationCommonModuleMocks();

// Cold module transformation belongs to collection; each test measures the mounted bar.
const { WidgetAreaLayoutBar } = await import('./WidgetAreaLayoutBar');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');

const DASHBOARDS = [
  { id: 'overview', name: 'Overview', isDefault: true },
  { id: 'release', name: 'Release', isDefault: false },
  { id: 'growth', name: 'Growth', isDefault: false },
] as const;
const LABELS = {
  list: 'Dashboards',
  current: (name: string) => `Dashboard: ${name}`,
  create: 'Create dashboard',
  createEllipsis: 'Create dashboard…',
  defaultLayout: 'Default',
  actions: (name: string) => `${name} actions`,
  rename: 'Rename',
  moveBefore: (name: string) => `Move before ${name}`,
  moveAfter: (name: string) => `Move after ${name}`,
  delete: 'Delete',
  deleteLabel: 'Delete',
};

type Screen = Awaited<ReturnType<typeof renderScreen>>;
/** The platform's layout pass: the bar's width, the strip's room and the tabs' natural width. */
async function measure(
  screen: Screen,
  testID: string,
  widths: Readonly<{ bar: number; viewport: number; strip: number }>,
) {
  await act(async () => {
    screen
      .findHostByTestId(testID)!
      .props.onLayout({
        nativeEvent: { layout: { width: widths.bar, height: 40 } },
      });
    screen
      .findByTestId(`${testID}.tabs:viewport`)!
      .props.onLayout({
        nativeEvent: { layout: { width: widths.viewport, height: 40 } },
      });
    screen
      .findByTestId(`${testID}.tabs:strip`)!
      .props.onLayout({
        nativeEvent: { layout: { width: widths.strip, height: 40 } },
      });
  });
}
/** A pane too narrow for its tabs. */
const overflow = (screen: Screen, testID: string) =>
  measure(screen, testID, { bar: 300, viewport: 200, strip: 520 });

describe('WidgetAreaLayoutBar', () => {
  it('names a lone layout as the page title with its menu, never a strip of one tab', async () => {
    const onCreate = vi.fn();
    const screen = await renderScreen(
      <WidgetAreaLayoutBar
        layouts={[DASHBOARDS[0]]}
        labels={LABELS}
        selectedId="overview"
        onSelect={vi.fn()}
        onCreate={onCreate}
        actions={null}
        testID="bar"
      />,
    );
    // Nothing to switch between: no tab strip, the name stands as the title and still lists Create.
    expect(screen.findByTestId('bar.tabs:viewport')).toBeNull();
    expect(screen.findHostByTestId('bar.current')).not.toBeNull();
    expect(screen.findHostByTestId('bar.create')).not.toBeNull();
    const menu = screen.root.findAllByType(DropdownMenu)[0]!;
    expect(menu.props.items.map((item: { id: string }) => item.id)[0]).toBe('overview');
  });

  it('remeasures compact tabs after a rename or deletion and restores the strip when it fits', async () => {
    const props = { selectedId: 'overview', onSelect: () => {}, onCreate: null,
      actions: null, labels: LABELS, testID: 'bar' };
    const screen = await renderScreen(<WidgetAreaLayoutBar {...props} layouts={DASHBOARDS} />);
    await overflow(screen, 'bar');
    expect(screen.findByTestId('bar.current')).not.toBeNull();
    const renamed = DASHBOARDS.map(layout => ({ ...layout, name: layout.id === 'release' ? 'R' : layout.name }));
    await screen.update(<WidgetAreaLayoutBar {...props} layouts={renamed} />);
    expect(screen.findByTestId('bar.tabs:strip')).not.toBeNull();
    await overflow(screen, 'bar');
    await screen.update(<WidgetAreaLayoutBar {...props} layouts={renamed.slice(0, 2)} />);
    expect(screen.findByTestId('bar.tabs:strip')).not.toBeNull();
    await measure(screen, 'bar', { bar: 300, viewport: 260, strip: 120 });
    expect(screen.findByTestId('bar.current')).toBeNull();
    expect(screen.findByTestId('bar.tabs:overview')).not.toBeNull();
    // Deleted down to one, there is nothing to switch between: the name stands as the title.
    await screen.update(<WidgetAreaLayoutBar {...props} layouts={[renamed[0]!]} />);
    expect(screen.findByTestId('bar.tabs:strip')).toBeNull();
    expect(screen.findByTestId('bar.current')).not.toBeNull();
    await screen.unmount();
  });
  it('separates host presets from the viewer layouts in the compact selector', async () => {
    const screen = await renderScreen(
      <WidgetAreaLayoutBar
        layouts={[
          { id: 'overview', name: 'Overview', isPreset: true },
          { id: 'mine', name: 'My view' },
        ]}
        selectedId="overview"
        onSelect={() => {}}
        onCreate={null}
        actions={null}
        labels={LABELS}
        testID="bar"
      />,
    );
    await overflow(screen, 'bar');
    const items = screen.findAllByType(DropdownMenu)[0]!.props.items;
    expect(
      items.find((item: { id: string }) => item.id === 'overview').category,
    ).not.toBe(
      items.find((item: { id: string }) => item.id === 'mine').category,
    );
    await screen.unmount();
  });
  it("draws one underlined tab strip for every area owner: a Project's dashboards and a core page's icon views are the same tabs", async () => {
    const { HappierTabs } = await import('@happier-dev/plugin-ui/presentation');
    const shared = {
      selectedId: 'overview',
      onSelect: () => {},
      onCreate: () => {},
      actions: null,
      labels: LABELS,
    };
    const project = await renderScreen(
      <WidgetAreaLayoutBar {...shared} layouts={DASHBOARDS} testID="project" />,
    );
    const usage = await renderScreen(
      <WidgetAreaLayoutBar
        {...shared}
        testID="usage"
        layouts={[
          {
            id: 'overview',
            name: 'Overview',
            icon: 'squares-four',
            edited: true,
          },
          { id: 'costs', name: 'Costs', icon: 'currency-dollar' },
        ]}
      />,
    );
    expect(project.findAllByType(HappierTabs)).toHaveLength(1);
    expect(usage.findAllByType(HappierTabs)).toHaveLength(1);
    expect(
      project.findByTestId('project.tabs:overview')?.props.accessibilityRole ??
        project.findByTestId('project.tabs:overview')?.props.role,
    ).toBe('tab');
    expect(usage.findHostByTestId('usage.tabs:overview:marker')).not.toBeNull();
    expect(usage.findHostByTestId('usage.tabs:costs:marker')).toBeNull();
    // Create sits on the strip for both owners.
    expect(project.findByTestId('project.create')).not.toBeNull();
    expect(usage.findByTestId('usage.create')).not.toBeNull();
  });
  it('keeps the edited dot and accessible status in wide tabs, the compact trigger and its menu, then clears them after Reset', async () => {
    const props = {
      labels: LABELS,
      layouts: DASHBOARDS.map((dashboard) => ({
        ...dashboard,
        edited: dashboard.id === 'overview',
      })),
      selectedId: 'overview',
      onSelect: () => {},
      onCreate: null,
      actions: null,
      testID: 'bar',
    };
    const wide = await renderScreen(<WidgetAreaLayoutBar {...props} />);
    expect(wide.findHostByTestId('bar.tabs:overview:marker')).not.toBeNull();
    const compact = await renderScreen(<WidgetAreaLayoutBar {...props} />);
    await overflow(compact, 'bar');
    expect(compact.findHostByTestId('bar.current:marker')).not.toBeNull();
    expect(
      compact.findByTestId('bar.current')?.props.accessibilityLabel,
    ).toContain('widgetFrame.presetEdited');
    const menu = compact.findAllByType(DropdownMenu)[0]!;
    const overview = menu.props.items.find(
      (item: { id: string }) => item.id === 'overview',
    );
    expect(overview.accessibilityLabel).toContain('widgetFrame.presetEdited');
    expect(overview.rightElement).toBeTruthy();
    expect(
      menu.props.items.find((item: { id: string }) => item.id === 'release')
        .rightElement,
    ).toBeUndefined();
    await compact.update(
      <WidgetAreaLayoutBar {...props} layouts={DASHBOARDS} labels={LABELS} />,
    );
    expect(compact.findHostByTestId('bar.current:marker')).toBeNull();
    expect(compact.findByTestId('bar.current')).not.toBeNull();
    expect(
      compact.findByTestId('bar.current')?.props.accessibilityLabel,
    ).not.toContain('widgetFrame.presetEdited');
    expect(
      compact.findAllByType(DropdownMenu)[0]!.props.items[0].rightElement,
    ).toBeUndefined();
  });
  it('switches dashboards through the one selector without acting on any document', async () => {
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const screen = await renderScreen(
      <WidgetAreaLayoutBar
        layouts={DASHBOARDS}
        labels={LABELS}
        selectedId="overview"
        onSelect={onSelect}
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

  it('becomes the current-name menu when its measured tabs do not fit, and the tabs again once the bar has the room', async () => {
    const screen = await renderScreen(
      <WidgetAreaLayoutBar
        layouts={DASHBOARDS}
        labels={LABELS}
        selectedId="overview"
        onSelect={() => {}}
        onCreate={() => {}}
        actions={null}
        testID="bar"
      />,
    );
    // Wide enough: the tabs stay (no device class decides this).
    await measure(screen, 'bar', { bar: 700, viewport: 600, strip: 320 });
    expect(screen.findHostByTestId('bar.tabs:overview')).not.toBeNull();
    // The strip runs past its room: the current name replaces it rather than a cut-off tab.
    await measure(screen, 'bar', { bar: 380, viewport: 280, strip: 320 });
    expect(screen.findHostByTestId('bar.tabs:overview')).toBeNull();
    expect(screen.findByTestId('bar.current')).not.toBeNull();
    // Still short of what the tabs need (420): the menu stays.
    await act(async () => {
      screen
        .findHostByTestId('bar')!
        .props.onLayout({
          nativeEvent: { layout: { width: 410, height: 40 } },
        });
    });
    expect(screen.findByTestId('bar.current')).not.toBeNull();
    // Room again: the tabs come back.
    await act(async () => {
      screen
        .findHostByTestId('bar')!
        .props.onLayout({
          nativeEvent: { layout: { width: 430, height: 40 } },
        });
    });
    expect(screen.findHostByTestId('bar.tabs:overview')).not.toBeNull();
  });

  it('keeps the tabs when the scroller reports a transient width while the bar settles, and never sticks on the menu', async () => {
    const screen = await renderScreen(
      <WidgetAreaLayoutBar
        layouts={DASHBOARDS.slice(0, 2)}
        labels={LABELS}
        selectedId="overview"
        onSelect={() => {}}
        onCreate={() => {}}
        actions={null}
        testID="bar"
      />,
    );
    // The bar's own controls are measured where they lay out (64 here); a scroller caught mid-layout at
    // 60 must not turn two tabs into "needs 1000+" and keep the menu up for good.
    await act(async () => { screen.findByTestId('bar.trailing')!.props.onLayout({ nativeEvent: { layout: { width: 64, height: 40 } } }); });
    await measure(screen, 'bar', { bar: 912, viewport: 60, strip: 260 });
    expect(screen.findHostByTestId('bar.tabs:overview')).not.toBeNull();
    expect(screen.findByTestId('bar.current')).toBeNull();
  });

  it('keeps the tab row by dropping the view icons first, and only then becomes the current-name menu', async () => {
    const screen = await renderScreen(
      <WidgetAreaLayoutBar
        labels={LABELS}
        selectedId="overview"
        onSelect={() => {}}
        onCreate={() => {}}
        actions={null}
        testID="views"
        layouts={[
          { id: 'overview', name: 'Overview', icon: 'squares-four' },
          { id: 'costs', name: 'Costs', icon: 'currency-dollar' },
        ]}
      />,
    );
    // With icons the strip needs 420; the bar has 400: the names still fit once the icons step aside.
    await measure(screen, 'views', { bar: 400, viewport: 300, strip: 320 });
    expect(screen.findHostByTestId('views.tabs:overview')).not.toBeNull();
    expect(screen.findByTestId('views.tabs:overview:icon')).toBeNull();
    // Far too narrow even for the names: the current-name menu.
    await act(async () => {
      screen
        .findHostByTestId('views')!
        .props.onLayout({
          nativeEvent: { layout: { width: 300, height: 40 } },
        });
    });
    expect(screen.findByTestId('views.current')).not.toBeNull();
    // Wide again: tabs with their icons.
    await act(async () => {
      screen
        .findHostByTestId('views')!
        .props.onLayout({
          nativeEvent: { layout: { width: 700, height: 40 } },
        });
    });
    expect(screen.findByTestId('views.tabs:overview:icon')).not.toBeNull();
  });

  it('holds the strip invisible, with its space, until the first fit is known, and then paints the final form once', async () => {
    const screen = await renderScreen(
      <WidgetAreaLayoutBar
        labels={LABELS}
        selectedId="overview"
        onSelect={() => {}}
        onCreate={() => {}}
        actions={null}
        testID="views"
        layouts={[
          { id: 'overview', name: 'Overview', icon: 'squares-four' },
          { id: 'costs', name: 'Costs', icon: 'currency-dollar' },
        ]}
      />,
    );
    const opacityOf = () =>
      (StyleSheet.flatten(screen.findHostByTestId('views')!.props.style) as { opacity?: number }).opacity;
    // Unmeasured: the tabs exist (so they can be measured) but nothing is painted yet.
    expect(opacityOf()).toBe(0);
    // The bar needs 420 with icons and has 400: the first painted frame is already the iconless strip.
    await measure(screen, 'views', { bar: 400, viewport: 300, strip: 320 });
    expect(opacityOf()).not.toBe(0);
    expect(screen.findByTestId('views.tabs:overview:icon')).toBeNull();
    // A later width change never hides the strip again.
    await act(async () => {
      screen.findHostByTestId('views')!.props.onLayout({ nativeEvent: { layout: { width: 700, height: 40 } } });
    });
    expect(opacityOf()).not.toBe(0);
  });

  it('becomes the current-name menu on a narrow pane, with Create at its end', async () => {
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    const screen = await renderScreen(
      <WidgetAreaLayoutBar
        layouts={DASHBOARDS}
        labels={LABELS}
        selectedId="release"
        onSelect={onSelect}
        onCreate={onCreate}
        actions={null}
        testID="bar"
      />,
    );
    await overflow(screen, 'bar');
    expect(screen.findHostByTestId('bar.tabs:release')).toBeNull();
    // The narrow bar keeps its own Create beside the current name, as the tabs do.
    expect(screen.findHostByTestId('bar.create')).not.toBeNull();
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
