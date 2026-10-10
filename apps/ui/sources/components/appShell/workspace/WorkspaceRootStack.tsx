import * as React from 'react';
import { Platform } from 'react-native';
import { Stack as ExpoStack } from 'expo-router';
import { getPathFromState } from 'expo-router/build/fork/getPathFromState';
import { parseRouteSegments } from 'expo-router/build/getReactNavigationConfig';
import { WorkspaceRouteHostingContext } from './WorkspaceRouteHostingContext';

type ScreenProps = React.ComponentProps<typeof ExpoStack.Screen>;

function admitScreens(child: React.ReactNode, ownsHref: (href: string) => boolean): React.ReactNode {
    if (Array.isArray(child)) return child.map(item => admitScreens(item, ownsHref));
    if (!React.isValidElement<ScreenProps>(child) || child.type !== ExpoStack.Screen) return child;
    const options: ScreenProps['options'] = (args) => {
        const declared = typeof child.props.options === 'function' ? child.props.options(args) : child.props.options;
        if (!declared?.presentation || declared.presentation === 'card') return declared ?? {};
        // Use Expo's own path/query projection, including dynamic segments and repeated query
        // values. Admission must agree with the workspace resolver, not the focused route alone.
        const href = getPathFromState({ routes: [args.route] }, {
            screens: { [args.route.name]: parseRouteSegments(args.route.name) },
        });
        return ownsHref(href) ? { ...declared, presentation: 'card' } : declared;
    };
    return <ExpoStack.Screen {...child.props} options={options} key={child.key ?? child.props.name} />;
}

function RootStack(props: React.ComponentProps<typeof ExpoStack>) {
    const ownsHref = React.useContext(WorkspaceRouteHostingContext);
    const children = React.useMemo(() => Platform.OS === 'web' && ownsHref
        ? admitScreens(props.children, ownsHref) : props.children, [ownsHref, props.children]);
    return <ExpoStack {...props}>{children}</ExpoStack>;
}

/** The root navigator consumes workspace admission before Expo mounts route modals. */
export const WorkspaceRootStack = Object.assign(RootStack, { Screen: ExpoStack.Screen });
