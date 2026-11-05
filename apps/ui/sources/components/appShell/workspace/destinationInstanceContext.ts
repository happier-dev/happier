import * as React from 'react';
import * as ExpoRouter from 'expo-router';
import type { useRouter } from 'expo-router';
import { NavigationContext } from '@react-navigation/native';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { shallow } from 'zustand/shallow';

import type { DestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';

export type DestinationNavigation = Pick<ReturnType<typeof useRouter>, 'push' | 'replace' | 'back'>
    & Partial<ReturnType<typeof useRouter>> & {
        /** Automatic route selection, distinct from an explicit replacement chosen by the user. */
        redirect?: ReturnType<typeof useRouter>['replace'];
        /** Open another destination without retiring the caller's mounted draft. */
        pushRetainingCurrent?: ReturnType<typeof useRouter>['push'];
        /** Retain this pane before acquiring work that outlives its preview. */
        retainCurrent?: () => void;
    };

export type DestinationInstanceContextValue = Readonly<{
    tabId: string;
    ref: DestinationRef;
    pathname: string;
    focused: boolean;
    visible: boolean;
    navigation?: DestinationNavigation;
}>;

/**
 * What a destination's content reads for focus, visibility, identity and navigation. It keeps its
 * identity when only the destination's route (params, pathname) moves, so a consumer of these
 * facts does not render for a params-only update.
 */
type DestinationInstanceFacts = Readonly<Pick<DestinationInstanceContextValue, 'tabId' | 'focused' | 'visible' | 'navigation'>>;

// Identity consumers share the host's contexts without loading destination composition.
const DestinationInstanceFactsContext = React.createContext<DestinationInstanceFacts | null>(null);
type DestinationInstanceIdentity = Readonly<Pick<DestinationInstanceContextValue, 'tabId' | 'navigation'>>;
/** Tab identity and its navigation owner alone: focus and visibility changes do not reach these readers. */
const DestinationInstanceIdentityContext = React.createContext<DestinationInstanceIdentity | null>(null);
type DestinationRouteSubscription = Readonly<{
    getSnapshot: () => DestinationInstanceContextValue | null;
    subscribe: (listener: () => void) => () => void;
}>;
const DestinationRouteContext = React.createContext<DestinationRouteSubscription | null>(null);

/** The one publisher of a destination instance: facts for identity readers, the full value for route readers. */
export const DestinationInstanceContext = {
    Provider(props: Readonly<{ value: DestinationInstanceContextValue | null; children?: React.ReactNode }>): React.ReactElement {
        const { value } = props;
        const current = React.useRef(value);
        current.current = value;
        const [route] = React.useState(() => {
            const listeners = new Set<() => void>();
            return {
                getSnapshot: () => current.current,
                subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
                notify: () => { for (const listener of listeners) listener(); },
            };
        });
        React.useLayoutEffect(route.notify, [route, value]);
        const tabId = value?.tabId;
        const focused = value?.focused;
        const visible = value?.visible;
        const navigation = value?.navigation;
        const facts = React.useMemo<DestinationInstanceFacts | null>(() => tabId === undefined ? null
            : { tabId, focused: focused === true, visible: visible === true, ...(navigation ? { navigation } : {}) },
            [focused, navigation, tabId, visible]);
        const identity = React.useMemo<DestinationInstanceIdentity | null>(() => tabId === undefined ? null
            : { tabId, ...(navigation ? { navigation } : {}) }, [navigation, tabId]);
        return React.createElement(DestinationInstanceIdentityContext.Provider, { value: identity },
            React.createElement(DestinationInstanceFactsContext.Provider, { value: facts },
                React.createElement(DestinationRouteContext.Provider, { value: route }, props.children)));
    },
};

const readDestinationInstance = (value: DestinationInstanceContextValue | null) => value;
const subscribeToNothing = () => () => {};

/** Select only the route facts this reader renders; commands may still read the full instance. */
export function useDestinationInstance<T>(selector: (value: DestinationInstanceContextValue | null) => T, equal?: (left: T, right: T) => boolean): T;
export function useDestinationInstance(): DestinationInstanceContextValue | null;
export function useDestinationInstance<T>(selector?: (value: DestinationInstanceContextValue | null) => T,
    equal?: (left: T, right: T) => boolean,
): T | DestinationInstanceContextValue | null {
    const route = React.useContext(DestinationRouteContext);
    const select = selector ?? readDestinationInstance;
    const getSnapshot = React.useMemo(() => {
        let previous: Readonly<{ value: T | DestinationInstanceContextValue | null }> | undefined;
        return () => {
            const next = select(route?.getSnapshot() ?? null);
            // The overload permits an equality function only alongside its T-producing selector.
            if (!previous || !(equal ? equal(previous.value as T, next as T) : shallow(previous.value, next))) previous = { value: next };
            return previous.value;
        };
    }, [equal, route, select]);
    return React.useSyncExternalStore(route?.subscribe ?? subscribeToNothing, getSnapshot, getSnapshot);
}

/** Focus, visibility, identity and navigation readers; params-only updates do not reach them. */
export function useDestinationInstanceFacts(): DestinationInstanceFacts | null {
    return React.useContext(DestinationInstanceFactsContext);
}
export const DestinationHeaderOptionsContext = React.createContext<((options: NativeStackNavigationOptions) => void) | null>(null);

/** The hosted tab and its navigation owner, without following focus or visibility. */
export function useDestinationInstanceIdentity(): DestinationInstanceIdentity | null {
    return React.useContext(DestinationInstanceIdentityContext);
}

export function useDestinationInstanceKey(): string | null {
    return useDestinationInstanceIdentity()?.tabId ?? null;
}

/** The retained host owns its chrome options; Back still belongs to the same tab owner. */
export function useDestinationNavigation() {
    const instance = useDestinationInstance();
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

/** Hosted destinations publish to retained chrome; native destinations keep their stack navigator. */
export function useDestinationRouteNavigation() {
    const hosted = useDestinationInstanceKey() !== null;
    const navigation = useDestinationNavigation();
    // eslint-disable-next-line react-hooks/rules-of-hooks -- ownership stays fixed for a mounted body.
    if (!hosted) return ExpoRouter.useNavigation();
    if (!navigation) throw new Error('A hosted destination requires navigation');
    return navigation;
}

/** Whether this mounted body is the focused one: its workspace pane's, or its Stack screen's. */
export function useDestinationFocus(): boolean {
    const instance = useDestinationInstanceFacts();
    // eslint-disable-next-line react-hooks/rules-of-hooks -- ownership is stable for this mounted body.
    return instance ? instance.focused : useOptionalScreenIsFocused();
}

/** Visibility belongs to the same retained destination context, without loading shell composition. */
export function useDestinationVisibility(): boolean {
    return useDestinationInstanceFacts()?.visible ?? true;
}
