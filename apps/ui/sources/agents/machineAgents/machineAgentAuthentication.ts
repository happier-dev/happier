import { projectAgentConnectedAccountPurposeDefaultsToSessionBindings, resolveAgentConnectedAccountPurposeDefaults } from '@happier-dev/protocol/account/settings/connected-services';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';
import type { DaemonMergedProjectionInputsState } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { getStorage } from '@/sync/domains/state/storage';
import { loadAccountProfile } from '@/sync/domains/state/accountProfilePersistence';
import type { Profile } from '@/sync/domains/profiles/profile';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getCachedServerFeaturesSnapshot, getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resolveRuntimeFeatureDecisionFromSnapshot, type ServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { resolveConnectedAccountUiNegotiation } from '@/sync/domains/connectedServices/resolveConnectedAccountUiNegotiation';
import { mergeConnectedAccountDescriptorProjections } from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import { projectConnectedServiceRegistryEntries, type ConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { buildQualifiedConnectedAccountGroupOptionsByServiceId, resolveProjectedConnectedAccountServiceKeys } from '@/sync/domains/connectedServices/qualifiedConnectedAccountServiceOptions';
import { presentConnectedAccountIdentity, type ConnectedAccountIdentityPresenter } from '@/sync/domains/connectedServices/maskAccountEmail';
import { refreshConnectedAccountCatalog } from '@/sync/engine/settings/connectedAccountCatalogEngine';
import { getConnectedAccountCatalogValue, type ConnectedAccountCatalogValue } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { getTeamCredentialResourceCatalogSnapshot } from '@/sync/store/teams/teamsSnapshots';
import type { MachineAgentInventoryObservation } from './machineAgentInventoryStore';
import { projectMachineAgentConnectedServices } from './machineAgentConnectedServices';

type AuthenticationObservation = Pick<MachineAgentInventoryObservation, 'connectedServicesByAgentId' | 'credentialSelectionsByAgentId'>;

/** One authentication projection for mounted inventory and imperative consumers. */
export function projectMachineAgentAuthentication(input: Readonly<{
    projection: DaemonMergedProjectionInputsState;
    scope: ServerAccountScope | null;
    profile: Pick<Profile, 'connectedServicesV2' | 'connectedAccountsV4' | 'connectedAccountGroupsV4'>;
    purposeBindings: ConnectedAccountCatalogValue<'purposes'> | null;
    features: ServerFeaturesRuntimeSnapshot;
    accountGroupsEnabled: boolean;
    teamCredentialResources?: readonly TeamCredentialResourceCatalogEntryV1[];
    titleForService?: (entry: ConnectedServiceRegistryEntry) => string;
    presentIdentity?: ConnectedAccountIdentityPresenter;
}>): AuthenticationObservation {
    // A lost Machine projection leaves last-known authentication intact; it does not select native.
    if (!input.projection.inputs) return {};
    const agents = Object.entries(input.projection.inputs.mergedProviderProjectionById);
    const descriptors = input.projection.inputs.connectedAccountProjection;
    const resolution = mergeConnectedAccountDescriptorProjections(descriptors ? [descriptors] : []);
    const entries = resolution.kind === 'error' ? [] : projectConnectedServiceRegistryEntries({
        scopeKey: input.scope ? JSON.stringify(input.scope) : '', status: resolution.kind,
        descriptors: resolution.descriptors, conflicts: resolution.conflicts, errorReason: null,
    });
    const groupOptionsByServiceId = buildQualifiedConnectedAccountGroupOptionsByServiceId({
        groups: input.profile.connectedAccountGroupsV4,
        supportedServiceIds: resolveProjectedConnectedAccountServiceKeys(agents.flatMap(([, agent]) => agent.connectedAccounts ?? [])),
    });
    const connectedServicesByAgentId = projectMachineAgentConnectedServices({
        agents: agents.map(([agentId, agent]) => ({ agentId, connectedAccounts: agent.connectedAccounts ?? undefined })),
        profile: input.profile, accountTransport: resolveConnectedAccountUiNegotiation(input.features), entries, now: Date.now(),
        titleForService: input.titleForService, presentIdentity: input.presentIdentity,
        groupOptionsByServiceId: input.accountGroupsEnabled ? groupOptionsByServiceId : {},
    });
    const credentialSelectionsByAgentId = Object.fromEntries(agents.map(([agentId, agent]) => {
        const declarations = agent.connectedAccounts ?? [];
        const credentialBindings = agent.identity && input.purposeBindings
            ? projectAgentConnectedAccountPurposeDefaultsToSessionBindings(resolveAgentConnectedAccountPurposeDefaults({
                purposeBindings: input.purposeBindings, consumer: agent.identity, declarations,
            })) : null;
        const usesTeamResource = Object.values(credentialBindings?.bindingsByServiceId ?? {}).some(binding => binding.source === 'team_resource');
        return [agentId, {
            credentialBindings,
            // Retained admitted defaults remain useful while refreshing; unread defaults do not imply native.
            credentialBindingsReady: (declarations.length === 0 || Boolean(agent.identity && input.purposeBindings))
                && (!usesTeamResource || input.teamCredentialResources !== undefined),
            groupOptionsByServiceId, teamCredentialResources: input.teamCredentialResources,
        }];
    }));
    return { connectedServicesByAgentId, credentialSelectionsByAgentId };
}

/** Finite inventory demand acquires the same Account defaults as a mounted inventory. */
export async function loadMachineAgentAuthentication(input: Readonly<{
    scope: ServerAccountScope;
    machineId: string;
    projection: DaemonMergedProjectionInputsState;
    signal?: AbortSignal;
}>): Promise<void> {
    if (!Object.values(input.projection.inputs?.mergedProviderProjectionById ?? {}).some(agent => agent.connectedAccounts?.length)) return;
    const purposes = getConnectedAccountCatalogValue(input.scope, 'purposes');
    await Promise.all([
        getServerFeaturesSnapshot({ serverId: input.scope.serverId, signal: input.signal }),
        purposes.status !== 'ready' || purposes.stale
            ? refreshConnectedAccountCatalog(input.scope, 'purposes', { sourceMachineId: input.machineId }) : Promise.resolve(),
    ]);
}

/** Exact-scope held inputs; Team discovery remains owned by its existing catalog consumers. */
export function readMachineAgentAuthentication(input: Readonly<{
    scope: ServerAccountScope;
    machineId: string;
    projection: DaemonMergedProjectionInputsState;
}>): AuthenticationObservation {
    if (!input.projection.inputs) return {};
    const state = getStorage().getState();
    const profile = areServerAccountScopesEqual(state.profileScope, input.scope) ? state.profile : loadAccountProfile(input.scope);
    const purposeBindings = getConnectedAccountCatalogValue(input.scope, 'purposes').value;
    const features = getCachedServerFeaturesSnapshot({ serverId: input.scope.serverId }) ?? { status: 'loading' as const };
    const teamCatalogs = (purposeBindings?.teamResourceSelections ?? []).map(selection => getTeamCredentialResourceCatalogSnapshot(
        input.scope, { serverId: input.scope.serverId, teamId: selection.teamId }, undefined, input.machineId,
    ));
    const teamCredentialResources = teamCatalogs.length > 0 && teamCatalogs.every(catalog => catalog?.selectionCurrent === true && catalog.status === 'ready' && !catalog.stale)
        ? teamCatalogs.flatMap(catalog => catalog?.data ?? []) : undefined;
    const accountGroupsEnabled = resolveRuntimeFeatureDecisionFromSnapshot({ featureId: 'connectedServices.accountGroups',
        settings: state.settings, snapshot: features, scope: { scopeKind: 'spawn', serverId: input.scope.serverId } })?.state === 'enabled';
    return projectMachineAgentAuthentication({ ...input, profile, purposeBindings, features, accountGroupsEnabled, teamCredentialResources,
        presentIdentity: identity => presentConnectedAccountIdentity({ hidden: state.localSettings.hideConnectedAccountIdentities === true,
            label: identity.label ?? null, labelKind: identity.labelKind, email: identity.email ?? null, accountId: identity.accountId ?? null }),
    });
}
