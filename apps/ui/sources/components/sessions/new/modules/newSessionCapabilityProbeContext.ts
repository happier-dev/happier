import { ConnectedServiceBindingsV2IngressSchema, type ConnectedServiceBindingsV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { BackendTargetRefV2, PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { RuntimeDescriptorV1 } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { getAgentModelConfig } from '@happier-dev/agents';

import {
    resolveCatalogAgentIdForBackendTarget,
    resolveOperationalBackendTargetForAgentSelection,
} from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveConfiguredAgentRuntimeKindFromUiBehavior } from '@/agents/registry/registryUiBehavior';
import type { AgentPluginSettingsSnapshot } from '@/agents/registry/registryUiBehavior';
import { resolveQualifiedConnectedAccountServiceKey } from '@/sync/domains/connectedServices/connectedServiceRegistry';
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

export function resolveNewSessionOperationalBackendTarget(params: Readonly<{
    backendTarget: PersistedBackendTargetRefV2;
    runtimeCarrierAgentId?: string | null;
}>): BackendTargetRefV2 {
    if (params.backendTarget.kind === 'backend') return params.backendTarget;
    return resolveOperationalBackendTargetForAgentSelection({
        backendTarget: params.backendTarget,
        selectedEntry: params.runtimeCarrierAgentId
            ? { agentId: params.runtimeCarrierAgentId }
            : null,
    }) ?? {
        kind: 'backend',
        backendId: buildQualifiedPluginContributionKey(params.backendTarget.identity),
    };
}

/**
 * The operational provider identity New Session ACP config-option controls
 * key by. A configured ACP backend is addressed by its configured backend id
 * — never the generic backend carrier — matching the canonical `providerId`
 * in `NewSessionEngineOptionDetail`. Agent-carrier targets resolve through
 * the operational backend-target owner, so the identity follows the runtime
 * carrier the catalog resolved.
 */
export function resolveNewSessionOperationalProviderId(params: Readonly<{
    backendTarget: PersistedBackendTargetRefV2;
    runtimeCarrierAgentId?: string | null;
}>): string {
    const operationalBackendTarget = resolveNewSessionOperationalBackendTarget(params);
    return operationalBackendTarget.configuredBackendId ?? operationalBackendTarget.backendId;
}

export function resolveNewSessionCapabilityProbeContext(params: Readonly<{
    backendTarget: PersistedBackendTargetRefV2;
    settings: Settings;
    selectedProfileId?: string | null;
    runtimeCarrierAgentId?: string | null;
    machineId?: string | null;
    pluginSettings?: AgentPluginSettingsSnapshot | null;
    runtimeDescriptorV1?: RuntimeDescriptorV1 | null;
}>): NewSessionCapabilityProbeContext | null {
    const backendTarget = resolveNewSessionOperationalBackendTarget(params);
    // The selected operational identity is authoritative for both bundled and
    // installed Agents. A qualified installed id may contain `/`; it must not
    // be narrowed through the bundled roster before the machine-scoped
    // declaration reader gets a chance to resolve it.
    const agentId = params.runtimeCarrierAgentId?.trim()
        || resolveCatalogAgentIdForBackendTarget(backendTarget);
    if (!agentId) {
        return null;
    }
    // `settings` is the canonical parsed Account settings. The open engine picker
    // resolves this on every render, so it is read as given, never re-parsed.
    const runtimeKind = params.runtimeDescriptorV1 ? null : resolveConfiguredAgentRuntimeKindFromUiBehavior({
        agentId,
        settings: params.settings,
        ...(params.pluginSettings ? { pluginSettings: params.pluginSettings } : {}),
        ...(params.machineId?.trim() ? { machineId: params.machineId } : {}),
    });
    const selectedProfileId = params.selectedProfileId?.trim() || null;
    if (!runtimeKind && !selectedProfileId && !params.runtimeDescriptorV1) return null;

    const cacheKeySuffixParts = [
        ...(params.runtimeDescriptorV1 ? [`runtime:${stableJsonStringify(params.runtimeDescriptorV1)}`] : []),
        ...(runtimeKind ? [runtimeKind] : []),
        ...(selectedProfileId ? [`profile:${selectedProfileId}`] : []),
    ];
    const capabilityParams = {
        ...(selectedProfileId ? { profileId: selectedProfileId } : {}),
        ...(params.runtimeDescriptorV1 ? { runtimeDescriptorV1: params.runtimeDescriptorV1 } : {}),
    };
    return getOrCreateProbeContext({
        key: stableJsonStringify({ cacheKeySuffixParts, capabilityParams }),
        cacheKeySuffixParts,
        capabilityParams,
    });
}

export function resolveNewSessionModelCapabilityProbeContext(params: Readonly<{
    backendTarget: PersistedBackendTargetRefV2;
    settings: Settings;
    selectedProfileId?: string | null;
    runtimeCarrierAgentId?: string | null;
    machineId?: string | null;
    pluginSettings?: AgentPluginSettingsSnapshot | null;
    runtimeDescriptorV1?: RuntimeDescriptorV1 | null;
    connectedServices?: ConnectedServiceBindingsV2 | null;
    connectedServicesCacheIdentity?: string | null;
}>): NewSessionCapabilityProbeContext | null {
    const shared = resolveNewSessionCapabilityProbeContext(params);
    const backendTarget = resolveNewSessionOperationalBackendTarget(params);
    const agentId = params.runtimeCarrierAgentId?.trim()
        || resolveCatalogAgentIdForBackendTarget(backendTarget);
    const observation = (agentId ? getAgentModelConfig(agentId)?.nativeCatalogObservation : null) ?? null;
    // Released bundled model-config author facts still name their observed
    // Connected service by the bundled scalar id. Canonical bindings are keyed
    // by qualified service keys, so the observation translates through the one
    // provenance-named legacy ingress before any binding lookup or probe cache
    // identity is derived. Unknown ids fail closed (no model-only probe).
    const observationServiceKey = observation
        ? resolveQualifiedConnectedAccountServiceKey(observation.connectedServiceId)
        : null;
    const bindings = ConnectedServiceBindingsV2IngressSchema.safeParse(params.connectedServices);
    const selection = observationServiceKey && bindings.success
        ? bindings.data.bindingsByServiceId[observationServiceKey]
        : null;
    if (!observation || !observationServiceKey || selection?.source !== 'connected') return shared;
    const selectedIdentity = selection.selection === 'group'
        ? `${observationServiceKey}:group:${selection.groupId}`
        : `${observationServiceKey}:profile:${selection.profileId}`;
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
