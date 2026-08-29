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
 * Owner for recovery surfaces that receive a service id in either persisted
 * shape: a canonical qualified Connected Account service key resolves through
 * the exact qualified account owner, and a released built-in scalar service id
 * is translated through the generated built-in mapping. Every successful
 * decision returns the exact qualified account route; profile kind and profile
 * id never select a mutation implementation.
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
