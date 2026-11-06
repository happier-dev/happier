import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import { readLocalDaemonSharedState } from '@/components/settings/machines/localControl/localDaemonSharedState';
import type { LocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { isDaemonOnActiveRelay } from '@/sync/domains/server/relayDrift/relayDriftModel';
import { getPluginMachineExecutionOriginRef } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { ServerMachineInventorySnapshotV1 } from '@/sync/domains/machines/machineInventorySnapshots';
import { getPluginExecutionOriginCandidateOrigin, readPluginMachineScopedContributors, type PluginExecutionOriginCandidateV1,
    type PluginExecutionOriginNativeToolAuthentication } from './pluginExecutionOrigin';
import { readPluginMachineExecutionLastUsedTarget } from './selectionPreferences';
import { resolveFreshMachineAdministrationExecutionTarget } from './useTargetSelection';

import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { BUILT_IN_INSTALLABLES_REGISTRY } from '@happier-dev/protocol/installables';
import { getLatestMachineCapabilityCacheState, subscribeLatestMachineCapabilityCacheState } from '@/hooks/server/useMachineCapabilitiesCache';
import type { PluginAccountInstalledPluginsAdmission } from '@/sync/domains/plugins/availability/reader';

const nativeCapabilityByTool = new Map(BUILT_IN_INSTALLABLES_REGISTRY.descriptors.flatMap(({ descriptor }) =>
    descriptor.binary.commands.map(command => [command, descriptor.capabilityId] as const)));

function nativeToolRequests(pluginId: string, materializations: readonly PluginMachineMaterializationV1[],
    machineSnapshots?: readonly ServerMachineInventorySnapshotV1[], installedPlugins?: PluginAccountInstalledPluginsAdmission) {
    const scope = getActiveServerAccountScope();
    const profile = scope && getServerProfileById(scope.serverId);
    const homes = new Map(machineSnapshots?.flatMap(snapshot => snapshot.kind === 'resolved'
        ? [[snapshot.serverIdentityId, { serverId: snapshot.profileId, accountId: snapshot.accountId }] as const] : []) ?? []);
    const requests = new Map<string, Omit<PluginExecutionOriginNativeToolAuthentication, 'authenticated'> & Readonly<{
        serverId: string; accountId: string; capabilityId: NonNullable<ReturnType<typeof nativeCapabilityByTool.get>>;
    }>>();
    for (const { materialization, nativeSystemTools } of readPluginMachineScopedContributors(pluginId, materializations, installedPlugins)) {
        const home = homes.get(materialization.serverIdentityId) ?? (profile?.serverIdentityId === materialization.serverIdentityId && scope
            ? { serverId: scope.serverId, accountId: scope.accountId } : null);
        if (!home || home.accountId === null) continue;
        for (const systemTool of nativeSystemTools) {
            const capabilityId = nativeCapabilityByTool.get(systemTool);
            if (!capabilityId) continue;
            const target = { serverIdentityId: materialization.serverIdentityId, machineId: materialization.machineId, systemTool };
            requests.set(JSON.stringify(target), { ...target, serverId: home.serverId, accountId: home.accountId, capabilityId });
        }
    }
    return [...requests.values()];
}

function readNativeToolAuthentication(requests: ReturnType<typeof nativeToolRequests>): readonly PluginExecutionOriginNativeToolAuthentication[] {
    return requests.flatMap(request => {
        const state = getLatestMachineCapabilityCacheState(request.machineId, request.serverId, request.capabilityId, request.accountId);
        const result = state && 'snapshot' in state ? state.snapshot?.response.results[request.capabilityId] : undefined;
        const data = result?.ok && result.data && typeof result.data === 'object' ? result.data : null;
        if (!data || !('installed' in data) || !('authenticated' in data)
            || typeof data.installed !== 'boolean' || typeof data.authenticated !== 'boolean') return [];
        return [{ serverIdentityId: request.serverIdentityId, machineId: request.machineId, systemTool: request.systemTool,
            authenticated: data.installed && data.authenticated }];
    });
}

/** Passive observations only: no capability request, retry, clock or plugin configuration read. */
export function subscribePluginExecutionOriginNativeToolAuthentication(pluginId: string, materializations: readonly PluginMachineMaterializationV1[],
    machineSnapshots: readonly ServerMachineInventorySnapshotV1[], listener: () => void,
    installedPlugins?: PluginAccountInstalledPluginsAdmission): () => void {
    const requests = nativeToolRequests(pluginId, materializations, machineSnapshots, installedPlugins);
    let previous = JSON.stringify(readNativeToolAuthentication(requests));
    const changed = () => {
        const next = JSON.stringify(readNativeToolAuthentication(requests));
        if (next === previous) return;
        previous = next;
        listener();
    };
    const stops = requests.map(request => subscribeLatestMachineCapabilityCacheState(request.machineId, request.serverId,
        request.capabilityId, changed, request.accountId));
    return () => stops.forEach(stop => stop());
}

/** Existing local/desktop facts only; election remains Administration-owned. */
export function readPluginExecutionOriginAutomaticHints(pluginId: string, candidates: readonly PluginExecutionOriginCandidateV1[],
    machineSnapshots?: readonly ServerMachineInventorySnapshotV1[],
    sourceMaterializations: readonly PluginMachineMaterializationV1[] = [], installedPlugins?: PluginAccountInstalledPluginsAdmission) {
    const scope = getActiveServerAccountScope();
    const profile = scope && getServerProfileById(scope.serverId);
    const local = readLocalDaemonSharedState<LocalDaemonStatusData>(getSystemTasksRunner()).status;
    const localMachineTarget = local?.machineId && profile?.serverIdentityId && local.daemonAccountId === scope?.accountId
        && isDaemonOnActiveRelay({ activeRelayUrl: profile.serverUrl, daemonRelayUrl: local.daemonServerUrl }) === true
        ? { serverIdentityId: profile.serverIdentityId, machineId: local.machineId } : null;
    const machineActivity = machineSnapshots ? machineSnapshots.flatMap(snapshot => snapshot.kind === 'resolved'
        ? snapshot.machines.map(machine => ({ serverIdentityId: snapshot.serverIdentityId, machineId: machine.id, activeAt: machine.activeAt })) : [])
        : candidates.flatMap(candidate => {
            const origin = getPluginExecutionOriginCandidateOrigin(candidate);
            const target = { serverIdentityId: origin.serverIdentityId, machineId: getPluginMachineExecutionOriginRef(origin).machineId };
            const fresh = resolveFreshMachineAdministrationExecutionTarget(target);
            return fresh ? [{ ...target, activeAt: fresh.machine.activeAt }] : [];
        });
    return { lastUsedTarget: readPluginMachineExecutionLastUsedTarget(scope, pluginId),
        localMachineTarget, machineActivity, sourceMaterializations, installedPlugins,
        nativeToolAuthentication: readNativeToolAuthentication(nativeToolRequests(pluginId, sourceMaterializations, machineSnapshots, installedPlugins)) };
}
