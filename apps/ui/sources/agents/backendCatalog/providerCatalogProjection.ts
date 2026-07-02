import type { AcpCatalogSettingsV1 } from '@happier-dev/protocol';

import { getAgentCore, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import { getProviderLocalAuthPlugin } from '@/agents/providers/catalog/providerLocalAuthCatalog';
import type {
    MergedBackendProjectionEntry,
    MergedProviderProjectionEntry,
} from '@/agents/backendCatalog/mergedProjectionTypes';
import {
    PROVIDER_SETTINGS_DESCRIPTORS,
    getProviderSettingsDescriptor,
    getProviderSettingsBehavior,
} from '@/agents/catalog/providerSettingsCatalog';
import type {
    ProviderSettingsBehavior,
    ProviderSettingsDescriptor,
} from '@/agents/providers/shared/providerSettingsPlugin';
import type { ProviderLocalAuthPlugin } from '@/agents/providers/shared/providerLocalAuthPlugin';
import { t } from '@/text';
import { LEGACY_COMPAT_PRIMARY_AGENT_ID_NORMALIZED } from './legacyCompatAgents';
import { resolveBackendTargetKeyV2 } from './backendTargetKeyV2';

export type ResolvedProviderCatalogEntry = Readonly<{
    providerId: string;
    providerAgentId: AgentId | null;
    iconAgentId: AgentId | null;
    backendTargetKey: string | null;
    title: string;
    subtitle: string | null;
    iconName: string;
    channel: 'stable' | 'experimental' | 'plugin' | null;
    enabled: boolean | null;
    isBuiltIn: boolean;
    descriptor: ProviderSettingsDescriptor | null;
    behavior: ProviderSettingsBehavior | null;
    authPlugin: ProviderLocalAuthPlugin | null;
}>;

function normalizeProviderId(providerId: string | null | undefined): string {
    return String(providerId ?? '').trim().toLowerCase();
}

function readMergedProviderProjection(
    providerId: string,
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null,
): MergedProviderProjectionEntry | null {
    return mergedProviderProjectionById?.[providerId] ?? null;
}

function readMergedBackendProjection(
    backendId: string,
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null,
): MergedBackendProjectionEntry | null {
    return mergedBackendProjectionById?.[backendId] ?? null;
}

function readFallbackSingleBackendProjectionForProvider(
    providerId: string,
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null,
): MergedBackendProjectionEntry | null {
    const matches = Object.values(mergedBackendProjectionById ?? {}).filter((entry) => entry.providerId === providerId);
    if (matches.length === 1) {
        return matches[0] ?? null;
    }
    return null;
}

function readSettingsBackendProjectionForProvider(
    providerId: string,
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

    return readFallbackSingleBackendProjectionForProvider(providerId, mergedBackendProjectionById);
}

function isBuiltInProvider(
    providerId: string,
    mergedProviderProjection: MergedProviderProjectionEntry | null,
): boolean {
    if (mergedProviderProjection?.isBuiltIn !== undefined) {
        return mergedProviderProjection.isBuiltIn === true;
    }
    return isAgentId(providerId);
}

function resolveProviderTargetKey(providerId: string, isBuiltIn: boolean): string | null {
    const normalizedProviderId = normalizeProviderId(providerId);
    if (!normalizedProviderId) return null;
    if (isBuiltIn && isAgentId(normalizedProviderId)) {
        return resolveBackendTargetKeyV2({ kind: 'backend', backendId: normalizedProviderId });
    }
    return null;
}

function resolveProviderTargetKeyFromSettingsBackend(
    providerId: string,
    isBuiltIn: boolean,
    settingsBackendProjection: MergedBackendProjectionEntry | null,
): string | null {
    if (settingsBackendProjection?.backendId) {
        return resolveBackendTargetKeyV2({ kind: 'backend', backendId: settingsBackendProjection.backendId });
    }
    return resolveProviderTargetKey(providerId, isBuiltIn);
}

function resolveBehaviorProviderId(
    providerId: string,
    mergedProviderProjection: MergedProviderProjectionEntry | null,
    primaryMergedBackendProjection: MergedBackendProjectionEntry | null,
): AgentId | null {
    const projectedProviderAgentId = mergedProviderProjection?.providerAgentId ?? primaryMergedBackendProjection?.providerAgentId ?? null;
    if (projectedProviderAgentId && isAgentId(projectedProviderAgentId)) {
        return projectedProviderAgentId;
    }
    if (isAgentId(providerId)) {
        return providerId;
    }
    return null;
}

function resolveProviderTitle(
    providerId: string,
    descriptor: ProviderSettingsDescriptor | null,
    mergedProviderProjection: MergedProviderProjectionEntry | null,
    primaryMergedBackendProjection: MergedBackendProjectionEntry | null,
): string {
    if (mergedProviderProjection?.title) {
        return mergedProviderProjection.title;
    }

    if (primaryMergedBackendProjection?.title) {
        return primaryMergedBackendProjection.title;
    }

    if (descriptor) {
        return typeof descriptor.title === 'string' ? descriptor.title : t(descriptor.title.key);
    }

    if (isAgentId(providerId)) {
        return t(getAgentCore(providerId).displayNameKey);
    }

    return formatAgentLikeIdForDisplay(providerId);
}

function resolveProviderSubtitle(
    providerId: string,
    descriptor: ProviderSettingsDescriptor | null,
    mergedProviderProjection: MergedProviderProjectionEntry | null,
    primaryMergedBackendProjection: MergedBackendProjectionEntry | null,
): string | null {
    if (mergedProviderProjection?.subtitle) {
        return mergedProviderProjection.subtitle;
    }

    if (primaryMergedBackendProjection?.subtitle) {
        return primaryMergedBackendProjection.subtitle;
    }

    if (descriptor) {
        return descriptor.providerId;
    }

    if (isAgentId(providerId)) {
        return providerId;
    }

    return null;
}

function resolveProviderIconName(providerId: string, descriptor: ProviderSettingsDescriptor | null): string {
    const providerCore = isAgentId(providerId) ? getAgentCore(providerId) : null;
    if (providerCore) {
        return providerCore.ui.agentPickerIconName;
    }

    if (descriptor) {
        return descriptor.icon.ionName;
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
    providerId: string,
    descriptor: ProviderSettingsDescriptor | null,
): string {
    if (iconAgentId) {
        return resolveProviderIconName(iconAgentId, null);
    }

    return resolveProviderIconName(providerId, descriptor);
}

function resolveProviderChannel(
    providerId: string,
    mergedProviderProjection: MergedProviderProjectionEntry | null,
): ResolvedProviderCatalogEntry['channel'] {
    if (mergedProviderProjection?.channel !== undefined) {
        return mergedProviderProjection.channel;
    }

    if (!isAgentId(providerId)) {
        return 'plugin';
    }

    return getAgentCore(providerId).availability.experimental ? 'experimental' : 'stable';
}

function resolveProviderEnabled(backendTargetKey: string | null, providerId: string, backendEnabledByTargetKey: Readonly<Record<string, boolean>> | null | undefined): boolean | null {
    if (!backendTargetKey && !isAgentId(providerId)) {
        return null;
    }
    const targetKey = backendTargetKey ?? resolveBackendTargetKeyV2({ kind: 'backend', backendId: providerId });
    return backendEnabledByTargetKey?.[targetKey] !== false;
}

function uniqueProviderIds(params: Readonly<{
    enabledAgentIds: readonly string[];
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null;
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null;
}>): string[] {
    const providerIds = new Set<string>();
    for (const agentId of params.enabledAgentIds) {
        const normalizedAgentId = normalizeProviderId(agentId);
        if (!normalizedAgentId || normalizedAgentId === LEGACY_COMPAT_PRIMARY_AGENT_ID_NORMALIZED) continue;
        const mergedBackendProjection = readMergedBackendProjection(normalizedAgentId, params.mergedBackendProjectionById);
        providerIds.add(normalizeProviderId(mergedBackendProjection?.providerId ?? normalizedAgentId));
    }

    for (const providerId of Object.keys(params.mergedProviderProjectionById ?? {})) {
        const normalizedProviderId = normalizeProviderId(providerId);
        if (!normalizedProviderId || normalizedProviderId === LEGACY_COMPAT_PRIMARY_AGENT_ID_NORMALIZED) continue;
        providerIds.add(normalizedProviderId);
    }

    for (const projection of Object.values(params.mergedBackendProjectionById ?? {})) {
        const normalizedProviderId = normalizeProviderId(projection.providerId);
        if (!normalizedProviderId || normalizedProviderId === LEGACY_COMPAT_PRIMARY_AGENT_ID_NORMALIZED) continue;
        providerIds.add(normalizedProviderId);
    }

    for (const descriptor of PROVIDER_SETTINGS_DESCRIPTORS) {
        const normalizedDescriptorId = normalizeProviderId(descriptor.providerId);
        if (!normalizedDescriptorId || normalizedDescriptorId === LEGACY_COMPAT_PRIMARY_AGENT_ID_NORMALIZED) continue;
        providerIds.add(normalizedDescriptorId);
    }

    return [...providerIds];
}

export function getResolvedProviderCatalogEntries(params: Readonly<{
    enabledAgentIds: readonly string[];
    backendEnabledByTargetKey?: Readonly<Record<string, boolean>> | null;
    acpCatalogSettingsV1?: AcpCatalogSettingsV1;
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null;
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null;
}>): ResolvedProviderCatalogEntry[] {
    void params.acpCatalogSettingsV1;
    return uniqueProviderIds({
        enabledAgentIds: params.enabledAgentIds,
        mergedBackendProjectionById: params.mergedBackendProjectionById,
        mergedProviderProjectionById: params.mergedProviderProjectionById,
    }).map((providerId) => {
        const mergedProviderProjection = readMergedProviderProjection(providerId, params.mergedProviderProjectionById);
        const settingsBackendProjection = readSettingsBackendProjectionForProvider(
            providerId,
            mergedProviderProjection,
            params.mergedBackendProjectionById,
        );
        const isBuiltIn = isBuiltInProvider(providerId, mergedProviderProjection);
        const behaviorProviderId = resolveBehaviorProviderId(providerId, mergedProviderProjection, settingsBackendProjection);
        const descriptor = getProviderSettingsDescriptor(behaviorProviderId);
        const behavior = getProviderSettingsBehavior(behaviorProviderId);
        const iconAgentId = resolveProviderIconAgentId(mergedProviderProjection, settingsBackendProjection, behaviorProviderId);
        const backendTargetKey = resolveProviderTargetKeyFromSettingsBackend(providerId, isBuiltIn, settingsBackendProjection);
        return {
            providerId,
            providerAgentId: behaviorProviderId,
            iconAgentId,
            backendTargetKey,
            title: resolveProviderTitle(providerId, descriptor, mergedProviderProjection, settingsBackendProjection),
            subtitle: resolveProviderSubtitle(providerId, descriptor, mergedProviderProjection, settingsBackendProjection),
            iconName: resolveProviderDisplayIconName(iconAgentId, providerId, descriptor),
            channel: resolveProviderChannel(providerId, mergedProviderProjection),
            enabled: resolveProviderEnabled(backendTargetKey, providerId, params.backendEnabledByTargetKey ?? null),
            isBuiltIn,
            descriptor: descriptor ?? null,
            behavior: behavior ?? null,
            authPlugin: behaviorProviderId ? getProviderLocalAuthPlugin(behaviorProviderId) : null,
        };
    });
}

export function resolveProviderCatalogProjection(providerId: string, params: Readonly<{
    enabledAgentIds: readonly string[];
    backendEnabledByTargetKey?: Readonly<Record<string, boolean>> | null;
    acpCatalogSettingsV1?: AcpCatalogSettingsV1;
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null;
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null;
}>): ResolvedProviderCatalogEntry {
    const normalizedProviderId = normalizeProviderId(providerId);
    const projections = getResolvedProviderCatalogEntries(params);
    if (projections.find((entry) => entry.providerId === normalizedProviderId)) {
        return projections.find((entry) => entry.providerId === normalizedProviderId)!;
    }

    const mergedProviderProjection = readMergedProviderProjection(normalizedProviderId, params.mergedProviderProjectionById);
    const settingsBackendProjection = readSettingsBackendProjectionForProvider(
        normalizedProviderId,
        mergedProviderProjection,
        params.mergedBackendProjectionById,
    );
    const isBuiltIn = isBuiltInProvider(normalizedProviderId, mergedProviderProjection);
    const behaviorProviderId = resolveBehaviorProviderId(normalizedProviderId, mergedProviderProjection, settingsBackendProjection);
    const descriptor = getProviderSettingsDescriptor(behaviorProviderId);
    const behavior = getProviderSettingsBehavior(behaviorProviderId);
    const iconAgentId = resolveProviderIconAgentId(mergedProviderProjection, settingsBackendProjection, behaviorProviderId);
    const backendTargetKey = resolveProviderTargetKeyFromSettingsBackend(normalizedProviderId, isBuiltIn, settingsBackendProjection);
    return {
        providerId: normalizedProviderId,
        providerAgentId: behaviorProviderId,
        iconAgentId,
        backendTargetKey,
        title: resolveProviderTitle(normalizedProviderId, descriptor, mergedProviderProjection, settingsBackendProjection),
        subtitle: resolveProviderSubtitle(normalizedProviderId, descriptor, mergedProviderProjection, settingsBackendProjection),
        iconName: resolveProviderDisplayIconName(iconAgentId, normalizedProviderId, descriptor),
        channel: resolveProviderChannel(normalizedProviderId, mergedProviderProjection),
        enabled: resolveProviderEnabled(backendTargetKey, normalizedProviderId, params.backendEnabledByTargetKey ?? null),
        isBuiltIn,
        descriptor: descriptor ?? null,
        behavior: behavior ?? null,
        authPlugin: behaviorProviderId ? getProviderLocalAuthPlugin(behaviorProviderId) : null,
    };
}
