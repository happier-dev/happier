import { agentDeclaresManagedCliInstall } from '@happier-dev/agents';
import type {
    TeamCredentialProviderModelSelectionV1,
    TeamCredentialResourceCatalogEntryV1,
} from '@happier-dev/protocol/teams';
import { SessionInitialAccessMaterializedV1Schema } from '@happier-dev/protocol/sessions/access/sessionInitialAccessDraftV1';
import type {
    PluginProjectedAgentV2,
    PluginProjectionInstalledPackageV2,
} from '@happier-dev/protocol';
import {
    projectExpectedMarketplaceListing,
    type ExpectedMarketplaceListingV1,
} from '@happier-dev/protocol/marketplace/internal';

import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/catalog';
import type { TemporaryComputerCreatorDependencies } from '../useNewSessionScreenModel';

/**
 * The exact producer facts a creator decision needs but cannot currently obtain.
 *
 * These are reported rather than guessed. A creator that fabricated a broker
 * machine, a resource revision or a reviewed model would hand the endpoint
 * authority nobody granted, so every gap here fails the decision closed and
 * surfaces as a typed unavailable state instead of a silent no-op control.
 */
export type TemporaryComputerCreatorProducerGap =
    /** The Agent has no unattended managed CLI install recipe, so a fresh computer cannot install it. */
    | 'agent_managed_install_undeclared'
    /**
     * The Agent comes from an installed plugin whose exact distribution a fresh
     * Temporary computer cannot acquire: it was installed from a path or an
     * archive, or its machine's marketplace index carries no listing for it.
     */
    | 'agent_plugin_distribution_unacquirable'
    /** No current, brokerable Team credential resource offers a model for the selected Agent. */
    | 'team_credential_resource_unavailable'
    /** Authoring has not selected a Team credential model to broker. */
    | 'team_credential_model_unselected'
    | 'broker_selection_unavailable';

export type TemporaryComputerCreatorComposition = Readonly<{
    dependencies: TemporaryComputerCreatorDependencies;
    /** Gaps observed by the most recent decision, for truthful surface reporting. */
    readGaps: () => readonly TemporaryComputerCreatorProducerGap[];
}>;

function resourceKey(resource: Readonly<{ teamId: string; id: string }>): string {
    return `${resource.teamId}:${resource.id}`;
}

/**
 * Composes the concrete Temporary-computer creator producers from facts the
 * mounted New Session owner already holds.
 *
 * It is deliberately a pure factory over projections rather than a hook: the
 * authoring model owns the Agent catalog, the entitled Team credential catalog
 * and the current model selection, so a second hook would open a duplicate
 * store for facts that are already loaded once.
 */
export function createTemporaryComputerCreatorDependencies(facts: Readonly<{
    /**
     * Exact Home the entitled catalog below was read for.
     *
     * Resource ids and revisions are only unique within a Home, so an answer
     * given without this identity could freeze one Home's resource into another
     * Home's activation. Absent identity therefore fails closed rather than
     * falling back to whichever Home happens to be in focus.
     */
    teamCredentialServerId: string | null;
    teamCredentialResources: readonly TeamCredentialResourceCatalogEntryV1[];
    /** Only exact, non-stale rows may admit a launch. */
    currentTeamCredentialResourceKeys: ReadonlySet<string>;
    selectedTeamCredentialModel: TeamCredentialProviderModelSelectionV1 | null;
    /**
     * The machine whose open Agent catalog this screen is showing — the
     * creator's focused, or most recently used, machine. A Temporary computer
     * has no machine of its own, so an externally installed Agent and the
     * marketplace index that resolves its exact distribution both come from
     * this one machine. Absent identity fails every external decision closed.
     */
    agentCatalogMachineId: string | null;
    /** That machine's projected Agent contributions, keyed by projected Agent id. */
    projectedAgentsById: Readonly<Record<string, PluginProjectedAgentV2>>;
    /** That machine's installed plugin packages, keyed by plugin id. */
    installedPluginPackagesById: Readonly<Record<string, PluginProjectionInstalledPackageV2>>;
    /** The machine-scoped marketplace index read. Injected only to test this producer. */
    queryMarketplaceIndex?: (input: Readonly<{
        machineId: string;
        pluginId: string;
        signal?: AbortSignal;
    }>) => Promise<Readonly<{ items: readonly unknown[] }>>;
}>): TemporaryComputerCreatorComposition {
    const gaps = new Set<TemporaryComputerCreatorProducerGap>();
    const note = (gap: TemporaryComputerCreatorProducerGap): false => {
        gaps.add(gap);
        return false;
    };
    const qualifiedHomeServerId = facts.teamCredentialServerId?.trim() ?? '';
    const queryMarketplaceIndex = facts.queryMarketplaceIndex
        // Loaded only when an external Agent is actually launched. This pure
        // producer is composed on every New Session render, and the machine RPC
        // owner pulls the whole sync runtime behind it.
        ?? (async ({ machineId, pluginId }) => await (
            await import('@/sync/ops/machineMarketplaceSources')
        ).machineMarketplaceIndexQuery(
            machineId,
            { text: '', cursor: null, limit: 1, filters: { pluginIds: [pluginId], includeUnavailable: true } },
            { serverId: qualifiedHomeServerId || null },
        ));

    const brokerableModelExistsFor = (agentTargetKey: string): boolean => (
        facts.teamCredentialResources.some((resource) => (
            facts.currentTeamCredentialResourceKeys.has(resourceKey(resource))
            && resource.mayBroker
            && resource.readiness.kind === 'available'
            && resource.providerModels.some((model) => (
                model.availability === 'available'
                && model.selection.deliveryMode === 'brokered'
                && model.selection.agentTargetKey === agentTargetKey
            ))
        ))
    );

    /**
     * The exact current catalog model for one Team model choice. Launch
     * readiness asks it about the composer's live choice; review asks it about
     * the choice frozen into the submitted package, so a later composer change
     * can never substitute another resource into an accepted launch.
     */
    const exactProviderModelFor = (
        selected: TeamCredentialProviderModelSelectionV1 | null,
        agentTargetKey: string,
    ) => {
        if (!selected) {
            note('team_credential_model_unselected');
            return null;
        }
        const resource = facts.teamCredentialResources.find((candidate) => (
            candidate.id === selected.resourceId
            && candidate.resourceRevision === selected.expectedResourceRevision
            && facts.currentTeamCredentialResourceKeys.has(resourceKey(candidate))
        ));
        if (!resource || !resource.mayBroker || resource.readiness.kind !== 'available') {
            note('team_credential_resource_unavailable');
            return null;
        }
        const providerModel = resource.providerModels.find((candidate) => (
            candidate.availability === 'available'
            && candidate.selection.resourceId === selected.resourceId
            && candidate.selection.teamId === selected.teamId
            && candidate.selection.expectedResourceRevision === selected.expectedResourceRevision
            && candidate.selection.agentTargetKey === agentTargetKey
            && candidate.selection.agentTargetKey === selected.agentTargetKey
            && candidate.selection.modelId === selected.modelId
            && candidate.selection.deliveryMode === selected.deliveryMode
            && candidate.selection.deliveryMode === 'brokered'
        ));
        if (!providerModel) {
            note('team_credential_resource_unavailable');
            return null;
        }
        gaps.delete('team_credential_model_unselected');
        gaps.delete('team_credential_resource_unavailable');
        return providerModel;
    };

    const projectedAgentFor = (identity: Readonly<{ pluginId: string; localId: string }>) => (
        Object.values(facts.projectedAgentsById).find((projected) => (
            projected.identity?.pluginId === identity.pluginId
            && projected.identity.localId === identity.localId
        )) ?? null
    );

    /**
     * Whether an unattended endpoint can set this Agent's CLI up by itself.
     *
     * A bundled Agent is answered by the Runner artifact's own bundled table —
     * the Runner runs that generation, not the creator machine's copy of it. An
     * externally installed Agent has exactly one authority for the same fact:
     * its own projected `cli.install.managed` declaration on the machine whose
     * catalog the creator chose from.
     */
    const declaresManagedCliInstall = (identity: Readonly<{ pluginId: string; localId: string }>): boolean => {
        const bundledAgentId = resolveBundledAgentIdFromContributionIdentity(identity);
        if (bundledAgentId) return agentDeclaresManagedCliInstall(bundledAgentId);
        return projectedAgentFor(identity)?.cli?.install?.managed != null;
    };

    /**
     * Whether the exact installed generation can be acquired again by a fresh
     * Temporary computer. A bundled Agent already ships inside the Runner. An
     * external Agent must have been installed from a registry package: a plugin
     * installed from a working tree or a local archive has no marketplace
     * listing, so no commitment exists for the endpoint to acquire.
     */
    const canAcquireExternalGeneration = (identity: Readonly<{ pluginId: string; localId: string }>): boolean => {
        if (resolveBundledAgentIdFromContributionIdentity(identity)) return true;
        if (!facts.agentCatalogMachineId) return false;
        const installed = facts.installedPluginPackagesById[identity.pluginId];
        return installed?.source.kind === 'package' || installed?.source.kind === 'marketplace';
    };

    const dependencies: TemporaryComputerCreatorDependencies = {
        isAuthoringCompatible: ({ backendTargetKey, agentTarget }) => {
            if (!qualifiedHomeServerId) return note('broker_selection_unavailable');
            // An Agent whose only install path is a vendor guide cannot be set
            // up by an unattended endpoint, whichever plugin contributes it.
            if (!declaresManagedCliInstall(agentTarget.identity)) {
                return note('agent_managed_install_undeclared');
            }
            if (!canAcquireExternalGeneration(agentTarget.identity)) {
                return note('agent_plugin_distribution_unacquirable');
            }
            if (!brokerableModelExistsFor(backendTargetKey)) {
                return note('team_credential_resource_unavailable');
            }
            gaps.delete('agent_managed_install_undeclared');
            gaps.delete('agent_plugin_distribution_unacquirable');
            gaps.delete('team_credential_resource_unavailable');
            return true;
        },

        resolveAgentPluginDistribution: async ({ agentTarget, signal }) => {
            // The Runner artifact already carries every bundled generation, so
            // a bundled Agent commits to no acquisition at all. Leg 4 of the
            // ratified mechanism: both kinds take the same endpoint path.
            if (resolveBundledAgentIdFromContributionIdentity(agentTarget.identity)) return null;
            const machineId = facts.agentCatalogMachineId;
            if (!machineId || !canAcquireExternalGeneration(agentTarget.identity)) {
                note('agent_plugin_distribution_unacquirable');
                return null;
            }
            signal?.throwIfAborted();
            const result = await queryMarketplaceIndex({
                machineId,
                pluginId: agentTarget.identity.pluginId,
                ...(signal ? { signal } : {}),
            });
            signal?.throwIfAborted();
            const listing = result.items.find((item) => (
                (item as Readonly<{ pluginId?: unknown }>).pluginId === agentTarget.identity.pluginId
            )) ?? null;
            if (!listing) {
                note('agent_plugin_distribution_unacquirable');
                return null;
            }
            gaps.delete('agent_plugin_distribution_unacquirable');
            // Private-registry authentication is an endpoint-side selection, so
            // the creator never carries a registry profile binding into the
            // sealed commitment.
            return projectExpectedMarketplaceListing(listing as never, null) satisfies ExpectedMarketplaceListingV1;
        },

        isLaunchReady: ({ backendTargetKey, agentTarget }) => (
            dependencies.isAuthoringCompatible({ backendTargetKey, agentTarget })
            && exactProviderModelFor(facts.selectedTeamCredentialModel, backendTargetKey) !== null
        ),

        resolveCredentialSelectionBinding: async ({ projection, preparedAuthoring, submittedTeamCredentialModel, client, signal }) => {
            if (!qualifiedHomeServerId) {
                note('broker_selection_unavailable');
                return null;
            }
            // The frozen submission decides; it is revalidated against the
            // current catalog, and an unavailable choice stays unavailable.
            const providerModel = submittedTeamCredentialModel
                ? exactProviderModelFor(submittedTeamCredentialModel, submittedTeamCredentialModel.agentTargetKey)
                : (note('team_credential_model_unselected'), null);
            if (!providerModel) return null;
            const authoring = preparedAuthoring.authoring;
            const teamVisibilityTeamIds = [...new Set((authoring.access?.grants ?? []).flatMap((grant) => {
                const subject = grant.subject;
                return subject.kind === 'team' || subject.kind === 'group' ? [subject.teamId] : [];
            }))];
            const resolution = await client.resolveCredentialSelection(projection.activationId, {
                v: 1,
                selection: providerModel.selection,
                application: providerModel.application,
                sourceRevision: providerModel.sourceRevision,
                plannedSession: {
                    primaryTeamId: authoring.primaryTeamId ?? null,
                    teamVisibilityTeamIds,
                },
            }, signal);
            if (resolution.status !== 'resolved') {
                note('broker_selection_unavailable');
                return null;
            }
            gaps.delete('broker_selection_unavailable');
            return {
                binding: resolution.credentialSelectionBinding,
                reviewedProviderModel: providerModel,
                displayFacts: resolution.displayFacts,
            };
        },

        resolveMaterializationInput: async ({ custody }) => {
            const authoring = custody.preparedAuthoring.authoring;
            const grants = authoring.access?.grants ?? [];
            const credentialSelection = custody.launchManifest.credentialSelectionBinding;
            const reviewedSelection = custody.launchManifest.reviewedProviderModel.selection;
            if (
                reviewedSelection.deliveryMode !== 'brokered'
                || reviewedSelection.resourceId !== credentialSelection.resourceId
                || reviewedSelection.expectedResourceRevision !== credentialSelection.revision
            ) {
                note('team_credential_resource_unavailable');
                return null;
            }
            return {
                // Stable across materialization retries: the activation is the
                // launch identity, so a retry rejoins instead of racing a second
                // Session into existence.
                tag: `temporary-computer:${custody.binding.activationId}`,
                // No Agent has run yet. The endpoint publishes agent state through
                // the ordinary Session runtime once it starts.
                agentState: null,
                ...(grants.length > 0
                    ? { initialAccess: SessionInitialAccessMaterializedV1Schema.parse({ grants }) }
                    : {}),
                // The reviewed credential selection is already sealed into the
                // launch manifest. Materialization must persist that exact
                // resource/revision on the Session or readiness can pass while
                // the first real Provider request has no broker authority.
                teamCredentialBindings: [{
                    v: 1,
                    slot: { kind: 'provider_model' },
                    resourceId: credentialSelection.resourceId,
                    expectedResourceRevision: credentialSelection.revision,
                    deliveryMode: reviewedSelection.deliveryMode,
                    teamId: reviewedSelection.teamId,
                }],
            };
        },
    };

    return { dependencies, readGaps: () => Object.freeze([...gaps]) };
}
