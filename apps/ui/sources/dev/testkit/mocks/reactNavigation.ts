import * as React from 'react';

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

    return {
        CommonActions: {
            setParams: (params: Record<string, unknown>) => ({ type: 'SET_PARAMS', payload: { params } }),
        },
        DarkTheme: {
            dark: true,
            colors: { ...defaultColors, background: '#000000', card: '#000000', text: '#ffffff' },
            fonts: {},
        },
        DefaultTheme: {
            dark: false,
            colors: defaultColors,
            fonts: {},
        },
        NavigationContainer: passThrough,
        NavigationIndependentTree: passThrough,
        ThemeProvider: passThrough,
        useIsFocused: () => isFocused,
        useFocusEffect: (effect: () => void | (() => void)) => {
            React.useEffect(() => effect(), [effect]);
        },
        useNavigation: () => navigation,
        usePreventRemove: options.usePreventRemove ?? (() => undefined),
    };
}
