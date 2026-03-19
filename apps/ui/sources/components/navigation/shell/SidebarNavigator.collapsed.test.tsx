import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const localSettingsStore = (() => {
  let sidebarCollapsed = false;
  let editorFocusModeEnabled = false;
  let sidebarWidthPx = 320;
  let sidebarWidthBasisPx = 1200;
  const listeners = new Set<() => void>();

  return {
    get sidebarCollapsed() {
      return sidebarCollapsed;
    },
    get editorFocusModeEnabled() {
      return editorFocusModeEnabled;
    },
    get sidebarWidthPx() {
      return sidebarWidthPx;
    },
    get sidebarWidthBasisPx() {
      return sidebarWidthBasisPx;
    },
    setSidebarCollapsed(next: boolean) {
      sidebarCollapsed = next;
      for (const l of listeners) l();
    },
    setEditorFocusModeEnabled(next: boolean) {
      editorFocusModeEnabled = next;
      for (const l of listeners) l();
    },
    setSidebarWidthPx(next: number) {
      sidebarWidthPx = next;
      for (const l of listeners) l();
    },
    setSidebarWidthBasisPx(next: number) {
      sidebarWidthBasisPx = next;
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
          if (key === 'sidebarWidthPx') return localSettingsStore.sidebarWidthPx;
          if (key === 'sidebarWidthBasisPx') return localSettingsStore.sidebarWidthBasisPx;
          return false;
        },
        () => {
          if (key === 'sidebarCollapsed') return localSettingsStore.sidebarCollapsed;
          if (key === 'editorFocusModeEnabled') return localSettingsStore.editorFocusModeEnabled;
          if (key === 'sidebarWidthPx') return localSettingsStore.sidebarWidthPx;
          if (key === 'sidebarWidthBasisPx') return localSettingsStore.sidebarWidthBasisPx;
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
          if (key === 'sidebarWidthPx') return localSettingsStore.sidebarWidthPx;
          if (key === 'sidebarWidthBasisPx') return localSettingsStore.sidebarWidthBasisPx;
          return false;
        },
        () => {
          if (key === 'sidebarCollapsed') return localSettingsStore.sidebarCollapsed;
          if (key === 'editorFocusModeEnabled') return localSettingsStore.editorFocusModeEnabled;
          if (key === 'sidebarWidthPx') return localSettingsStore.sidebarWidthPx;
          if (key === 'sidebarWidthBasisPx') return localSettingsStore.sidebarWidthBasisPx;
          return false;
        }
      );
      return [val, (next: unknown) => {
        if (key === 'sidebarCollapsed' && typeof next === 'boolean') localSettingsStore.setSidebarCollapsed(next);
        if (key === 'editorFocusModeEnabled' && typeof next === 'boolean') localSettingsStore.setEditorFocusModeEnabled(next);
        if (key === 'sidebarWidthPx' && typeof next === 'number') localSettingsStore.setSidebarWidthPx(next);
        if (key === 'sidebarWidthBasisPx' && typeof next === 'number') localSettingsStore.setSidebarWidthBasisPx(next);
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
      React.createElement(
        'Pressable',
        {
          testID: 'sidebar-expand-button',
          onPress: () => localSettingsStore.setSidebarCollapsed(false),
        },
        React.createElement('SidebarCollapseIcon', {}, null)
      )
    ),
}));

vi.mock('./SidebarIcons', () => ({
  SidebarExpandIcon: (props: any) => React.createElement('SidebarExpandIcon', props, null),
  SidebarCollapseIcon: (props: any) => React.createElement('SidebarCollapseIcon', props, null),
}));

function getDrawer(tree: renderer.ReactTestRenderer) {
  return tree.root.findByType('Drawer' as any);
}

function getResizableSidebarPane(tree: renderer.ReactTestRenderer) {
  return tree.root.find((node) => {
    return typeof node.props?.onCommitWidthPx === 'function' && node.props?.minWidthPx === 250;
  });
}

describe('SidebarNavigator (collapsed sidebar)', () => {
  beforeEach(() => {
    act(() => {
      localSettingsStore.setSidebarCollapsed(false);
      localSettingsStore.setEditorFocusModeEnabled(false);
      localSettingsStore.setSidebarWidthPx(320);
      localSettingsStore.setSidebarWidthBasisPx(1200);
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

  it('keeps the full sidebar when resized down to the minimum width', async () => {
    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<SidebarNavigator />);
    });

    expect(localSettingsStore.sidebarCollapsed).toBe(false);
    const resizablePane = getResizableSidebarPane(tree);

    await act(async () => {
      resizablePane.props.onDragWidthPx(250, {
        attemptedSizePx: 250,
        clampedSizePx: 250,
        exceededMinPx: false,
        exceededMaxPx: false,
      });
      resizablePane.props.onCommitWidthPx(250, {
        attemptedSizePx: 250,
        clampedSizePx: 250,
        exceededMinPx: false,
        exceededMaxPx: false,
      });
    });

    expect(localSettingsStore.sidebarCollapsed).toBe(false);
    expect(localSettingsStore.sidebarWidthPx).toBe(250);

    const drawer = getDrawer(tree);
    expect(drawer.props.screenOptions.drawerStyle.width).toBe(250);
  });

  it('collapses into compact view when resized narrower again from the minimum width', async () => {
    act(() => {
      localSettingsStore.setSidebarWidthPx(250);
      localSettingsStore.setSidebarWidthBasisPx(1000);
    });

    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<SidebarNavigator />);
    });

    const resizablePane = getResizableSidebarPane(tree);

    await act(async () => {
      resizablePane.props.onDragWidthPx(250, {
        attemptedSizePx: 200,
        clampedSizePx: 250,
        exceededMinPx: true,
        exceededMaxPx: false,
      });
    });

    expect(localSettingsStore.sidebarCollapsed).toBe(true);

    const drawer = getDrawer(tree);
    expect(drawer.props.screenOptions.drawerStyle.width).toBe(72);
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

  it('can collapse again on the first resize attempt after expanding from compact view', async () => {
    act(() => {
      localSettingsStore.setSidebarWidthPx(250);
      localSettingsStore.setSidebarWidthBasisPx(1000);
    });

    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(<SidebarNavigator />);
    });

    let resizablePane = getResizableSidebarPane(tree);
    let onDragWidthPx = resizablePane.props.onDragWidthPx;

    await act(async () => {
      onDragWidthPx(250, {
        attemptedSizePx: 200,
        clampedSizePx: 250,
        exceededMinPx: true,
        exceededMaxPx: false,
      });
    });

    expect(localSettingsStore.sidebarCollapsed).toBe(true);

    await act(async () => {
      onDragWidthPx(null, null);
    });

    const expandButton = tree.root.findByProps({ testID: 'sidebar-expand-button' });
    await act(async () => {
      expandButton.props.onPress();
    });

    expect(localSettingsStore.sidebarCollapsed).toBe(false);

    resizablePane = getResizableSidebarPane(tree);
    onDragWidthPx = resizablePane.props.onDragWidthPx;
    await act(async () => {
      onDragWidthPx(250, {
        attemptedSizePx: 200,
        clampedSizePx: 250,
        exceededMinPx: true,
        exceededMaxPx: false,
      });
    });

    expect(localSettingsStore.sidebarCollapsed).toBe(true);
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
