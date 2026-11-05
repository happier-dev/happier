import React from 'react';
import 'fake-indexeddb/auto';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';

import { installNavigationShellCommonModuleMocks } from './navigationShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
type SettingsHarnessModule = typeof import('@/components/settings/secrets/secretSettingsTestHarness');
let account: Awaited<ReturnType<SettingsHarnessModule['createSecretSettingsTestHarness']>>;
let browserDom: JSDOM | undefined;
let browserStorage: ReturnType<typeof installLocalStorageMock> | undefined;

vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

const hoistedState = vi.hoisted(() => ({
    mockPlatformOS: 'web' as 'web' | 'ios',
    mockWindowDimensions: { width: 1000, height: 800 },
    mockPathname: '/' as string,
    mockSegments: ['(app)'] as string[],
    routerReplaceMock: vi.fn(),
    dimensionListeners: new Set<() => void>(),
}));

installNavigationShellCommonModuleMocks({
    appPaneProvider: () => vi.importActual('@/components/appShell/panes/AppPaneProvider'),
    reactNative: installReactNativeWebMock({
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
        useWindowDimensions: () => React.useSyncExternalStore(
            (listener) => {
                hoistedState.dimensionListeners.add(listener);
                return () => { hoistedState.dimensionListeners.delete(listener); };
            },
            () => hoistedState.mockWindowDimensions,
        ),
        Platform: {
            get OS() {
                return hoistedState.mockPlatformOS;
            },
            select: (options: any) =>
                options?.[hoistedState.mockPlatformOS] ?? options?.default ?? options?.ios ?? options?.android,
        },
    }),
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: () => hoistedState.mockPathname,
            segments: () => hoistedState.mockSegments,
            router: {
                replace: hoistedState.routerReplaceMock,
            },
        }).module;
    },
    storage: importOriginal => importOriginal(),
});

// Install the OS/transport boundaries before any real owner can import React Native.
const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { SIDEBAR_DOCK_MIN_WIDTH_PX } = await import('./sidebarSizing');
const { createSecretSettingsTestHarness } = await import('@/components/settings/secrets/secretSettingsTestHarness');
const initialStorage = storage.getState();

const mockLocalSettingsStore = (() => {
  return {
    get sidebarCollapsed() {
      return storage.getState().localSettings.sidebarCollapsed;
    },
    get sidebarWidthPx() {
      return storage.getState().localSettings.sidebarWidthPx;
    },
    setSidebarCollapsed(next: boolean) {
      storage.getState().applyLocalSettings({ sidebarCollapsed: next }, { source: 'ui' });
    },
    setSidebarWidthPx(next: number) {
      storage.getState().applyLocalSettings({ sidebarWidthPx: next }, { source: 'ui' });
    },
    subscribe(listener: () => void) {
      return storage.subscribe(listener);
    },
  };
})();

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock('./appRail/AppRail', () => ({
  AppRail: () => React.createElement('AppRail', { testID: 'app-rail' }, null),
}));

vi.mock('./appRail/AppShellColumn', () => ({
  AppShellColumn: (props: any) => React.createElement('AppShellColumn', props, null),
}));

vi.mock('./SidebarIcons', () => ({
  SidebarExpandIcon: (props: any) => React.createElement('SidebarExpandIcon', props, null),
  SidebarCollapseIcon: (props: any) => React.createElement('SidebarCollapseIcon', props, null),
}));

function getSidebar(tree: renderer.ReactTestRenderer) {
  return tree.root.findByProps({ testID: 'navigation-sidebar' });
}

/** The column's laid-out width (its style is the column's own style plus the measured width). */
function widthOf(node: { props: { style?: unknown } }): number | undefined {
  const styles = [node.props.style].flat(Infinity as 1) as Array<{ width?: number } | null | undefined>;
  return styles.reduce<number | undefined>((width, style) => (typeof style?.width === 'number' ? style.width : width), undefined);
}

function getResizableSidebarPane(tree: renderer.ReactTestRenderer) {
  return tree.find((node) => {
    return typeof node.props?.onCommitWidthPx === 'function' && node.props?.minWidthPx === SIDEBAR_DOCK_MIN_WIDTH_PX;
  });
}

function installResizePointerBoundary() {
  const listeners = new Map<string, Set<(event: { clientX: number }) => void>>();
  vi.stubGlobal('window', {
    addEventListener: (type: string, listener: (event: { clientX: number }) => void) => {
      const group = listeners.get(type) ?? new Set();
      group.add(listener);
      listeners.set(type, group);
    },
    removeEventListener: (type: string, listener: (event: { clientX: number }) => void) => listeners.get(type)?.delete(listener),
  });
  return (type: 'pointermove' | 'pointerup', clientX: number) => {
    for (const listener of [...listeners.get(type) ?? []]) listener({ clientX });
  };
}

describe('SidebarNavigator (collapsed sidebar)', () => {
  it('runs the sidebar keyboard command through the same admitted toggle', async () => {
    const { KeyboardShortcutProvider, useKeyboardCommand } = await import('@/keyboard/KeyboardShortcutProvider');
    const { SidebarNavigator } = await import('./SidebarNavigator');
    let command: ReturnType<typeof useKeyboardCommand> | undefined;
    function CommandProbe() { command = useKeyboardCommand(); return null; }
    const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><SidebarNavigator /><CommandProbe /></KeyboardShortcutProvider>);
    await act(async () => { expect(command?.('shell.column.toggle')).toBe(true); });
    await vi.waitFor(() => expect(mockLocalSettingsStore.sidebarCollapsed).toBe(true));
    expect(screen.findByTestId('navigation-sidebar')).toBeNull();
    await act(async () => { expect(command?.('shell.column.toggle')).toBe(true); });
    await vi.waitFor(() => expect(mockLocalSettingsStore.sidebarCollapsed).toBe(false));
    expect(screen.findByTestId('navigation-sidebar')).not.toBeNull();
  });

  it('resets the sidebar preference through the shared resize handle to its default', async () => {
    mockLocalSettingsStore.setSidebarWidthPx(410);
    const { SidebarNavigator } = await import('./SidebarNavigator');
    const screen = await renderScreen(<SidebarNavigator />);
    // Shared-handle DOM tests own dblclick delivery; exercise this consumer's real reset binding.
    const handle = getResizableSidebarPane(screen.tree).find(node => typeof node.props.interactionProps?.onDoubleClick === 'function');
    await act(async () => { handle.props.interactionProps.onDoubleClick(); });
    expect(mockLocalSettingsStore.sidebarWidthPx).toBe(272);
    expect(widthOf(getSidebar(screen.tree))).toBe(272);
  });

  it('keeps literal pixel preferences across window changes and clamps only the rendered width', async () => {
    mockLocalSettingsStore.setSidebarWidthPx(650);
    hoistedState.mockWindowDimensions = { width: 1200, height: 900 };
    const { SidebarNavigator } = await import('./SidebarNavigator');
    const screen = await renderScreen(<SidebarNavigator />);
    expect(widthOf(getSidebar(screen.tree))).toBe(600);
    expect(mockLocalSettingsStore.sidebarWidthPx).toBe(650);
    await act(async () => {
      hoistedState.mockWindowDimensions = { width: 2560, height: 900 };
      for (const listener of hoistedState.dimensionListeners) listener();
    });
    expect(widthOf(getSidebar(screen.tree))).toBe(650);
    expect(mockLocalSettingsStore.sidebarWidthPx).toBe(650);
  });

  it('does not hide while the pointer is between the minimum and its collapse threshold', async () => {
    const { SidebarNavigator } = await import('./SidebarNavigator');
    const screen = await renderScreen(<SidebarNavigator />);
    const pane = getResizableSidebarPane(screen.tree);
    await act(async () => {
      pane.props.onDragWidthPx(SIDEBAR_DOCK_MIN_WIDTH_PX, {
        attemptedSizePx: SIDEBAR_DOCK_MIN_WIDTH_PX - 1,
        clampedSizePx: SIDEBAR_DOCK_MIN_WIDTH_PX,
        exceededMinPx: true,
        exceededMaxPx: false,
        overshootPx: -1,
        collapseArmed: false,
      });
    });
    expect(mockLocalSettingsStore.sidebarCollapsed).toBe(false);
    expect(getSidebar(screen.tree)).toBeDefined();
  });
  afterEach(async () => {
    try {
      standardCleanup();
      hoistedState.mockPlatformOS = 'web';
      await account?.dispose();
      storage.setState(initialStorage, true);
    } finally {
      browserStorage?.restore();
      browserDom?.window.close();
    }
  });
  beforeEach(async () => {
    vi.unstubAllGlobals();
    browserDom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
    vi.stubGlobal('window', browserDom.window);
    vi.stubGlobal('document', browserDom.window.document);
    browserStorage = installLocalStorageMock();
    hoistedState.mockPlatformOS = 'web';
    act(() => {
      mockLocalSettingsStore.setSidebarCollapsed(false);
      mockLocalSettingsStore.setSidebarWidthPx(320);
    });
    account = await createSecretSettingsTestHarness({ settings: settingsParse({
      actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
    }) });
    hoistedState.mockPlatformOS = 'web';
    hoistedState.mockWindowDimensions = { width: 1000, height: 800 };
    hoistedState.mockPathname = '/';
    hoistedState.mockSegments = ['(app)'];
    hoistedState.routerReplaceMock.mockReset();
  });

  it.each(['web', 'ios'] as const)('preserves the mounted navigator across responsive layouts on %s', async (platform) => {
    hoistedState.mockPlatformOS = platform;
    hoistedState.mockWindowDimensions = { width: 1280, height: 577 };
    const { SidebarNavigator } = await import('./SidebarNavigator');
    const { Stack } = await import('expo-router');
    const screen = await renderScreen(<SidebarNavigator />);
    const navigator = screen.tree.findByType(Stack);
    for (const dimensions of [{ width: 1440, height: 1007 }, { width: 1280, height: 577 }]) {
      await act(async () => {
        hoistedState.mockWindowDimensions = dimensions;
        for (const listener of hoistedState.dimensionListeners) listener();
      });
      expect(screen.tree.findByType(Stack) === navigator).toBe(true);
    }
  });

  it('preserves the navigator while onboarding owns and releases the viewport', async () => {
    const { SidebarNavigator } = await import('./SidebarNavigator');
    const { Stack } = await import('expo-router');
    const { beginOnboardingJourneySession, endOnboardingJourneySession } = await import('@/components/onboarding/tour/state/journeySession');
    const screen = await renderScreen(<SidebarNavigator />);
    const navigator = screen.tree.findByType(Stack);
    try {
      await act(async () => { beginOnboardingJourneySession(); });
      expect(screen.tree.findAllByProps({ testID: 'navigation-sidebar' })).toHaveLength(0);
      expect(screen.tree.findByType(Stack) === navigator).toBe(true);
    } finally {
      await act(async () => { endOnboardingJourneySession(); });
    }
    expect(screen.findByTestId('navigation-sidebar')).toBeTruthy();
    expect(screen.tree.findByType(Stack) === navigator).toBe(true);
  });

  it('keeps public setup routes free of sidebar chrome', async () => {
    hoistedState.mockPathname = '/setup';
    hoistedState.mockSegments = ['(app)', 'setup'];
    const { SidebarNavigator } = await import('./SidebarNavigator');
    const { Stack } = await import('expo-router');
    const screen = await renderScreen(<SidebarNavigator />);
    expect(screen.tree.findByType(Stack)).toBeDefined();
    expect(screen.tree.findAllByProps({ testID: 'navigation-sidebar' })).toHaveLength(0);
  });

  it.each(['activity-overlay', 'pet-overlay', 'capture', 'capture-selection'])('keeps the dedicated %s presenter transparent and free of sidebar chrome', async route => {
    vi.stubGlobal('isTauri', true);
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: createDesktopSecureStorageBoundary().invoke });
    vi.stubGlobal('window', { location: { href: `http://localhost/desktop/${route}` } });
    const addEventListener = vi.fn();
    vi.stubGlobal('document', { addEventListener, removeEventListener: vi.fn() });
    const { SidebarNavigator } = await import('./SidebarNavigator');
    const { Stack } = await import('expo-router');
    const { StyleSheet } = await import('react-native');
    const screen = await renderScreen(<SidebarNavigator />);
    expect(screen.tree.findAllByProps({ testID: 'navigation-sidebar' })).toHaveLength(0);
    expect(screen.tree.findByType(Stack).props.screenOptions.contentStyle.backgroundColor).toBe('transparent');
    // Stack is empty in this harness: every painted host here belongs to the window backing.
    const backgrounds = screen.tree.findAll(node => typeof node.type === 'string').flatMap(node => {
      const color = StyleSheet.flatten(node.props.style)?.backgroundColor;
      return color && color !== 'transparent' ? [color] : [];
    });
    expect(backgrounds).toEqual([]);
    expect(addEventListener).not.toHaveBeenCalledWith('mousedown', expect.any(Function), true);
  });

  it('stops wheel propagation on web so sidebar scrolling is not blocked by document scroll-lock listeners', async () => {
    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    tree = (await renderScreen(<SidebarNavigator />)).tree;

    const wheelBoundary = tree.root.find((node) => {
      return (node.type as any) === 'View' && typeof (node.props as any)?.onWheel === 'function';
    });

    const stopPropagation = vi.fn();
    wheelBoundary.props.onWheel({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('hides the column and keeps the rail when sidebarCollapsed is true', async () => {
    act(() => {
      mockLocalSettingsStore.setSidebarCollapsed(true);
    });

    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    tree = (await renderScreen(<SidebarNavigator />)).tree;

    expect(tree.root.findAllByProps({ testID: 'navigation-sidebar' })).toHaveLength(0);
    expect(tree.root.findAllByType('AppRail' as any)).toHaveLength(1);
  });

  it('enables the permanent sidebar when min edge is at least 600px', async () => {
    hoistedState.mockWindowDimensions = { width: 800, height: 600 };

    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    tree = (await renderScreen(<SidebarNavigator />)).tree;

    const sidebar = getSidebar(tree);
    expect(widthOf(sidebar)).toBeGreaterThan(0);
  });

  it('hides the permanent sidebar on a landscape phone below 600px', async () => {
    hoistedState.mockPlatformOS = 'ios';
    hoistedState.mockWindowDimensions = { width: 812, height: 375 };

    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    tree = (await renderScreen(<SidebarNavigator />)).tree;

    expect(tree.findAllByProps({ testID: 'navigation-sidebar' })).toHaveLength(0);
    expect(tree.root.findAllByType('AppRail' as any)).toHaveLength(0);
  });

  it('keeps the permanent sidebar and rail on a short desktop web window', async () => {
    hoistedState.mockWindowDimensions = { width: 812, height: 375 };

    const { SidebarNavigator } = await import('./SidebarNavigator');
    const { tree } = await renderScreen(<SidebarNavigator />);

    expect(widthOf(getSidebar(tree))).toBeGreaterThan(0);
    expect(tree.root.findAllByType('AppRail' as any)).toHaveLength(1);
  });

  it('keeps the full sidebar when resized down to the minimum width', async () => {
    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    tree = (await renderScreen(<SidebarNavigator />)).tree;

    expect(mockLocalSettingsStore.sidebarCollapsed).toBe(false);
    const resizablePane = getResizableSidebarPane(tree);

    await act(async () => {
      resizablePane.props.onDragWidthPx(SIDEBAR_DOCK_MIN_WIDTH_PX, {
        attemptedSizePx: SIDEBAR_DOCK_MIN_WIDTH_PX,
        clampedSizePx: SIDEBAR_DOCK_MIN_WIDTH_PX,
        exceededMinPx: false,
        exceededMaxPx: false,
        overshootPx: 0,
        collapseArmed: false,
      });
      resizablePane.props.onCommitWidthPx(SIDEBAR_DOCK_MIN_WIDTH_PX, {
        attemptedSizePx: SIDEBAR_DOCK_MIN_WIDTH_PX,
        clampedSizePx: SIDEBAR_DOCK_MIN_WIDTH_PX,
        exceededMinPx: false,
        exceededMaxPx: false,
        overshootPx: 0,
        collapseArmed: false,
      });
    });

    expect(mockLocalSettingsStore.sidebarCollapsed).toBe(false);
    expect(mockLocalSettingsStore.sidebarWidthPx).toBe(SIDEBAR_DOCK_MIN_WIDTH_PX);

    const sidebar = getSidebar(tree);
    expect(widthOf(sidebar)).toBe(SIDEBAR_DOCK_MIN_WIDTH_PX);
  });

  it('collapses only on release past half the minimum, preserving the stored width for restore', async () => {
    act(() => {
      mockLocalSettingsStore.setSidebarWidthPx(320);
    });

    const pointer = installResizePointerBoundary();
    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    tree = (await renderScreen(<SidebarNavigator />)).tree;

    const handle = getResizableSidebarPane(tree).findByProps({ accessibilityRole: 'adjustable' });
    await act(async () => { handle.props.onPressIn({ clientX: 320 }); });
    await act(async () => { pointer('pointermove', Math.floor(SIDEBAR_DOCK_MIN_WIDTH_PX / 2) - 1); });
    expect(mockLocalSettingsStore.sidebarCollapsed).toBe(false);
    await act(async () => { pointer('pointerup', 0); });

    expect(mockLocalSettingsStore.sidebarCollapsed).toBe(true);
    expect(tree.root.findAllByProps({ testID: 'navigation-sidebar' })).toHaveLength(0);
    expect(tree.root.findAllByType('AppRail' as any)).toHaveLength(1);
    expect(mockLocalSettingsStore.sidebarWidthPx).toBe(320);
    await tree.pressByTestIdAsync('app-shell-column-toggle');
    expect(widthOf(getSidebar(tree))).toBe(320);
  });

  it("stands the open destination's column beside the page, and none beside a full-page destination", async () => {
    const { SidebarNavigator } = await import('./SidebarNavigator');
    const at = async (pathname: string) => {
      hoistedState.mockPathname = pathname;
      const tree = (await renderScreen(<SidebarNavigator />)).tree;
      const column = tree.root.findAllByType('AppShellColumn' as any)[0]?.props.column ?? null;
      act(() => tree.unmount());
      return column;
    };
    expect(await at('/')).toEqual({ kind: 'builtin', id: 'sessions' });
    expect(await at('/settings/appearance')).toEqual({ kind: 'builtin', id: 'settings' });
    expect(await at('/settings/home/srv-1/people')).toEqual({ kind: 'builtin', id: 'settings' });
    expect(await at('/plugins')).toEqual({ kind: 'builtin', id: 'plugins' });
    expect(await at('/projects/ws-1')).toEqual({ kind: 'builtin', id: 'projects' });
    // A full-page destination stands no column: the column slot is not mounted.
    expect(await at('/search')).toBeNull();
  });

  it('toggles the column from the title strip and keeps the rail', async () => {
    const { SidebarNavigator } = await import('./SidebarNavigator');
    const tree = (await renderScreen(<SidebarNavigator />)).tree;

    await act(async () => {
      await tree.pressByTestIdAsync('app-shell-column-toggle');
    });
    expect(mockLocalSettingsStore.sidebarCollapsed).toBe(true);
    expect(tree.root.findAllByProps({ testID: 'navigation-sidebar' })).toHaveLength(0);
    expect(tree.root.findAllByType('AppRail' as any)).toHaveLength(1);

    await act(async () => {
      await tree.pressByTestIdAsync('app-shell-column-toggle');
    });
    expect(mockLocalSettingsStore.sidebarCollapsed).toBe(false);
    expect(getSidebar(tree)).toBeDefined();
  });

  it('admits the real title-strip toggle through shell.column.set under Off, Ask and Allowed', async () => {
    await act(async () => account.replaceSettings(settingsParse({ ...account.persistedSettings,
      actionsSettingsV1: { v: 1, actions: { 'shell.column.set': { disabledSurfaces: ['ui'] } } },
    })));
    const { SidebarNavigator } = await import('./SidebarNavigator');
    const screen = await renderScreen(<SidebarNavigator />);
    await screen.pressByTestIdAsync('app-shell-column-toggle');
    expect(storage.getState().localSettings.sidebarCollapsed).toBe(false);
    expect(account.artifacts.list()).toHaveLength(0);
    await act(async () => account.replaceSettings(settingsParse({ ...account.persistedSettings,
      actionsSettingsV1: { v: 1, actions: { 'shell.column.set': { approvalRequiredSurfaces: ['ui'] } } },
    })));
    await screen.pressByTestIdAsync('app-shell-column-toggle');
    await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
    expect(storage.getState().localSettings.sidebarCollapsed).toBe(false);
    await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'approve');
    await vi.waitFor(() => expect(storage.getState().localSettings.sidebarCollapsed).toBe(true));
    await act(async () => account.replaceSettings(settingsParse({ ...account.persistedSettings,
      actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'shell.column.set': ['ui'] } },
    })));
    await screen.pressByTestIdAsync('app-shell-column-toggle');
    await vi.waitFor(() => expect(storage.getState().localSettings.sidebarCollapsed).toBe(false));
    expect(account.artifacts.list()).toHaveLength(1);
    expect(screen.findAllByType('AppRail')).toHaveLength(1);
  });

  it('retires the real title-strip toggle when its Account scope is replaced', async () => {
    const { SidebarNavigator } = await import('./SidebarNavigator');
    const screen = await renderScreen(<SidebarNavigator />);
    const press = screen.tree.find(node => typeof node.props.onToggleColumn === 'function').props.onToggleColumn;
    await act(async () => {
      await account.dispose();
      account = await createSecretSettingsTestHarness({
        token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-b' })).toString('base64url')}.signature`,
        settings: settingsParse({ actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'shell.column.set': ['ui'] } } }),
      });
    });
    await act(async () => { await press(); });
    expect(storage.getState().localSettings.sidebarCollapsed).toBe(false);
    expect(account.artifacts.list()).toHaveLength(0);
  });

  it('disarms a drag when it returns above half the minimum and commits the minimum', async () => {
    act(() => {
      mockLocalSettingsStore.setSidebarWidthPx(320);
    });

    const pointer = installResizePointerBoundary();
    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    tree = (await renderScreen(<SidebarNavigator />)).tree;

    const handle = getResizableSidebarPane(tree).findByProps({ accessibilityRole: 'adjustable' });
    await act(async () => { handle.props.onPressIn({ clientX: 320 }); });
    await act(async () => { pointer('pointermove', 0); });
    await act(async () => { pointer('pointermove', SIDEBAR_DOCK_MIN_WIDTH_PX - 1); });
    await act(async () => { pointer('pointerup', SIDEBAR_DOCK_MIN_WIDTH_PX - 1); });
    expect(mockLocalSettingsStore.sidebarCollapsed).toBe(false);
    expect(mockLocalSettingsStore.sidebarWidthPx).toBe(SIDEBAR_DOCK_MIN_WIDTH_PX);
    expect(widthOf(getSidebar(tree))).toBe(SIDEBAR_DOCK_MIN_WIDTH_PX);
  });

  it('keeps the sidebar and navigator independent of hiding the main pane', async () => {
    hoistedState.mockPathname = '/session/s1';
    const { SidebarNavigator } = await import('./SidebarNavigator');
    const { AppPaneProvider, useAppPaneContext } = await import('@/components/appShell/panes/AppPaneProvider');
    let pane: ReturnType<typeof useAppPaneContext> | undefined;
    function PaneProbe() { pane = useAppPaneContext(); return null; }
    const tree = (await renderScreen(<AppPaneProvider><SidebarNavigator /><PaneProbe /></AppPaneProvider>)).tree;

    const { Stack } = await import('expo-router');
    const navigator = tree.root.findByType(Stack);

    const sidebarBefore = getSidebar(tree);
    expect(widthOf(sidebarBefore)).toBeGreaterThan(0);

    await act(async () => {
      pane?.dispatch({ type: 'openRight', scopeId: 'session:s1', tabId: 'files' });
      pane?.dispatch({ type: 'setMainHidden', scopeId: 'session:s1', hidden: true });
    });
    expect(pane?.state.scopes['session:s1']?.mainHidden).toBe(true);

    // Hiding main preserves both the navigator and the independent navigation preference.
    expect(tree.root.findByType(Stack) === navigator).toBe(true);

    expect(widthOf(getSidebar(tree))).toBeGreaterThan(0);
    expect(tree.root.findAllByType('AppRail' as any)).toHaveLength(1);

    const expandButton = tree.findByTestId('app-shell-column-toggle');
    await act(async () => {
      await pressTestInstanceAsync(expandButton);
    });

    expect(pane?.state.scopes['session:s1']?.mainHidden).toBe(true);
    expect(mockLocalSettingsStore.sidebarCollapsed).toBe(true);
  });

  it('keeps the route navigator mounted with hidden chrome on terminal-connect desktop web routes', async () => {
    hoistedState.mockPathname = '/terminal/connect';
    hoistedState.mockSegments = ['(app)', 'terminal', 'connect'];

    const { SidebarNavigator } = await import('./SidebarNavigator');
    let tree!: renderer.ReactTestRenderer;

    tree = (await renderScreen(<SidebarNavigator />)).tree;

    const { Stack } = await import('expo-router');
    const navigator = tree.root.findByType(Stack);

    expect(navigator).toBeDefined();
    expect(tree.root.findAllByProps({ testID: 'navigation-sidebar' })).toHaveLength(0);
    expect(tree.root.findAllByType('AppRail' as any)).toHaveLength(0);
    expect(tree.root.findAllByType('AppShellColumn' as any)).toHaveLength(0);

  });
});
