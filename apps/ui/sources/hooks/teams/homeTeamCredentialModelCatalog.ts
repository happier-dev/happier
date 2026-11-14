import { TEAM_DIRECTORY_PAGE_LIMIT_DEFAULT_V1, teamDirectoryQueryKeyV1, mergeTeamCredentialCatalogResourcesV1, type TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';
import type { ProviderBrokerApplicationBindingV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { resolveAccountAgentTeamCredentialDemand, type ProviderDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveRuntimeFeatureDecisionFromSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { storage } from '@/sync/domains/state/storage';
import { refreshTeamsDirectory, refreshTeamCredentialResourceCatalog } from '@/sync/engine/teams/teamsDirectoryEngine';
import { getTeamsDirectorySnapshot, getTeamCredentialResourceCatalogSnapshot } from '@/sync/store/teams/teamsSnapshots';
import type { TeamCredentialResourceStatus, TeamCredentialResourceStatusByKey } from '@/sync/domains/teams/teamCredentialResourceStatus';
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';

const EMPTY_RESOURCES: readonly TeamCredentialResourceCatalogEntryV1[] = Object.freeze([]);

type CatalogSnapshot = ReturnType<typeof getTeamCredentialResourceCatalogSnapshot>;
type CatalogDemand = ReturnType<typeof resolveAccountAgentTeamCredentialDemand> | null;
type CatalogProjection = Readonly<{
    resources: readonly TeamCredentialResourceCatalogEntryV1[];
    resourceStatusByKey: TeamCredentialResourceStatusByKey;
    current: boolean;
}>;

export function projectHomeCatalogSnapshots(snapshots: readonly CatalogSnapshot[], demand: CatalogDemand, homeUnreachable = false): CatalogProjection {
    const resourceStatusByKey = new Map<string, TeamCredentialResourceStatus>();
    let current = true;
    for (const snapshot of snapshots) {
        // The snapshot owner retains admitted choices through a transient read failure.
        const status: TeamCredentialResourceStatus = homeUnreachable || snapshot?.error?.kind === 'unreachable'
            ? { kind: 'homeUnreachable' }
            : snapshot?.selectionCurrent ? { kind: 'current' }
                : snapshot?.error ? { kind: 'failed', code: snapshot.error.code ?? snapshot.error.kind, reason: snapshot.error.kind }
                    : { kind: 'pending' };
        if (snapshot?.status !== 'ready' || snapshot.stale) current = false;
        for (const resource of snapshot?.data ?? []) {
            const key = `${resource.teamId}:${resource.id}`;
            const previous = resourceStatusByKey.get(key);
            if (!previous || previous.kind === 'current' || status.kind === 'failed' || status.kind === 'homeUnreachable') {
                resourceStatusByKey.set(key, status);
            }
        }
    }
    const resourcesByKey = mergeTeamCredentialCatalogResourcesV1(snapshots.map(snapshot => snapshot?.data ?? []), demand?.connectedServiceKeys ?? null, {
        requireProviderModels: Boolean(demand && demand.applications.length > 0),
    });
    for (const key of resourceStatusByKey.keys()) if (!resourcesByKey.has(key)) resourceStatusByKey.delete(key);
    return { resources: [...resourcesByKey.values()], resourceStatusByKey, current };
}

/** Finite consumers demand the same Home snapshots and application projection as the mounted picker. */
export async function loadHomeTeamCredentialModelCatalog(input: Readonly<{
    scope: ServerAccountScope;
    agentTargetKey: string;
    machineId: string;
    declarationContext: ProviderDeclarationContext;
    assertCurrent: () => void;
    signal?: AbortSignal;
}>): Promise<CatalogProjection & Readonly<{ teamNameById: Readonly<Record<string, string>> }>> {
    const features = await getServerFeaturesSnapshot({ serverId: input.scope.serverId, signal: input.signal });
    input.assertCurrent();
    const admission = resolveRuntimeFeatureDecisionFromSnapshot({ featureId: 'teams.credentialResources',
        snapshot: features, settings: storage.getState().settings,
        scope: { scopeKind: 'spawn', serverId: input.scope.serverId } });
    const teamNameById: Record<string, string> = {};
    if (admission?.state !== 'enabled' || isEmbedWindowContext()) return {
        resources: EMPTY_RESOURCES, resourceStatusByKey: new Map<string, TeamCredentialResourceStatus>(), teamNameById,
        current: admission?.state === 'disabled' || admission?.state === 'unsupported',
    };
    const query = { v: 1 as const, scope: 'member' as const, archived: 'active' as const, limit: TEAM_DIRECTORY_PAGE_LIMIT_DEFAULT_V1 };
    const queryKey = teamDirectoryQueryKeyV1(query);
    const held = getTeamsDirectorySnapshot(input.scope, queryKey);
    if (held?.status !== 'ready' || held.stale) await refreshTeamsDirectory(input.scope, query);
    input.assertCurrent();
    const directory = getTeamsDirectorySnapshot(input.scope, queryKey);
    const demand = resolveAccountAgentTeamCredentialDemand(input.agentTargetKey, input.declarationContext);
    const applications: readonly (ProviderBrokerApplicationBindingV1 | undefined)[] = [undefined, ...demand.applications];
    const targets = (directory?.data ?? []).flatMap(team => applications.map(application => ({
        address: { serverId: input.scope.serverId, teamId: team.id }, application,
    })));
    await Promise.all(targets.map(async ({ address, application }) => {
        const held = getTeamCredentialResourceCatalogSnapshot(input.scope, address, application, input.machineId);
        if (held?.status !== 'ready' || held.stale || !held.selectionCurrent) {
            await refreshTeamCredentialResourceCatalog(input.scope, address, application, input.machineId);
        }
    }));
    input.assertCurrent();
    const projected = projectHomeCatalogSnapshots(targets.map(({ address, application }) =>
        getTeamCredentialResourceCatalogSnapshot(input.scope, address, application, input.machineId)), demand,
        directory?.error?.kind === 'unreachable');
    for (const team of directory?.data ?? []) teamNameById[team.id] = team.name;
    return { ...projected, teamNameById,
        current: projected.current && directory?.status === 'ready' && !directory.stale && demand.requirements !== null };
}
