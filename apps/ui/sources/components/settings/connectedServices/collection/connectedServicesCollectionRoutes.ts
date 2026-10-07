import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { resolveSettingsNestedRouteName } from '@/components/settings/navigation/settingsRouteRegistry';

export const CONNECTED_SERVICES_COLLECTION_ROUTE = '/settings/connected-services';
export const CONNECTED_SERVICES_AGENT_SIGN_IN_ROUTE = '/settings/connected-services/sign-in';
const ACCOUNT_ROUTE = `${CONNECTED_SERVICES_COLLECTION_ROUTE}/account`;

/** What the collection's detail shows: the index, a service, an account, a pool, or how agents sign in. */
export type ConnectedServicesSelection =
    | Readonly<{ kind: 'index' }>
    | Readonly<{ kind: 'service'; serviceKey: string }>
    | Readonly<{ kind: 'account'; serviceKey: string; accountId: string }>
    | Readonly<{ kind: 'pool'; serviceKey: string; groupId: string }>
    | Readonly<{ kind: 'agentSignIn' }>
    | Readonly<{ kind: 'other' }>;

type Params = Readonly<Record<string, string | string[] | undefined>>;

function readParam(params: Params, name: string): string | null {
    const raw = params[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}

/** The nested stack screen at `pathname` (registry-owned), so the phone header follows it. */
export function resolveConnectedServicesChildRoute(pathname: string): string {
    return resolveSettingsNestedRouteName('connected-services', pathname) ?? 'index';
}

/** The rail's selection, from the route: the account route's focus params name the entity. */
export function resolveConnectedServicesSelection(pathname: string, params: Params): ConnectedServicesSelection {
    const normalized = pathname.replace(/\/+$/, '');
    if (normalized === CONNECTED_SERVICES_COLLECTION_ROUTE) return { kind: 'index' };
    if (normalized === CONNECTED_SERVICES_AGENT_SIGN_IN_ROUTE) return { kind: 'agentSignIn' };
    if (normalized !== ACCOUNT_ROUTE) return { kind: 'other' };
    const pluginId = readParam(params, 'pluginId');
    const localId = readParam(params, 'localId');
    if (!pluginId || !localId) return { kind: 'other' };
    const serviceKey = buildQualifiedPluginContributionKey({ pluginId, localId });
    const accountId = readParam(params, 'accountId');
    if (accountId) return { kind: 'account', serviceKey, accountId };
    const groupId = readParam(params, 'groupId');
    if (groupId) return { kind: 'pool', serviceKey, groupId };
    return { kind: 'service', serviceKey };
}
