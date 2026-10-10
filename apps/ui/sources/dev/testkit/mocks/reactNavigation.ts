import * as React from 'react';
import { getFocusedRouteNameFromRoute, StackRouter, type ParamListBase } from '@react-navigation/core';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

type NavigationPropFixture = NativeStackNavigationProp<ParamListBase>;

/**
 * Complete installed-SDK navigation port for a header or NavigationContext.
 * Focus/state reads have concrete defaults; unconfigured commands fail loudly
 * instead of pretending to perform navigation. Product route owners stay real.
 */
export function createNavigationPropMock(
    overrides: Partial<NavigationPropFixture> = {},
): NavigationPropFixture {
    const state = StackRouter({}).getInitialState({
        routeNames: ['test-route'], routeParamList: {}, routeGetIdList: {},
    });
    const unsupported = (): never => {
        throw new Error('Configure the navigation SDK port used by this test');
    };
    return {
        addListener: () => () => undefined,
        removeListener: () => undefined,
        isFocused: () => true,
        canGoBack: () => false,
        getId: () => undefined,
        getState: () => state,
        getParent: unsupported,
        dispatch: unsupported,
        navigate: unsupported,
        navigateDeprecated: unsupported,
        preload: unsupported,
        reset: unsupported,
        goBack: unsupported,
        setOptions: unsupported,
        setParams: unsupported,
        replaceParams: unsupported,
        replace: unsupported,
        push: unsupported,
        pop: unsupported,
        popToTop: unsupported,
        popTo: unsupported,
        ...overrides,
    };
}

export type CreateReactNavigationNativeMockOptions = Readonly<{
    isFocused?: boolean;
    navigation?: Readonly<Record<string, unknown>>;
    usePreventRemove?: (
        preventRemove: boolean,
        callback: (event: { data: { action: unknown } }) => void,
    ) => void;
}>;

export function createReactNavigationNativeMock(options: CreateReactNavigationNativeMockOptions = {}) {
    const isFocused = options.isFocused ?? true;
    const navigation = {
        addListener: () => () => undefined,
        canGoBack: () => false,
        dispatch: () => undefined,
        getState: () => ({ index: 0, routes: [] }),
        goBack: () => undefined,
        navigate: () => undefined,
        setOptions: () => undefined,
        setParams: () => undefined,
        ...options.navigation,
    };
    const passThrough = ({ children }: React.PropsWithChildren) =>
        React.createElement(React.Fragment, null, children);
    const defaultColors = {
        primary: '#0a84ff',
        background: '#ffffff',
        card: '#ffffff',
        text: '#000000',
        border: '#d1d1d6',
        notification: '#ff3b30',
    };
    const defaultTheme = { dark: false, colors: defaultColors, fonts: {} };
    // The real library hands the nearest provider's theme to `useTheme`.
    const ThemeContext = React.createContext<unknown>(null);

    return {
        getFocusedRouteNameFromRoute,
        CommonActions: {
            setParams: (params: Record<string, unknown>) => ({ type: 'SET_PARAMS', payload: { params } }),
        },
        DarkTheme: {
            dark: true,
            colors: { ...defaultColors, background: '#000000', card: '#000000', text: '#ffffff' },
            fonts: {},
        },
        DefaultTheme: defaultTheme,
        NavigationContext: React.createContext<Readonly<Record<string, unknown>> | undefined>(undefined),
        NavigationRouteContext: React.createContext<Readonly<{ key?: string; name?: string }> | undefined>(undefined),
        NavigationContainer: passThrough,
        NavigationIndependentTree: passThrough,
        // Installed SDK's no-config factory returns these three native containers.
        createNavigatorFactory: (_Navigator: unknown) => () => ({
            Navigator: passThrough, Screen: passThrough, Group: passThrough,
        }),
        ThemeProvider: ({ children, value }: { children?: React.ReactNode; value: unknown }) =>
            React.createElement(ThemeContext.Provider, { value }, children),
        useTheme: () => React.useContext(ThemeContext) ?? defaultTheme,
        useIsFocused: () => isFocused,
        useFocusEffect: (effect: () => void | (() => void)) => {
            React.useEffect(() => effect(), [effect]);
        },
        useNavigation: () => navigation,
        usePreventRemove: options.usePreventRemove ?? (() => undefined),
    };
}
