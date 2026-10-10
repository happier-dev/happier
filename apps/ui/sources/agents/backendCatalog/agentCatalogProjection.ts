import type {
    AcpBackendDefinitionV1,
    PluginAgentCliMetadata,
    PluginContributionIdentityV1,
    PluginProjectedAgentConnectedAccountPurposeV2,
    PluginProjectionInstalledPackageV2,
} from '@happier-dev/protocol';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { AgentExecutionTargetV1Schema, CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';

import { AGENT_IDS, getAgentCore, isBundledAgentId, type AgentId } from '@/agents/catalog/catalog';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import { getAgentLocalAuthPlugin } from '@/agents/catalog/localAuth/agentLocalAuthCatalog';
import { createProjectedAgentLocalAuthPlugin } from '@/agents/catalog/localAuth/createProjectedAgentLocalAuthPlugin';
import type { BundledAgentUiBehaviorDescriptor } from '@/agents/registry/generatedBundledPluginEntries.uiBehaviorOverrides';
import { BUNDLED_CANONICAL_AGENT_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import {
    resolveBundledAgentUiBehaviorProjection,
    type AgentUiBehavior,
} from '@/agents/registry/registryUiBehavior';
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
import { resolveCliAuthBackgroundCheckSafe } from './resolveCliAuthBackgroundCheckSafe';
import { resolveAgentMarkAgentId } from './resolveAgentMarkAgentId';

export type ResolvedAgentCatalogEntry = Readonly<{
    agentId: string;
    /** Exact qualified identity from a daemon row or admitted bundled declaration. */
    qualifiedId: string;
    /**
     * Exact daemon-projected identity for an external Agent. Consumers that
     * need an Agent route must retain this instead of parsing `agentId`.
     */
    identity: PluginContributionIdentityV1 | null;
    installedPackage: PluginProjectionInstalledPackageV2 | null;
    projectionGeneration: number | null;
    catalogAgentId: AgentId | null;
    iconAgentId: AgentId | null;
    backendTargetKey: string | null;
    title: string;
    subtitle: string | null;
    iconName: string;
    channel: 'stable' | 'experimental' | 'plugin' | null;
    enabled: boolean | null;
    isBuiltIn: boolean;
    /**
     * Bundled presentation behavior projected only through an explicit
     * built-in backing Agent. `agentId` remains the external Agent identity.
     */
    descriptor: BundledAgentUiBehaviorDescriptor | null;
    behavior: AgentUiBehavior | null;
    authPlugin: AgentLocalAuthPlugin | null;
    /** Exact public CLI declaration; bundled facts do not grant execution. */
    cli?: PluginAgentCliMetadata | null;
    cliAuthBackgroundCheckSafe: boolean;
    /** Exact Agent-owned Account purposes, available from bundled declarations when cold. */
    connectedAccounts: readonly PluginProjectedAgentConnectedAccountPurposeV2[];
}>;

const CANONICAL_AGENT_ID_BY_NORMALIZED = new Map<string, AgentId>(
    AGENT_IDS.map((agentId) => [agentId.toLowerCase(), agentId]),
);

function normalizeAgentId(agentId: string | null | undefined): string {
    const trimmed = String(agentId ?? '').trim();
    if (!trimmed) return '';
    if (isBundledAgentId(trimmed)) return trimmed;
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
    return isBundledAgentId(agentId);
}

function resolveProviderTargetKey(agentId: string, isBuiltIn: boolean): string | null {
    const normalizedProviderId = normalizeAgentId(agentId);
    if (!normalizedProviderId) return null;
    if (isBuiltIn && isBundledAgentId(normalizedProviderId)) {
        // A declared contribution may require instance authoring before it is
        // an executable selection. Its container has no target binding key.
        try {
            return resolveBackendTargetKeyV2({ kind: 'backend', backendId: normalizedProviderId });
        } catch {
            return null;
        }
    }
    return null;
}

function resolveProviderTargetKeyFromSettingsBackend(
    agentId: string,
    isBuiltIn: boolean,
    settingsBackendProjection: MergedBackendProjectionEntry | null,
    identity: PluginContributionIdentityV1 | null,
): string | null {
    if (isBuiltIn && isBundledAgentId(agentId)) {
        return resolveProviderTargetKey(agentId, isBuiltIn);
    }
    if (settingsBackendProjection?.backendId) {
        return resolveBackendTargetKeyV2({ kind: 'backend', backendId: settingsBackendProjection.backendId });
    }
    // An installed Agent's canonical binding key is its qualified contribution
    // identity — the exact key the selectable-target catalog already publishes
    // and every enablement/permission/model writer already uses. Reporting
    // `null` here left the same Agent with no reachable enable state, default
    // permission mode, or Models entry on its own detail screen.
    if (identity) {
        const target = AgentExecutionTargetV1Schema.safeParse({ kind: 'agent', identity });
        return target.success ? resolveBackendTargetKeyV2(target.data) : null;
    }
    return resolveProviderTargetKey(agentId, isBuiltIn);
}

export function resolveAgentCatalogBackingId(agentId: string, declaredCatalogAgentId: string | null): AgentId | null {
    if (declaredCatalogAgentId && isBundledAgentId(declaredCatalogAgentId) && getAgentCore(declaredCatalogAgentId)) {
        return declaredCatalogAgentId;
    }
    return isBundledAgentId(agentId) && getAgentCore(agentId) ? agentId : null;
}

function resolveBehaviorProviderId(
    agentId: string,
    mergedProviderProjection: MergedProviderProjectionEntry | null,
    primaryMergedBackendProjection: MergedBackendProjectionEntry | null,
): AgentId | null {
    const projectedCatalogAgentId = mergedProviderProjection?.catalogAgentId ?? primaryMergedBackendProjection?.catalogAgentId ?? null;
    return resolveAgentCatalogBackingId(agentId, projectedCatalogAgentId);
}

export function resolveAgentCatalogTitle(
    agentId: string,
    mergedProviderProjection: MergedProviderProjectionEntry | null = null,
    primaryMergedBackendProjection: MergedBackendProjectionEntry | null = null,
): string {
    agentId = normalizeAgentId(agentId);
    if (mergedProviderProjection?.title) {
        return mergedProviderProjection.title;
    }

    if (primaryMergedBackendProjection?.title) {
        return primaryMergedBackendProjection.title;
    }

    const core = getAgentCore(agentId);
    if (core) return t(core.displayNameKey);

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

    if (isBundledAgentId(agentId)) {
        return agentId;
    }

    return null;
}

function resolveProviderIconName(agentId: string): string {
    const providerCore = getAgentCore(agentId);
    if (providerCore) {
        return providerCore.ui.agentPickerIconName;
    }

    return 'layers-outline';
}

function resolveProviderIconAgentId(
    agentId: string,
    mergedProviderProjection: MergedProviderProjectionEntry | null,
    primaryMergedBackendProjection: MergedBackendProjectionEntry | null,
): AgentId | null {
    return resolveAgentMarkAgentId({
        agentId,
        iconAgentId: mergedProviderProjection?.iconAgentId ?? primaryMergedBackendProjection?.iconAgentId ?? null,
        catalogAgentId: mergedProviderProjection?.catalogAgentId ?? primaryMergedBackendProjection?.catalogAgentId ?? null,
    });
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

    if (!isBundledAgentId(agentId)) {
        return 'plugin';
    }

    const core = getAgentCore(agentId);
    if (!core) return null;
    return core.availability.experimental ? 'experimental' : 'stable';
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
    if (!backendTargetKey) return null;
    const targetKey = backendTargetKey;
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
    isBuiltIn: boolean,
): AgentLocalAuthPlugin | null {
    if (mergedProviderProjection?.cli) {
        return createProjectedAgentLocalAuthPlugin({
            agentId,
            cli: mergedProviderProjection.cli,
        });
    }
    // A bundled catalog backing may lend presentation/behavior to an external
    // Agent, but it is not that Agent's executable or authentication contract.
    // External auth exists only when the Agent's own projection contributes CLI
    // metadata above; otherwise setup/settings must remain truthfully empty.
    return isBuiltIn && behaviorProviderId ? getAgentLocalAuthPlugin(behaviorProviderId) : null;
}

export function getResolvedAgentCatalogEntries(params: Readonly<{
    enabledAgentIds: readonly string[];
    backendEnabledByTargetKey?: Readonly<Record<string, boolean>> | null;
    acpCatalogSnapshot?: AcpCatalogSnapshotV1;
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null;
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null;
}>): ResolvedAgentCatalogEntry[] {
    const entries = uniqueProviderIds({
        enabledAgentIds: params.enabledAgentIds,
        mergedBackendProjectionById: params.mergedBackendProjectionById,
        mergedProviderProjectionById: params.mergedProviderProjectionById,
    }).map((agentId) => resolveAgentCatalogProjection(agentId, params));
    if (params.acpCatalogSnapshot?.status === 'ready') {
        entries.push(...params.acpCatalogSnapshot.record.definitions.map(definition =>
            resolveConfiguredAcpAgentCatalogProjection(definition, params)));
    }
    return entries;
}

/** Configured targets stay distinct from a bundled Agent with the same display id. */
export function resolveConfiguredAcpAgentCatalogProjection(definition: AcpBackendDefinitionV1,
    params: Parameters<typeof resolveAgentCatalogProjection>[1]): ResolvedAgentCatalogEntry {
    const identity = CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1;
    const projectedAgent = Object.values(params.mergedProviderProjectionById ?? {}).find((entry) => (
        entry.identity?.pluginId === identity.pluginId && entry.identity.localId === identity.localId
    ));
    const presentation = resolveAgentCatalogProjection(projectedAgent?.agentId ?? identity.localId, params);
    const backendTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: definition.id, configuredBackendId: definition.id });
    return {
        ...presentation,
        backendTargetKey,
        qualifiedId: `${identity.pluginId}/${identity.localId}`,
        title: definition.title ?? definition.name,
        subtitle: null,
        enabled: readBackendTargetEnabled({ backendEnabledByTargetKey: params.backendEnabledByTargetKey,
            canonicalTargetKey: backendTargetKey }),
        isBuiltIn: false,
        identity,
    };
}

export function resolveAgentCatalogProjection(agentId: string, params: Readonly<{
    enabledAgentIds: readonly string[];
    backendEnabledByTargetKey?: Readonly<Record<string, boolean>> | null;
    acpCatalogSnapshot?: AcpCatalogSnapshotV1;
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null;
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null;
}>): ResolvedAgentCatalogEntry {
    const normalizedProviderId = normalizeAgentId(agentId);
    const mergedProviderProjection = readMergedProviderProjection(normalizedProviderId, params.mergedProviderProjectionById);
    const settingsBackendProjection = readSettingsBackendProjectionForAgent(
        normalizedProviderId,
        mergedProviderProjection,
        params.mergedBackendProjectionById,
    );
    const isBuiltIn = isBuiltInProvider(normalizedProviderId, mergedProviderProjection);
    const behaviorProviderId = resolveBehaviorProviderId(normalizedProviderId, mergedProviderProjection, settingsBackendProjection);
    const behaviorProjection = resolveBundledAgentUiBehaviorProjection(behaviorProviderId);
    const iconAgentId = resolveProviderIconAgentId(normalizedProviderId, mergedProviderProjection, settingsBackendProjection);
    // A current daemon declaration wins, including explicit removals. Only a
    // canonical bundled Agent without a daemon row uses admitted static facts.
    const declaration = !mergedProviderProjection && isBuiltIn && isBundledAgentId(normalizedProviderId)
        ? BUNDLED_CANONICAL_AGENT_DECLARATIONS[normalizedProviderId] : null;
    const identity = mergedProviderProjection?.identity ?? declaration?.identity ?? null;
    const backendTargetKey = resolveProviderTargetKeyFromSettingsBackend(
        normalizedProviderId,
        isBuiltIn,
        settingsBackendProjection,
        identity,
    );
    return {
        agentId: normalizedProviderId,
        qualifiedId: mergedProviderProjection?.qualifiedId ?? normalizedProviderId,
        identity,
        installedPackage: mergedProviderProjection?.installedPackage ?? null,
        projectionGeneration: mergedProviderProjection?.projectionGeneration ?? null,
        catalogAgentId: behaviorProviderId,
        iconAgentId,
        backendTargetKey,
        title: mergedProviderProjection?.title ?? settingsBackendProjection?.title
            ?? resolveAgentCatalogTitle(normalizedProviderId, mergedProviderProjection, settingsBackendProjection),
        subtitle: resolveProviderSubtitle(normalizedProviderId, mergedProviderProjection, settingsBackendProjection),
        iconName: resolveProviderDisplayIconName(iconAgentId, normalizedProviderId),
        channel: resolveProviderChannel(normalizedProviderId, mergedProviderProjection),
        enabled: resolveProviderEnabled(backendTargetKey, normalizedProviderId, {
            backendEnabledByTargetKey: params.backendEnabledByTargetKey ?? null,
            mergedBackendProjectionById: params.mergedBackendProjectionById,
            mergedProviderProjectionById: params.mergedProviderProjectionById,
        }),
        isBuiltIn,
        descriptor: behaviorProjection?.descriptor ?? null,
        behavior: behaviorProjection?.behavior ?? null,
        authPlugin: resolveAgentLocalAuthPlugin(normalizedProviderId, behaviorProviderId, mergedProviderProjection, isBuiltIn),
        cli: mergedProviderProjection?.cli ?? declaration?.cli ?? null,
        cliAuthBackgroundCheckSafe: resolveCliAuthBackgroundCheckSafe(normalizedProviderId, mergedProviderProjection),
        connectedAccounts: mergedProviderProjection?.connectedAccounts ?? declaration?.connectedAccounts.map((purpose) => ({
            ...purpose,
            service: qualifyPluginContributionReferenceV1(purpose.service, declaration.identity.pluginId),
        })) ?? [],
    };
}
