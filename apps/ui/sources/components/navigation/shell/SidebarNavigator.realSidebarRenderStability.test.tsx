import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installPartialStorageModuleMock } from '@/dev/testkit/mocks/storage';
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
    } satisfies Pick<Document, 'addEventListener' | 'removeEventListener'>;

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
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        Text: (props: any) => React.createElement('Text', props, props.children),
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
    storage: installPartialStorageModuleMock({
        useLocalSetting: (key: string) => {
            if (key === 'sidebarCollapsed') return false;
            if (key === 'sidebarWidthPx') return 320;
            if (key === 'sidebarWidthBasisPx') return 1200;
            return null;
        },
        useLocalSettingMutable: (key: string) => {
            if (key === 'sidebarCollapsed') return [false, vi.fn()] as const;
            if (key === 'sidebarWidthPx') return [320, vi.fn()] as const;
            if (key === 'sidebarWidthBasisPx') return [1200, vi.fn()] as const;
            return [null, vi.fn()] as const;
        },
        useFriendRequests: () => [],
        useSetting: () => false,
        useSocketStatus: () => ({ status: 'connected', lastError: null }),
        useSyncError: () => null,
        useRealtimeStatus: () => 'disconnected',
    }),
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

vi.mock('@/utils/platform/responsive', () => ({
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

vi.mock('@/sync/runtime/appVariant', () => ({
    resolveVisibleAppEnvironmentBadge: () => null,
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

vi.mock('@/components/ui/popover', () => ({
    PopoverBoundaryProvider: ({ children }: any) => React.createElement(React.Fragment, null, children),
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

afterEach(() => {
    hoistedState.isDesktopHost = false;
    hoistedState.startDesktopWindowDragging.mockReset();
    hoistedState.getDesktopWindowChromePolicy.mockReset();
    hoistedState.getDesktopWindowChromePolicy.mockResolvedValue({ strategy: 'none' });
    hoistedState.getDesktopWindowState.mockReset();
    hoistedState.getDesktopWindowState.mockResolvedValue({ isMaximized: false });
    hoistedState.listenDesktopWindowState.mockReset();
    hoistedState.listenDesktopWindowState.mockResolvedValue(async () => {});
    standardCleanup();
    vi.resetModules();
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter(Boolean));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('SidebarNavigator real sidebar render stability', () => {
    it('renders the authenticated permanent drawer shell with the real SidebarView subtree on web', async () => {
        const { SidebarNavigator } = await import('./SidebarNavigator');

        const screen = await renderScreen(<SidebarNavigator />);

        expect(screen.findByTestId('main-view')).toBeTruthy();
        const dragSurface = screen.findByTestId('desktop-main-content-drag-surface');
        expect(dragSurface).toBeTruthy();
        expect(dragSurface?.props.onPointerDownCapture).toBeUndefined();
    });

    it('starts Tauri dragging from the main content titlebar strip without blocking interactive targets', async () => {
        hoistedState.isDesktopHost = true;
        const documentListenerSpy = installDocumentEventListenerSpy();
        const { SidebarNavigator } = await import('./SidebarNavigator');

        try {
            const screen = await renderScreen(<SidebarNavigator />);
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
                clientX: 321,
                clientY: 40,
                preventDefault,
                target: { closest: vi.fn(() => null) },
            } as unknown as MouseEvent);

            expect(preventDefault).toHaveBeenCalledTimes(1);
            expect(hoistedState.startDesktopWindowDragging).toHaveBeenCalledTimes(1);

            mouseDownListener({
                buttons: 1,
                clientX: 319,
                clientY: 40,
                preventDefault: vi.fn(),
                target: { closest: vi.fn(() => null) },
            } as unknown as MouseEvent);
            mouseDownListener({
                buttons: 1,
                clientX: 321,
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
