import * as React from 'react';
import { useGlobalSearchParams, useLocalSearchParams, usePathname, useRouter } from 'expo-router';
import { NavigationContext } from '@react-navigation/native';
import { resolveHref } from 'expo-router/build/link/href';

import type { DestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';
import { useOptionalWorkspaceNavigation } from './WorkspaceNavigationContext';
import { qualifyPaneScopeId } from '@/components/appShell/panes/paneScopeIdentity';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

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

export function DestinationInstanceHost(props: Readonly<{
    tabId: string;
    ref: DestinationRef;
    pathname: string;
    focused: boolean;
    visible: boolean;
    navigation?: DestinationInstanceContextValue['navigation'];
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
            {props.children}
        </PluginSurfaceFocusEligibilityProvider>
    </DestinationInstanceContext.Provider>;
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
    // eslint-disable-next-line react-hooks/rules-of-hooks -- ownership is stable for this mounted body.
    return instance ? instance.pathname : usePathname();
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

/** Native screen chrome is absent in the workspace; Back still belongs to the same tab owner. */
export function useDestinationNavigation() {
    const instance = React.useContext(DestinationInstanceContext);
    const nativeNavigation = React.useContext(NavigationContext);
    return React.useMemo(() => instance ? {
        canGoBack: () => instance.navigation?.canGoBack?.() ?? false,
        goBack: () => instance.navigation?.back(),
        setOptions: (_options: unknown) => {},
        isFocused: () => instance.focused,
        addListener: (_event: string, _listener: () => void) => () => {},
        getParent: () => undefined,
    } : nativeNavigation, [instance, nativeNavigation]);
}

export function useDestinationFocusEffect(effect: React.EffectCallback): void {
    const focused = useDestinationFocus();
    React.useEffect(() => focused ? effect() : undefined, [effect, focused]);
}
