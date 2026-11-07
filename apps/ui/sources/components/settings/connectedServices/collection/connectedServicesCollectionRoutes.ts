import { buildQualifiedPluginContributionKey, parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { resolveSettingsNestedRouteName } from '@/components/settings/navigation/settingsRouteMatching';
import type { QualifiedConnectedAccountPurposeBindingGroupTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';

export const CONNECTED_SERVICES_COLLECTION_ROUTE = '/settings/connected-services';
export const CONNECTED_SERVICES_AGENT_SIGN_IN_ROUTE = '/settings/connected-services/sign-in';
export const CONNECTED_SERVICES_GATEWAY_ROUTE = '/settings/connected-services/gateway';
/** Saved Secrets, folded into Credentials (owner 10-30): one page in the collection, a secret selected by `secret`. */
export const CONNECTED_SERVICES_SECRETS_ROUTE = '/settings/connected-services/secrets';

/** A Saved Secret beside the rail (`ref`), or the new-secret draft (`add`). */
export function buildCredentialsSecretRoute(input: Readonly<{ ref: string }> | Readonly<{ add: true }>): string {
    const query = new URLSearchParams('ref' in input ? { secret: input.ref } : { add: '1' });
    return `/(app)${CONNECTED_SERVICES_SECRETS_ROUTE}?${query}`;
}
const ACCOUNT_ROUTE = `${CONNECTED_SERVICES_COLLECTION_ROUTE}/account`;

/** Both gateway entries stay in this collection; only explicit Create persists a connection. */
export function buildConnectedServicesGatewayRoute(input:
    | Readonly<{ connectionId: string }>
    | Readonly<{ contributionKey: string; slot?: Readonly<{ purpose: string; target: QualifiedConnectedAccountPurposeBindingGroupTargetV1 }> }>,
): string {
    const query = new URLSearchParams();
    if ('connectionId' in input) query.set('connectionId', input.connectionId);
    else {
        query.set('contributionKey', input.contributionKey);
        if (input.slot) {
            query.set('poolService', buildQualifiedPluginContributionKey(input.slot.target.service));
            query.set('poolId', input.slot.target.groupId);
            query.set('purpose', input.slot.purpose);
        }
    }
    return `/(app)${CONNECTED_SERVICES_GATEWAY_ROUTE}?${query}`;
}

/** What the collection's detail shows: the index, a service, an account, a pool, or how agents sign in. */
export type ConnectedServicesSelection =
    | Readonly<{ kind: 'index' }>
    | Readonly<{ kind: 'service'; serviceKey: string }>
    | Readonly<{ kind: 'account'; serviceKey: string; accountId: string }>
    | Readonly<{ kind: 'pool'; serviceKey: string; groupId: string }>
    | Readonly<{ kind: 'accountDraft'; serviceKey: string }>
    | Readonly<{ kind: 'poolDraft'; serviceKey: string }>
    | Readonly<{ kind: 'gatewayDraft'; contributionKey: string }>
    | Readonly<{ kind: 'gateway'; connectionId: string }>
    | Readonly<{ kind: 'agentSignIn' }>
    | Readonly<{ kind: 'secret'; ref: string }>
    | Readonly<{ kind: 'secretDraft' }>
    | Readonly<{ kind: 'secrets' }>
    | Readonly<{ kind: 'other' }>;

type Params = Readonly<Record<string, string | string[] | undefined>>;

function readParam(params: Params, name: string): string | null {
    const raw = params[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * What the index route shows. Beside the rail it is the designed overview (All services); where no rail
 * shows it is the collection list itself, as on every other column (lab `s2svc:listP`), and the overview
 * is one push away (`?view=all`). Set-up links and a just-settled account land on the overview, which
 * owns those flows.
 */
export function resolveConnectedServicesIndexRoot(
    indexView: 'pending' | 'land' | 'list',
    params: Params,
): 'pending' | 'list' | 'overview' {
    if (indexView === 'pending') return 'pending';
    if (indexView === 'land') return 'overview';
    const overview = readParam(params, 'view') === 'all'
        || readParam(params, 'connect') !== null
        || readParam(params, 'connectedService') !== null
        || readParam(params, 'connectedAccount') !== null;
    return overview ? 'overview' : 'list';
}

/** The overview of every service, pushed from the phone's collection list. */
export const CONNECTED_SERVICES_OVERVIEW_ROUTE = `${CONNECTED_SERVICES_COLLECTION_ROUTE}?view=all`;

/** The nested stack screen at `pathname` (registry-owned), so the phone header follows it. */
export function resolveConnectedServicesChildRoute(pathname: string): string {
    return resolveSettingsNestedRouteName('connected-services', pathname) ?? 'index';
}

/** The rail's selection, from the route: the account route's focus params name the entity. */
export function resolveConnectedServicesSelection(pathname: string, params: Params): ConnectedServicesSelection {
    const normalized = pathname.replace(/\/+$/, '');
    if (normalized === `${CONNECTED_SERVICES_COLLECTION_ROUTE}/connect`
        || normalized === CONNECTED_SERVICES_COLLECTION_ROUTE && readParam(params, 'connect') === '1') {
        const service = parseQualifiedPluginContributionKey(readParam(params, 'service'));
        if (service) {
            const serviceKey = buildQualifiedPluginContributionKey(service);
            const accountId = readParam(params, 'accountId');
            return accountId ? { kind: 'account', serviceKey, accountId } : { kind: 'accountDraft', serviceKey };
        }
    }
    if (normalized === CONNECTED_SERVICES_COLLECTION_ROUTE) return { kind: 'index' };
    if (normalized === CONNECTED_SERVICES_AGENT_SIGN_IN_ROUTE) return { kind: 'agentSignIn' };
    if (normalized === CONNECTED_SERVICES_SECRETS_ROUTE) {
        const ref = readParam(params, 'secret');
        if (ref) return { kind: 'secret', ref };
        return readParam(params, 'add') === '1' ? { kind: 'secretDraft' } : { kind: 'secrets' };
    }
    if (normalized === CONNECTED_SERVICES_GATEWAY_ROUTE) {
        const connectionId = readParam(params, 'connectionId');
        if (connectionId) return { kind: 'gateway', connectionId };
        const contribution = parseQualifiedPluginContributionKey(readParam(params, 'contributionKey'));
        return contribution ? { kind: 'gatewayDraft', contributionKey: buildQualifiedPluginContributionKey(contribution) } : { kind: 'other' };
    }
    if (normalized !== ACCOUNT_ROUTE) return { kind: 'other' };
    const pluginId = readParam(params, 'pluginId');
    const localId = readParam(params, 'localId');
    if (!pluginId || !localId) return { kind: 'other' };
    const serviceKey = buildQualifiedPluginContributionKey({ pluginId, localId });
    const accountId = readParam(params, 'accountId');
    if (accountId) return { kind: 'account', serviceKey, accountId };
    const groupId = readParam(params, 'groupId');
    if (groupId) return { kind: 'pool', serviceKey, groupId };
    if (readParam(params, 'newPool') === '1') return { kind: 'poolDraft', serviceKey };
    if (readParam(params, 'add') === '1') return { kind: 'accountDraft', serviceKey };
    return { kind: 'service', serviceKey };
}
