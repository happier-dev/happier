import * as React from 'react';
import { useGlobalSearchParams, useLocalSearchParams, usePathname, useRouter } from 'expo-router';
import { NavigationContext } from '@react-navigation/native';
import { resolveHref } from 'expo-router/build/link/href';

import { hrefForDestinationRef, type DestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';
import { useOptionalWorkspaceNavigation } from './WorkspaceNavigationContext';
import { qualifyPaneScopeId } from '@/components/appShell/panes/paneScopeIdentity';
import { PluginSurfaceFocusEligibilityProvider, useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { DefaultBackButton, Header, NavigationHeaderTitle } from '@/components/navigation/Header';
import { NavigationTitleChromeProvider } from '@/components/ui/layout/navigationTitleChrome';

const DestinationHeaderOptionsContext = React.createContext<((options: NativeStackNavigationOptions) => void) | null>(null);

export type DestinationNavigation = Pick<ReturnType<typeof useRouter>, 'push' | 'replace' | 'back'>
    & Partial<ReturnType<typeof useRouter>> & {
        /** Open another destination without retiring the caller's mounted draft. */
        pushRetainingCurrent?: ReturnType<typeof useRouter>['push'];
    };

type DestinationRouter = ReturnType<typeof useRouter> & {
    pushRetainingCurrent: ReturnType<typeof useRouter>['push'];
};

type DestinationInstanceContextValue = Readonly<{
    tabId: string;
    ref: DestinationRef;
    pathname: string;
    focused: boolean;
    visible: boolean;
    navigation?: DestinationNavigation;
}>;

const DestinationInstanceContext = React.createContext<DestinationInstanceContextValue | null>(null);

function RetainedDestinationContext(props: Readonly<{
    captured: DestinationInstanceContextValue | null;
    children: React.ReactNode;
}>): React.ReactElement {
    const presented = useLayoutPresentationActive();
    const value = React.useMemo(() => props.captured ? {
        ...props.captured,
        visible: props.captured.visible && presented,
        focused: props.captured.focused && presented,
    } : null, [presented, props.captured]);
    return <DestinationInstanceContext.Provider value={value}>{props.children}</DestinationInstanceContext.Provider>;
}

/** Retain this destination's identity/navigation without mounting a second destination or chrome. */
export function useRetainedDestinationNode(children: React.ReactNode): React.ReactElement {
    const captured = React.useContext(DestinationInstanceContext);
    return <RetainedDestinationContext captured={captured}>{children}</RetainedDestinationContext>;
}

export function DestinationInstanceHost(props: Readonly<{
    tabId: string;
    ref: DestinationRef;
    pathname: string;
    focused: boolean;
    visible: boolean;
    navigation?: DestinationInstanceContextValue['navigation'];
    phone?: boolean;
    children: React.ReactNode;
}>): React.ReactNode {
    const value = React.useMemo<DestinationInstanceContextValue>(() => ({
        tabId: props.tabId,
        ref: props.ref,
        pathname: props.pathname,
        focused: props.focused && props.visible,
        visible: props.visible,
        ...(props.navigation ? { navigation: props.navigation } : {}),
    }), [props.focused, props.navigation, props.pathname, props.ref, props.tabId, props.visible]);
    return <DestinationInstanceContext.Provider value={value}>
        <PluginSurfaceFocusEligibilityProvider active={value.focused} presentationActive={value.visible} currentUiContextActive={value.focused}>
            <DestinationNavigationChrome phone={props.phone === true} navigation={props.navigation}>
                {props.children}
            </DestinationNavigationChrome>
        </PluginSurfaceFocusEligibilityProvider>
    </DestinationInstanceContext.Provider>;
}

function DestinationNavigationChrome(props: Readonly<{
    phone: boolean;
    navigation?: DestinationNavigation;
    children: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    const [options, setOptions] = React.useState<NativeStackNavigationOptions>({});
    const [title, setTitle] = React.useState<string | null | undefined>(undefined);
    const [back, setBack] = React.useState<React.ReactNode>(null);
    const updateOptions = React.useCallback((next: NativeStackNavigationOptions) => {
        setOptions(previous => Object.entries(next).every(([key, value]) => previous[key as keyof NativeStackNavigationOptions] === value)
            ? previous : { ...previous, ...next });
    }, []);
    const publisher = React.useMemo(() => ({ setTitle, setBack }), []);
    const canGoBack = props.navigation?.canGoBack?.() ?? false;
    const tintColor = options.headerTintColor ?? theme.colors.chrome.header.foreground;
    const chromeShown = props.phone && options.headerShown !== false;
    const declaredTitle = typeof options.headerTitle === 'string' ? options.headerTitle : options.title;
    const titleNode = title !== undefined
        ? (title === null ? null : <NavigationHeaderTitle title={title} tintColor={tintColor} />)
        : typeof options.headerTitle === 'function' ? options.headerTitle({ children: declaredTitle ?? '', tintColor })
            : declaredTitle ? <NavigationHeaderTitle title={declaredTitle} tintColor={tintColor} style={options.headerTitleStyle} /> : null;
    const hasChrome = title !== undefined || titleNode !== null || options.headerLeft || options.headerRight || back;
    return <DestinationHeaderOptionsContext.Provider value={updateOptions}>
        <NavigationTitleChromeProvider showsTitle={chromeShown}
            showsBack={chromeShown && Boolean(options.headerLeft || back || canGoBack)} publisher={publisher}>
            {chromeShown && hasChrome ? <View testID="workspace-destination-header">
                <Header title={titleNode}
                    subtitle={(options as Readonly<{ headerSubtitle?: string }>).headerSubtitle}
                    headerLeft={options.headerLeft ? () => options.headerLeft!({ tintColor, canGoBack }) : () => back ?? (canGoBack
                        ? <DefaultBackButton tintColor={tintColor} onPress={() => props.navigation?.back()} /> : null)}
                    headerRight={options.headerRight ? () => options.headerRight!({ tintColor, canGoBack }) : undefined} />
            </View> : null}
            {props.children}
        </NavigationTitleChromeProvider>
    </DestinationHeaderOptionsContext.Provider>;
}

/** Screen declarations target this retained destination; named layout declarations remain inventory. */
export function useDestinationScreenOptions(options: NativeStackNavigationOptions | undefined) {
    const setOptions = React.useContext(DestinationHeaderOptionsContext);
    React.useEffect(() => {
        if (!setOptions || !options) return;
        setOptions(options);
        return () => setOptions(Object.fromEntries(Object.keys(options).map(key => [key, undefined])));
    }, [options, setOptions]);
}

export function useDestinationParams<T extends Record<string, string | string[] | undefined>>(): T {
    const instance = React.useContext(DestinationInstanceContext);
    // A mounted body never moves between the Expo and workspace owners.
    // eslint-disable-next-line react-hooks/rules-of-hooks -- ownership is stable for this mounted body.
    return (instance ? instance.ref.params : useLocalSearchParams()) as T;
}

export function useDestinationGlobalParams<T extends Record<string, string | string[] | undefined>>(): T {
    const instance = React.useContext(DestinationInstanceContext);
    // eslint-disable-next-line react-hooks/rules-of-hooks -- ownership is stable for this mounted body.
    return (instance ? instance.ref.params : useGlobalSearchParams()) as T;
}

export function useDestinationPathname(): string {
    const instance = React.useContext(DestinationInstanceContext);
    const workspace = useOptionalWorkspaceNavigation();
    // eslint-disable-next-line react-hooks/rules-of-hooks -- ownership is stable for this mounted body.
    const pathname = instance ? null : usePathname();
    if (instance) return instance.pathname;
    if (workspace?.active) {
        const group = workspace.state.groups[workspace.state.focusedGroupId];
        const tab = workspace.state.tabs[group.activeTabId];
        // The shell column follows the same tab owner as its body. Expo mirrors that route after
        // navigation and must not retain a previous tab's selection in the meantime.
        return hrefForDestinationRef(workspace.catalog ?? [], tab.target)?.split(/[?#]/, 1)[0] ?? '';
    }
    return pathname!;
}

export function useDestinationFocus(): boolean {
    const instance = React.useContext(DestinationInstanceContext);
    // eslint-disable-next-line react-hooks/rules-of-hooks -- ownership is stable for this mounted body.
    return instance ? instance.focused : useOptionalScreenIsFocused();
}

export function useDestinationVisibility(): boolean {
    return React.useContext(DestinationInstanceContext)?.visible ?? true;
}

export function useDestinationInstanceKey(): string | null {
    return React.useContext(DestinationInstanceContext)?.tabId ?? null;
}

export function useDestinationPaneScopeId(resourceScopeId: string): string {
    return qualifyPaneScopeId(resourceScopeId, useDestinationInstanceKey());
}

export function useDestinationRouter(): DestinationRouter {
    const instance = React.useContext(DestinationInstanceContext);
    // eslint-disable-next-line react-hooks/rules-of-hooks -- ownership is stable for this mounted body.
    if (!instance) return useWorkspaceOrExpoRouter();
    // eslint-disable-next-line react-hooks/rules-of-hooks -- ownership is stable for this mounted body.
    return React.useMemo(() => {
        const navigation = instance.navigation;
        if (!navigation) throw new Error('A hosted destination requires workspace navigation');
        const unsupported = () => { throw new Error('The workspace navigation owner did not supply this operation'); };
        return {
            navigate: navigation.push,
            canGoBack: () => false,
            canDismiss: () => false,
            dismiss: navigation.back,
            dismissTo: navigation.replace,
            dismissAll: navigation.back,
            setParams: unsupported,
            reload: unsupported,
            prefetch: () => {},
            ...navigation,
            pushRetainingCurrent: navigation.pushRetainingCurrent ?? unsupported,
        };
    }, [instance.navigation]);
}

function useWorkspaceOrExpoRouter() {
    const workspace = useOptionalWorkspaceNavigation();
    const router = useRouter();
    return React.useMemo(() => {
        if (!workspace?.active) return { ...router, pushRetainingCurrent: router.push };
        const navigate: typeof router.push = (href, options) => {
            if (!workspace.openHref(resolveHref(href))) router.push(href, options);
        };
        const replace: typeof router.replace = (href, options) => {
            if (!workspace.openHref(resolveHref(href), { replace: true })) router.replace(href, options);
        };
        const pushRetainingCurrent: typeof router.push = (href, options) => {
            const group = workspace.state.groups[workspace.state.focusedGroupId];
            const navigation = workspace.navigationForTab(group.activeTabId);
            if (!navigation.pushRetainingCurrent) throw new Error('The workspace navigation owner did not supply draft retention');
            navigation.pushRetainingCurrent(href, options);
        };
        return { ...router, push: navigate, navigate, replace, pushRetainingCurrent,
            back: workspace.back,
            canGoBack: () => workspace.canGoBack };
    }, [router, workspace]);
}

/** The retained host owns its chrome options; Back still belongs to the same tab owner. */
export function useDestinationNavigation() {
    const instance = React.useContext(DestinationInstanceContext);
    const nativeNavigation = React.useContext(NavigationContext);
    const setOptions = React.useContext(DestinationHeaderOptionsContext);
    return React.useMemo(() => instance ? {
        canGoBack: () => instance.navigation?.canGoBack?.() ?? false,
        goBack: () => instance.navigation?.back(),
        setOptions: setOptions ?? ((_options: NativeStackNavigationOptions) => {}),
        isFocused: () => instance.focused,
        addListener: (_event: string, _listener: () => void) => () => {},
        getParent: () => undefined,
    } : nativeNavigation, [instance, nativeNavigation, setOptions]);
}

export function useDestinationFocusEffect(effect: React.EffectCallback): void {
    const focused = useDestinationFocus();
    React.useEffect(() => focused ? effect() : undefined, [effect, focused]);
}
