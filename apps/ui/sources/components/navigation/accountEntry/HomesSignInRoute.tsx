import * as React from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { useWindowDimensions } from 'react-native';

import type { AccountDirectoryAuthTransport } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import { useAuth } from '@/auth/context/AuthContext';
import { shouldUseWizardFullscreenPresentation } from '@/components/onboarding/ui/wizardPresentation';
import { BaseModal } from '@/modal/components/BaseModal';
import { getActiveServerHomeCarrier, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { t } from '@/text';
import { admitInternalRouteHref } from '@/utils/path/routeUtils';

import { AuthenticatedAccountEntryRouteSurface } from './AuthenticatedAccountEntryRouteSurface';
import { parseAuthenticatedAccountEntryRoute, type AuthenticatedAccountEntryRequest } from './authenticatedAccountEntryRoute';

/**
 * The transport that reaches the account service through the Home this device uses, only when the
 * requested service is exactly that Home (same address and stable identity); otherwise the flow
 * reaches the service directly.
 */
function resolveActiveHomeTransport(request: AuthenticatedAccountEntryRequest): AccountDirectoryAuthTransport | undefined {
    const active = getActiveServerSnapshot();
    const profile = getServerProfileById(active.serverId);
    const activeIdentity = profile?.serverIdentityId?.trim() ?? '';
    const activeEndpoint = createServerUrlComparableKey(profile?.canonicalServerUrl ?? profile?.serverUrl ?? active.serverUrl);
    const requestedEndpoint = createServerUrlComparableKey(request.service.endpointUrl);
    if (activeIdentity !== request.service.serverIdentityId || activeEndpoint !== requestedEndpoint) return undefined;
    const homeCarrier = getActiveServerHomeCarrier();
    if (homeCarrier) return { homeCarrier };
    const runtimeOrigin = active.runtimeOrigin?.trim() ?? '';
    return runtimeOrigin ? { runtimeOrigin } : undefined;
}

/**
 * `/homes/sign-in`: sign in with an account service to find your Homes, link this Home, or refresh
 * the account (`useAccountEntryFlow`). The account service's sign-in returns here, possibly before
 * this device is signed in to any Home, so an OAuth return stays mounted until it settles. A request
 * that does not parse (unknown or secret-bearing params) goes Home.
 */
export function HomesSignInRoute() {
    const auth = useAuth();
    const { width: windowWidth } = useWindowDimensions();
    const params = useLocalSearchParams() as Readonly<Record<string, string | string[] | undefined>>;
    const [hydrationAttempted, setHydrationAttempted] = React.useState(false);
    const request = React.useMemo(
        () => parseAuthenticatedAccountEntryRoute(params),
        [
            params.accountIntent,
            params.accountServiceEndpoint,
            params.accountServiceIdentity,
            params.accountServiceReturn,
            params.accountEntryReturnTo,
        ],
    );
    const callbackReturn = request !== null && params.accountServiceReturn === '1';
    const transport = React.useMemo(() => (request ? resolveActiveHomeTransport(request) : undefined), [request]);

    React.useEffect(() => {
        if (auth.isAuthenticated) {
            setHydrationAttempted(true);
            return;
        }
        if (hydrationAttempted) return;
        let canceled = false;
        Promise.resolve(auth.refreshFromActiveServer?.())
            .catch(() => {})
            .finally(() => {
                if (!canceled) setHydrationAttempted(true);
            });
        return () => {
            canceled = true;
        };
    }, [auth.isAuthenticated, auth.refreshFromActiveServer, hydrationAttempted]);

    React.useEffect(() => {
        if (!request) {
            router.replace('/');
            return;
        }
        if (!auth.isAuthenticated && hydrationAttempted && !callbackReturn) router.replace('/');
    }, [auth.isAuthenticated, callbackReturn, hydrationAttempted, request]);

    if (!request || (!auth.isAuthenticated && !callbackReturn)) return null;

    return (
        <BaseModal
            visible={true}
            showBackdrop={true}
            accessibilityLabel={t('settingsAccount.accountServiceHomes')}
            webPlacement={shouldUseWizardFullscreenPresentation(windowWidth) ? 'top' : undefined}
            onClose={() => router.replace('/')}
        >
            <AuthenticatedAccountEntryRouteSurface
                request={request}
                routeParams={params}
                transport={transport}
                onExit={(returnTo) => router.replace(admitInternalRouteHref(returnTo))}
            />
        </BaseModal>
    );
}

export default HomesSignInRoute;
