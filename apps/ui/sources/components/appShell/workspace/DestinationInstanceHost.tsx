import * as React from 'react';
import { useGlobalSearchParams, useLocalSearchParams, usePathname, useRouter } from 'expo-router';
import { resolveHref } from 'expo-router/build/link/href';

import type { DestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { useOptionalWorkspaceNavigation, useWorkspaceFocusedPathname, useWorkspaceFocusedRoute, useWorkspaceFocusedRouteSelector, useWorkspaceRouterFacts, type WorkspaceFocusedRoute } from './WorkspaceNavigationContext';
import { sameDestinationRef } from './workspaceState';
import { qualifyPaneScopeId } from '@/components/appShell/panes/paneScopeIdentity';
import { PluginSurfaceFocusEligibilityProvider, useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useRetainedPresentationEntryRetirement } from '@/components/ui/presentation/retainedPresentationEntryLifetime';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { DefaultBackButton, Header, NavigationHeaderTitle, PageHeaderActionsHost } from '@/components/navigation/Header';
import { HeaderActionsScope, useEnclosingHeaderActionsScope } from '@/components/navigation/stackHeaderActions';
import { NavigationTitleChromeProvider, useNavigationChromeShowsBack, useNavigationTitleChromePublisher, useNavigationTitleChromeShowsTitle } from '@/components/ui/layout/navigationTitleChrome';
import { useRootStackRouteOptions } from '@/components/navigation/root/useRootStackRouteOptions';
import { resolveRootStackRouteOptions } from '@/components/navigation/root/rootStackRouteOptions';
import { matchWorkspaceDestinationRoute, workspaceRouteFiles } from './workspaceRoutes';
import { SessionViewerDestinationScope } from '@/components/sessions/viewer/SessionViewerDestinationScope';
import { HostedSessionRouteQualification } from '@/components/sessions/shell/HostedSessionRouteQualification';
import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { DestinationInstanceContext, DestinationHeaderOptionsContext, useDestinationFocus, useDestinationInstance, useDestinationInstanceIdentity, useDestinationInstanceKey, type DestinationInstanceContextValue, type DestinationNavigation } from './destinationInstanceContext';
export { useDestinationInstanceKey, useDestinationNavigation, type DestinationNavigation } from './destinationInstanceContext';

const EMPTY_SCREEN_OPTIONS: NativeStackNavigationOptions = {};

type DestinationRouter = ReturnType<typeof useRouter> & {
    redirect: ReturnType<typeof useRouter>['replace'];
    pushRetainingCurrent: ReturnType<typeof useRouter>['push'];
    retainCurrent: () => void;
};

type DestinationFocusIdentity = Pick<DestinationInstanceContextValue, 'tabId' | 'ref' | 'navigation'>;

/** Delayed work keeps its identity while reading the current committed owner's focus query. */
function useCurrentDestinationFocus(identity: DestinationFocusIdentity | null, query: () => boolean): () => boolean {
    const current = React.useRef<(DestinationFocusIdentity & Readonly<{ query: () => boolean }>) | null>(null);
    React.useLayoutEffect(() => {
        current.current = identity ? { tabId: identity.tabId, ref: identity.ref, navigation: identity.navigation, query } : null;
        return () => { current.current = null; };
    });
    const tabId = identity?.tabId;
    const ref = identity?.ref;
    const navigation = identity?.navigation;
    return React.useCallback(() => {
        const latest = current.current;
        return latest !== null && latest.tabId === tabId && ref !== undefined && sameDestinationRef(latest.ref, ref)
            && latest.navigation === navigation && latest.query();
    }, [navigation, ref, tabId]);
}

function RetainedDestinationContext(props: Readonly<{
    captured: DestinationInstanceContextValue | null;
    children: React.ReactNode;
}>): React.ReactElement {
    const presented = useLayoutPresentationActive();
    const workspace = useOptionalWorkspaceNavigation();
    const retire = useRetainedPresentationEntryRetirement();
    // The portal remains under the live workspace owner even after its route/binder leaves.
    // Only actual destination removal ends this lifetime; inactive workspaces still own their tabs.
    const present = props.captured === null || workspace === null
        || Object.hasOwn(workspace.state.tabs, props.captured.tabId);
    React.useLayoutEffect(() => {
        if (!present) retire?.();
    }, [present, retire]);
    const active = present && presented;
    const canonicalQuery = props.captured?.isFocused;
    const query = React.useCallback(() => active && canonicalQuery?.() === true, [active, canonicalQuery]);
    const isFocused = useCurrentDestinationFocus(props.captured, query);
    const value = React.useMemo(() => props.captured ? {
        ...props.captured,
        visible: props.captured.visible && presented,
        focused: props.captured.focused && presented,
        isFocused,
    } : null, [isFocused, presented, props.captured]);
    return <DestinationInstanceContext.Provider value={value}>{props.children}</DestinationInstanceContext.Provider>;
}

/** Retain this destination's identity/navigation without mounting a second destination or chrome. */
export function useRetainedDestinationNode(children: React.ReactNode): React.ReactElement {
    const captured = useDestinationInstance();
    return React.useMemo(() => <RetainedDestinationContext captured={captured}>{children}</RetainedDestinationContext>,
        [captured, children]);
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
    const rootOptions = useRootStackRouteOptions();
    const match = matchWorkspaceDestinationRoute(props.pathname);
    const sessionRoute = props.ref.kind === 'session' || props.ref.kind === 'sessionDetails'
        || match?.routeKey.startsWith('session/[id]/') === true;
    const sessionAddress = sessionRoute ? normalizeSessionAddress(props.ref.params.serverId, props.ref.params.id) : null;
    const baseOptions = resolveRootStackRouteOptions(rootOptions, match ? workspaceRouteFiles[match.routeKey] : undefined) ?? EMPTY_SCREEN_OPTIONS;
    const focused = props.focused && props.visible;
    const query = React.useCallback(() => focused, [focused]);
    const isFocused = useCurrentDestinationFocus(props, query);
    const value = React.useMemo<DestinationInstanceContextValue>(() => ({
        tabId: props.tabId,
        ref: props.ref,
        pathname: props.pathname,
        focused,
        visible: props.visible,
        isFocused,
        ...(props.navigation ? { navigation: props.navigation } : {}),
    }), [focused, isFocused, props.navigation, props.pathname, props.ref, props.tabId, props.visible]);
    return <DestinationInstanceContext.Provider value={value}>
        <PluginSurfaceFocusEligibilityProvider active={value.focused} presentationActive={value.visible} currentUiContextActive={value.focused}>
            <DestinationNavigationChrome scopeKey={`destination:${props.tabId}`} phone={props.phone === true} navigation={props.navigation} baseOptions={baseOptions}>
                {sessionRoute && !props.ref.params.serverId && props.navigation ? <HostedSessionRouteQualification
                    params={props.ref.params} pathname={props.pathname} focused={focused} replace={props.navigation.replace} /> : null}
                {sessionAddress ? <SessionViewerDestinationScope key={sessionAddressKey(sessionAddress)}
                    sessionId={sessionAddress.sessionId} serverId={sessionAddress.serverId}>
                    {props.children}
                </SessionViewerDestinationScope> : props.children}
            </DestinationNavigationChrome>
        </PluginSurfaceFocusEligibilityProvider>
    </DestinationInstanceContext.Provider>;
}

function DestinationNavigationChrome(props: Readonly<{
    scopeKey: string;
    phone: boolean;
    navigation?: DestinationNavigation;
    baseOptions?: NativeStackNavigationOptions;
    /** Native scenes keep their own router and visual chrome; collect only identity. */
    publicationOnly?: Readonly<{ tabId: string; ref: DestinationRef }> | null;
    children: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    const hostedInstance = useDestinationInstance();
    const publicationOnly = props.publicationOnly !== undefined;
    const instance = publicationOnly ? props.publicationOnly : hostedInstance;
    const nativeShowsTitle = useNavigationTitleChromeShowsTitle();
    const nativeShowsBack = useNavigationChromeShowsBack();
    const ref = instance?.ref;
    const publishTitle = useOptionalWorkspaceNavigation(value => value?.publishDestinationTitle);
    // The publication owner changes with the Account even when a retained
    // route happens to reuse the same target object.
    type TitleIdentity = Readonly<{ ref: typeof ref; owner: typeof publishTitle }>;
    const [declared, setDeclared] = React.useState<TitleIdentity & Readonly<{ options: NativeStackNavigationOptions }>>({ ref, owner: publishTitle, options: {} });
    const [chromeTitle, setChromeTitle] = React.useState<TitleIdentity & Readonly<{ title: string | null | undefined }>>({ ref, owner: publishTitle, title: undefined });
    const [pageIdentity, setPageIdentity] = React.useState<TitleIdentity & Readonly<{ title: string | null | undefined }>>({ ref, owner: publishTitle, title: undefined });
    const isCurrent = (identity: TitleIdentity) => identity.ref === ref && identity.owner === publishTitle;
    const overrides = isCurrent(declared) ? declared.options : EMPTY_SCREEN_OPTIONS;
    const options = React.useMemo<NativeStackNavigationOptions>(() => ({
        ...props.baseOptions,
        // Withdrawing a leaf declaration restores the inherited layout option.
        ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)),
    }), [overrides, props.baseOptions]);
    const title = isCurrent(chromeTitle) ? chromeTitle.title : undefined;
    const pageTitle = isCurrent(pageIdentity) ? pageIdentity.title : undefined;
    const [back, setBack] = React.useState<React.ReactNode>(null);
    const updateOptions = React.useCallback((next: NativeStackNavigationOptions) => {
        setDeclared(previous => {
            const current = previous.ref === ref && previous.owner === publishTitle;
            const options = current ? previous.options : {};
            return current && Object.entries(next).every(([key, value]) => options[key as keyof NativeStackNavigationOptions] === value)
                ? previous : { ref, owner: publishTitle, options: { ...options, ...next } };
        });
    }, [ref, publishTitle]);
    const publisher = React.useMemo(() => ({
        setTitle: (title: string | null | undefined) => setChromeTitle(previous => previous.ref === ref && previous.owner === publishTitle && previous.title === title ? previous : { ref, owner: publishTitle, title }),
        setPageTitle: (title: string | null | undefined) => setPageIdentity(previous => previous.ref === ref && previous.owner === publishTitle && previous.title === title ? previous : { ref, owner: publishTitle, title }),
        setBack,
    }), [ref, publishTitle]);
    const identityPublisher = React.useMemo(() => publicationOnly ? { setPageTitle: publisher.setPageTitle } : publisher, [publicationOnly, publisher]);
    const canGoBack = props.navigation?.canGoBack?.() ?? false;
    const tintColor = options.headerTintColor ?? theme.colors.chrome.header.foreground;
    const chromeShown = props.phone && options.headerShown !== false;
    // Only the trailing actions are lent: `headerLeft` is the hidden header's way back, which the page header's
    // own Back (or the page's crumb) already is. Lent, it would stand a second Back among the actions.
    const renderActions = React.useMemo(() => !chromeShown && options.headerRight
        ? () => options.headerRight?.({ tintColor, canGoBack }) ?? null
        : null, [canGoBack, chromeShown, options.headerRight, tintColor]);
    // Hosted inside a pane that lends its controls (a Work peek, the Inbox's detail), a route with no
    // actions of its own hands the pane's scope through, so the page's header draws those controls.
    const enclosingScope = useEnclosingHeaderActionsScope();
    const declaredTitle = typeof options.headerTitle === 'string' ? options.headerTitle : options.title;
    // headerTitle belongs to navigation chrome; title and PageHeader supply
    // screen identity. A page's explicit null withdraws its previous identity.
    const instanceTitle = pageTitle !== undefined ? pageTitle : Object.hasOwn(options, 'title') ? options.title ?? null : undefined;
    React.useEffect(() => {
        if (!publishTitle || !instance || instanceTitle === undefined) return;
        return publishTitle(instance.tabId, instance.ref, instanceTitle?.trim() ? instanceTitle : null);
    }, [instance?.ref, instance?.tabId, instanceTitle, publishTitle]);
    const titleNode = title !== undefined
        ? (title === null ? null : <NavigationHeaderTitle title={title} tintColor={tintColor} />)
        : typeof options.headerTitle === 'function' ? options.headerTitle({ children: declaredTitle ?? '', tintColor })
            : declaredTitle ? <NavigationHeaderTitle title={declaredTitle} tintColor={tintColor} style={options.headerTitleStyle} /> : null;
    const hasChrome = title !== undefined || titleNode !== null || options.headerLeft || options.headerRight || back;
    if (publicationOnly) return <DestinationHeaderOptionsContext.Provider value={updateOptions}>
        <NavigationTitleChromeProvider showsTitle={nativeShowsTitle} showsBack={nativeShowsBack} publisher={identityPublisher}>
            {props.children}
        </NavigationTitleChromeProvider>
    </DestinationHeaderOptionsContext.Provider>;
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
            <HeaderActionsScope scopeKey={chromeShown ? null : renderActions === null && typeof enclosingScope === 'string' ? enclosingScope : props.scopeKey}>
                <PageHeaderActionsHost scopeKey={props.scopeKey} render={renderActions} />
                {props.children}
            </HeaderActionsScope>
        </NavigationTitleChromeProvider>
    </DestinationHeaderOptionsContext.Provider>;
}

/** Publish a native scene's identity without lending its params, router or chrome to the workspace. */
export function DestinationTitlePublication(props: Readonly<{ instance: Readonly<{ tabId: string; ref: DestinationRef }> | null; children: React.ReactNode }>): React.ReactNode {
    return <DestinationNavigationChrome scopeKey={`destination:${props.instance?.tabId ?? ''}`} phone={false} publicationOnly={props.instance}>
        {props.children}
    </DestinationNavigationChrome>;
}

/** A screen without a PageHeader supplies the same plain-text title at its existing title owner. */
export function useDestinationPageTitle(title: string | null | undefined): void {
    const setPageTitle = useNavigationTitleChromePublisher()?.setPageTitle;
    React.useEffect(() => {
        if (!setPageTitle || title === undefined) return;
        setPageTitle(title?.trim() ? title : null);
        return () => setPageTitle(undefined);
    }, [setPageTitle, title]);
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
    const instance = useDestinationInstance();
    // A mounted body never moves between the Expo and workspace owners.
    // eslint-disable-next-line react-hooks/rules-of-hooks -- ownership is stable for this mounted body.
    return (instance ? instance.ref.params : useLocalSearchParams()) as T;
}

/** A hosted reader follows only its selected params; the Expo owner keeps its existing fallback. */
export function useDestinationParamsSelector<T>(selector: (params: Readonly<Record<string, string | string[] | undefined>>) => T,
    equal?: (left: T | null, right: T | null) => boolean): T {
    const hosted = useDestinationInstanceKey() !== null;
    const select = React.useCallback((instance: DestinationInstanceContextValue | null) => instance ? selector(instance.ref.params) : null, [selector]);
    const selected = useDestinationInstance(select, equal);
    if (hosted) return selected as T;
    // eslint-disable-next-line react-hooks/rules-of-hooks -- a mounted body keeps its route owner.
    return selector(useLocalSearchParams());
}

export function useDestinationGlobalParams<T extends Record<string, string | string[] | undefined>>(): T {
    const instance = useDestinationInstance();
    const focused = useWorkspaceFocusedRoute();
    // eslint-disable-next-line react-hooks/rules-of-hooks -- ownership is stable for this mounted body.
    const params = instance ? null : useGlobalSearchParams();
    if (instance) return instance.ref.params as T;
    if (focused) return focused.target.params as T;
    return params as T;
}

type DestinationRouteParams = Readonly<Record<string, string | string[] | undefined>>;
/**
 * A selected fact of the params `useDestinationGlobalParams` returns. A hosted body selects its own tab's
 * params; a shell reader selects the focused tab's, rendering only when its selection changes. `select`
 * must keep its identity (a module-level function).
 */
export function useDestinationGlobalParamsSelector<T>(select: (params: DestinationRouteParams) => T): T {
    const hosted = useDestinationInstanceKey() !== null;
    // eslint-disable-next-line react-hooks/rules-of-hooks -- ownership is stable for this mounted body.
    if (hosted) return useDestinationParamsSelector(select);
    // eslint-disable-next-line react-hooks/rules-of-hooks -- ownership is stable for this mounted body.
    const focused = useWorkspaceFocusedRouteSelector(React.useCallback((route: WorkspaceFocusedRoute | null) =>
        route ? select(route.target.params) : NO_FOCUSED_SELECTION, [select]));
    // Without a focused tab Expo's route is current (no workspace leads it); it moves only on Expo navigation.
    // eslint-disable-next-line react-hooks/rules-of-hooks -- ownership is stable for this mounted body.
    const params = useGlobalSearchParams();
    return focused === NO_FOCUSED_SELECTION ? select(params) : focused as T;
}
const NO_FOCUSED_SELECTION: unique symbol = Symbol('no focused route');

export function useDestinationPathname(): string {
    const instance = useDestinationInstance();
    const focused = useWorkspaceFocusedPathname();
    // eslint-disable-next-line react-hooks/rules-of-hooks -- ownership is stable for this mounted body.
    const pathname = instance || focused !== null ? null : usePathname();
    if (instance) return instance.pathname;
    // The shell column follows the same tab owner as its body. Expo mirrors that route after
    // navigation and must not retain a previous tab's selection in the meantime.
    if (focused !== null) return focused;
    return pathname!;
}

export { useDestinationFocus, useDestinationVisibility } from './destinationInstanceContext';

export function useDestinationPaneScopeId(resourceScopeId: string): string {
    return qualifyPaneScopeId(resourceScopeId, useDestinationInstanceKey());
}

/** Explicit section navigation is distinct from opening a page inside the selected section. */
export function useOpenAppSection(): (href: string, replace?: boolean) => void {
    const workspace = useWorkspaceRouterFacts();
    const router = useDestinationRouter();
    return React.useCallback((href, replace = false) => {
        if (!workspace?.openHref(href, { section: true, replace })) {
            if (replace) router.replace(href as never);
            else router.navigate(href as never);
        }
    }, [router, workspace]);
}

export function useDestinationRouter(): DestinationRouter {
    // A router binds the tab's navigation owner, not its focus or visibility.
    const instance = useDestinationInstanceIdentity();
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
            redirect: navigation.redirect ?? navigation.replace,
            pushRetainingCurrent: navigation.pushRetainingCurrent ?? unsupported,
            retainCurrent: navigation.retainCurrent ?? unsupported,
        };
    }, [instance.navigation]);
}

function useWorkspaceOrExpoRouter() {
    // Workspace publications include titles, history and focus. Those are
    // invocation-time facts, not a new navigation owner for every consumer.
    const workspace = useWorkspaceRouterFacts();
    const router = useRouter();
    return React.useMemo(() => {
        if (!workspace) return { ...router, redirect: router.replace, pushRetainingCurrent: router.push, retainCurrent: () => {} };
        const { active, openHref, navigationForTab, back, read } = workspace;
        const navigate: typeof router.push = (href, options) => {
            if (!openHref(resolveHref(href))) router.push(href, options);
        };
        const replace: typeof router.replace = (href, options) => {
            if (!openHref(resolveHref(href), { replace: true })) router.replace(href, options);
        };
        const pushRetainingCurrent: typeof router.push = (href, options) => {
            const workspace = read();
            if (!workspace.active) { router.push(href, options); return; }
            const group = workspace.state.groups[workspace.state.focusedGroupId];
            const navigation = navigationForTab(group.activeTabId);
            if (!navigation.pushRetainingCurrent) throw new Error('The workspace navigation owner did not supply draft retention');
            navigation.pushRetainingCurrent(href, options);
        };
        const retainCurrent = () => {
            const workspace = read();
            if (!workspace.active) return;
            const group = workspace.state.groups[workspace.state.focusedGroupId];
            const navigation = navigationForTab(group.activeTabId);
            if (!navigation.retainCurrent) throw new Error('The workspace navigation owner did not supply pane retention');
            navigation.retainCurrent();
        };
        return { ...router, push: navigate, navigate, replace, redirect: replace, pushRetainingCurrent, retainCurrent,
            back: active ? back : router.back,
            canGoBack: active ? () => read().canGoBack === true : router.canGoBack };
    }, [router, workspace]);
}

export function useDestinationFocusEffect(effect: React.EffectCallback): void {
    const focused = useDestinationFocus();
    React.useEffect(() => focused ? effect() : undefined, [effect, focused]);
}
