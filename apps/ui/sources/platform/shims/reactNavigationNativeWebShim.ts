import * as React from 'react';

// This file is used only on web via Metro's custom resolver.
// It polyfills `NavigationProvider`, which is referenced by `@react-navigation/elements`' `Screen`
// but is not exported by the pinned `@react-navigation/native` version in this repo.
//
// Importing via the deep module path avoids resolver recursion (Metro remaps only the package root).
import * as ReactNavigationNative from '@react-navigation/native/lib/module/index';

export * from '@react-navigation/native/lib/module/index';

export function NavigationProvider(props: Readonly<{
    navigation: unknown;
    route: unknown;
    children: React.ReactNode;
}>) {
    // `@react-navigation/native` contexts are typed for React Navigation internals. This web-only shim
    // is an interop boundary, so we pass through the runtime values without trying to model the types.
    return React.createElement(
        ReactNavigationNative.NavigationRouteContext.Provider,
        { value: props.route as any },
        React.createElement(
            ReactNavigationNative.NavigationHelpersContext.Provider,
            { value: props.navigation as any },
            React.createElement(
                ReactNavigationNative.NavigationContext.Provider,
                { value: props.navigation as any },
                props.children,
            ),
        ),
    );
}
