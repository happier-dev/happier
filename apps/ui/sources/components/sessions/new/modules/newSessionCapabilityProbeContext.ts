import { ConnectedServiceBindingsV1Schema, readBackendTargetRefV2, type BackendTargetRefV2, type ConnectedServiceBindingsV1 } from '@happier-dev/protocol';
import { getAgentModelConfig, resolveAgentConfiguredRuntimeKind } from '@happier-dev/agents';

import { resolveCatalogAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { isAgentId, type AgentId } from '@/agents/catalog/catalog';
import type { Settings } from '@/sync/domains/settings/settings';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

export type NewSessionCapabilityProbeContext = Readonly<{
    cacheKeySuffixParts?: readonly string[] | null;
    capabilityParams?: Readonly<Record<string, unknown>> | null;
    modelSuccessCacheMaxAgeMs?: number | null;
}>;

const MAX_CACHED_PROBE_CONTEXTS = 32;
const probeContextByKey = new Map<string, NewSessionCapabilityProbeContext>();

function getOrCreateProbeContext(params: Readonly<{
    key: string;
    cacheKeySuffixParts: readonly string[];
    capabilityParams: Readonly<Record<string, unknown>>;
    modelSuccessCacheMaxAgeMs?: number | null;
}>): NewSessionCapabilityProbeContext {
    const key = params.key.trim();
    const existing = probeContextByKey.get(key);
    if (existing) {
        probeContextByKey.delete(key);
        probeContextByKey.set(key, existing);
        return existing;
    }

    const created: NewSessionCapabilityProbeContext = Object.freeze({
        cacheKeySuffixParts: Object.freeze([...params.cacheKeySuffixParts]),
        capabilityParams: Object.freeze({ ...params.capabilityParams }),
        ...(params.modelSuccessCacheMaxAgeMs
            ? { modelSuccessCacheMaxAgeMs: params.modelSuccessCacheMaxAgeMs }
            : {}),
    });

    probeContextByKey.set(key, created);
    while (probeContextByKey.size > MAX_CACHED_PROBE_CONTEXTS) {
        const oldest = probeContextByKey.keys().next();
        if (oldest.done) break;
        probeContextByKey.delete(oldest.value);
    }

    return created;
}

export function normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts(
    probeContext: NewSessionCapabilityProbeContext | null | undefined,
): readonly string[] | null {
    const raw = probeContext?.cacheKeySuffixParts;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const normalized = raw.map((part) => String(part ?? '').trim()).filter(Boolean);
    return normalized.length > 0 ? normalized : null;
}

export function buildNewSessionCapabilityProbeContextKey(probeContext: NewSessionCapabilityProbeContext | null | undefined): string {
    return stableJsonStringify({
        cacheKeySuffixParts: probeContext?.cacheKeySuffixParts ?? null,
        capabilityParams: probeContext?.capabilityParams ?? null,
        modelSuccessCacheMaxAgeMs: probeContext?.modelSuccessCacheMaxAgeMs ?? null,
    });
}

export function resolveNewSessionCapabilityProbeContext(params: Readonly<{
    backendTarget: BackendTargetRefV2;
    settings: Settings;
    runtimeCarrierAgentId?: AgentId | null;
}>): NewSessionCapabilityProbeContext | null {
    const backendTarget = readBackendTargetRefV2(params.backendTarget);
    const agentId = isAgentId(params.runtimeCarrierAgentId)
        ? params.runtimeCarrierAgentId
        : (resolveCatalogAgentIdForBackendTarget(backendTarget)
            ?? (isAgentId(backendTarget.backendId) ? backendTarget.backendId : null));
    if (!agentId) {
        return null;
    }
    const runtimeKind = resolveAgentConfiguredRuntimeKind({
        agentId,
        accountSettings: params.settings as unknown as Record<string, unknown>,
    });
    if (!runtimeKind) return null;

    return getOrCreateProbeContext({
        key: `runtime:${runtimeKind}`,
        cacheKeySuffixParts: [runtimeKind],
        capabilityParams: { runtimeKindOverride: runtimeKind },
    });
}

export function resolveNewSessionModelCapabilityProbeContext(params: Readonly<{
    backendTarget: BackendTargetRefV2;
    settings: Settings;
    runtimeCarrierAgentId?: AgentId | null;
    connectedServices?: ConnectedServiceBindingsV1 | null;
    connectedServicesCacheIdentity?: string | null;
}>): NewSessionCapabilityProbeContext | null {
    const shared = resolveNewSessionCapabilityProbeContext(params);
    const backendTarget = readBackendTargetRefV2(params.backendTarget);
    const agentId = isAgentId(params.runtimeCarrierAgentId)
        ? params.runtimeCarrierAgentId
        : (resolveCatalogAgentIdForBackendTarget(backendTarget)
            ?? (isAgentId(backendTarget.backendId) ? backendTarget.backendId : null));
    const observation = agentId ? getAgentModelConfig(agentId).nativeCatalogObservation : null;
    const bindings = ConnectedServiceBindingsV1Schema.safeParse(params.connectedServices);
    const selection = observation && bindings.success
        ? bindings.data.bindingsByServiceId[observation.connectedServiceId]
        : null;
    if (!observation || selection?.source !== 'connected') return shared;
    const selectedIdentity = selection.selection === 'group'
        ? `${observation.connectedServiceId}:group:${selection.groupId}`
        : `${observation.connectedServiceId}:profile:${selection.profileId}`;
    const cacheKeySuffixParts = [
        ...(shared?.cacheKeySuffixParts ?? []),
        selectedIdentity,
        ...(params.connectedServicesCacheIdentity ? [params.connectedServicesCacheIdentity] : []),
    ];
    const capabilityParams = {
        ...(shared?.capabilityParams ?? {}),
        connectedServices: bindings.data,
    };
    return getOrCreateProbeContext({
        key: stableJsonStringify({ cacheKeySuffixParts, capabilityParams }),
        cacheKeySuffixParts,
        capabilityParams,
        modelSuccessCacheMaxAgeMs: 5 * 60_000,
    });
}
