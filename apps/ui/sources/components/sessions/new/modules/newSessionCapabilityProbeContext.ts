import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import { resolveAgentConfiguredRuntimeKind } from '@happier-dev/agents';

import { resolveProviderAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { Settings } from '@/sync/domains/settings/settings';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

export type NewSessionCapabilityProbeContext = Readonly<{
    cacheKeySuffixParts?: readonly string[] | null;
    capabilityParams?: Readonly<Record<string, unknown>> | null;
}>;

const MAX_CACHED_RUNTIME_KINDS = 32;
const probeContextByRuntimeKind = new Map<string, NewSessionCapabilityProbeContext>();

function getOrCreateProbeContextForRuntimeKind(runtimeKind: string): NewSessionCapabilityProbeContext {
    const key = runtimeKind.trim();
    const existing = probeContextByRuntimeKind.get(key);
    if (existing) {
        probeContextByRuntimeKind.delete(key);
        probeContextByRuntimeKind.set(key, existing);
        return existing;
    }

    const cacheKeySuffixParts = Object.freeze([key]);
    const capabilityParams = Object.freeze({
        runtimeKindOverride: key,
    }) as Readonly<Record<string, unknown>>;

    const created: NewSessionCapabilityProbeContext = Object.freeze({
        cacheKeySuffixParts,
        capabilityParams,
    });

    probeContextByRuntimeKind.set(key, created);
    while (probeContextByRuntimeKind.size > MAX_CACHED_RUNTIME_KINDS) {
        const oldest = probeContextByRuntimeKind.keys().next();
        if (oldest.done) break;
        probeContextByRuntimeKind.delete(oldest.value);
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
    });
}

export function resolveNewSessionCapabilityProbeContext(params: Readonly<{
    backendTarget: BackendTargetRefV1;
    settings: Settings;
}>): NewSessionCapabilityProbeContext | null {
    const agentId = resolveProviderAgentIdForBackendTarget(params.backendTarget);
    const runtimeKind = resolveAgentConfiguredRuntimeKind({
        agentId,
        accountSettings: params.settings as unknown as Record<string, unknown>,
    });
    if (!runtimeKind) return null;

    return getOrCreateProbeContextForRuntimeKind(runtimeKind);
}
