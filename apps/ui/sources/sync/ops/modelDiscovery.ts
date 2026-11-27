import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import type { AgentId } from '@/agents/catalog/catalog';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import {
    isDynamicModelProbeCacheFresh,
    readDynamicModelProbeCache,
    runDynamicModelProbeDedupe,
    writeDynamicModelProbeCacheError,
    writeDynamicModelProbeCacheSuccess,
    writeDynamicModelProbeCacheTransientSuccess,
    type DynamicModelProbeCacheEntry,
} from '@/sync/domains/models/dynamicModelProbeCache';
import { parsePreflightModelListFromProbeModelsResult } from '@/sync/domains/models/parsePreflightModelListFromProbeModelsResult';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { readNonBlankSessionControlIdentifier } from '@/sync/domains/sessionControl/opaqueIdentifiers';
import { findModelOptionForEffectiveModelId } from '@/sync/domains/models/modelOptions';

type MachineModelProbeInput = Readonly<{
    agentType: AgentId;
    machineId: string;
    serverId?: string | null;
    backendTarget: BackendTargetRefV1;
    capabilityParams: Readonly<Record<string, unknown>>;
    bypassCache?: boolean;
    includeConfiguredModel?: boolean;
}>;

async function requestMachineModelProbe(params: MachineModelProbeInput): Promise<Record<string, unknown> | null> {
    const response = await machineCapabilitiesInvoke(params.machineId, {
        id: `cli.${params.agentType}`,
        method: 'probeModels',
        params: {
            ...params.capabilityParams,
            backendTarget: params.backendTarget,
            ...(params.bypassCache ? { bypassCache: true } : {}),
            ...(params.includeConfiguredModel ? { includeConfiguredModel: true } : {}),
        },
    }, { ...(params.serverId ? { serverId: params.serverId } : {}) });
    const result = response.supported && response.response.ok ? response.response.result : null;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
    return result as Record<string, unknown>;
}

/** Coordinates for which the wizard obtained an observation. */
export type LaunchModelAdvisoryTarget = Readonly<{ machineId: string; serverId: string; cwd: string }>;
type MachineModelDiscovery = Readonly<{
    entry: DynamicModelProbeCacheEntry | null;
    missingConfiguredModelId?: string;
}>;

/** Shared discovery lifecycle for model pickers and voice catalog requests. */
export async function discoverMachineModels(params: MachineModelProbeInput & Readonly<{
    cacheKey: string;
}>): Promise<MachineModelDiscovery> {
    const cached = readDynamicModelProbeCache(params.cacheKey);
    if (!params.bypassCache && isDynamicModelProbeCacheFresh(cached)) return { entry: cached };

    const requestKey = stableJsonStringify([params.cacheKey, Boolean(params.bypassCache), Boolean(params.includeConfiguredModel)]);
    return runDynamicModelProbeDedupe(requestKey, async () => {
        try {
            const record = await requestMachineModelProbe(params);
            const parsed = parsePreflightModelListFromProbeModelsResult(record);
            if (parsed && record) {
                const previous = readDynamicModelProbeCache(params.cacheKey);
                const previousList = previous?.kind === 'success' ? previous.value : null;
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
                    const configuredModelId = params.includeConfiguredModel && record.source === 'dynamic'
                        ? readNonBlankSessionControlIdentifier(record.configuredModelId)
                        : null;
                    const missingConfiguredModelId = configuredModelId && !findModelOptionForEffectiveModelId(
                        list.availableModels
                            .filter(({ id }) => id !== 'default')
                            .map(({ id, extendedContextModelId }) => ({ value: id, extendedContextModelId })),
                        configuredModelId,
                    ) ? configuredModelId : undefined;
                    return { entry: readDynamicModelProbeCache(params.cacheKey), missingConfiguredModelId };
                }
                if (!previousList || (record.source !== 'static' && typeof record.observedAt === 'number' && previous?.kind === 'success' && record.observedAt > previous.updatedAt)) {
                    // A daemon can retain a real last-good observation after failure. A static fallback
                    // is display-only and must never acquire a successful-observation timestamp.
                    writeDynamicModelProbeCacheTransientSuccess(params.cacheKey, list, observedAt, record.source === 'static' || typeof record.observedAt !== 'number');
                }
            }
        } catch {
            // Transport failures are visible through the resource error state, including retained data.
        }
        writeDynamicModelProbeCacheError(params.cacheKey);
        return { entry: readDynamicModelProbeCache(params.cacheKey) };
    });
}
