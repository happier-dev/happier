import type { BackendTargetRefV1, BackendTargetRefV2 } from '@happier-dev/protocol';
import { buildProviderCliCapabilityId } from '@/capabilities/cliCapabilityId';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import {
    isDynamicModelProbeCacheFresh,
    readDynamicModelProbeCache,
    runDynamicModelProbeDedupe,
    writeDynamicModelProbeCacheError,
    writeDynamicModelProbeCacheUnavailable,
    writeDynamicModelProbeCacheSuccess,
    writeDynamicModelProbeCacheTransientSuccess,
    type DynamicModelProbeCacheEntry,
} from '@/sync/domains/models/dynamicModelProbeCache';
import { parsePreflightModelListFromProbeModelsResult } from '@/sync/domains/models/parsePreflightModelListFromProbeModelsResult';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { invokeAgentInventoryProbeAction } from './actions/agentInventoryActionDeps';
import type { MachineCapabilitiesInvokeResult } from './capabilities';

/** Shared discovery lifecycle for model pickers and voice catalog requests. */
type MachineModelDiscoveryParams = Readonly<{
    cacheKey: string;
    agentType: string;
    machineId: string;
    serverId?: string | null;
    backendTarget?: BackendTargetRefV1 | BackendTargetRefV2 | null;
    successMaxAgeMs?: number;
    timeoutMs?: number;
    capabilityParams: Readonly<Record<string, unknown>>;
    bypassCache?: boolean;
}>;

export async function discoverMachineModels(params: MachineModelDiscoveryParams): Promise<DynamicModelProbeCacheEntry | null> {
    return discoverMachineModelsWithTransport(params, () => invokeAgentInventoryProbeAction({
        agentId: params.agentType, machineId: params.machineId, serverId: params.serverId,
        backendTarget: params.backendTarget,
        capabilityParams: params.capabilityParams,
        transportTimeoutMs: params.timeoutMs,
        bypassCache: params.bypassCache,
    }, 'probeModels'));
}

/** The inventory Action is already admitted; do not recurse into its own front door. */
export async function discoverMachineModelsForActions(params: MachineModelDiscoveryParams): Promise<DynamicModelProbeCacheEntry | null> {
    return discoverMachineModelsWithTransport(params, () => machineCapabilitiesInvoke(params.machineId, {
        id: buildProviderCliCapabilityId(params.agentType), method: 'probeModels',
        params: { ...params.capabilityParams, ...(params.backendTarget ? { backendTarget: params.backendTarget } : {}),
            ...(params.bypassCache ? { bypassCache: true } : {}) },
    }, { ...(params.serverId ? { serverId: params.serverId } : {}), ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}) }));
}

async function discoverMachineModelsWithTransport(params: MachineModelDiscoveryParams, invoke: () => Promise<MachineCapabilitiesInvokeResult>): Promise<DynamicModelProbeCacheEntry | null> {
    const cached = readDynamicModelProbeCache(params.cacheKey, params.successMaxAgeMs);
    if (!params.bypassCache && isDynamicModelProbeCacheFresh(cached)) return cached;

    return runDynamicModelProbeDedupe(params.cacheKey, async () => {
        try {
            const response = await invoke();
            if (response.supported && response.response.ok) {
                const result = response.response.result;
                const record = result && typeof result === 'object' && !Array.isArray(result)
                    ? result as Record<string, unknown> : null;
                // Older daemons ignore session runtime context and return account-default rows.
                const runtimeAccepted = params.capabilityParams.runtimeDescriptorV1 == null
                    || record?.runtimeDescriptorV1Accepted === true;
                const parsed = runtimeAccepted ? parsePreflightModelListFromProbeModelsResult(result) : null;
                if (parsed && record) {
                    if (parsed.unavailable === true) {
                        writeDynamicModelProbeCacheUnavailable(params.cacheKey);
                        return readDynamicModelProbeCache(params.cacheKey, params.successMaxAgeMs);
                    }
                    const previous = readDynamicModelProbeCache(params.cacheKey, params.successMaxAgeMs);
                    const previousList = previous?.kind === 'success' && !previous.value.unavailable ? previous.value : null;
                    const list = previousList && stableJsonStringify(previousList) === stableJsonStringify(parsed) ? previousList : parsed;
                    const failed = record.refreshError === true || (record.source === 'static' && record.refreshError !== false);
                    const observedAt = typeof record.observedAt === 'number' && Number.isFinite(record.observedAt)
                        ? record.observedAt : Date.now();
                    if (!failed) {
                        if (record.cacheable === false) {
                            writeDynamicModelProbeCacheTransientSuccess(params.cacheKey, list, observedAt);
                        } else {
                            writeDynamicModelProbeCacheSuccess(params.cacheKey, list, observedAt);
                        }
                        return readDynamicModelProbeCache(params.cacheKey, params.successMaxAgeMs);
                    }
                    if (!previousList || (record.source !== 'static' && typeof record.observedAt === 'number' && previous?.kind === 'success' && record.observedAt > previous.updatedAt)) {
                        // A daemon can retain a real last-good observation after failure. A static fallback
                        // is display-only and must never acquire a successful-observation timestamp.
                        writeDynamicModelProbeCacheTransientSuccess(params.cacheKey, list, observedAt, record.source === 'static' || typeof record.observedAt !== 'number');
                    }
                }
            }
        } catch {
            // Transport failures are visible through the resource error state, including retained data.
        }
        writeDynamicModelProbeCacheError(params.cacheKey);
        return readDynamicModelProbeCache(params.cacheKey, params.successMaxAgeMs);
    });
}
