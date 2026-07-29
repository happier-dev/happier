import type { AcpCatalogSettingsV1 } from '@happier-dev/protocol';

import { AGENT_IDS, getAgentCore, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import { getAgentLocalAuthPlugin } from '@/agents/catalog/localAuth/agentLocalAuthCatalog';
import { createProjectedAgentLocalAuthPlugin } from '@/agents/catalog/localAuth/createProjectedAgentLocalAuthPlugin';
import type {
    MergedBackendProjectionEntry,
    MergedProviderProjectionEntry,
} from '@/agents/backendCatalog/mergedProjectionTypes';
import type { AgentLocalAuthPlugin } from '@/agents/catalog/localAuth/agentLocalAuthPlugin';
import { t } from '@/text';
import { LEGACY_COMPAT_PRIMARY_AGENT_ID_NORMALIZED } from './legacyCompatAgents';
import { resolveBackendTargetKeyV2 } from './backendTargetKeyV2';
import {
    getAgentBackendCompatibilityTargetKeys,
    readBackendTargetEnabled,
} from './backendTargetEnablement';

export type ResolvedAgentCatalogEntry = Readonly<{
    agentId: string;
    catalogAgentId: AgentId | null;
    iconAgentId: AgentId | null;
    backendTargetKey: string | null;
    title: string;
    subtitle: string | null;
    iconName: string;
    channel: 'stable' | 'experimental' | 'plugin' | null;
    enabled: boolean | null;
    isBuiltIn: boolean;
    authPlugin: AgentLocalAuthPlugin | null;
}>;

const CANONICAL_AGENT_ID_BY_NORMALIZED = new Map<string, AgentId>(
    AGENT_IDS.map((agentId) => [agentId.toLowerCase(), agentId]),
);

function normalizeAgentId(agentId: string | null | undefined): string {
    const trimmed = String(agentId ?? '').trim();
    if (!trimmed) return '';
    if (isAgentId(trimmed)) return trimmed;
    return CANONICAL_AGENT_ID_BY_NORMALIZED.get(trimmed.toLowerCase()) ?? trimmed;
}

function readMergedProviderProjection(
    agentId: string,
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null,
): MergedProviderProjectionEntry | null {
    return mergedProviderProjectionById?.[agentId] ?? null;
}

function readMergedBackendProjection(
    backendId: string,
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null,
): MergedBackendProjectionEntry | null {
    return mergedBackendProjectionById?.[backendId] ?? null;
}

function readFallbackSingleBackendProjectionForAgent(
    agentId: string,
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null,
): MergedBackendProjectionEntry | null {
    const matches = Object.values(mergedBackendProjectionById ?? {}).filter((entry) => entry.agentId === agentId);
    if (matches.length === 1) {
        return matches[0] ?? null;
    }
    return null;
}

function readSettingsBackendProjectionForAgent(
    agentId: string,
    mergedProviderProjection: MergedProviderProjectionEntry | null,
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null,
): MergedBackendProjectionEntry | null {
    const explicitSettingsBackendId = typeof mergedProviderProjection?.settingsBackendId === 'string'
        ? mergedProviderProjection.settingsBackendId.trim()
        : '';
    if (explicitSettingsBackendId) {
        return readMergedBackendProjection(explicitSettingsBackendId, mergedBackendProjectionById);
    }

    if (mergedProviderProjection) {
        return null;
    }

    return readFallbackSingleBackendProjectionForAgent(agentId, mergedBackendProjectionById);
}

function isBuiltInProvider(
    agentId: string,
    mergedProviderProjection: MergedProviderProjectionEntry | null,
): boolean {
    if (mergedProviderProjection?.isBuiltIn !== undefined) {
        return mergedProviderProjection.isBuiltIn === true;
    }
    return isAgentId(agentId);
}

function resolveProviderTargetKey(agentId: string, isBuiltIn: boolean): string | null {
    const normalizedProviderId = normalizeAgentId(agentId);
    if (!normalizedProviderId) return null;
    if (isBuiltIn && isAgentId(normalizedProviderId)) {
        return resolveBackendTargetKeyV2({ kind: 'backend', backendId: normalizedProviderId });
    }
    return null;
}

function resolveProviderTargetKeyFromSettingsBackend(
    agentId: string,
    isBuiltIn: boolean,
    settingsBackendProjection: MergedBackendProjectionEntry | null,
): string | null {
    if (isBuiltIn && isAgentId(agentId)) {
        return resolveProviderTargetKey(agentId, isBuiltIn);
    }
    if (settingsBackendProjection?.backendId) {
        return resolveBackendTargetKeyV2({ kind: 'backend', backendId: settingsBackendProjection.backendId });
    }
    return resolveProviderTargetKey(agentId, isBuiltIn);
}

function resolveBehaviorProviderId(
    agentId: string,
    mergedProviderProjection: MergedProviderProjectionEntry | null,
    primaryMergedBackendProjection: MergedBackendProjectionEntry | null,
): AgentId | null {
    const projectedCatalogAgentId = mergedProviderProjection?.catalogAgentId ?? primaryMergedBackendProjection?.catalogAgentId ?? null;
    if (projectedCatalogAgentId && isAgentId(projectedCatalogAgentId)) {
        return projectedCatalogAgentId;
    }
    if (isAgentId(agentId)) {
        return agentId;
    }
    return null;
}

function resolveProviderTitle(
    agentId: string,
    mergedProviderProjection: MergedProviderProjectionEntry | null,
    primaryMergedBackendProjection: MergedBackendProjectionEntry | null,
): string {
    if (mergedProviderProjection?.title) {
        return mergedProviderProjection.title;
    }

    if (primaryMergedBackendProjection?.title) {
        return primaryMergedBackendProjection.title;
    }

    if (isAgentId(agentId)) {
        return t(getAgentCore(agentId).displayNameKey);
    }

    return formatAgentLikeIdForDisplay(agentId);
}

function resolveProviderSubtitle(
    agentId: string,
    mergedProviderProjection: MergedProviderProjectionEntry | null,
    primaryMergedBackendProjection: MergedBackendProjectionEntry | null,
): string | null {
    if (mergedProviderProjection?.subtitle) {
        return mergedProviderProjection.subtitle;
    }

    if (primaryMergedBackendProjection?.subtitle) {
        return primaryMergedBackendProjection.subtitle;
    }

    if (isAgentId(agentId)) {
        return agentId;
    }

    return null;
}

function resolveProviderIconName(agentId: string): string {
    const providerCore = isAgentId(agentId) ? getAgentCore(agentId) : null;
    if (providerCore) {
        return providerCore.ui.agentPickerIconName;
    }

    return 'layers-outline';
}

function resolveProviderIconAgentId(
    mergedProviderProjection: MergedProviderProjectionEntry | null,
    primaryMergedBackendProjection: MergedBackendProjectionEntry | null,
    behaviorProviderId: AgentId | null,
): AgentId | null {
    return mergedProviderProjection?.iconAgentId ?? primaryMergedBackendProjection?.iconAgentId ?? behaviorProviderId ?? null;
}

function resolveProviderDisplayIconName(
    iconAgentId: AgentId | null,
    agentId: string,
): string {
    if (iconAgentId) {
        return resolveProviderIconName(iconAgentId);
    }

    return resolveProviderIconName(agentId);
}

function resolveProviderChannel(
    agentId: string,
    mergedProviderProjection: MergedProviderProjectionEntry | null,
): ResolvedAgentCatalogEntry['channel'] {
    if (mergedProviderProjection?.channel != null) {
        return mergedProviderProjection.channel;
    }

    if (!isAgentId(agentId)) {
        return 'plugin';
    }

    return getAgentCore(agentId).availability.experimental ? 'experimental' : 'stable';
}

function resolveProviderEnabled(
    backendTargetKey: string | null,
    agentId: string,
    params: Readonly<{
        backendEnabledByTargetKey: Readonly<Record<string, boolean>> | null | undefined;
        mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null;
        mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null;
    }>,
): boolean | null {
    if (!backendTargetKey && !isAgentId(agentId)) {
        return null;
    }
    const targetKey = backendTargetKey ?? resolveBackendTargetKeyV2({ kind: 'backend', backendId: agentId });
    return readBackendTargetEnabled({
        backendEnabledByTargetKey: params.backendEnabledByTargetKey,
        canonicalTargetKey: targetKey,
        compatibilityTargetKeys: getAgentBackendCompatibilityTargetKeys({
            agentId,
            canonicalTargetKey: targetKey,
            mergedBackendProjectionById: params.mergedBackendProjectionById,
            mergedProviderProjectionById: params.mergedProviderProjectionById,
        }),
    });
}

function uniqueProviderIds(params: Readonly<{
    enabledAgentIds: readonly string[];
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null;
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null;
}>): string[] {
    const agentIds = new Set<string>();
    for (const agentId of params.enabledAgentIds) {
        const normalizedAgentId = normalizeAgentId(agentId);
        if (!normalizedAgentId || normalizedAgentId === LEGACY_COMPAT_PRIMARY_AGENT_ID_NORMALIZED) continue;
        const mergedBackendProjection = readMergedBackendProjection(normalizedAgentId, params.mergedBackendProjectionById);
        agentIds.add(normalizeAgentId(mergedBackendProjection?.agentId ?? normalizedAgentId));
    }

    for (const agentId of Object.keys(params.mergedProviderProjectionById ?? {})) {
        const normalizedProviderId = normalizeAgentId(agentId);
        if (!normalizedProviderId || normalizedProviderId === LEGACY_COMPAT_PRIMARY_AGENT_ID_NORMALIZED) continue;
        agentIds.add(normalizedProviderId);
    }

    for (const projection of Object.values(params.mergedBackendProjectionById ?? {})) {
        const normalizedProviderId = normalizeAgentId(projection.agentId);
        if (!normalizedProviderId || normalizedProviderId === LEGACY_COMPAT_PRIMARY_AGENT_ID_NORMALIZED) continue;
        agentIds.add(normalizedProviderId);
    }

    for (const agentId of AGENT_IDS) {
        const normalizedAgentId = normalizeAgentId(agentId);
        if (!normalizedAgentId || normalizedAgentId === LEGACY_COMPAT_PRIMARY_AGENT_ID_NORMALIZED) continue;
        agentIds.add(normalizedAgentId);
    }

    return [...agentIds];
}

function resolveAgentLocalAuthPlugin(
    agentId: string,
    behaviorProviderId: AgentId | null,
    mergedProviderProjection: MergedProviderProjectionEntry | null,
): AgentLocalAuthPlugin | null {
    if (mergedProviderProjection?.cli) {
        return createProjectedAgentLocalAuthPlugin({
            agentId,
            cli: mergedProviderProjection.cli,
        });
    }
    return behaviorProviderId ? getAgentLocalAuthPlugin(behaviorProviderId) : null;
}

export function getResolvedAgentCatalogEntries(params: Readonly<{
    enabledAgentIds: readonly string[];
    backendEnabledByTargetKey?: Readonly<Record<string, boolean>> | null;
    acpCatalogSettingsV1?: AcpCatalogSettingsV1;
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null;
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null;
}>): ResolvedAgentCatalogEntry[] {
    void params.acpCatalogSettingsV1;
    return uniqueProviderIds({
        enabledAgentIds: params.enabledAgentIds,
        mergedBackendProjectionById: params.mergedBackendProjectionById,
        mergedProviderProjectionById: params.mergedProviderProjectionById,
    }).map((agentId) => {
        const mergedProviderProjection = readMergedProviderProjection(agentId, params.mergedProviderProjectionById);
        const settingsBackendProjection = readSettingsBackendProjectionForAgent(
            agentId,
            mergedProviderProjection,
            params.mergedBackendProjectionById,
        );
        const isBuiltIn = isBuiltInProvider(agentId, mergedProviderProjection);
        const behaviorProviderId = resolveBehaviorProviderId(agentId, mergedProviderProjection, settingsBackendProjection);
        const iconAgentId = resolveProviderIconAgentId(mergedProviderProjection, settingsBackendProjection, behaviorProviderId);
        const backendTargetKey = resolveProviderTargetKeyFromSettingsBackend(agentId, isBuiltIn, settingsBackendProjection);
        return {
            agentId,
            catalogAgentId: behaviorProviderId,
            iconAgentId,
            backendTargetKey,
            title: resolveProviderTitle(agentId, mergedProviderProjection, settingsBackendProjection),
            subtitle: resolveProviderSubtitle(agentId, mergedProviderProjection, settingsBackendProjection),
            iconName: resolveProviderDisplayIconName(iconAgentId, agentId),
            channel: resolveProviderChannel(agentId, mergedProviderProjection),
            enabled: resolveProviderEnabled(backendTargetKey, agentId, {
                backendEnabledByTargetKey: params.backendEnabledByTargetKey ?? null,
                mergedBackendProjectionById: params.mergedBackendProjectionById,
                mergedProviderProjectionById: params.mergedProviderProjectionById,
            }),
            isBuiltIn,
            authPlugin: resolveAgentLocalAuthPlugin(agentId, behaviorProviderId, mergedProviderProjection),
        };
    });
}

export function resolveAgentCatalogProjection(agentId: string, params: Readonly<{
    enabledAgentIds: readonly string[];
    backendEnabledByTargetKey?: Readonly<Record<string, boolean>> | null;
    acpCatalogSettingsV1?: AcpCatalogSettingsV1;
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null;
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null;
}>): ResolvedAgentCatalogEntry {
    const normalizedProviderId = normalizeAgentId(agentId);
    const projections = getResolvedAgentCatalogEntries(params);
    if (projections.find((entry) => entry.agentId === normalizedProviderId)) {
        return projections.find((entry) => entry.agentId === normalizedProviderId)!;
    }

    const mergedProviderProjection = readMergedProviderProjection(normalizedProviderId, params.mergedProviderProjectionById);
    const settingsBackendProjection = readSettingsBackendProjectionForAgent(
        normalizedProviderId,
        mergedProviderProjection,
        params.mergedBackendProjectionById,
    );
    const isBuiltIn = isBuiltInProvider(normalizedProviderId, mergedProviderProjection);
    const behaviorProviderId = resolveBehaviorProviderId(normalizedProviderId, mergedProviderProjection, settingsBackendProjection);
    const iconAgentId = resolveProviderIconAgentId(mergedProviderProjection, settingsBackendProjection, behaviorProviderId);
    const backendTargetKey = resolveProviderTargetKeyFromSettingsBackend(normalizedProviderId, isBuiltIn, settingsBackendProjection);
    return {
        agentId: normalizedProviderId,
        catalogAgentId: behaviorProviderId,
        iconAgentId,
        backendTargetKey,
        title: resolveProviderTitle(normalizedProviderId, mergedProviderProjection, settingsBackendProjection),
        subtitle: resolveProviderSubtitle(normalizedProviderId, mergedProviderProjection, settingsBackendProjection),
        iconName: resolveProviderDisplayIconName(iconAgentId, normalizedProviderId),
        channel: resolveProviderChannel(normalizedProviderId, mergedProviderProjection),
        enabled: resolveProviderEnabled(backendTargetKey, normalizedProviderId, {
            backendEnabledByTargetKey: params.backendEnabledByTargetKey ?? null,
            mergedBackendProjectionById: params.mergedBackendProjectionById,
            mergedProviderProjectionById: params.mergedProviderProjectionById,
        }),
        isBuiltIn,
        authPlugin: resolveAgentLocalAuthPlugin(normalizedProviderId, behaviorProviderId, mergedProviderProjection),
    };
}
