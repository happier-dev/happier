import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { isConnectedAccountSignedOut, parseDisplayableCredentialHealthStatus } from '@/sync/domains/connectedServices/parseDisplayableCredentialHealthStatus';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { isQualifiedConnectedAccountProfileUsableV4 } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import type { PluginProjectedAgentConnectedAccountPurposeV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { isConnectedServiceProfileStatusSelectable, type ConnectedServicesAccountGroupOption, type ConnectedServicesProfileOption } from '@happier-dev/agents';
import type { ConnectedAccountIdentityPresenter } from '@/sync/domains/connectedServices/maskAccountEmail';
import { formatConnectedAccountNameInline, presentConnectedAccountName } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';

import type { ConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import type { ConnectedAccountUiNegotiation } from '@/sync/domains/connectedServices/resolveConnectedAccountUiNegotiation';
import type { Profile } from '@/sync/domains/profiles/profile';
import {
    applyProjectedCredentialKindRestrictions,
    buildQualifiedConnectedAccountProfileOptionsByServiceId,
    resolveProjectedConnectedAccountServiceKeys,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountServiceOptions';

import type { MachineAgentConnectedService } from './machineAgentTypes';

/** Passive inventory projection; entries come from this Machine's current descriptor scope. */
export function projectMachineAgentConnectedServices(params: Readonly<{
    agents: readonly Readonly<{
        agentId: string;
        connectedAccounts?: readonly PluginProjectedAgentConnectedAccountPurposeV2[];
    }>[];
    profile: Pick<Profile, 'connectedServicesV2' | 'connectedAccountsV4'>;
    accountTransport: ConnectedAccountUiNegotiation;
    entries: readonly ConnectedServiceRegistryEntry[];
    now: number;
    titleForService?: (entry: ConnectedServiceRegistryEntry) => string;
    presentIdentity?: ConnectedAccountIdentityPresenter;
    groupOptionsByServiceId?: Readonly<Record<string, readonly ConnectedServicesAccountGroupOption[]>>;
}>): Readonly<Record<string, readonly MachineAgentConnectedService[]>> {
    const declarations = params.agents.flatMap((agent) => agent.connectedAccounts ?? []);
    const qualifiedOptions: Readonly<Record<string, readonly ConnectedServicesProfileOption[]>> = params.accountTransport === 'advertised-v4'
        ? buildQualifiedConnectedAccountProfileOptionsByServiceId({
            accounts: params.profile.connectedAccountsV4,
            supportedServiceIds: resolveProjectedConnectedAccountServiceKeys(declarations),
            labelsByKey: {},
            presentIdentity: params.presentIdentity,
        })
        : {};

    return Object.fromEntries(params.agents.map((agent) => [agent.agentId, (agent.connectedAccounts ?? []).map((declaration) => {
        const serviceId = buildQualifiedPluginContributionKey(declaration.service);
        const entry = params.entries.find((candidate) => candidate.service
            && candidate.service.pluginId === declaration.service.pluginId
            && candidate.service.localId === declaration.service.localId);
        const projectedTitle = entry?.projectedTitle ?? entry?.projectedDescriptor?.title;
        const title = entry && params.titleForService
            ? params.titleForService(entry)
            : entry?.shortName ?? (projectedTitle == null ? undefined : resolvePluginLocalizedStringV2Text(projectedTitle)) ?? serviceId;
        const disconnected: MachineAgentConnectedService = { serviceId, title, connected: false, healthy: false, profileLabel: null };
        if (!entry || params.accountTransport === 'indeterminate' || entry.executable !== true) return disconnected;

        let options: readonly ConnectedServicesProfileOption[];
        if (params.accountTransport === 'advertised-v4') {
            const authentication = entry.projectedDescriptor?.authentication;
            if (!authentication) return disconnected;
            options = qualifiedOptions[serviceId] ?? [];
            const restricted = applyProjectedCredentialKindRestrictions({
                optionsByServiceId: { [serviceId]: options }, connectedAccounts: [declaration],
            })[serviceId] ?? [];
            const profiles = restricted.map((option) => {
                const profile = params.profile.connectedAccountsV4.find((candidate) => (
                    candidate.ref.service.pluginId === declaration.service.pluginId
                    && candidate.ref.service.localId === declaration.service.localId
                    && candidate.ref.accountId === option.profileId
                ));
                return { profileId: option.profileId, profileLabel: option.label ?? option.providerEmail ?? null,
                    ...(params.presentIdentity ? { providerEmail: option.providerEmail ?? null } : {}),
                    healthy: Boolean(isConnectedServiceProfileStatusSelectable(option.status) && profile
                        && isQualifiedConnectedAccountProfileUsableV4({ profile, authentication, now: params.now })),
                    ...(isConnectedAccountSignedOut(profile?.status) ? { reconnectRequired: true } : {}) };
            });
            const usable = profiles.find((profile) => profile.healthy);
            const selected = usable ?? profiles[0];
            return {
                serviceId, title, connected: options.length > 0, healthy: Boolean(usable),
                profileLabel: selected && params.presentIdentity ? formatConnectedAccountNameInline(presentConnectedAccountName({
                    serviceTitle: title, userLabel: selected.profileLabel, email: selected.providerEmail,
                })) : selected?.profileLabel ?? null, profiles,
                ...(params.groupOptionsByServiceId ? { groups: params.groupOptionsByServiceId[serviceId] ?? [] } : {}),
            };
        }

        // Only the exact known registry entry supplies the released V2/V3 scalar mapping.
        // Novel plugin services cannot acquire a legacy account from a matching local id.
        if (!entry.legacyServiceId) return disconnected;
        options = (params.profile.connectedServicesV2.find((candidate) => candidate.serviceId === entry.legacyServiceId)?.profiles ?? []).map((profile) => ({
            profileId: profile.profileId, status: profile.status, kind: profile.kind,
            providerEmail: params.presentIdentity
                ? params.presentIdentity({ email: profile.providerEmail ?? null }).email : profile.providerEmail,
            label: null,
        }));
        const restricted = applyProjectedCredentialKindRestrictions({
            optionsByServiceId: { [serviceId]: options }, connectedAccounts: [declaration],
        })[serviceId] ?? [];
        const profiles = restricted.map((option) => ({ profileId: option.profileId, profileLabel: option.label ?? option.providerEmail ?? null,
            ...(params.presentIdentity ? { providerEmail: option.providerEmail ?? null } : {}),
            healthy: option.status !== 'unsupported_kind' && isConnectedServiceProfileStatusSelectable(option.status),
            ...(isConnectedAccountSignedOut(parseDisplayableCredentialHealthStatus(option.status)) ? { reconnectRequired: true } : {}) }));
        const usable = profiles.find((profile) => profile.healthy);
        const selected = usable ?? profiles[0];
        return {
            serviceId, title, connected: options.length > 0, healthy: Boolean(usable),
            profileLabel: selected && params.presentIdentity ? formatConnectedAccountNameInline(presentConnectedAccountName({
                serviceTitle: title, userLabel: selected.profileLabel, email: selected.providerEmail,
            })) : selected?.profileLabel ?? null, profiles,
        };
    })]));
}
