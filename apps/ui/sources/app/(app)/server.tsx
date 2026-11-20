import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { resolvePostAuthLanding } from '@/components/onboarding/state/resolvePostAuthLanding';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useWorkspaceRouterFacts } from '@/components/appShell/workspace/WorkspaceNavigationContext';

import { HomeRecoveryAuthenticationFlow } from '@/components/account/auth/HomeRecoveryAuthenticationFlow';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { HOMES_GROUP_NEW_ROUTE } from '@/components/settings/server/collection/homeCollectionModel';
import { openAddHome } from '@/components/homes/add/openAddHome';
import { parseServerSettingsRouteParams } from '@/components/settings/server/navigation/serverSettingsRouteParams';

type RouteParams = Record<string, string | string[]>;

/**
 * Non-connection legacy entries open the new-group draft or the Homes collection.
 * Address links delegate to the Home connection entry owner below.
 */
function resolveForward(params: RouteParams): Readonly<{ pathname: string; params?: Record<string, string> }> {
    const route = parseServerSettingsRouteParams(params);
    if (route.groupEditor) {
        return { pathname: HOMES_GROUP_NEW_ROUTE, params: { groupServerIds: JSON.stringify(route.initialGroupServerIds) } };
    }
    return { pathname: SETTINGS_ROUTES.servers };
}

/**
 * `/server` retains legacy address/group/configuration links. Home recovery (`recoveryProfile`)
 * stays here as its own full-screen flow; adding a Home uses the shared shell decision.
 */
export default function ServerConfigRoute() {
    const router = useRouter();
    const workspace = useWorkspaceRouterFacts();
    const params = useLocalSearchParams<RouteParams>();
    const recovery = React.useMemo(() => parseServerSettingsRouteParams(params).recovery, [params]);
    const handledRef = React.useRef(false);
    React.useEffect(() => {
        if (recovery || handledRef.current) return;
        handledRef.current = true;
        const route = parseServerSettingsRouteParams(params);
        if (route.url) {
            openAddHome(router, { replace: true, address: route.url, auto: route.auto, source: route.source ?? undefined });
            return;
        }
        router.replace(resolveForward(params) as never);
    }, [params, recovery, router]);

    if (!recovery) return null;
    return (
        <HomeRecoveryAuthenticationFlow
            profileRef={recovery.profileRef}
            returnTo={recovery.returnTo}
            onAuthenticated={() => resolvePostAuthLanding({ returnTo: recovery.returnTo, replace: href => {
                if (typeof href === 'string' && href !== '/' && workspace?.read().openHref(href, { replace: true, admittedEntry: true })) return;
                router.replace(href);
            } })}
            onBack={() => router.replace(recovery.returnTo as never)}
        />
    );
}
