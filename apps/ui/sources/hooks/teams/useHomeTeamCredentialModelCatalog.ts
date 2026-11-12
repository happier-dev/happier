import * as React from 'react';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';
import type { ProviderBrokerApplicationBindingV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { teamsUnavailableReason, type TeamsDirectoryUnavailableHome } from '@/components/settings/teams/teamsDirectoryViewState';

import { observeTeamCredentialResourceCatalog, refreshTeamCredentialResourceCatalog } from '@/sync/engine/teams/teamsDirectoryEngine';
import { getTeamCredentialResourceCatalogSnapshot, getTeamCredentialResourceCatalogsSelectionKey, subscribeTeamsSnapshots } from '@/sync/store/teams/teamsSnapshots';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { PROVIDER_DECLARATION_CONTEXT_SECTIONS, providerDeclarationContext, resolveAccountAgentTeamCredentialDemand } from '@/providers/catalog/accountProviderDeclarations';
import { projectHomeCatalogSnapshots } from './homeTeamCredentialModelCatalog';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { useProviderModelProjection } from '@/providers/hooks/useProviderModelProjection';
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';
import { useTeamsDirectory } from './useTeamsDirectory';
import type { TeamCredentialResourceStatus, TeamCredentialResourceStatusByKey } from '@/sync/domains/teams/teamCredentialResourceStatus';

export type HomeTeamCredentialModelCatalog = Readonly<{
    resources: readonly TeamCredentialResourceCatalogEntryV1[];
    teamNameById: Readonly<Record<string, string>>;
    homeNameByTeamId: Readonly<Record<string, string>>;
    resourceStatusByKey: TeamCredentialResourceStatusByKey;
    current: boolean;
    /** The owning directory/catalog's cold-load or failed-read condition, never inferred from emptiness. */
    condition: Pick<TeamsDirectoryUnavailableHome, 'reason' | 'retryable'> | null;
    /** Re-reads membership discovery and observed Team catalogs through their canonical engine. */
    reload: () => Promise<void>;
}>;

const EMPTY_RESOURCES: readonly TeamCredentialResourceCatalogEntryV1[] = Object.freeze([]);

/**
 * Recipient-safe model catalog for the exact Home selected by Session authoring.
 * The Team directory owns membership discovery and each Team resource loader
 * owns eligibility/currentness. The snapshot loader gathers Account/application
 * discovery before Action admission; this hook only composes their projections.
 */
export function useHomeTeamCredentialModelCatalog(input: Readonly<{
    serverId: string | null | undefined;
    enabled: boolean;
    /** Omission requests generic resource discovery, without Agent model projection. */
    agentTargetKey?: string | null;
    /** The exact Session/Agent execution target; declarations never borrow another Machine. */
    machineId?: string | null;
    /** A mounted caller's current projection for this exact Machine; null means not admitted. */
    declarationProjection?: PluginProjectionV2 | null;
}>): HomeTeamCredentialModelCatalog {
    // Embed model choices come from the admitted grant/options projection, never Account Team discovery.
    const enabled = input.enabled && !isEmbedWindowContext();
    const serverId = input.serverId?.trim() ?? '';
    const declarationState = useDaemonMergedProjectionInputs({ machineId: input.machineId, serverId,
        enabled: input.declarationProjection === undefined && enabled && Boolean(input.agentTargetKey && input.machineId),
        sections: PROVIDER_DECLARATION_CONTEXT_SECTIONS });
    const projection = input.declarationProjection !== undefined ? input.declarationProjection
        : declarationState.phase === 'ready' ? declarationState.inputs?.pluginProjectionV2 ?? null : null;
    const declarationContext = React.useMemo(() => providerDeclarationContext(input.machineId, projection), [input.machineId, projection]);
    // One derivation (protocol owner) of the applications and services this Agent can use here.
    const demand = React.useMemo(() => input.agentTargetKey
        ? resolveAccountAgentTeamCredentialDemand(input.agentTargetKey, declarationContext) : null,
    [input.agentTargetKey, declarationContext]);
    const directory = useTeamsDirectory({ enabled: enabled && serverId !== '', serverIds: serverId ? [serverId] : [] });
    const scopeServerId = resolveServerProfileScopeIdForIdentifier(serverId);
    const scope = directory.scopes.find((candidate) => candidate.serverId === scopeServerId) ?? null;
    // Team loaders accept canonical Home addresses, not device-local route aliases.
    const { rows, rowsKey } = React.useMemo(() => {
        const rows = directory.rows.map(row => ({ ...row,
            address: { ...row.address, serverId: resolveServerProfileScopeIdForIdentifier(row.address.serverId) },
        }));
        return { rows, rowsKey: JSON.stringify(rows.map(row => [row.address.serverId, row.address.teamId])) };
    }, [directory.rows]);
    const applications = React.useMemo<readonly (ProviderBrokerApplicationBindingV1 | undefined)[]>(() => {
        // Generic Connected Account choices do not require model compatibility.
        // Unknown requirements admit no model application and keep `current` false.
        if (!demand || demand.requirements === null) return [undefined];
        return [undefined, ...demand.applications];
    }, [demand]);
    const executionMachineId = input.machineId?.trim() || undefined;
    const { demands, demandsKey } = React.useMemo(() => ({
        demands: rows.flatMap(row => applications.map(application => ({ row, application }))),
        demandsKey: JSON.stringify([rowsKey, applications, executionMachineId]),
    }), [rows, rowsKey, applications, executionMachineId]);
    const catalogSelections = React.useMemo(() => demands.map(({ row, application }) => ({ address: row.address, application, executionMachineId })), [demands, executionMachineId]);

    React.useEffect(() => {
        if (!enabled || !scope) return;
        const releases = demands.map(({ row, application }) => observeTeamCredentialResourceCatalog(scope, row.address, application, executionMachineId));
        return () => { for (const release of releases) release(); };
        // demandsKey includes every Team address and exact admitted application.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, demandsKey, scope?.accountId, scope?.serverId]);

    const reloadHomeCatalog = React.useCallback(async () => {
        if (!enabled) return;
        directory.refresh();
        if (!scope) return;
        await Promise.all(demands.map(({ row, application }) => refreshTeamCredentialResourceCatalog(scope, row.address, application, executionMachineId)));
    }, [directory.refresh, demands, executionMachineId, enabled, scope]);

    const subscribeCatalogs = React.useCallback((listener: () => void) =>
        subscribeTeamsSnapshots(listener, { scope, credentialCatalogs: catalogSelections }), [scope, catalogSelections]);
    const snapshotVersion = React.useSyncExternalStore(
        subscribeCatalogs,
        () => getTeamCredentialResourceCatalogsSelectionKey(scope, catalogSelections),
        () => '',
    );

    const discovered = React.useMemo(() => {
        const unavailable = directory.unavailableHomes.find((home) => home.serverId === serverId);
        let condition: HomeTeamCredentialModelCatalog['condition'] = unavailable
            ? { reason: unavailable.reason, retryable: unavailable.retryable }
            : null;
        if (!enabled || !scope) {
            return {
                resources: EMPTY_RESOURCES,
                teamNameById: {},
                homeNameByTeamId: {},
                resourceStatusByKey: new Map<string, TeamCredentialResourceStatus>(),
                current: false,
                condition: enabled ? condition : null,
                reload: reloadHomeCatalog,
            };
        }
        const pages: ReturnType<typeof getTeamCredentialResourceCatalogSnapshot>[] = [];
        const teamNameById: Record<string, string> = {};
        const homeNameByTeamId: Record<string, string> = {};
        let current = directory.kind !== 'loading' && !directory.partial
            && (!demand || demand.requirements !== null);
        if (directory.kind === 'loading' && !condition) condition = { reason: 'loading', retryable: false };
        for (const { row, application } of demands) {
            teamNameById[row.address.teamId] = row.team.name;
            homeNameByTeamId[row.address.teamId] = row.homeName;
            const snapshot = getTeamCredentialResourceCatalogSnapshot(scope, row.address, application, executionMachineId);
            if (snapshot?.error && (!condition || condition.reason === 'loading')) condition = teamsUnavailableReason(snapshot.error);
            else if (snapshot?.status !== 'ready' && !condition) condition = { reason: 'loading', retryable: false };
            pages.push(snapshot);
        }
        const projected = projectHomeCatalogSnapshots(pages, demand, unavailable?.reason === 'offline');
        current = current && projected.current;
        const { resources, resourceStatusByKey } = projected;
        return Object.freeze({
            resources: resources.length > 0 ? Object.freeze(resources) : EMPTY_RESOURCES,
            teamNameById: Object.freeze(teamNameById),
            homeNameByTeamId: Object.freeze(homeNameByTeamId),
            resourceStatusByKey,
            current,
            condition: current ? null : condition,
            reload: reloadHomeCatalog,
        });
        // snapshotVersion is the scoped store change signal.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [directory.kind, directory.partial, directory.unavailableHomes, enabled, demand, reloadHomeCatalog, demandsKey, scope?.accountId, scope?.serverId, serverId, snapshotVersion]);

    const needsMachineProjection = Boolean(input.agentTargetKey && executionMachineId
        && discovered.resources.some(resource => resource.providerModels.length > 0));
    const modelProjection = useProviderModelProjection({
        enabled: enabled && needsMachineProjection,
        active: discovered.current,
        serverId: serverId || null,
        machineId: executionMachineId ?? null,
        agentTargetKey: input.agentTargetKey ?? null,
        teamCredentialResources: discovered.resources,
        teamCredentialCatalogSources: catalogSelections.map(demand =>
            getTeamCredentialResourceCatalogSnapshot(scope, demand.address, demand.application, demand.executionMachineId)?.data),
    });
    const refreshModels = modelProjection.refreshWithResult;
    const reload = React.useCallback(async () => {
        await reloadHomeCatalog();
        if (needsMachineProjection) await refreshModels(false);
    }, [needsMachineProjection, refreshModels, reloadHomeCatalog]);

    return React.useMemo(() => {
        if (!needsMachineProjection) {
            // Generic discovery is useful without a Machine, but its Home rows
            // cannot independently select a delivery route for an Agent.
            const resources = input.agentTargetKey
                ? discovered.resources.map(resource => resource.providerModels.length === 0 ? resource : { ...resource, providerModels: [] })
                : discovered.resources;
            return { ...discovered, resources, reload };
        }
        const resources = modelProjection.data?.teamCredentialResources ?? discovered.resources;
        const resolved = modelProjection.data?.teamCredentialResources !== undefined;
        const projectionCurrent = resolved && !modelProjection.loading && modelProjection.error === null;
        const current = discovered.current && projectionCurrent;
        const resourceStatusByKey = new Map(discovered.resourceStatusByKey);
        for (const resource of resources) {
            if (resource.providerModels.length === 0) continue;
            const key = `${resource.teamId}:${resource.id}`;
            const discoveredStatus = resourceStatusByKey.get(key);
            // Entitlement/Home failures retain their cause. A Machine failure
            // says nothing about the Home's reachability.
            if (discoveredStatus && discoveredStatus.kind !== 'current') continue;
            resourceStatusByKey.set(key, modelProjection.error
                ? { kind: 'failed', code: modelProjection.error.code }
                : projectionCurrent ? { kind: 'current' } : { kind: 'pending' });
        }
        return {
            ...discovered,
            resources,
            current,
            resourceStatusByKey,
            condition: modelProjection.error
                ? teamsUnavailableReason({ kind: 'unknown', retryable: modelProjection.error.retryable, code: modelProjection.error.code })
                : current ? null : discovered.condition ?? { reason: 'loading' as const, retryable: false },
            reload,
        };
    }, [discovered, input.agentTargetKey, modelProjection.data, modelProjection.error, modelProjection.loading, needsMachineProjection, reload]);
}
