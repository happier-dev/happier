import * as React from 'react';
import * as ExpoRouter from 'expo-router';
import type { LinkProps, RedirectProps } from 'expo-router';
import { WorkspaceRouteOutlet } from './WorkspaceRouteOutlet';
import { NavigatorSafeAreaBleed, ScreenSafeAreaFrame } from '@/components/navigation/safeArea/HorizontalSafeArea';
import { composeAppStackScreenLayout } from '@/components/navigation/appStackScreenLayout';
import { DestinationBodyLoading } from './DestinationBodyLoading';

import {
    useDestinationFocus,
    useDestinationFocusEffect,
    useDestinationGlobalParams,
    useDestinationInstanceKey,
    useDestinationParams,
    useDestinationPathname,
    useDestinationRouter,
    useDestinationScreenOptions,
} from './DestinationInstanceHost';
export { useDestinationRouteNavigation as useNavigation } from './destinationInstanceContext';
export { useOpenAppSection } from './DestinationInstanceHost';

export type { Href } from 'expo-router';
export { useDestinationParams as useLocalSearchParams, useDestinationGlobalParams as useGlobalSearchParams,
    useDestinationPathname as usePathname, useDestinationRouter as useRouter,
    useDestinationFocus as useIsFocused, useDestinationFocusEffect as useFocusEffect };

/** A leaf's options go to its current navigation owner; named Screens are layout declarations. */
function Screen(props: React.ComponentProps<typeof ExpoRouter.Stack.Screen>) {
    const hosted = useDestinationInstanceKey() !== null;
    useDestinationScreenOptions(!props.name && typeof props.options !== 'function' ? props.options : undefined);
    return hosted ? null : <ExpoRouter.Stack.Screen {...props} />;
}

/** Expo parses declaration types before rendering them, so translate only the layout's Screens. */
function mapStackScreens(child: React.ReactNode): React.ReactNode {
    if (Array.isArray(child)) return child.map(mapStackScreens);
    if (React.isValidElement<React.ComponentProps<typeof ExpoRouter.Stack.Screen>>(child) && child.type === Screen) {
        return <ExpoRouter.Stack.Screen {...child.props} key={child.key ?? undefined} />;
    }
    return child;
}

function StackRoot(props: React.ComponentProps<typeof ExpoRouter.Stack>) {
    const hosted = useDestinationInstanceKey() !== null;
    const outlet = React.useContext(WorkspaceRouteOutlet);
    const screenLayout = React.useMemo(() => composeAppStackScreenLayout(props.screenLayout), [props.screenLayout]);
    return <NavigatorSafeAreaBleed>
        {hosted
            ? <ScreenSafeAreaFrame presentation={undefined}><HostedOutlet outlet={outlet} /></ScreenSafeAreaFrame>
            : <ExpoRouter.Stack {...props} screenLayout={screenLayout}>{mapStackScreens(props.children)}</ExpoRouter.Stack>}
    </NavigatorSafeAreaBleed>;
}

export const Stack = Object.assign(StackRoot, { Screen });

/**
 * A hosted layout's leaf: while its chunk loads (a route's first visit), only the leaf waits. Without this
 * boundary the destination's own Suspense took the whole layout, so a collection's rail blanked and remounted.
 */
function HostedOutlet(props: Readonly<{ outlet: React.ReactNode }>) {
    return <React.Suspense fallback={<DestinationBodyLoading />}>{props.outlet}</React.Suspense>;
}

export function Slot(props: React.ComponentProps<typeof ExpoRouter.Slot>) {
    const hosted = useDestinationInstanceKey() !== null;
    const outlet = React.useContext(WorkspaceRouteOutlet);
    return hosted ? <HostedOutlet outlet={outlet} /> : <ExpoRouter.Slot {...props} />;
}

export function Redirect(props: RedirectProps) {
    const hosted = useDestinationInstanceKey() !== null;
    const redirect = useDestinationRouter().redirect;
    React.useEffect(() => { if (hosted) redirect(props.href); },
        [hosted, props.href, redirect] satisfies readonly [boolean, RedirectProps['href'], typeof redirect]);
    return hosted ? null : <ExpoRouter.Redirect {...props} />;
}

export function Link(props: LinkProps) {
    const hosted = useDestinationInstanceKey() !== null;
    const router = useDestinationRouter();
    return <ExpoRouter.Link {...props} onPress={(event) => {
        props.onPress?.(event);
        if (!hosted || event.defaultPrevented) return;
        // Preserve the browser's modified-click and explicit new-window behavior.
        const mouse = event as Readonly<{ button?: number; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }>;
        if ((mouse.button !== undefined && mouse.button !== 0) || mouse.metaKey || mouse.ctrlKey || mouse.altKey || mouse.shiftKey
            || (props.target && props.target !== '_self')) return;
        event.preventDefault();
        if (props.replace) router.replace(props.href);
        else router.push(props.href);
    }} />;
}
