import type { CapabilitiesDetectResponse, CapabilityDetectResult } from '@/sync/api/capabilities/capabilitiesProtocol';
import { getLatestMachineCapabilityCacheState, subscribeLatestMachineCapabilityCacheState } from '@/hooks/server/useMachineCapabilitiesCache';
import { buildMachineUpdateFactsRequest } from '@/capabilities/requests';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { getStorage } from '@/sync/domains/state/storage';
import { subscribeMachineUpdates } from '@/sync/store/domains/machines';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

/** One question in the existing capability store, shared by cold discovery and open Updates. */
export const MACHINE_UPDATE_FACTS_CACHE_SALT = 'updates';

type Target = Readonly<{ machineId: string; serverId?: string | null; accountId?: string | null }>;

function isFactRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function installationFacts(result: CapabilityDetectResult | undefined): readonly unknown[] | null {
    const data = result?.ok ? result.data : null;
    if (!isFactRecord(data)) return null;
    // Latest registry answers, check timestamps, login labels and progress are
    // outputs, not installation inputs. Never retain authentication material.
    return [data.available ?? null, data.installed ?? null, data.version ?? null, data.installedVersion ?? null,
        data.installSource ?? null, data.resolutionSource ?? null, data.resolvedPath ?? null, data.sourceKind ?? null,
        Array.isArray(data.kinds) ? data.kinds.filter((kind): kind is string => typeof kind === 'string').sort() : null];
}

/** Capture the actual inputs; an unrelated registry publication is not a new installation. */
export function createMachineUpdateFactsCacheInputKey(target: Target): (response?: CapabilitiesDetectResponse) => string {
    const machine = resolveServerScopedMachine(getStorage().getState(), target.serverId, target.machineId);
    const identity = [machine?.daemonState?.runtimeId ?? null, machine?.daemonState?.startedAt ?? null,
        machine?.daemonState?.pid ?? null, machine?.metadata?.platform ?? null, machine?.metadata?.arch ?? null,
        machine?.metadata?.agentInventory ? [...machine.metadata.agentInventory.installedAgentIds].sort() : null];
    const observed = (buildMachineUpdateFactsRequest().requests ?? []).map(({ id }) => {
        const state = getLatestMachineCapabilityCacheState(target.machineId, target.serverId, id, target.accountId);
        const result = state && 'snapshot' in state ? state.snapshot?.response.results[id] : undefined;
        return { id, result };
    });
    return response => JSON.stringify([identity, observed.map(({ id, result }) =>
        [id, installationFacts(response?.results[id] ?? result)])]);
}

/** Reuse the installation and capability publishers; there is no additional fact store or clock. */
export function subscribeMachineUpdateFactsInputs(target: Target, listener: () => void): () => void {
    const disposers = (buildMachineUpdateFactsRequest().requests ?? []).map(({ id }) =>
        subscribeLatestMachineCapabilityCacheState(target.machineId, target.serverId, id, listener, target.accountId));
    disposers.push(subscribeMachineUpdates((serverId, ids) => {
        if (areServerProfileIdentifiersEquivalent(serverId, target.serverId) && ids.includes(target.machineId)) listener();
    }));
    return () => { for (const dispose of disposers) dispose(); };
}
