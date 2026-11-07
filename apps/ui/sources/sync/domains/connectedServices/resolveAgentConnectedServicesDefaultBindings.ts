import {
    projectAgentConnectedAccountPurposeDefaultsToSessionBindings,
    resolveAgentConnectedAccountPurposeDefaults,
} from '@happier-dev/protocol/account/settings/connected-services';
import { ConnectedServiceBindingSelectionV2Schema, type ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { resolveManagedSessionDefaults, type ManagedConnectedServiceDefaultV1, type ManagedSessionDefaultsContext } from '@happier-dev/protocol/teams';
import type { ConnectedServicesServiceBinding } from './connectedServicesAgentOptionStateBindings';

/** Resolve the selected Agent's Account defaults as an explicit spawn choice, including native. */
export function resolveAgentConnectedServicesDefaultBindings(
    input: Parameters<typeof resolveAgentConnectedAccountPurposeDefaults>[0] & Readonly<{
        managedSessionDefaults?: ManagedSessionDefaultsContext;
        agentTargetKey?: string;
        /** Each present binding is authored intent, including native. */
        explicitBindings?: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
    }>,
): ConnectedServiceBindingsV2 {
    const accountDefaults = resolveAgentConnectedAccountPurposeDefaults(input);
    if (!input.managedSessionDefaults || !input.agentTargetKey) {
        return projectAgentConnectedAccountPurposeDefaultsToSessionBindings(accountDefaults)
            ?? { v: 2, bindingsByServiceId: {} };
    }
    const explicitChoices = accountDefaults.flatMap((entry): ManagedConnectedServiceDefaultV1[] => {
        const binding = input.explicitBindings?.[buildQualifiedPluginContributionKey(entry.service)];
        if (binding === undefined) return entry.target || entry.teamResource ? [entry] : [];
        const target = binding?.source === 'connected'
            ? binding.selection === 'group' && binding.groupId
                ? { kind: 'group' as const, service: entry.service, groupId: binding.groupId }
                : binding.profileId
                    ? { kind: 'account' as const, account: { service: entry.service, accountId: binding.profileId } }
                    : null
            : null;
        // Session Team bindings intentionally omit teamId. A null marker records
        // authored intent; only a shared decision selecting that explicit source
        // restores the original Session selection below, without inventing a Team.
        return [{ purpose: entry.purpose, service: entry.service, target, teamResource: null }];
    });
    const decisions = resolveManagedSessionDefaults({
        ...input.managedSessionDefaults,
        agentTargetKey: input.agentTargetKey,
        explicitChoices: { connectedServicesByAgentTargetKey: { [input.agentTargetKey]: explicitChoices } },
    }).connectedServices;
    const decisionsByPurpose = new Map(decisions.flatMap(decision => decision.value
        ? [[qualifiedPurposeKey(decision.value.purpose), decision] as const] : []));
    const bindingsByServiceId: ConnectedServiceBindingsV2['bindingsByServiceId'] = {};
    // Keep the existing Session projection rule: the first declared purpose
    // with a choice decides each service. Explicit native is also a choice.
    for (const entry of accountDefaults) {
        const serviceId = buildQualifiedPluginContributionKey(entry.service);
        if (serviceId in bindingsByServiceId) continue;
        const decision = decisionsByPurpose.get(qualifiedPurposeKey(entry.purpose));
        if (!decision?.value) continue;
        const explicit = decision.source === 'explicit' ? input.explicitBindings?.[serviceId] : undefined;
        const selected = explicit && explicit.source !== 'connected'
            ? explicit
            : projectAgentConnectedAccountPurposeDefaultsToSessionBindings([decision.value])?.bindingsByServiceId[serviceId];
        bindingsByServiceId[serviceId] = selected ?? { source: 'native' };
    }
    // Retained undeclared service choices have no declared managed purpose.
    // Keep them through unrelated edits, just as the Session payload owner does.
    for (const [serviceId, binding] of Object.entries(input.explicitBindings ?? {})) {
        if (!(serviceId in bindingsByServiceId) && binding) {
            const parsed = ConnectedServiceBindingSelectionV2Schema.safeParse(binding);
            if (parsed.success) bindingsByServiceId[serviceId] = parsed.data;
        }
    }
    return { v: 2, bindingsByServiceId };
}
