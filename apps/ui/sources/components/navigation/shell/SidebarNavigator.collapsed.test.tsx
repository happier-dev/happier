import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const localSettingsStore = (() => {
  let sidebarCollapsed = false;
  let editorFocusModeEnabled = false;
  const listeners = new Set<() => void>();

  return {
    get sidebarCollapsed() {
      return sidebarCollapsed;
    },
    get editorFocusModeEnabled() {
      return editorFocusModeEnabled;
    },
    setSidebarCollapsed(next: boolean) {
      sidebarCollapsed = next;
      for (const l of listeners) l();
    },
    setEditorFocusModeEnabled(next: boolean) {
      editorFocusModeEnabled = next;
      for (const l of listeners) l();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();

let platformOS: 'web' | 'ios' = 'web';
let windowDimensions = { width: 1000, height: 800 };

const drawerLifecycle = { mounts: 0, unmounts: 0 };

vi.mock('react-native', () => ({
  View: (props: any) => React.createElement('View', props, props.children),
  Pressable: (props: any) => React.createElement('Pressable', props, props.children),
  PanResponder: { create: () => ({ panHandlers: {} }) },
  Dimensions: {
    get: () => ({ width: windowDimensions.width, height: windowDimensions.height, scale: 1, fontScale: 1 }),
  },
  useWindowDimensions: () => ({ width: windowDimensions.width, height: windowDimensions.height }),
  Platform: {
    get OS() {
      return platformOS;
    },
    select: (options: any) => options?.[platformOS] ?? options?.default ?? options?.ios ?? options?.android,
  },
}));

vi.mock('expo-router/drawer', () => ({
  Drawer: (props: any) => {
    React.useEffect(() => {
      drawerLifecycle.mounts += 1;
      return () => {
        drawerLifecycle.unmounts += 1;
      };
    }, []);

    return React.createElement(
      'Drawer',
      props,
      props.drawerContent ? props.drawerContent({}) : null
    );
  },
}));

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock('@/sync/domains/state/storage', async () => {
  const React = await import('react');

  return {
    useLocalSetting: (key: string) => {
      return React.useSyncExternalStore(
        (listener) => localSettingsStore.subscribe(listener),
        () => {
          if (key === 'sidebarCollapsed') return localSettingsStore.sidebarCollapsed;
          if (key === 'editorFocusModeEnabled') return localSettingsStore.editorFocusModeEnabled;
          if (key === 'sidebarWidthPx') return 320;
          if (key === 'sidebarWidthBasisPx') return 1200;
          return false;
        },
        () => {
          if (key === 'sidebarCollapsed') return localSettingsStore.sidebarCollapsed;
          if (key === 'editorFocusModeEnabled') return localSettingsStore.editorFocusModeEnabled;
          if (key === 'sidebarWidthPx') return 320;
          if (key === 'sidebarWidthBasisPx') return 1200;
          return false;
        }
      );
    },
    useLocalSettingMutable: (key: string) => {
      const val = (React as any).useSyncExternalStore(
        (listener: any) => localSettingsStore.subscribe(listener),
        () => {
          if (key === 'sidebarCollapsed') return localSettingsStore.sidebarCollapsed;
          if (key === 'editorFocusModeEnabled') return localSettingsStore.editorFocusModeEnabled;
          if (key === 'sidebarWidthPx') return 320;
          if (key === 'sidebarWidthBasisPx') return 1200;
          return false;
        },
        () => {
          if (key === 'sidebarCollapsed') return localSettingsStore.sidebarCollapsed;
          if (key === 'editorFocusModeEnabled') return localSettingsStore.editorFocusModeEnabled;
          if (key === 'sidebarWidthPx') return 320;
          if (key === 'sidebarWidthBasisPx') return 1200;
          return false;
        }
      );
      return [val, (next: boolean) => {
        if (key === 'sidebarCollapsed') localSettingsStore.setSidebarCollapsed(next);
        if (key === 'editorFocusModeEnabled') localSettingsStore.setEditorFocusModeEnabled(next);
        // Sidebar width settings are out-of-scope for this suite.
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
      localSettingsStore.setEditorFocusModeEnabled(false);
    });
    platformOS = 'web';
    windowDimensions = { width: 1000, height: 800 };
    drawerLifecycle.mounts = 0;
    drawerLifecycle.unmounts = 0;
  });

  it('stops wheel propagation on web so sidebar scrolling is not blocked by document scroll-lock listeners', async () => {
    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<SidebarNavigator />);
    });

    const wheelBoundary = tree.root.find((node) => {
      return (node.type as any) === 'View' && typeof (node.props as any)?.onWheel === 'function';
    });

    const stopPropagation = vi.fn();
    wheelBoundary.props.onWheel({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  }, 60_000);

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

  it('enables the permanent drawer when min edge is at least 600px', async () => {
    windowDimensions = { width: 800, height: 600 };

    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<SidebarNavigator />);
    });

    const drawer = getDrawer(tree);
    expect(drawer.props.screenOptions.drawerType).toBe('permanent');
    expect(drawer.props.screenOptions.drawerStyle.width).toBeGreaterThan(0);
  });

  it('hides the permanent drawer when min edge is below 600px (e.g. landscape phone)', async () => {
    windowDimensions = { width: 812, height: 375 };

    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<SidebarNavigator />);
    });

    const drawer = getDrawer(tree);
    expect(drawer.props.screenOptions.drawerType).toBe('front');
    expect(drawer.props.screenOptions.drawerStyle.width).toBe(0);
    expect(drawer.props.screenOptions.drawerStyle.display).toBe('none');
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

  it('keeps the desktop collapse button inside the sidebar hit area', async () => {
    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<SidebarNavigator />);
    });

    const collapseButton = tree.root.findByProps({ testID: 'sidebar-collapse-button' });
    const right = Number((collapseButton.props.style ?? {}).right);
    const top = Number((collapseButton.props.style ?? {}).top);
    expect(Number.isFinite(right)).toBe(true);
    expect(right).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(top)).toBe(true);
    expect(top).toBeGreaterThanOrEqual(48);
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

  it('hides the permanent drawer when editorFocusModeEnabled toggles without remounting (so session state is preserved)', async () => {
    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<SidebarNavigator />);
    });

    expect(drawerLifecycle.mounts).toBe(1);
    expect(drawerLifecycle.unmounts).toBe(0);

    const drawerBefore = getDrawer(tree);
    expect(drawerBefore.props.screenOptions.drawerStyle.width).toBeGreaterThan(0);

    await act(async () => {
      localSettingsStore.setEditorFocusModeEnabled(true);
    });

    // No remount: toggling focus should not reset session/details state.
    expect(drawerLifecycle.mounts).toBe(1);
    expect(drawerLifecycle.unmounts).toBe(0);

    const drawerAfter = getDrawer(tree);
    expect(drawerAfter).toBeDefined();
    expect(drawerAfter.props.screenOptions.drawerType).toBe('front');
    expect(drawerAfter.props.screenOptions.drawerStyle.width).toBe(0);
    expect(drawerAfter.props.screenOptions.drawerStyle.display).toBe('none');
  });
});
