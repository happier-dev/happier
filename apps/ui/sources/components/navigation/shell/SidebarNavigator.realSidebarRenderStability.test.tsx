import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import type { DesktopWindowState } from '@/utils/platform/desktopWindowBridge';

import { installNavigationShellCommonModuleMocks } from './navigationShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hoistedState = vi.hoisted(() => ({
    mockPathname: '/' as string,
    mockSegments: ['(app)'] as string[],
    mockWindowDimensions: { width: 1200, height: 900 },
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
    const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const records: RegisteredDocumentListener[] = [];
    const fakeDocument = {
        addEventListener: vi.fn((
            type: string,
            listener: EventListenerOrEventListenerObject,
            options?: boolean | AddEventListenerOptions,
        ) => {
            records.push({ type, listener, options });
        }),
        removeEventListener: vi.fn((
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
        }),
        // Modules the app shell imports probe the document at load (a list backend's web check).
        getElementById: vi.fn(() => null),
    } satisfies Pick<Document, 'addEventListener' | 'removeEventListener' | 'getElementById'>;

    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: fakeDocument,
    });

    return {
        records,
        restore: () => {
            if (previousDescriptor) {
                Object.defineProperty(globalThis, 'document', previousDescriptor);
            } else {
                Reflect.deleteProperty(globalThis, 'document');
            }
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
        return createExpoRouterMock({
            pathname: () => hoistedState.mockPathname,
            segments: () => hoistedState.mockSegments,
            router: {
                push: vi.fn(),
                replace: vi.fn(),
                back: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
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

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => hoistedState.isDesktopHost,
}));

vi.mock('@/utils/platform/desktopWindowBridge', () => ({
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

vi.mock('@/hooks/inbox/useInboxHasContent', () => ({
    useInboxHasContent: () => false,
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

vi.mock('@/components/voice/surface/VoiceSurface', () => ({
    VoiceSurface: () => React.createElement('VoiceSurface'),
}));

vi.mock('@/components/appShell/search/UniversalSearchRuntimeContext', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/appShell/search/UniversalSearchRuntimeContext')>()),
    useUniversalSearchRuntime: () => ({ open: vi.fn(), buildCommands: vi.fn() }),
}));

// Configure the platform boundaries before loading the real shell, outside behavior-test timeouts.
const { storage } = await import('@/sync/domains/state/storage');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { SidebarNavigator } = await import('./SidebarNavigator');
const initialStorageState = storage.getState();

beforeEach(() => {
    storage.setState({ ...initialStorageState, localSettings: { ...initialStorageState.localSettings,
        sidebarCollapsed: false, sidebarWidthPx: 320, sidebarWidthBasisPx: 1200 } }, true);
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
