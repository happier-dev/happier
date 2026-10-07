import * as React from 'react';
import * as ExpoRouter from 'expo-router';
import { WorkspaceRouteOutlet } from './WorkspaceRouteOutlet';

import {
    useDestinationFocus,
    useDestinationFocusEffect,
    useDestinationGlobalParams,
    useDestinationInstanceKey,
    useDestinationNavigation,
    useDestinationParams,
    useDestinationPathname,
    useDestinationRouter,
} from './DestinationInstanceHost';

export type { Href } from 'expo-router';
export { useDestinationParams as useLocalSearchParams, useDestinationGlobalParams as useGlobalSearchParams,
    useDestinationPathname as usePathname, useDestinationRouter as useRouter,
    useDestinationFocus as useIsFocused, useDestinationFocusEffect as useFocusEffect };

/** Route-level header declarations only apply when this body is rendered by Expo. */
function Screen(props: React.ComponentProps<typeof ExpoRouter.Stack.Screen>) {
    const hosted = useDestinationInstanceKey() !== null;
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
    return hosted ? <>{outlet}</> : <ExpoRouter.Stack {...props}>{mapStackScreens(props.children)}</ExpoRouter.Stack>;
}

export const Stack = Object.assign(StackRoot, { Screen });

export function Slot(props: React.ComponentProps<typeof ExpoRouter.Slot>) {
    const hosted = useDestinationInstanceKey() !== null;
    const outlet = React.useContext(WorkspaceRouteOutlet);
    return hosted ? <>{outlet}</> : <ExpoRouter.Slot {...props} />;
}

export function Redirect(props: React.ComponentProps<typeof ExpoRouter.Redirect>) {
    const hosted = useDestinationInstanceKey() !== null;
    const router = useDestinationRouter();
    React.useEffect(() => { if (hosted) router.replace(props.href); }, [hosted, props.href, router]);
    return hosted ? null : <ExpoRouter.Redirect {...props} />;
}

/** This adapter suppresses native-header writes while preserving the existing mobile screen. */
export function useNavigation() {
    const hosted = useDestinationInstanceKey() !== null;
    const navigation = useDestinationNavigation();
    // eslint-disable-next-line react-hooks/rules-of-hooks -- ownership stays fixed for a mounted body.
    if (!hosted) return ExpoRouter.useNavigation();
    if (!navigation) throw new Error('A hosted destination requires navigation');
    return navigation;
}

export function Link(props: React.ComponentProps<typeof ExpoRouter.Link>) {
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
