import * as React from 'react';

import { RouteModalPortalScope } from '@/components/navigation/RouteModalPortalScope';

/** Picker chrome only; rootStackRouteOptions owns presentation before mount. */
export function createNewSessionContainedModalScreenOptions(params: Readonly<{
    title: string;
    headerBackTitle: string;
    headerShown?: boolean;
}>) {
    return {
        headerShown: params.headerShown ?? true,
        title: params.title,
        headerTitle: params.title,
        headerBackTitle: params.headerBackTitle,
    } as const;
}

export function useNewSessionContainedModalScreenOptions(params: Readonly<{
    title: string;
    headerBackTitle: string;
    headerShown?: boolean;
}>) {
    return React.useMemo(() => createNewSessionContainedModalScreenOptions({
        ...params,
    }), [params.headerBackTitle, params.headerShown, params.title]);
}

/**
 * Actual `/new` routes use the canonical route portal owner. An embedded
 * composer is not another route: it inherits its page's host so withdrawing
 * the composer cannot also destroy unrelated page dialogs.
 */
export function NewSessionScreenPortalScope(props: Readonly<{
    presentation?: 'screen' | 'embedded';
    children: React.ReactNode;
}>) {
    return props.presentation === 'embedded'
        ? <>{props.children}</>
        : <RouteModalPortalScope>{props.children}</RouteModalPortalScope>;
}
