import type {
    ConnectedServiceRegistryEntry,
} from './connectedServiceRegistry';
import {
    buildConnectedAccountSettingsRoute,
    resolveConnectedAccountSettingsRoute,
} from './connectedAccountSettingsRoute';

export type ConnectedServiceProfileActionRoute =
    | ReturnType<typeof buildConnectedAccountSettingsRoute>
    | Readonly<{
        pathname: '/(app)/settings/connected-services';
    }>;

/**
 * Compatibility owner for recovery surfaces that still receive a released
 * built-in scalar service id. Every successful decision is translated through
 * the generated built-in mapping and returns the exact qualified account route;
 * profile kind and profile id never select a mutation implementation.
 */
export function resolveConnectedServiceProfileActionRoute(
    params: Readonly<{ serviceId?: unknown; profileId?: unknown }>,
    entries: readonly ConnectedServiceRegistryEntry[],
): ConnectedServiceProfileActionRoute {
    const resolved = resolveConnectedAccountSettingsRoute(
        { serviceId: params.serviceId, profileId: params.profileId },
        entries,
    );
    return resolved
        ? buildConnectedAccountSettingsRoute(resolved.service, resolved.focus)
        : { pathname: '/(app)/settings/connected-services' };
}
