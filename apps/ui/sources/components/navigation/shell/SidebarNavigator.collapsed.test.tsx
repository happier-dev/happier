import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hoistedState = vi.hoisted(() => ({
    mockPlatformOS: 'web' as 'web' | 'ios',
    mockWindowDimensions: { width: 1000, height: 800 },
}));

const mockLocalSettingsStore = (() => {
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

const mockDrawerLifecycle = { mounts: 0, unmounts: 0 };

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            View: (props: any) => React.createElement('View', props, props.children),
                            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
                            PanResponder: {
                                create: () => ({ panHandlers: {} }),
                            },
                            Dimensions: {
                                get: () => ({
                                    width: hoistedState.mockWindowDimensions.width,
                                    height: hoistedState.mockWindowDimensions.height,
                                    scale: 1,
                                    fontScale: 1,
                                }),
                            },
                            useWindowDimensions: () => ({
                                width: hoistedState.mockWindowDimensions.width,
                                height: hoistedState.mockWindowDimensions.height,
                            }),
                            Platform: {
                                get OS() {
                                    return hoistedState.mockPlatformOS;
                                },
                                select: (options: any) =>
                                    options?.[hoistedState.mockPlatformOS] ?? options?.default ?? options?.ios ?? options?.android,
                            },
                        }
    );
});

vi.mock('expo-router/drawer', () => ({
  Drawer: (props: any) => {
    React.useEffect(() => {
      mockDrawerLifecycle.mounts += 1;
      return () => {
        mockDrawerLifecycle.unmounts += 1;
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

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
  const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
  return createPartialStorageModuleMock(importOriginal, {
    useLocalSetting: (key: string) => {
      return React.useSyncExternalStore(
          (listener) => mockLocalSettingsStore.subscribe(listener),
        () => {
          if (key === 'sidebarCollapsed') return mockLocalSettingsStore.sidebarCollapsed;
          if (key === 'editorFocusModeEnabled') return mockLocalSettingsStore.editorFocusModeEnabled;
          if (key === 'sidebarWidthPx') return mockLocalSettingsStore.sidebarWidthPx;
          if (key === 'sidebarWidthBasisPx') return mockLocalSettingsStore.sidebarWidthBasisPx;
          return false;
        },
        () => {
          if (key === 'sidebarCollapsed') return mockLocalSettingsStore.sidebarCollapsed;
          if (key === 'editorFocusModeEnabled') return mockLocalSettingsStore.editorFocusModeEnabled;
          if (key === 'sidebarWidthPx') return mockLocalSettingsStore.sidebarWidthPx;
          if (key === 'sidebarWidthBasisPx') return mockLocalSettingsStore.sidebarWidthBasisPx;
          return false;
        }
      );
    },
    useLocalSettingMutable: (key: string) => {
      const val = (React as any).useSyncExternalStore(
        (listener: any) => mockLocalSettingsStore.subscribe(listener),
        () => {
          if (key === 'sidebarCollapsed') return mockLocalSettingsStore.sidebarCollapsed;
          if (key === 'editorFocusModeEnabled') return mockLocalSettingsStore.editorFocusModeEnabled;
          if (key === 'sidebarWidthPx') return mockLocalSettingsStore.sidebarWidthPx;
          if (key === 'sidebarWidthBasisPx') return mockLocalSettingsStore.sidebarWidthBasisPx;
          return false;
        },
        () => {
          if (key === 'sidebarCollapsed') return mockLocalSettingsStore.sidebarCollapsed;
          if (key === 'editorFocusModeEnabled') return mockLocalSettingsStore.editorFocusModeEnabled;
          if (key === 'sidebarWidthPx') return mockLocalSettingsStore.sidebarWidthPx;
          if (key === 'sidebarWidthBasisPx') return mockLocalSettingsStore.sidebarWidthBasisPx;
          return false;
        }
      );
      return [val, (next: unknown) => {
        if (key === 'sidebarCollapsed' && typeof next === 'boolean') mockLocalSettingsStore.setSidebarCollapsed(next);
        if (key === 'editorFocusModeEnabled' && typeof next === 'boolean') mockLocalSettingsStore.setEditorFocusModeEnabled(next);
        if (key === 'sidebarWidthPx' && typeof next === 'number') mockLocalSettingsStore.setSidebarWidthPx(next);
        if (key === 'sidebarWidthBasisPx' && typeof next === 'number') mockLocalSettingsStore.setSidebarWidthBasisPx(next);
      }] as const;
    },
  });
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
          onPress: () => mockLocalSettingsStore.setSidebarCollapsed(false),
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
  return tree.findByType('Drawer' as any);
}

function getResizableSidebarPane(tree: renderer.ReactTestRenderer) {
  return tree.find((node) => {
    return typeof node.props?.onCommitWidthPx === 'function' && node.props?.minWidthPx === 250;
  });
}

describe('SidebarNavigator (collapsed sidebar)', () => {
  beforeEach(() => {
    act(() => {
      mockLocalSettingsStore.setSidebarCollapsed(false);
      mockLocalSettingsStore.setEditorFocusModeEnabled(false);
      mockLocalSettingsStore.setSidebarWidthPx(320);
      mockLocalSettingsStore.setSidebarWidthBasisPx(1200);
    });
    hoistedState.mockPlatformOS = 'web';
    hoistedState.mockWindowDimensions = { width: 1000, height: 800 };
    mockDrawerLifecycle.mounts = 0;
    mockDrawerLifecycle.unmounts = 0;
  });

  it('stops wheel propagation on web so sidebar scrolling is not blocked by document scroll-lock listeners', async () => {
    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    tree = (await renderScreen(<SidebarNavigator />)).tree;

    const wheelBoundary = tree.find((node) => {
      return (node.type as any) === 'View' && typeof (node.props as any)?.onWheel === 'function';
    });

    const stopPropagation = vi.fn();
    wheelBoundary.props.onWheel({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('uses a collapsed drawer width when sidebarCollapsed is true', async () => {
    act(() => {
      mockLocalSettingsStore.setSidebarCollapsed(true);
    });

    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    tree = (await renderScreen(<SidebarNavigator />)).tree;

    const drawer = getDrawer(tree);
    expect(drawer.props.screenOptions.drawerStyle.width).toBe(72);
  });

  it('enables the permanent drawer when min edge is at least 600px', async () => {
    hoistedState.mockWindowDimensions = { width: 800, height: 600 };

    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    tree = (await renderScreen(<SidebarNavigator />)).tree;

    const drawer = getDrawer(tree);
    expect(drawer.props.screenOptions.drawerType).toBe('permanent');
    expect(drawer.props.screenOptions.drawerStyle.width).toBeGreaterThan(0);
  });

  it('hides the permanent drawer when min edge is below 600px (e.g. landscape phone)', async () => {
    hoistedState.mockWindowDimensions = { width: 812, height: 375 };

    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    tree = (await renderScreen(<SidebarNavigator />)).tree;

    const drawer = getDrawer(tree);
    expect(drawer.props.screenOptions.drawerType).toBe('front');
    expect(drawer.props.screenOptions.drawerStyle.width).toBe(0);
    expect(drawer.props.screenOptions.drawerStyle.display).toBe('none');
  });

  it('keeps the full sidebar when resized down to the minimum width', async () => {
    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    tree = (await renderScreen(<SidebarNavigator />)).tree;

    expect(mockLocalSettingsStore.sidebarCollapsed).toBe(false);
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

    expect(mockLocalSettingsStore.sidebarCollapsed).toBe(false);
    expect(mockLocalSettingsStore.sidebarWidthPx).toBe(250);

    const drawer = getDrawer(tree);
    expect(drawer.props.screenOptions.drawerStyle.width).toBe(250);
  });

  it('collapses into compact view when resized narrower again from the minimum width', async () => {
    act(() => {
      mockLocalSettingsStore.setSidebarWidthPx(250);
      mockLocalSettingsStore.setSidebarWidthBasisPx(1000);
    });

    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    tree = (await renderScreen(<SidebarNavigator />)).tree;

    const resizablePane = getResizableSidebarPane(tree);

    await act(async () => {
      resizablePane.props.onDragWidthPx(250, {
        attemptedSizePx: 200,
        clampedSizePx: 250,
        exceededMinPx: true,
        exceededMaxPx: false,
      });
    });

    expect(mockLocalSettingsStore.sidebarCollapsed).toBe(true);

    const drawer = getDrawer(tree);
    expect(drawer.props.screenOptions.drawerStyle.width).toBe(72);
  });

  it('renders the expand icon button in collapsed sidebar on desktop', async () => {
    act(() => {
      mockLocalSettingsStore.setSidebarCollapsed(true);
    });
    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    tree = (await renderScreen(<SidebarNavigator />)).tree;

    const expandButton = tree.findByProps({ testID: 'sidebar-expand-button' });
    expect(expandButton.findByType('SidebarCollapseIcon' as any)).toBeDefined();
  });

  it('can collapse again on the first resize attempt after expanding from compact view', async () => {
    act(() => {
      mockLocalSettingsStore.setSidebarWidthPx(250);
      mockLocalSettingsStore.setSidebarWidthBasisPx(1000);
    });

    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    tree = (await renderScreen(<SidebarNavigator />)).tree;

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

    expect(mockLocalSettingsStore.sidebarCollapsed).toBe(true);

    await act(async () => {
      onDragWidthPx(null, null);
    });

    const expandButton = tree.findByProps({ testID: 'sidebar-expand-button' });
    await act(async () => {
      await pressTestInstanceAsync(expandButton);
    });

    expect(mockLocalSettingsStore.sidebarCollapsed).toBe(false);

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

    expect(mockLocalSettingsStore.sidebarCollapsed).toBe(true);
  });

  it('hides the permanent drawer when editorFocusModeEnabled toggles without remounting (so session state is preserved)', async () => {
    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    tree = (await renderScreen(<SidebarNavigator />)).tree;

    expect(mockDrawerLifecycle.mounts).toBe(1);
    expect(mockDrawerLifecycle.unmounts).toBe(0);

    const drawerBefore = getDrawer(tree);
    expect(drawerBefore.props.screenOptions.drawerStyle.width).toBeGreaterThan(0);

    await act(async () => {
      mockLocalSettingsStore.setEditorFocusModeEnabled(true);
    });

    // No remount: toggling focus should not reset session/details state.
    expect(mockDrawerLifecycle.mounts).toBe(1);
    expect(mockDrawerLifecycle.unmounts).toBe(0);

    const drawerAfter = getDrawer(tree);
    expect(drawerAfter).toBeDefined();
    expect(drawerAfter.props.screenOptions.drawerType).toBe('front');
    expect(drawerAfter.props.screenOptions.drawerStyle.width).toBe(0);
    expect(drawerAfter.props.screenOptions.drawerStyle.display).toBe('none');
  });
});
