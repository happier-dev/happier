import {
    materializeExternalSessionSourceInstances,
    parseExternalSessionsSourceForDeclaration,
    resolveExternalSessionsSourceKeyForDeclaration,
    type AccountProfile,
    type ExternalSessionsAgentId,
    type ExternalSessionsSource,
    type PluginBackendExternalSessionSourceDeclarationV1,
    type PluginProjectedAgentV2,
    type PluginProjectionV2,
} from '@happier-dev/protocol';

import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { resolveAgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import type {
    ExternalSessionBrowseLinkEnsureRequestExtras,
    ExternalSessionBrowseSourceOption,
} from '@/agents/registry/registryUiBehavior';
import type { Settings } from '@/sync/domains/settings/settings';
import { resolveCompatibleExternalSessionBrowseLinkSource } from './resolveCompatibleExternalSessionBrowseLinkSource';

function resolveProjectedExternalSessionsAgent(params: Readonly<{
    providerId: string;
    projection: PluginProjectionV2 | null | undefined;
}>): Readonly<{
    agent: PluginProjectedAgentV2;
    externalSessions: NonNullable<PluginProjectedAgentV2['externalSessions']>;
}> | null {
    const projection = params.projection;
    if (!projection) return null;
    const agent = projection.agentsById[params.providerId];
    const externalSessions = agent?.externalSessions;
    if (
        !agent
        || agent.id !== params.providerId
        || !externalSessions
        || externalSessions.generation !== projection.generation
    ) {
        return null;
    }
    const installedPackage = projection.installedPackagesById[externalSessions.agent.pluginId];
    if (
        !installedPackage
        || installedPackage.id !== externalSessions.agent.pluginId
        || installedPackage.enabled !== true
    ) {
        return null;
    }
    return { agent, externalSessions };
}

function resolveProjectedExternalSessionBrowseAgent(params: Readonly<{
    providerId: string;
    projection: PluginProjectionV2 | null | undefined;
}>): Readonly<{
    agent: PluginProjectedAgentV2;
    externalSessions: NonNullable<PluginProjectedAgentV2['externalSessions']>;
}> | null {
    const projected = resolveProjectedExternalSessionsAgent(params);
    if (
        !projected
        || projected.externalSessions.operations.listCandidates !== true
        || projected.externalSessions.operations.resolveLinkIdentity !== true
        || projected.externalSessions.sources.length === 0
    ) {
        return null;
    }
    return projected;
}

function materializeProjectedSourceOptions(params: Readonly<{
    providerId: string;
    agent: PluginProjectedAgentV2;
    declarations: readonly PluginBackendExternalSessionSourceDeclarationV1[];
    profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
    settings: Pick<Settings, 'connectedServicesProfileLabelByKey'>;
    activeServerId?: string | null;
}>): ExternalSessionBrowseSourceOption[] {
    const options: ExternalSessionBrowseSourceOption[] = [];
    const label = params.agent.title ?? resolveAgentCatalogProjection(params.providerId, {
        enabledAgentIds: [params.providerId],
    }).title;
    for (const declaration of params.declarations) {
        // The daemon admits exactly what this owner materializes; a browsable
        // option that the daemon would reject is a defect, not a presentation
        // difference, so both sides share one materializer.
        const materialized = materializeExternalSessionSourceInstances({
            declaration,
            ...(params.profile ? { connectedServices: params.profile.connectedServicesV2 } : {}),
            agentSettings: params.settings,
            activeServerId: params.activeServerId ?? null,
        });
        for (const instance of materialized.instances) {
            const source = parseExternalSessionsSourceForDeclaration(declaration, instance.source);
            if (!source) continue;
            if (instance.origin.kind === 'connectedServiceProfile') {
                const { serviceId, profileId } = instance.origin;
                options.push({
                    key: `${params.providerId}:${declaration.sourceKind}:${serviceId}:${profileId}`,
                    label,
                    detail: params.settings.connectedServicesProfileLabelByKey[
                        `${serviceId}/${profileId}`
                    ] ?? profileId,
                    source,
                });
                continue;
            }
            if (instance.origin.kind === 'agentSetting') {
                options.push({
                    key: `${params.providerId}:${declaration.sourceKind}:setting:${instance.origin.settingId}`,
                    label,
                    detail: instance.origin.value,
                    source,
                });
                continue;
            }
            options.push({
                key: `${params.providerId}:${declaration.sourceKind}`,
                label,
                source,
            });
        }
    }
    return options;
}

function enrichProjectedSourceOptions(params: Readonly<{
    providerId: string;
    projectedOptions: readonly ExternalSessionBrowseSourceOption[];
    declarations: readonly PluginBackendExternalSessionSourceDeclarationV1[];
    profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
    settings: Pick<Settings, 'connectedServicesProfileLabelByKey'>;
}>): ExternalSessionBrowseSourceOption[] {
    const getSourceOptions = resolveAgentUiBehavior(params.providerId).externalSessions?.browse?.getSourceOptions;
    if (!getSourceOptions) return [...params.projectedOptions];
    const presentationBySourceKey = new Map<string, ExternalSessionBrowseSourceOption>();
    for (const option of getSourceOptions({
        agentId: params.providerId,
        profile: params.profile,
        settings: params.settings as Settings,
    })) {
        const declaration = params.declarations.find((candidate) => candidate.sourceKind === option.source.kind);
        if (!declaration) continue;
        const parsed = parseExternalSessionsSourceForDeclaration(declaration, option.source);
        if (!parsed) continue;
        presentationBySourceKey.set(resolveExternalSessionsSourceKeyForDeclaration(declaration, parsed), option);
    }
    return params.projectedOptions.map((projectedOption) => {
        const declaration = params.declarations.find(
            (candidate) => candidate.sourceKind === projectedOption.source.kind,
        );
        if (!declaration) return projectedOption;
        const sourceKey = resolveExternalSessionsSourceKeyForDeclaration(declaration, projectedOption.source);
        return presentationBySourceKey.get(sourceKey) ?? projectedOption;
    });
}

export function resolveExternalSessionBrowseSourceOptions(params: Readonly<{
    providerId: ExternalSessionsAgentId;
    profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
    settings: Pick<Settings, 'connectedServicesProfileLabelByKey'>;
    projection: PluginProjectionV2 | null | undefined;
    activeServerId?: string | null;
}>): ExternalSessionBrowseSourceOption[] {
    const projected = resolveProjectedExternalSessionBrowseAgent(params);
    if (!projected) return [];
    return enrichProjectedSourceOptions({
        ...params,
        declarations: projected.externalSessions.sources,
        projectedOptions: materializeProjectedSourceOptions({
            ...params,
            agent: projected.agent,
            declarations: projected.externalSessions.sources,
        }),
    });
}

export function resolveExternalSessionBrowseSourceOption(params: Readonly<{
    providerId: ExternalSessionsAgentId;
    profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
    settings: Pick<Settings, 'connectedServicesProfileLabelByKey'>;
    projection: PluginProjectionV2 | null | undefined;
    source: ExternalSessionsSource;
    activeServerId?: string | null;
}>): ExternalSessionBrowseSourceOption | null {
    const projected = resolveProjectedExternalSessionBrowseAgent(params);
    const declaration = projected?.externalSessions.sources.find(
        (candidate) => candidate.sourceKind === params.source.kind,
    );
    if (!declaration) return null;
    const parsedSource = parseExternalSessionsSourceForDeclaration(declaration, params.source);
    if (!parsedSource) return null;
    const sourceKey = resolveExternalSessionsSourceKeyForDeclaration(declaration, parsedSource);
    return resolveExternalSessionBrowseSourceOptions(params).find((option) => {
        const parsedOptionSource = parseExternalSessionsSourceForDeclaration(declaration, option.source);
        if (!parsedOptionSource) return false;
        return resolveExternalSessionsSourceKeyForDeclaration(declaration, parsedOptionSource) === sourceKey;
    }) ?? null;
}

export function listExternalSessionBrowseProviderIds(params: Readonly<{
    projection: PluginProjectionV2 | null | undefined;
}>): ExternalSessionsAgentId[] {
    const projection = params.projection;
    if (!projection) return [];
    return Object.keys(projection.agentsById)
        .filter((providerId) => resolveProjectedExternalSessionBrowseAgent({ providerId, projection }) !== null)
        .sort((a, b) => {
            const orderA = resolveAgentUiBehavior(a).externalSessions?.browse?.order ?? Number.MAX_SAFE_INTEGER;
            const orderB = resolveAgentUiBehavior(b).externalSessions?.browse?.order ?? Number.MAX_SAFE_INTEGER;
            if (orderA !== orderB) return orderA - orderB;
            const titleA = projection.agentsById[a]?.title ?? a;
            const titleB = projection.agentsById[b]?.title ?? b;
            return titleA.localeCompare(titleB);
        });
}

export function supportsExternalSessionBackgroundFollow(params: Readonly<{
    providerId: string;
    source: ExternalSessionsSource;
    projection: PluginProjectionV2 | null | undefined;
}>): boolean {
    const projected = resolveProjectedExternalSessionsAgent(params);
    const declaration = projected?.externalSessions.sources.find(
        (candidate) => candidate.sourceKind === params.source.kind,
    );
    if (declaration?.terminalFollow?.userRowClassification !== 'explicitV1') {
        return false;
    }
    return parseExternalSessionsSourceForDeclaration(declaration, params.source) !== null;
}

export function resolveExternalSessionBrowseLinkEnsureRequestExtras(params: Readonly<{
    providerId: ExternalSessionsAgentId;
    source: ExternalSessionsSource;
    candidate: Readonly<{ details?: Record<string, unknown> }>;
}>): ExternalSessionBrowseLinkEnsureRequestExtras {
    const buildExtras = resolveAgentUiBehavior(params.providerId).externalSessions?.browse?.buildLinkEnsureRequestExtras;
    if (!buildExtras) return {};
    return buildExtras({
        agentId: params.providerId,
        source: params.source,
        candidate: params.candidate,
    });
}

export function resolveExternalSessionBrowseCompatibleLinkSource(params: Readonly<{
    providerId: ExternalSessionsAgentId;
    selectedSource: ExternalSessionsSource;
    candidateSource?: ExternalSessionsSource | null;
}>): ExternalSessionsSource {
    const resolveCompatibleLinkSource = resolveAgentUiBehavior(params.providerId).externalSessions?.browse?.resolveCompatibleLinkSource;
    return resolveCompatibleExternalSessionBrowseLinkSource({
        selectedSource: params.selectedSource,
        candidateSource: params.candidateSource,
        ...(resolveCompatibleLinkSource
            ? {
                resolveCompatibleLinkSource: (ctx) => resolveCompatibleLinkSource({
                    agentId: params.providerId,
                    selectedSource: ctx.selectedSource,
                    candidateSource: ctx.candidateSource,
                }),
            }
            : {}),
    });
}
