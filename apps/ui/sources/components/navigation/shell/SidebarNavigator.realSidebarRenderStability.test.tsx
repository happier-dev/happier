/** @vitest-environment jsdom */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import type { DesktopWindowState } from '@/utils/platform/desktopWindowBridge';

import { installNavigationShellCommonModuleMocks } from './navigationShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hoistedState = vi.hoisted(() => ({
    mockPathname: '/' as string,
    mockSegments: ['(app)'] as string[],
    mockWindowDimensions: { width: 1200, height: 900 },
    routeStackRenders: 0,
    isDesktopHost: false,
    startDesktopWindowDragging: vi.fn(),
    getDesktopWindowChromePolicy: vi.fn(async () => ({ strategy: 'none' })),
    getDesktopWindowState: vi.fn(async () => ({ isMaximized: false })),
    listenDesktopWindowState: vi.fn<(handler: (state: DesktopWindowState) => void) => Promise<() => Promise<void>>>(
        async () => async () => {},
    ),
}));

type RegisteredDocumentListener = Readonly<{
    type: string;
    listener: EventListenerOrEventListenerObject;
    options?: boolean | AddEventListenerOptions;
}>;

function installDocumentEventListenerSpy(): Readonly<{
    records: RegisteredDocumentListener[];
    restore: () => void;
}> {
    const records: RegisteredDocumentListener[] = [];
    const addEventListener = document.addEventListener.bind(document);
    const removeEventListener = document.removeEventListener.bind(document);
    const addSpy = vi.spyOn(document, 'addEventListener').mockImplementation((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
    ) => {
        records.push({ type, listener, options });
        addEventListener(type, listener, options);
    });
    const removeSpy = vi.spyOn(document, 'removeEventListener').mockImplementation((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
    ) => {
        const index = records.findIndex((record) =>
            record.type === type
            && record.listener === listener
            && record.options === options,
        );
        if (index !== -1) {
            records.splice(index, 1);
        }
        removeEventListener(type, listener, options);
    });

    return {
        records,
        restore: () => {
            addSpy.mockRestore();
            removeSpy.mockRestore();
        },
    };
}

function resolveMainContentMouseDownListener(records: RegisteredDocumentListener[]): (event: MouseEvent) => void {
    const record = records.find((item) =>
        item.type === 'mousedown'
        && (
            item.options === true
            || (typeof item.options === 'object' && item.options?.capture === true)
        ),
    );

    expect(record).toBeTruthy();
    expect(typeof record?.listener).toBe('function');
    return record?.listener as (event: MouseEvent) => void;
}

installNavigationShellCommonModuleMocks({
    reactNative: installReactNativeWebMock({
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
            OS: 'web',
            select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
        },
        PanResponder: {
            create: () => ({ panHandlers: {} }),
        },
        InteractionManager: {
            runAfterInteractions: (fn: () => void) => fn(),
        },
    }),
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const module = createExpoRouterMock({
            pathname: () => hoistedState.mockPathname,
            segments: () => hoistedState.mockSegments,
            router: {
                push: vi.fn(),
                replace: vi.fn(),
                back: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
        // The route navigator stands in for the whole route tree; its render count is that tree's.
        const RouteStack = Object.assign(function Stack() {
            hoistedState.routeStackRenders += 1;
            return null;
        }, { Screen: module.Stack.Screen });
        return { ...module, Stack: RouteStack };
    },
    storage: async (importOriginal) => importOriginal<typeof import('@/sync/domains/state/storage')>(),
    appPaneProvider: async () => vi.importActual<typeof import('@/components/appShell/panes/AppPaneProvider')>('@/components/appShell/panes/AppPaneProvider'),
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock('@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext', () => ({
    isDesktopActivityOverlayWindowContext: () => false,
}));

vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/platform/desktopHost')>()),
    isDesktopHost: () => hoistedState.isDesktopHost,
}));

vi.mock('@/utils/platform/desktopWindowBridge', async (importOriginal) => ({
    // Policy interpretation stays real; only the native window bridge is replaced.
    ...(await importOriginal<typeof import('@/utils/platform/desktopWindowBridge')>()),
    getDesktopWindowChromePolicy: () => hoistedState.getDesktopWindowChromePolicy(),
    getDesktopWindowState: () => hoistedState.getDesktopWindowState(),
    listenDesktopWindowState: (handler: (state: DesktopWindowState) => void) =>
        hoistedState.listenDesktopWindowState(handler),
    startDesktopWindowDragging: () => hoistedState.startDesktopWindowDragging(),
}));

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaInsetsContext: React.createContext({ top: 0, bottom: 0, left: 0, right: 0 }),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('./MainView', () => ({
    MainView: () => React.createElement('MainView', { testID: 'main-view' }),
}));

vi.mock('@/components/navigation/ConnectionStatusControl', () => ({
    ConnectionStatusControl: () => React.createElement('ConnectionStatusControl'),
}));

vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/platform/responsive')>()),
    useHeaderHeight: () => 56,
    useIsTablet: () => true,
}));

vi.mock('@/hooks/inbox/useInboxAvailable', () => ({
    useInboxAvailable: () => true,
}));

vi.mock('@/hooks/server/useFriendsEnabled', () => ({
    useFriendsEnabled: () => true,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'inbox.global' ? true : false,
}));

vi.mock('@/config', () => ({
    config: { variant: 'prod' },
}));

vi.mock('@/sync/domains/server/serverContext', () => ({
    isStackContext: () => false,
}));

vi.mock('@/sync/domains/server/serverConfig', () => ({
    isUsingCustomServer: () => false,
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: () => React.createElement('ItemRowActions'),
}));

vi.mock('@/components/appShell/search/UniversalSearchRuntimeContext', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/appShell/search/UniversalSearchRuntimeContext')>()),
    useUniversalSearchRuntime: () => ({ open: vi.fn(), buildCommands: vi.fn() }),
}));

// Configure the platform boundaries before loading the real shell, outside behavior-test timeouts.
const { storage } = await import('@/sync/domains/state/storage');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { SidebarNavigator } = await import('./SidebarNavigator');
const { AppShellMaterialFrame } = await import('./AppShellMaterialFrame');
const { ResizableDockedPane } = await import('@/components/ui/panels/ResizableDockedPane');
const { act } = await import('react-test-renderer');
const { WorkspaceNavigationProvider } = await import('@/components/appShell/workspace/WorkspaceNavigationContext');
const { createWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
const initialStorageState = storage.getState();

beforeEach(() => {
    storage.setState({ ...initialStorageState, localSettings: { ...initialStorageState.localSettings,
        sidebarCollapsed: false, sidebarWidthPx: 320 } }, true);
});
afterEach(async () => {
    hoistedState.isDesktopHost = false;
    hoistedState.startDesktopWindowDragging.mockReset();
    hoistedState.getDesktopWindowChromePolicy.mockReset();
    hoistedState.getDesktopWindowChromePolicy.mockResolvedValue({ strategy: 'none' });
    hoistedState.getDesktopWindowState.mockReset();
    hoistedState.getDesktopWindowState.mockResolvedValue({ isMaximized: false });
    hoistedState.listenDesktopWindowState.mockReset();
    hoistedState.listenDesktopWindowState.mockResolvedValue(async () => {});
    await standardCleanup();
    storage.setState(initialStorageState, true);
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter(Boolean));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('SidebarNavigator real sidebar render stability', () => {
    it('renders the authenticated app shell with the real rail and Sessions column on web', async () => {
        const screen = await renderScreen(<AppPaneProvider><SidebarNavigator /></AppPaneProvider>);

        expect(screen.findByTestId('main-view')).toBeTruthy();
        expect(screen.findByTestId('app-rail')).toBeTruthy();
        const dragSurface = screen.findByTestId('desktop-main-content-drag-surface');
        expect(dragSurface).toBeTruthy();
        expect(dragSurface?.props.onPointerDownCapture).toBeUndefined();
    });

    it('keeps the route tree when workspace navigation changes without changing whether it hosts the route', async () => {
        const noop = () => {};
        const inactive: import('@/components/appShell/workspace/WorkspaceNavigationContext').WorkspaceNavigationContextValue = {
            active: false, state: createWorkspaceState({ id: 'tab', target: { kind: 'newTab', params: {} }, pinned: false, preview: true }),
            canGoBack: false, canGoForward: false, openHref: () => false, activateTab: noop, closeTab: noop, closeTabs: noop,
            dispatch: noop, navigationForTab: () => ({ push: noop, replace: noop, back: noop }), registerBackStep: () => noop,
            back: noop, forward: noop,
        };
        const render = (value: typeof inactive) => <AppPaneProvider><WorkspaceNavigationProvider value={value}>
            <SidebarNavigator />
        </WorkspaceNavigationProvider></AppPaneProvider>;
        const screen = await renderScreen(render(inactive));
        const rail = () => screen.findByType(AppShellMaterialFrame)?.props.rail;
        const routeTree = rail();
        expect(routeTree).toBeTruthy();

        // A title publication or history step replaces the navigation value, not the route tree.
        await screen.update(render({ ...inactive, canGoBack: true }));

        expect(rail()).toBe(routeTree);
    });

    it('follows a sidebar resize drag without re-rendering the route tree beside it', async () => {
        const screen = await renderScreen(<AppPaneProvider><SidebarNavigator /></AppPaneProvider>);
        const sidebarResizer = () => screen.findAllByType(ResizableDockedPane)
            .find((pane) => pane.props.resizeEdge === 'right' && pane.props.collapse === true);
        expect(sidebarResizer()).toBeTruthy();
        const rendersBeforeDrag = hoistedState.routeStackRenders;
        expect(rendersBeforeDrag).toBeGreaterThan(0);

        for (const widthPx of [330, 340, 350, 360, 370]) {
            await act(async () => { sidebarResizer()?.props.onDragWidthPx?.(widthPx, { overshootPx: 0 }); });
        }

        // The column follows the pointer; the pages beside it only reflow, React does not re-render them.
        expect(screen.findByType(AppShellMaterialFrame)?.props.sidebarWidth).toBe(370);
        expect(hoistedState.routeStackRenders - rendersBeforeDrag).toBe(0);
    });

    it('starts Tauri dragging from the main content titlebar strip without blocking interactive targets', async () => {
        hoistedState.isDesktopHost = true;
        const documentListenerSpy = installDocumentEventListenerSpy();
        try {
            const screen = await renderScreen(<AppPaneProvider><SidebarNavigator /></AppPaneProvider>);
            const dragSurface = screen.findByTestId('desktop-main-content-drag-surface');

            expect(dragSurface).toBeTruthy();
            expect(dragSurface?.props.onPointerDownCapture).toBeUndefined();
            expect(dragSurface?.props.onMouseDownCapture).toBeUndefined();
            const flattenedStyle = flattenStyle(dragSurface?.props.style);
            expect(flattenedStyle.flex).toBe(1);

            const mouseDownListener = resolveMainContentMouseDownListener(documentListenerSpy.records);
            const preventDefault = vi.fn();
            mouseDownListener({
                buttons: 1,
                clientX: 377,
                clientY: 40,
                preventDefault,
                target: { closest: vi.fn(() => null) },
            } as unknown as MouseEvent);

            expect(preventDefault).toHaveBeenCalledTimes(1);
            expect(hoistedState.startDesktopWindowDragging).toHaveBeenCalledTimes(1);

            mouseDownListener({
                buttons: 1,
                clientX: 375,
                clientY: 40,
                preventDefault: vi.fn(),
                target: { closest: vi.fn(() => null) },
            } as unknown as MouseEvent);
            mouseDownListener({
                buttons: 1,
                clientX: 377,
                clientY: 40,
                preventDefault: vi.fn(),
                target: { closest: vi.fn(() => ({})) },
            } as unknown as MouseEvent);

            expect(hoistedState.startDesktopWindowDragging).toHaveBeenCalledTimes(1);
        } finally {
            documentListenerSpy.restore();
        }
    });
});
