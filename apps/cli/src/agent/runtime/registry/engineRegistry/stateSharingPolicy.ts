import {
    resolveConnectedServicesProviderStateSharingPolicyV1,
    type ConnectedServicesProviderStateSharingPolicyV1,
} from '@happier-dev/protocol';

import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

/**
 * Resolves the account's provider state-sharing policy for one Agent so a
 * native Agent launch carries it on the open request.
 *
 * Connected-service home materialization already reads this exact policy
 * before applying the Agent's `ConnectedServiceStateSharingDescriptor`. An
 * Agent that materializes its own launch-time home — Claude's pinned root for
 * a credential-less Provider binding is the live case — never reaches that
 * materializer, so without this the user's explicit `isolated` choice was
 * silently ignored on that path. The settings resolver stays the single
 * decision-maker; this only carries its answer to the second launch shape.
 */
export function resolveNativeAgentSessionStateSharingPolicy(
    agentId: string,
): ConnectedServicesProviderStateSharingPolicyV1 {
    const settings = getActiveAccountSettingsSnapshot()?.settings as
        | Readonly<{ connectedServicesProviderStateSharingSettingsV1?: unknown }>
        | null
        | undefined;
    return Object.freeze(resolveConnectedServicesProviderStateSharingPolicyV1(
        settings?.connectedServicesProviderStateSharingSettingsV1,
        agentId,
    ));
}
