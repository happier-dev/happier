import {
    readBackendTargetRefV2,
    type AcpCatalogSettingsV1,
    type BackendTargetRefV2,
    type BackendTargetRefV2Input,
} from '@happier-dev/protocol';

import type { AgentId } from '@/agents/catalog/catalog';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import { getAgentCore, isAgentId } from '@/agents/catalog/catalog';
import { LEGACY_COMPAT_PRIMARY_AGENT_ID, LEGACY_COMPAT_PRIMARY_AGENT_ID_NORMALIZED } from './legacyCompatAgents';
import { formatBackendTargetKeyV2, resolveBackendTargetKeyV2 } from './backendTargetKeyV2';
import type {
    MergedBackendProjectionEntry,
    MergedProviderProjectionEntry,
} from './mergedProjectionTypes';
import { normalizeAcpCatalogSettingsV1 } from '@/sync/domains/acpCatalog/normalizeAcpCatalogSettingsV1';
import { t } from '@/text';

export type ResolvedBackendCatalogEntry = Readonly<{
    backendTarget: BackendTargetRefV2;
    backendTargetKey: string;
    kind: 'builtInAgent' | 'configuredBackend' | 'pluginBackend';
    backendId: string;
    providerId: string;
    /**
     * The built-in provider identity (when one exists).
     *
     * For plugin/configured backends, do not collapse identity to the legacy compat carrier.
     * Use `iconAgentId` for UI icon fallback only.
     */
    providerAgentId: AgentId | null;
    builtInAgentId: AgentId | null;
    iconAgentId: AgentId | null;
    title: string;
    subtitle: string | null;
}>;

function isBackendTargetEnabled(
    backendEnabledByTargetKey: Readonly<Record<string, boolean>> | null | undefined,
    backendTargetKey: string,
): boolean {
    return backendEnabledByTargetKey?.[backendTargetKey] !== false;
}

type MergedProjectionInputs = Readonly<{
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null;
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null;
}>;

export function getResolvedBackendCatalogEntries(params: Readonly<{
    enabledAgentIds: readonly string[];
    acpCatalogSettingsV1: AcpCatalogSettingsV1;
    backendEnabledByTargetKey?: Readonly<Record<string, boolean>> | null;
    collapseConfiguredBackendProviderSentinels?: boolean;
    discoveredBackendIds?: readonly string[];
}> & MergedProjectionInputs): ResolvedBackendCatalogEntry[] {
    const entriesByTargetKey = new Map<string, ResolvedBackendCatalogEntry>();

    for (const enabledAgentIdRaw of params.enabledAgentIds) {
        const resolvedEntry = createBuiltInTargetEntry(String(enabledAgentIdRaw ?? '').trim(), params);
        if (!resolvedEntry) continue;
        if (!isBackendTargetEnabled(
            params.backendEnabledByTargetKey,
            resolvedEntry.backendTargetKey,
        )) {
            continue;
        }
        entriesByTargetKey.set(resolvedEntry.backendTargetKey, resolvedEntry);
    }

    const catalog = normalizeAcpCatalogSettingsV1(
        params.acpCatalogSettingsV1 ?? { v: 2, backends: [] },
    );
    const configuredBackendIds = new Set(catalog.backends.map((backend) => backend.id));

    for (const backend of catalog.backends) {
        const canonicalTarget: BackendTargetRefV2 = {
            kind: 'backend',
            backendId: backend.id,
            configuredBackendId: backend.id,
        };
        const backendTargetKey = formatBackendTargetKeyV2(canonicalTarget);
        const backendProjection = readMergedBackendProjection(backend.id, params);
        const providerIdFromProjection = typeof backendProjection?.providerId === 'string' ? backendProjection.providerId.trim() : '';
        const providerId = providerIdFromProjection || backend.id;
        const providerProjection = providerId ? readMergedProviderProjection(providerId, params) : null;
        if (!isBackendTargetEnabled(
            params.backendEnabledByTargetKey,
            backendTargetKey,
        )) {
            continue;
        }
        entriesByTargetKey.set(backendTargetKey, {
            backendTarget: canonicalTarget,
            backendTargetKey,
            kind: 'configuredBackend',
            backendId: backend.id,
            providerId,
            providerAgentId: resolveProjectionProviderAgentId(providerId, backendProjection, providerProjection),
            builtInAgentId: null,
            iconAgentId: resolveProjectionIconAgentId(providerId, backendProjection, providerProjection, null),
            title: backendProjection?.title ?? providerProjection?.title ?? (backend.title || backend.name),
            subtitle: backendProjection?.subtitle ?? providerProjection?.subtitle ?? backend.name,
        });
    }

    for (const discoveredTarget of collectDiscoveredTargets({ ...params, configuredBackendIds })) {
        const backendTargetKey = formatBackendTargetKeyV2(discoveredTarget);
        if (entriesByTargetKey.has(backendTargetKey)) {
            continue;
        }
        const discoveredEntry = createDiscoveredTargetEntry(discoveredTarget, params);
        if (!discoveredEntry) continue;
        entriesByTargetKey.set(discoveredEntry.backendTargetKey, discoveredEntry);
    }

    const entries = [...entriesByTargetKey.values()];

    if (params.collapseConfiguredBackendProviderSentinels !== true) {
        return entries;
    }

    const hasConfiguredBackends = entries.some((entry) => entry.kind === 'configuredBackend');
    if (!hasConfiguredBackends) {
        return entries;
    }

    const configuredProviderAgentIds = new Set(
        entries
            .filter((entry) => entry.kind === 'configuredBackend')
            .map((entry) => entry.providerAgentId)
            .filter((agentId): agentId is AgentId => agentId !== null),
    );

    return entries.filter((entry) => {
        if (entry.kind !== 'builtInAgent') return true;
        if (entry.providerAgentId === null) return true;
        return !configuredProviderAgentIds.has(entry.providerAgentId);
    });
}

export function resolveProviderAgentIdForBackendTarget(target: BackendTargetRefV2): AgentId | null {
    return isAgentId(target.backendId) ? target.backendId : null;
}

function readMergedProviderProjection(
    providerId: string,
    params: MergedProjectionInputs,
): MergedProviderProjectionEntry | null {
    return params.mergedProviderProjectionById?.[providerId] ?? null;
}

function readMergedBackendProjection(
    backendId: string,
    params: MergedProjectionInputs,
): MergedBackendProjectionEntry | null {
    return params.mergedBackendProjectionById?.[backendId] ?? null;
}

function resolveProjectionProviderAgentId(
    providerId: string,
    backendProjection: MergedBackendProjectionEntry | null,
    providerProjection: MergedProviderProjectionEntry | null,
): AgentId | null {
    const explicitAgentId = backendProjection?.providerAgentId ?? providerProjection?.providerAgentId ?? null;
    if (explicitAgentId && isAgentId(explicitAgentId)) {
        return explicitAgentId;
    }
    if (isAgentId(providerId)) {
        return providerId;
    }
    return null;
}

function resolveProjectionIconAgentId(
    providerId: string,
    backendProjection: MergedBackendProjectionEntry | null,
    providerProjection: MergedProviderProjectionEntry | null,
    fallbackAgentId: AgentId | null,
): AgentId | null {
    const explicitIconAgentId = backendProjection?.iconAgentId ?? providerProjection?.iconAgentId ?? null;
    if (explicitIconAgentId && isAgentId(explicitIconAgentId)) {
        return explicitIconAgentId;
    }
    if (isAgentId(providerId)) {
        return providerId;
    }
    return fallbackAgentId;
}

function createBuiltInTargetEntry(agentId: string, params: MergedProjectionInputs): ResolvedBackendCatalogEntry | null {
    if (!agentId || agentId === LEGACY_COMPAT_PRIMARY_AGENT_ID) {
        return null;
    }
    const canonicalTarget: BackendTargetRefV2 = {
        kind: 'backend',
        backendId: agentId,
    };
    const backendTargetKey = formatBackendTargetKeyV2(canonicalTarget);
    const backendProjection = readMergedBackendProjection(agentId, params);
    const providerId = backendProjection?.providerId ?? agentId;
    const providerProjection = readMergedProviderProjection(providerId, params);

    if (isAgentId(agentId)) {
        const core = getAgentCore(agentId);
        return {
            backendTarget: canonicalTarget,
            backendTargetKey,
            kind: 'builtInAgent',
            backendId: agentId,
            providerId: String(providerId ?? '').trim() || agentId,
            providerAgentId: resolveProjectionProviderAgentId(providerId, backendProjection, providerProjection),
            builtInAgentId: agentId,
            iconAgentId: resolveProjectionIconAgentId(providerId, backendProjection, providerProjection, agentId),
            title: backendProjection?.title ?? t(core.displayNameKey),
            subtitle: backendProjection?.subtitle ?? agentId,
        };
    }

    return {
        backendTarget: canonicalTarget,
        backendTargetKey,
        kind: 'pluginBackend',
        backendId: agentId,
        providerId: String(providerId ?? '').trim() || agentId,
        providerAgentId: resolveProjectionProviderAgentId(providerId, backendProjection, providerProjection),
        builtInAgentId: null,
        iconAgentId: resolveProjectionIconAgentId(providerId, backendProjection, providerProjection, null),
        title: backendProjection?.title ?? providerProjection?.title ?? formatAgentLikeIdForDisplay(agentId),
        subtitle: backendProjection?.subtitle ?? providerProjection?.subtitle ?? agentId,
    };
}

function createDiscoveredTargetEntry(target: BackendTargetRefV2, params: MergedProjectionInputs): ResolvedBackendCatalogEntry | null {
    if (target.configuredBackendId) {
        const backendProjection = readMergedBackendProjection(target.backendId, params);
        const providerIdFromProjection = typeof backendProjection?.providerId === 'string' ? backendProjection.providerId.trim() : '';
        const providerId = providerIdFromProjection || target.backendId;
        const providerProjection = providerId ? readMergedProviderProjection(providerId, params) : null;
        const backendTargetKey = formatBackendTargetKeyV2(target);
        return {
            backendTarget: target,
            backendTargetKey,
            kind: 'configuredBackend',
            backendId: target.backendId,
            providerId,
            providerAgentId: resolveProjectionProviderAgentId(providerId, backendProjection, providerProjection),
            builtInAgentId: null,
            iconAgentId: resolveProjectionIconAgentId(providerId, backendProjection, providerProjection, null),
            title: backendProjection?.title ?? providerProjection?.title ?? formatAgentLikeIdForDisplay(target.backendId),
            subtitle: backendProjection?.subtitle ?? providerProjection?.subtitle ?? target.backendId,
        };
    }

    return createBuiltInTargetEntry(target.backendId, params);
}

function collectDiscoveredTargets(params: Readonly<{
    backendEnabledByTargetKey?: Readonly<Record<string, boolean>> | null;
    discoveredBackendIds?: readonly string[];
    configuredBackendIds?: ReadonlySet<string>;
}>): BackendTargetRefV2[] {
    const discoveredTargetsByKey = new Map<string, BackendTargetRefV2>();

    for (const backendId of params.discoveredBackendIds ?? []) {
        const normalizedBackendId = String(backendId ?? '').trim();
        if (!normalizedBackendId || normalizedBackendId.toLowerCase() === LEGACY_COMPAT_PRIMARY_AGENT_ID_NORMALIZED) continue;
        if (params.configuredBackendIds?.has(normalizedBackendId)) continue;
        const target: BackendTargetRefV2 = { kind: 'backend', backendId: normalizedBackendId };
        const key = formatBackendTargetKeyV2(target);
        if (params.backendEnabledByTargetKey?.[key] === false) continue;
        discoveredTargetsByKey.set(key, target);
    }

    const enabledByTarget = params.backendEnabledByTargetKey ?? null;
    if (enabledByTarget) {
        for (const [targetKey, isEnabled] of Object.entries(enabledByTarget)) {
            if (isEnabled === false) continue;
            const parsedTarget = parseBackendTargetFromUnknownKey(targetKey);
            if (!parsedTarget) continue;
            const key = formatBackendTargetKeyV2(parsedTarget);
            if (params.backendEnabledByTargetKey?.[key] === false) continue;
            discoveredTargetsByKey.set(key, parsedTarget);
        }
    }

    return [...discoveredTargetsByKey.values()];
}

function parseBackendTargetFromUnknownKey(targetKey: string): BackendTargetRefV2 | null {
    try {
        return readBackendTargetRefV2(targetKey as BackendTargetRefV2Input);
    } catch {
        return null;
    }
}
