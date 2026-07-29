import { readBackendTargetRefV2, type BackendTargetRefV2 } from '@happier-dev/protocol';
import { resolveAgentConfiguredRuntimeKind } from '@happier-dev/agents';

import { resolveCatalogAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { isAgentId, type AgentId } from '@/agents/catalog/catalog';
import type { Settings } from '@/sync/domains/settings/settings';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

export type NewSessionCapabilityProbeContext = Readonly<{
    cacheKeySuffixParts?: readonly string[] | null;
    capabilityParams?: Readonly<Record<string, unknown>> | null;
}>;

const MAX_CACHED_PROBE_CONTEXTS = 32;
const probeContextByKey = new Map<string, NewSessionCapabilityProbeContext>();

function getOrCreateProbeContext(params: Readonly<{
    key: string;
    cacheKeySuffixParts: readonly string[];
    capabilityParams: Readonly<Record<string, unknown>>;
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
    });

    probeContextByKey.set(key, created);
    while (probeContextByKey.size > MAX_CACHED_PROBE_CONTEXTS) {
        const oldest = probeContextByKey.keys().next();
        if (oldest.done) break;
        probeContextByKey.delete(oldest.value);
    }

    return created;
}

function hasConnectedServicesPayload(value: unknown): boolean {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
    });
}

export function resolveNewSessionCapabilityProbeContext(params: Readonly<{
    backendTarget: BackendTargetRefV2;
    settings: Settings;
    runtimeCarrierAgentId?: AgentId | null;
    connectedServices?: unknown;
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
    const hasConnectedServices = hasConnectedServicesPayload(params.connectedServices);
    if (!runtimeKind && !hasConnectedServices) return null;

    if (runtimeKind && !hasConnectedServices) {
        return getOrCreateProbeContext({
            key: `runtime:${runtimeKind}`,
            cacheKeySuffixParts: [runtimeKind],
            capabilityParams: { runtimeKindOverride: runtimeKind },
        });
    }

    const connectedServicesKey = hasConnectedServices ? stableJsonStringify(params.connectedServices) : '';
    const cacheKeySuffixParts = [
        ...(runtimeKind ? [`runtime:${runtimeKind}`] : []),
        ...(hasConnectedServices ? [`connectedServices:${connectedServicesKey}`] : []),
    ];
    const capabilityParams = {
        ...(runtimeKind ? { runtimeKindOverride: runtimeKind } : {}),
        ...(hasConnectedServices ? { connectedServices: params.connectedServices } : {}),
    };

    return getOrCreateProbeContext({
        key: cacheKeySuffixParts.join('|'),
        cacheKeySuffixParts,
        capabilityParams,
    });
}
