import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const localSettingsStore = (() => {
  let sidebarCollapsed = false;
  const listeners = new Set<() => void>();

  return {
    get sidebarCollapsed() {
      return sidebarCollapsed;
    },
    setSidebarCollapsed(next: boolean) {
      sidebarCollapsed = next;
      for (const l of listeners) l();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();

let platformOS: 'web' | 'ios' = 'web';

vi.mock('react-native', () => ({
  View: (props: any) => React.createElement('View', props, props.children),
  Pressable: (props: any) => React.createElement('Pressable', props, props.children),
  useWindowDimensions: () => ({ width: 1000, height: 800 }),
  Platform: {
    get OS() {
      return platformOS;
    },
  },
}));

vi.mock('expo-router/drawer', () => ({
  Drawer: (props: any) =>
    React.createElement(
      'Drawer',
      props,
      props.drawerContent ? props.drawerContent({}) : null
    ),
}));

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock('@/utils/platform/responsive', () => ({
  useIsTablet: () => true,
}));

vi.mock('@/sync/domains/state/storage', async () => {
  const React = await import('react');

  return {
    useLocalSetting: (key: string) => {
      return React.useSyncExternalStore(
        (listener) => localSettingsStore.subscribe(listener),
        () => {
          if (key === 'sidebarCollapsed') return localSettingsStore.sidebarCollapsed;
          return false;
        },
        () => {
          if (key === 'sidebarCollapsed') return localSettingsStore.sidebarCollapsed;
          return false;
        }
      );
    },
    useLocalSettingMutable: (key: string) => {
      const val = (React as any).useSyncExternalStore(
        (listener: any) => localSettingsStore.subscribe(listener),
        () => {
          if (key === 'sidebarCollapsed') return localSettingsStore.sidebarCollapsed;
          return false;
        },
        () => {
          if (key === 'sidebarCollapsed') return localSettingsStore.sidebarCollapsed;
          return false;
        }
      );
      return [val, (next: boolean) => {
        if (key === 'sidebarCollapsed') localSettingsStore.setSidebarCollapsed(next);
      }] as const;
    },
  };
});

vi.mock('./SidebarView', () => ({
  SidebarView: () => React.createElement('SidebarView', {}, null),
}));

vi.mock('./CollapsedSidebarView', () => ({
  CollapsedSidebarView: () =>
    React.createElement(
      'CollapsedSidebarView',
      {},
      React.createElement('Pressable', { testID: 'sidebar-expand-button' }, React.createElement('SidebarCollapseIcon', {}, null))
    ),
}));

vi.mock('./SidebarIcons', () => ({
  SidebarExpandIcon: (props: any) => React.createElement('SidebarExpandIcon', props, null),
  SidebarCollapseIcon: (props: any) => React.createElement('SidebarCollapseIcon', props, null),
}));

function getDrawer(tree: renderer.ReactTestRenderer) {
  return tree.root.findByType('Drawer' as any);
}

describe('SidebarNavigator (collapsed sidebar)', () => {
  beforeEach(() => {
    act(() => {
      localSettingsStore.setSidebarCollapsed(false);
    });
    platformOS = 'web';
  });

  it('uses a collapsed drawer width when sidebarCollapsed is true', async () => {
    act(() => {
      localSettingsStore.setSidebarCollapsed(true);
    });

    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<SidebarNavigator />);
    });

    const drawer = getDrawer(tree);
    expect(drawer.props.screenOptions.drawerStyle.width).toBe(72);
  });

  it('collapses when the collapse button is pressed', async () => {
    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<SidebarNavigator />);
    });

    expect(localSettingsStore.sidebarCollapsed).toBe(false);

    const collapseButton = tree.root.findByProps({ testID: 'sidebar-collapse-button' });

    await act(async () => {
      collapseButton.props.onPress();
    });

    expect(localSettingsStore.sidebarCollapsed).toBe(true);

    const drawer = getDrawer(tree);
    expect(drawer.props.screenOptions.drawerStyle.width).toBe(72);
  });

  it('renders the collapse icon button on desktop', async () => {
    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<SidebarNavigator />);
    });

    const collapseButton = tree.root.findByProps({ testID: 'sidebar-collapse-button' });
    expect(collapseButton.findByType('SidebarExpandIcon' as any)).toBeDefined();
  });

  it('does not render collapse button on mobile', async () => {
    platformOS = 'ios';
    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<SidebarNavigator />);
    });

    const collapseButtons = tree.root.findAllByProps({ testID: 'sidebar-collapse-button' });
    expect(collapseButtons).toHaveLength(0);
  });

  it('renders the expand icon button in collapsed sidebar on desktop', async () => {
    act(() => {
      localSettingsStore.setSidebarCollapsed(true);
    });
    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<SidebarNavigator />);
    });

    const expandButton = tree.root.findByProps({ testID: 'sidebar-expand-button' });
    expect(expandButton.findByType('SidebarCollapseIcon' as any)).toBeDefined();
  });
});
