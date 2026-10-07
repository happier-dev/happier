import {
    parseQualifiedPluginContributionKey,
    type PluginContributionIdentityV1,
} from '@happier-dev/protocol/plugins/contribution-identity';

import { readSessionConnectedServiceBindings } from './readSessionConnectedServiceBindings';

/**
 * Which connected account a session signs in with, for its usage (lab `csvc` U3). Only the session's
 * own binding decides it: a binding that names its account is `known`; a pool binding without its
 * account, a Team resource, several connected bindings, or no readable binding is `unknown` (the
 * pool, when there is exactly one, is still a session fact); a session that signs in on its own is
 * `not_connected`. A pool's current member is never taken for the session's account: it may have
 * moved since the session signed in (`lanes/csvc-capabilities.md`).
 */
export type SessionUsageAccount =
    | Readonly<{
        status: 'known';
        source: 'session_binding';
        account: Readonly<{ service: PluginContributionIdentityV1; accountId: string }>;
        /** The pool the session signs in through, when it does. */
        groupId: string | null;
    }>
    | Readonly<{
        status: 'unknown';
        pool: Readonly<{ service: PluginContributionIdentityV1; groupId: string }> | null;
    }>
    | Readonly<{ status: 'not_connected' }>;

const UNKNOWN: SessionUsageAccount = Object.freeze({ status: 'unknown', pool: null });

export function resolveSessionUsageAccount(params: Readonly<{
    metadata: unknown;
    agentId: string;
}>): SessionUsageAccount {
    const bindings = readSessionConnectedServiceBindings(params);
    if (!bindings) return UNKNOWN;
    const entries = Object.entries(bindings.bindingsByServiceId);
    const signedIn = entries.filter(([, binding]) => binding.source !== 'native');
    if (signedIn.length === 0) return entries.length > 0 ? { status: 'not_connected' } : UNKNOWN;
    if (signedIn.length > 1) return UNKNOWN;

    const [serviceKey, binding] = signedIn[0]!;
    const service = parseQualifiedPluginContributionKey(serviceKey);
    if (!service || binding.source !== 'connected') return UNKNOWN;
    const groupId = binding.selection === 'group' ? binding.groupId : null;
    if (!binding.profileId) return groupId ? { status: 'unknown', pool: { service, groupId } } : UNKNOWN;
    return {
        status: 'known',
        source: 'session_binding',
        account: { service, accountId: binding.profileId },
        groupId,
    };
}
