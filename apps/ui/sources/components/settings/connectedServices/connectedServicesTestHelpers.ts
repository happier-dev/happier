import { vi } from 'vitest';

import type { ExpoRouterParams } from '@/dev/testkit/mocks/router';

type ConnectedServicesModuleFactory = () => unknown | Promise<unknown>;

type InstallConnectedServicesCommonModuleMocksOptions = Readonly<{
    modal?: ConnectedServicesModuleFactory;
    reactNative?: ConnectedServicesModuleFactory;
    router?: ConnectedServicesModuleFactory;
    searchParams?: ExpoRouterParams;
    text?: ConnectedServicesModuleFactory;
}>;

const connectedServicesModuleState = vi.hoisted(() => ({
    routerBackSpy: vi.fn(),
    routerPushSpy: vi.fn(),
    setOptionsSpy: vi.fn(),
    searchParams: {} as ExpoRouterParams,
    options: {
        modal: undefined as ConnectedServicesModuleFactory | undefined,
        reactNative: undefined as ConnectedServicesModuleFactory | undefined,
        router: undefined as ConnectedServicesModuleFactory | undefined,
        text: undefined as ConnectedServicesModuleFactory | undefined,
    },
}));

export function resetConnectedServicesCommonModuleMockState() {
    connectedServicesModuleState.routerBackSpy.mockClear();
    connectedServicesModuleState.routerPushSpy.mockClear();
    connectedServicesModuleState.setOptionsSpy.mockClear();
    connectedServicesModuleState.searchParams = {};
    connectedServicesModuleState.options = {
        modal: undefined,
        reactNative: undefined,
        router: undefined,
        text: undefined,
    };
}

/**
 * Opt-in passthrough mocks for the UI-primitive boundaries the REDESIGNED
 * `ConnectedServiceDetailView` mounts: the segmented `Accounts | Pools` shell,
 * brand-icon SVGs, and member avatars. These are intentionally NOT part of the
 * always-on common mocks so existing connected-services tests (oauth, settings
 * index, profile/pool detail) keep their own boundary setup untouched.
 *
 * - `SegmentedTabBar`: the real one reads `theme.colors.segmentedControl.*`,
 *   which the global unistyles test theme omits. Rendered here as one pressable
 *   per tab, preserving the `${testIDPrefix}:${tab.id}` testID + `onSelectTab`
 *   callback so segment switching stays exercisable.
 * - `react-native-svg`: native boundary; the controller renders brand icons via
 *   `<SvgXml>` (AccountBlock + PoolsList).
 * - `Avatar`: the PoolsList member stack dynamically requires
 *   `@/agents/registry/registryUi`, which the Node test runtime cannot resolve.
 *
 * Call this AT MODULE SCOPE (alongside `installConnectedServicesCommonModuleMocks`).
 */
export function installConnectedServiceDetailShellMocks() {
    vi.mock('@react-navigation/native', () => ({
        useIsFocused: () => true,
    }));

    vi.mock('@/components/ui/navigation/SegmentedTabBar', () => {
        const React = require('react');
        type Tab = { id: string; label: string };
        type Props = {
            tabs: ReadonlyArray<Tab>;
            activeTabId: string;
            onSelectTab: (id: string) => void;
            testIDPrefix?: string;
        };
        return {
            SegmentedTabBar: (props: Props) =>
                React.createElement(
                    'SegmentedTabBar',
                    { testID: props.testIDPrefix },
                    props.tabs.map((tab) =>
                        React.createElement('Pressable', {
                            key: tab.id,
                            testID: props.testIDPrefix ? `${props.testIDPrefix}:${tab.id}` : undefined,
                            accessibilityState: { selected: props.activeTabId === tab.id },
                            onPress: () => props.onSelectTab(tab.id),
                        }, tab.label),
                    ),
                ),
        };
    });

    vi.mock('react-native-svg', () => {
        const React = require('react');
        return {
            SvgXml: (props: Record<string, unknown>) => React.createElement('SvgXml', props),
            Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Svg', props, props.children),
            Circle: (props: Record<string, unknown>) => React.createElement('Circle', props, null),
        };
    });

    vi.mock('@/components/ui/avatar/Avatar', () => {
        const React = require('react');
        return {
            Avatar: (props: Record<string, unknown>) => React.createElement('Avatar', props),
        };
    });
}

export function installConnectedServicesCommonModuleMocks(
    options: InstallConnectedServicesCommonModuleMocksOptions = {},
) {
    connectedServicesModuleState.searchParams = options.searchParams ?? {};
    connectedServicesModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        text: options.text,
    };

    vi.mock('react-native', async () => {
        const activeOptions = connectedServicesModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = connectedServicesModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = connectedServicesModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });

    vi.mock('expo-router', async () => {
        const activeOptions = connectedServicesModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: {
                back: connectedServicesModuleState.routerBackSpy,
                push: connectedServicesModuleState.routerPushSpy,
                replace: vi.fn(),
                setParams: vi.fn(),
            },
            // The redesigned controller registers a header-right "+" via
            // `useNavigation().setOptions` in a layout effect.
            navigation: { setOptions: connectedServicesModuleState.setOptionsSpy },
        });

        return {
            ...routerMock.module,
            useLocalSearchParams: () => connectedServicesModuleState.searchParams,
            useGlobalSearchParams: () => connectedServicesModuleState.searchParams,
        };
    });
}

export { connectedServicesModuleState };
