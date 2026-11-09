import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { AcpCatalogRecordV1, AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { ProviderConnectionsCatalogSnapshotV1, ProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import type { SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { ReachRulesV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import { describeAccountProviderConnectionsV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';

import { useMcpServerCatalogForServer } from '@/components/settings/mcpServers/useMcpServersSettings';
import { refreshMcpServerCatalog } from '@/sync/engine/settings/mcpServerCatalogEngine';
import { useSkillsLibrary, type SkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { useAcpCatalog } from '@/sync/store/useAcpCatalog';
import { useProviderCatalog } from '@/sync/store/useProviderCatalog';
import { useMachineDisplaysByServerId } from '@/sync/store/hooks';
import { usePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import type { PluginAccountInstalledPluginsAdmission } from '@/sync/domains/plugins/availability/reader';
import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import type { ServerMachineInventorySnapshotV1 } from '@/sync/domains/machines/machineInventorySnapshots';
import { resolvePortableMachineAdministrationTarget, type PortableMachineAdministrationTargetResolution } from '@/sync/domains/machines/resolveServerScopedMachines';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useMachineAgentsByMachine } from '@/agents/machineAgents/useMachineAgents';
import { readInstalledMachineAgentInventory } from '@/sync/domains/capabilities/reach/installedMachineAgents';
import { projectReachOnMachines, type ReachMachine, type ReachMachineProjection } from '@/sync/domains/capabilities/reach/useReachProjection';
import type { McpServerCatalogValueSnapshot } from '@/sync/store/settings/mcpServerCatalogSnapshot';
import { useProjectAccountRows, type ProjectAccountRowsSnapshot } from '@/sync/domains/workspaces/projectAccountRows';
import { getAcpCatalogSnapshot, subscribeAcpCatalogSnapshots } from '@/sync/store/settings/acpCatalogSnapshot';
import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { usePluginMachineDetails } from '@/components/settings/plugins/model/usePluginMachineDetails';
import type { InstalledPluginEntry } from '@/components/settings/plugins/model/pluginMarketplaceModel';
import { resolveFreshMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/executionTarget';

import type { InstalledFamilyResult, StoreDemand, StoreInstalledInput } from './storeKinds';
import type { InstalledSoftwareRow } from './storeSoftwareInstalled';
import type { InstalledAppRow } from './storeApps';
import type { InstalledBrowserExtensionRow } from './storeBrowserExtensions';
import { createInstalledAgentRowsProjection } from './storeInstalledAgentRows';
import type { InstalledScopeAdmission, StoreScopeFailure as ScopeFailure } from './storeAccountAdmission';

type MachineFailure = Exclude<PortableMachineAdministrationTargetResolution<MachineDisplayRenderable>, { kind: 'resolved' }>;
type PlacementFact = ServerMachineInventorySnapshotV1 | ProjectAccountRowsSnapshot | ReturnType<typeof readInstalledMachineAgentInventory>;
type InstalledIdentity = Readonly<{ key: string; scope: ServerAccountScope }>;

export type InstalledMcpServerRow = InstalledIdentity & Readonly<{
    kind: 'mcpServer'; native: McpServerCatalogEntryV1; reach: readonly ReachMachineProjection[];
}>;
export type InstalledSkillRow = InstalledIdentity & Readonly<{
    kind: 'skill'; native: SkillListItemV1; reach: readonly ReachMachineProjection[];
}>;
export type InstalledAgentRow = InstalledIdentity & (Readonly<{
    kind: 'agent'; subject: 'definition'; native: AcpCatalogRecordV1['definitions'][number];
}> | Readonly<{
    kind: 'agent'; subject: 'machineAgent'; native: string; machineIds: readonly string[];
}>);
export type InstalledProviderRow = InstalledIdentity & Readonly<{
    kind: 'provider'; native: ProviderConnectionsCatalogV1['connections'][number];
    /** Saved connections are Account subjects; these are grants, never probe/readiness facts. */
    catalog: ProviderConnectionsCatalogV1;
    view: ReturnType<typeof describeAccountProviderConnectionsV1>['connections'][number];
}>;
type AvailablePlugins = Extract<PluginAccountInstalledPluginsAdmission, { kind: 'available' }>;
export type InstalledPluginRow = InstalledIdentity & Readonly<{
    kind: 'plugin'; native: AvailablePlugins['plugins'][number];
    /** Selected placement narrows installations without changing the admitted native row. */
    installations: AvailablePlugins['plugins'][number]['installations'];
    /** Native daemon facts exist only for the explicitly demanded Machine. */
    detail?: InstalledPluginEntry;
}>;
export type InstalledRow = InstalledAppRow | InstalledMcpServerRow | InstalledSkillRow | InstalledAgentRow | InstalledProviderRow | InstalledPluginRow | InstalledSoftwareRow | InstalledBrowserExtensionRow;
export type InstalledMcpServersResult = InstalledFamilyResult<InstalledMcpServerRow,
    ScopeFailure | MachineFailure | McpServerCatalogValueSnapshot | PlacementFact, () => Promise<void>>;
export type InstalledSkillsResult = InstalledFamilyResult<InstalledSkillRow,
    ScopeFailure | MachineFailure | SkillsLibrary | PlacementFact, SkillsLibrary['retry']>;
export type InstalledAgentsResult = InstalledFamilyResult<InstalledAgentRow,
    ScopeFailure | MachineFailure | AcpCatalogSnapshotV1 | PlacementFact, never>;
export type InstalledProvidersResult = InstalledFamilyResult<InstalledProviderRow,
    ScopeFailure | MachineFailure | ProviderConnectionsCatalogSnapshotV1, never>;
export type InstalledPluginsResult = InstalledFamilyResult<InstalledPluginRow,
    ScopeFailure | MachineFailure | PluginAccountInstalledPluginsAdmission | ServerMachineInventorySnapshotV1
    | ReturnType<typeof usePluginMachineDetails>['machineCapabilities']['state'],
    ReturnType<typeof usePluginMachineDetails>['machineCapabilities']['refresh']>;

const EMPTY_MACHINES: readonly MachineDisplayRenderable[] = Object.freeze([]);
const EMPTY_ROWS = Object.freeze([]);

/** Held, Home-qualified inventory only. This composition never requests a machine census or probe. */
export function useInstalledMachines(input: StoreInstalledInput, demand: StoreDemand, scope: ServerAccountScope | null,
    includeMembership = false) {
    const snapshots = useAllProfileMachineInventorySnapshots(demand.presented && scope !== null,
        scope ? { scope, machineId: input.machine?.machineId ?? null } : undefined);
    const snapshot = snapshots.find(candidate => candidate.kind === 'resolved' && scope
        && candidate.accountId === scope.accountId
        && areServerProfileIdentifiersEquivalent(candidate.serverIdentityId, scope.serverId));
    const machineResolution = React.useMemo(() => {
        if (!input.machine || !scope) return null;
        const machines = snapshot?.kind === 'resolved' ? snapshot.machines : EMPTY_MACHINES;
        return resolvePortableMachineAdministrationTarget({ target: input.machine, activeServerId: '', activeMachines: EMPTY_MACHINES,
            machineListByServerId: snapshot?.kind === 'resolved' ? { [snapshot.profileId]: machines, [snapshot.serverIdentityId]: machines } : {},
            machineListStatusByServerId: snapshot?.kind === 'resolved' && snapshot.inventoryStatus
                ? { [snapshot.profileId]: snapshot.inventoryStatus, [snapshot.serverIdentityId]: snapshot.inventoryStatus } : {} });
    }, [input.machine, scope, snapshot]);
    const machines = React.useMemo(() => machineResolution
        ? machineResolution.kind === 'resolved' ? [machineResolution.machine] : EMPTY_MACHINES
        : input.machine ? EMPTY_MACHINES : snapshot?.machines ?? EMPTY_MACHINES,
    [input.machine, machineResolution, snapshot]);
    const failure: MachineFailure | null = machineResolution && machineResolution.kind !== 'resolved' ? machineResolution : null;
    // Content readers demand only membership from the existing Home display projection;
    // raw snapshot arrays also change when an unrelated daemon resource sample arrives.
    const homes = React.useMemo(() => includeMembership && demand.presented && scope ? [scope.serverId] : [],
    [includeMembership, demand.presented, scope?.serverId]);
    const displays = useMachineDisplaysByServerId(homes);
    const selectedMachineId = input.machine?.machineId;
    const machineIds = React.useMemo(() => {
        const records = scope ? displays[scope.serverId] : undefined;
        if (selectedMachineId) {
            const machine = records?.[selectedMachineId];
            return machine ? [machine.id] : [];
        }
        return records ? Object.keys(records) : [];
    }, [displays, scope?.serverId, selectedMachineId]);
    const selectIds = useShallow((ids: readonly string[]) => ids);
    return { machines, machineIds: selectIds(machineIds), snapshot, failure };
}

function useInstalledReach(input: StoreInstalledInput, demand: StoreDemand, scope: ServerAccountScope | null,
    definitions: readonly AcpCatalogRecordV1['definitions'][number][] | undefined) {
    const held = useInstalledMachines(input, demand, scope);
    const selectProjects = React.useCallback((rows: ProjectAccountRowsSnapshot | null) => rows && scope
        && rows.scope.accountId === scope.accountId && areServerProfileIdentifiersEquivalent(rows.scope.serverId, scope.serverId)
        ? rows : null, [scope]);
    const projects = useProjectAccountRows(selectProjects, demand.presented && scope !== null);
    const readDefinitions = React.useCallback(() => getAcpCatalogSnapshot(scope)?.data?.definitions, [scope]);
    const subscribeDefinitions = React.useCallback((listener: () => void) => demand.presented
        ? subscribeAcpCatalogSnapshots(listener) : () => {}, [demand.presented]);
    const heldDefinitions = React.useSyncExternalStore(subscribeDefinitions, readDefinitions, readDefinitions);
    const definitionsForInventory = definitions ?? heldDefinitions;
    const machines = React.useMemo(() => input.projectKey ? held.machines.filter(machine => projects?.workspaceRefs.some(ref =>
        (ref.projectKey ?? ref.id) === input.projectKey && ref.machineId === machine.id && scope
        && areServerProfileIdentifiersEquivalent(ref.serverId, scope.serverId))) : held.machines,
    [held.machines, input.projectKey, projects, scope]);
    const machineIds = React.useMemo(() => machines.map(machine => machine.id), [machines]);
    const cached = useMachineAgentsByMachine({ serverId: scope?.serverId ?? '', machineIds, load: false });
    const inventory = React.useMemo(() => machines.map(machine => readInstalledMachineAgentInventory(
        machine.metadata?.agentInventory, cached.get(machine.id), definitionsForInventory?.map(definition => definition.id))),
    [machines, cached, definitionsForInventory]);
    const reach = React.useMemo<readonly ReachMachine[]>(() => machines.map((machine, index) => ({
        machineId: machine.id, platform: machine.metadata?.platform === 'win32' ? 'win32'
            : machine.metadata?.platform ? 'posix' : null,
        agentIds: inventory[index]!.agentIds, agentInventoryComplete: inventory[index]!.complete,
        name: machine.metadata?.displayName ?? machine.metadata?.host ?? null,
        // Inventory is recorded membership, not a fresh presence observation.
        online: null, offline: false, lastSeenAt: null,
    })), [machines, inventory]);
    const unknownInventory = React.useMemo(() => readInstalledMachineAgentInventory(undefined, undefined), []);
    const incomplete = input.projectKey && projects?.coverage !== 'complete' ? projects
        : inventory.find(item => !item.complete) ?? (held.snapshot?.kind !== 'resolved'
        || held.snapshot.settled !== true ? held.snapshot ?? unknownInventory : undefined);
    return { ...held, machines, reach, inventory, incomplete, projects, projectLoading: Boolean(input.projectKey && !projects) };
}

function projectPlacement(rules: ReachRulesV1, reach: readonly ReachMachine[], input: StoreInstalledInput,
    projects: ProjectAccountRowsSnapshot | null) {
    return projectReachOnMachines(rules, reach, input.projectKey ?? undefined, projects?.workspaceRefs ?? []);
}

function matchesPlacement(input: StoreInstalledInput, reach: readonly ReachMachineProjection[]): boolean {
    return !input.machine && !input.projectKey || reach.some(machine => machine.agents.some(agent => agent.enabled));
}

export function useInstalledMcpServers(input: StoreInstalledInput, demand: StoreDemand, admitted: InstalledScopeAdmission): InstalledMcpServersResult {
    const native = useMcpServerCatalogForServer(admitted.scope?.serverId ?? null, demand.presented, input.scope);
    const retry = React.useCallback(() => admitted.scope ? refreshMcpServerCatalog(admitted.scope) : Promise.resolve(), [admitted.scope]);
    const held = useInstalledReach(input, demand, admitted.scope, undefined);
    // The catalog admission owner retains unchanged native row identities. Carry
    // those identities through this row producer while placement remains equal.
    const projectRows = React.useMemo(() => {
        const scope = admitted.scope;
        let previous: readonly InstalledMcpServerRow[] = EMPTY_ROWS;
        return (value: McpServerCatalogValueSnapshot['value']): readonly InstalledMcpServerRow[] => {
            if (!scope) return EMPTY_ROWS;
            const byNative = new Map(previous.map(row => [row.native, row]));
            previous = (value?.servers ?? []).map(server => byNative.get(server) ?? ({ kind: 'mcpServer' as const,
                key: serverAccountScopedResourceKey(scope, 'mcpServer', server.id), scope, native: server,
                reach: projectPlacement(value?.bindings.filter(rule => rule.serverId === server.id) ?? [], held.reach, input, held.projects) }))
                .filter(row => matchesPlacement(input, row.reach));
            return previous;
        };
    }, [admitted.scope, native.value?.bindings, held.reach, held.projects, input.machine, input.projectKey]);
    const rows = React.useMemo(() => projectRows(native.value), [projectRows, native.value]);
    return React.useMemo<InstalledMcpServersResult>(() => {
        if (!admitted.scope) return { rows: EMPTY_ROWS, coverage: admitted.coverage };
        if (held.failure) return { rows: EMPTY_ROWS, coverage: { unavailable: held.failure } };
        return { rows, ...(demand.presented && native.status === 'unavailable' ? { continuation: retry } : {}),
            coverage: native.status === 'unavailable' ? { unavailable: native } : native.status === 'loading' || held.projectLoading ? 'loading'
            : native.status === 'partial' ? { partial: native } : held.incomplete ? { partial: held.incomplete } : 'available' };
    }, [admitted.scope, admitted.coverage, held.failure, held.incomplete, held.projectLoading, native, rows, demand.presented, retry]);
}

export function useInstalledSkills(input: StoreInstalledInput, demand: StoreDemand, admitted: InstalledScopeAdmission): InstalledSkillsResult {
    const native = useSkillsLibrary(admitted.scope, { enabled: demand.presented });
    const held = useInstalledReach(input, demand, admitted.scope, undefined);
    return React.useMemo<InstalledSkillsResult>(() => {
        if (!admitted.scope) return { rows: EMPTY_ROWS, coverage: admitted.coverage };
        if (held.failure) return { rows: EMPTY_ROWS, coverage: { unavailable: held.failure } };
        const scope = admitted.scope;
        const rows = native.items.map(skill => ({ kind: 'skill' as const,
            key: serverAccountScopedResourceKey(scope, 'skill', skill.skillId), scope, native: skill,
            reach: projectPlacement(skill.rules, held.reach, input, held.projects) })).filter(row => matchesPlacement(input, row.reach));
        return { rows, ...(demand.presented ? { continuation: native.retry } : {}),
            coverage: native.status === 'unavailable' ? { unavailable: native } : native.status === 'loading' || held.projectLoading ? 'loading'
            : native.unavailableItems?.length ? { partial: native } : held.incomplete ? { partial: held.incomplete } : 'available' };
    }, [admitted.scope, admitted.coverage, held.failure, held.incomplete, held.reach, held.projects, held.projectLoading, input, native, demand.presented]);
}

export function useInstalledAgents(input: StoreInstalledInput, demand: StoreDemand, admitted: InstalledScopeAdmission): InstalledAgentsResult {
    const { snapshot } = useAcpCatalog(admitted.scope, { enabled: demand.presented });
    const held = useInstalledReach(input, demand, admitted.scope, snapshot?.data?.definitions);
    const projectRows = React.useMemo(() => createInstalledAgentRowsProjection(admitted.scope), [admitted.scope]);
    const rows = React.useMemo(() => projectRows(
        input.machine === null && input.projectKey === null ? snapshot?.data?.definitions ?? [] : [], held.machines, held.inventory),
    [projectRows, input.machine, input.projectKey, snapshot?.data?.definitions, held.machines, held.inventory]);
    return React.useMemo<InstalledAgentsResult>(() => {
        if (!admitted.scope) return { rows: EMPTY_ROWS, coverage: admitted.coverage };
        if (held.failure) return { rows: EMPTY_ROWS, coverage: { unavailable: held.failure } };
        const native = snapshot?.catalog;
        return { rows, coverage: native?.status === 'unavailable' ? { unavailable: native }
            : !native || native.status === 'loading' || held.projectLoading ? 'loading' : native.status === 'partial' ? { partial: native }
                : held.incomplete ? { partial: held.incomplete } : 'available' };
    }, [admitted.scope, admitted.coverage, held.failure, held.incomplete, held.projectLoading, rows, snapshot]);
}

export function useInstalledProviders(input: StoreInstalledInput, demand: StoreDemand, admitted: InstalledScopeAdmission): InstalledProvidersResult {
    const snapshot = useProviderCatalog(admitted.scope, { enabled: demand.presented });
    const held = useInstalledMachines(input, { presented: demand.presented && input.machine !== null }, admitted.scope);
    return React.useMemo<InstalledProvidersResult>(() => {
        if (!admitted.scope) return { rows: EMPTY_ROWS, coverage: admitted.coverage };
        if (held.failure) return { rows: EMPTY_ROWS, coverage: { unavailable: held.failure } };
        const scope = admitted.scope;
        const catalog = snapshot?.data;
        const views = new Map((catalog ? describeAccountProviderConnectionsV1(catalog,
            readAccountProviderDeclarations({ kind: 'account' })).connections : []).map(view => [view.connectionId, view]));
        // Connections have Account/Machine grants, never Project membership. A checkout on the
        // granted Machine does not make the connection a Project resource.
        const rows = input.projectKey ? EMPTY_ROWS : catalog?.connections.flatMap(connection => {
            const view = views.get(connection.id)!;
            const machineId = input.machine?.machineId;
            if (machineId && !view.grants.enabledMachineIds.includes(machineId)
                && !(view.deployment.kind === 'managedLocal' && view.deployment.targetMachineId === machineId)) return [];
            return [{ kind: 'provider' as const, scope, native: connection, catalog, view,
                key: serverAccountScopedResourceKey(scope, 'provider', connection.id) }];
        }) ?? EMPTY_ROWS;
        const native = snapshot?.catalog;
        return { rows, coverage: !native || native.status === 'loading' ? 'loading'
            : native.status === 'unavailable' ? { unavailable: native } : native.status === 'partial' ? { partial: native } : 'available' };
    }, [admitted.scope, admitted.coverage, held.failure, input.machine, input.projectKey, snapshot]);
}

export function useInstalledPlugins(input: StoreInstalledInput, demand: StoreDemand, admitted: InstalledScopeAdmission): InstalledPluginsResult {
    const reader = usePluginAccountAvailabilityReader(admitted.scope, undefined, { enabled: demand.presented && admitted.scope !== null });
    const native = React.useMemo(() => reader?.readInstalledPlugins() ?? null, [reader]);
    const held = useInstalledMachines(input, demand, admitted.scope);
    const selectedTarget = admitted.scope && !held.failure && input.projectKey === null ? input.machine : null;
    const executionTarget = React.useMemo(() => selectedTarget && demand.presented
        ? resolveFreshMachineAdministrationExecutionTarget(selectedTarget, { accountScope: admitted.scope }) : null,
    [selectedTarget, demand.presented, admitted.scope, held.snapshot]);
    const details = usePluginMachineDetails({ selectedTarget, executionTarget, enabled: demand.presented });
    const detailById = React.useMemo(() => new Map(details.installedPlugins.map(detail => [detail.pluginId, detail])), [details.installedPlugins]);
    return React.useMemo<InstalledPluginsResult>(() => {
        if (!admitted.scope) return { rows: EMPTY_ROWS, coverage: admitted.coverage };
        if (held.failure) return { rows: EMPTY_ROWS, coverage: { unavailable: held.failure } };
        if (!native) throw new Error('An admitted Account requires its scoped Plugin availability reader');
        // The Account's availability arrives after the page opens; until then Plugins are loading, not failed.
        if (native.kind === 'unavailable' && native.code === 'account_availability_not_loaded') return { rows: EMPTY_ROWS, coverage: 'loading' };
        if (native.kind !== 'available') return { rows: EMPTY_ROWS, coverage: { unavailable: native } };
        const scope = admitted.scope;
        // Native materializations have Home/Machine placement only; neither their declarations
        // nor a checkout on that Machine establishes Project installation membership.
        const rows = input.projectKey ? EMPTY_ROWS : native.plugins.flatMap(plugin => {
            const target = input.machine;
            const installations = target ? plugin.installations.filter(installation => installation.materialization.machineId === target.machineId
                && areServerProfileIdentifiersEquivalent(installation.materialization.serverIdentityId, target.serverIdentityId)) : plugin.installations;
            const detail = demand.presented && target ? detailById.get(plugin.pluginId) : undefined;
            return !target || installations.length ? [{ kind: 'plugin' as const, scope, native: plugin, installations,
                ...(detail ? { detail } : {}),
                key: serverAccountScopedResourceKey(scope, 'plugin', plugin.pluginId) }] : [];
        });
        const detailState = executionTarget ? details.machineCapabilities.state : null;
        return { rows, ...(executionTarget ? { continuation: details.refreshOnDemand } : {}),
            coverage: native.completeness !== 'complete' ? { partial: native }
            : detailState?.status === 'idle' || detailState?.status === 'loading' ? 'loading'
            : detailState?.status === 'error' || detailState?.status === 'not-supported' ? { partial: detailState }
            : held.snapshot?.kind === 'resolved' && held.snapshot.settled !== true ? { partial: held.snapshot }
                : !held.snapshot && demand.presented ? 'loading' : 'available' };
    }, [admitted.scope, admitted.coverage, held.failure, held.snapshot, demand.presented, input.machine, input.projectKey, reader, native,
        detailById, selectedTarget, executionTarget, details.machineCapabilities.state, details.refreshOnDemand]);
}
