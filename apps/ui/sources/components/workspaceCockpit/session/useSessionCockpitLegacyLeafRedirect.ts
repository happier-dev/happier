import * as React from 'react';
import type { Href } from 'expo-router';

import { useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';

import { resolveSessionCockpitLegacyLeafRedirect } from './sessionCockpitState';

/**
 * A phone cockpit shows every tab on the Session route (owner 2026-11-17). An old cockpit tab link that lands on
 * `/session/<id>/files|git|terminal` (or a `/details` link that names no page) is replaced by its surface there, so
 * the leaf never builds a second cockpit beside the retained one. Returns whether this leaf is redirecting; the
 * leaf then renders nothing. Classic phones and wider windows keep their leaf screens.
 */
export function useSessionCockpitLegacyLeafRedirect(input: Readonly<{
    leaf: 'files' | 'git' | 'terminal' | 'details';
    sessionId: string;
    params: Readonly<Record<string, unknown>>;
    cockpitEnabled: boolean;
    terminalTabAvailable: boolean;
}>): boolean {
    const router = useDestinationRouter();
    // Whether a Details link names a page is decided by the link that opened it: a Details page whose last tab
    // closes later stays that page's destination, it does not turn into the Session's Tabs surface.
    const [openedOnDetailsPage] = React.useState(() => input.leaf === 'details' && typeof input.params.details === 'string'
        && input.params.details.trim().length > 0);
    const href = input.cockpitEnabled && input.sessionId && !openedOnDetailsPage
        ? resolveSessionCockpitLegacyLeafRedirect(input)
        : null;
    React.useEffect(() => {
        if (href) router.replace(href as Href);
    }, [href, router]);
    return href !== null;
}
