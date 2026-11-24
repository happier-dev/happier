import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { readBuiltInLegacyConnectedServiceIdForQualifiedService, type ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { PluginProjectedAgentConnectedAccountPurposeV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import { resolveQualifiedConnectedAccountServiceKey } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { resolveProjectedConnectedAccountServiceKeys } from '@/sync/domains/connectedServices/qualifiedConnectedAccountServiceOptions';
import type { SessionUsageAccount } from '@/sync/domains/connectedServices/resolveSessionUsageAccount';

/** The resolved Session account's projection onto the released scalar quota transport. */
export type ConnectedServiceSessionQuotaProfileRef = Readonly<{
    serviceKey: string;
    legacyServiceId: ConnectedServiceId;
    profileId: string;
    groupId?: string;
}>;

/**
 * The supported Connected Account services for the current Session identity,
 * as canonical qualified keys. The exact Agent-owned account declarations from
 * the machine catalog projection are authoritative when available; released
 * bundled catalog facts translate through the provenance-named legacy ingress.
 * Unknown facts fail closed and are dropped.
 */
function resolveSupportedQualifiedServiceKeys(params: Readonly<{
    agentId: string;
    connectedAccounts?: readonly PluginProjectedAgentConnectedAccountPurposeV2[];
}>): readonly string[] {
    if (params.connectedAccounts && params.connectedAccounts.length > 0) {
        return resolveProjectedConnectedAccountServiceKeys(params.connectedAccounts);
    }
    if (!isBundledAgentId(params.agentId)) return [];
    const out: string[] = [];
    const core = getAgentCore(params.agentId);
    if (!core) return out;
    for (const serviceId of core.connectedServices?.supportedServiceIds ?? []) {
        const qualified = resolveQualifiedConnectedAccountServiceKey(serviceId);
        if (qualified && !out.includes(qualified)) out.push(qualified);
    }
    return out;
}

export function resolveConnectedServiceQuotaProfileRefForSession(params: Readonly<{
    usageAccount: SessionUsageAccount;
    agentId: string;
    connectedAccounts?: readonly PluginProjectedAgentConnectedAccountPurposeV2[];
}>): ConnectedServiceSessionQuotaProfileRef | null {
    if (params.usageAccount.status !== 'known') return null;
    const { account, groupId } = params.usageAccount;
    const serviceKey = buildQualifiedPluginContributionKey(account.service);
    if (!resolveSupportedQualifiedServiceKeys(params).includes(serviceKey)) return null;
    const legacyServiceId = readBuiltInLegacyConnectedServiceIdForQualifiedService(account.service);
    if (!legacyServiceId) return null;
    return {
        serviceKey,
        legacyServiceId,
        profileId: account.accountId,
        ...(groupId ? { groupId } : {}),
    };
}
