import { materializeExternalSessionSourceInstances } from '@happier-dev/protocol/plugins/backendExternalSessionSourceInstances';
import { parseExternalSessionsSourceForDeclaration, resolveExternalSessionsSourceKeyForDeclaration } from '@happier-dev/protocol/sessions/external/sourceCatalog';
import type { AccountProfile } from '@happier-dev/protocol/account/profile';
import type { ExternalSessionsAgentId, ExternalSessionsSource } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import type { PluginBackendExternalSessionSourceDeclarationV1 } from '@happier-dev/protocol/plugins/backendDefinitionV1';
import type { PluginProjectedAgentV2, PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolveQualifiedConnectedAccountLabel } from '@happier-dev/protocol/connect/connectedServiceProfilePreferences';

import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { resolveAgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import type {
    ExternalSessionBrowseLinkEnsureRequestExtras,
    ExternalSessionBrowseSourceOption,
} from '@/agents/registry/registryUiBehavior';
import { resolveQualifiedConnectedAccountServiceKey } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveCompatibleExternalSessionBrowseLinkSource } from './resolveCompatibleExternalSessionBrowseLinkSource';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contributionIdentity';

/** Presentation input from the scoped catalog, not a live Account Settings root. */
export type ExternalSessionBrowseLabels = Readonly<Record<string, string | undefined>>;

/** Capture supplies a qualified producer and its admitted source, never a guessed Agent id. */
export function resolveExternalSessionBrowseTargetForQualifiedSource(params: Readonly<{
    agent: PluginContributionIdentityV1;
    source: ExternalSessionsSource;
    projection: PluginProjectionV2 | null | undefined;
}>): Readonly<{ agentId: ExternalSessionsAgentId; source: ExternalSessionsSource }> | null {
    const matches = Object.values(params.projection?.agentsById ?? {}).flatMap(agent => {
        const projected = resolveProjectedExternalSessionBrowseAgent({ providerId: agent.id, projection: params.projection });
        if (!projected || projected.externalSessions.agent.pluginId !== params.agent.pluginId
            || projected.externalSessions.agent.localId !== params.agent.localId) return [];
        const declaration = projected.externalSessions.sources.find(row => row.sourceKind === params.source.kind && row.resumeOnly !== true);
        const source = declaration ? parseExternalSessionsSourceForDeclaration(declaration, params.source) : null;
        return source ? [{ agentId: agent.id, source }] : [];
    });
    return matches.length === 1 ? matches[0] : null;
}

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
    interaction?: 'openSession' | 'pickRemoteSessionId';
}>): Readonly<{
    agent: PluginProjectedAgentV2;
    externalSessions: NonNullable<PluginProjectedAgentV2['externalSessions']>;
}> | null {
    const projected = resolveProjectedExternalSessionsAgent(params);
    if (
        !projected
        || projected.externalSessions.operations.listCandidates !== true
        || (params.interaction !== 'pickRemoteSessionId'
            && projected.externalSessions.operations.resolveLinkIdentity !== true)
        || !projected.externalSessions.sources.some((source) => (
            params.interaction === 'pickRemoteSessionId' || source.resumeOnly !== true
        ))
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
    labelsByKey: ExternalSessionBrowseLabels;
    agentSettings?: Readonly<Record<string, unknown>>;
    activeServerId?: string | null;
    interaction?: 'openSession' | 'pickRemoteSessionId';
}>): ExternalSessionBrowseSourceOption[] {
    const options: ExternalSessionBrowseSourceOption[] = [];
    const label = params.agent.title ?? resolveAgentCatalogProjection(params.providerId, {
        enabledAgentIds: [params.providerId],
    }).title;
    for (const declaration of params.declarations) {
        if (declaration.resumeOnly === true && params.interaction !== 'pickRemoteSessionId') continue;
        // The daemon admits exactly what this owner materializes; a browsable
        // option that the daemon would reject is a defect, not a presentation
        // difference, so both sides share one materializer.
        const materialized = materializeExternalSessionSourceInstances({
            declaration,
            ...(params.profile ? { connectedServices: params.profile.connectedServicesV2 } : {}),
            agentSettings: params.agentSettings,
            activeServerId: params.activeServerId ?? null,
        });
        for (const instance of materialized.instances) {
            const source = parseExternalSessionsSourceForDeclaration(declaration, instance.source);
            if (!source) continue;
            if (instance.origin.kind === 'connectedServiceProfile') {
                const { serviceId, profileId } = instance.origin;
                const serviceKey = resolveQualifiedConnectedAccountServiceKey(serviceId);
                const service = serviceKey ? parseQualifiedPluginContributionKey(serviceKey) : null;
                options.push({
                    key: `${params.providerId}:${declaration.sourceKind}:${serviceId}:${profileId}`,
                    label,
                    detail: (service ? resolveQualifiedConnectedAccountLabel({
                        labelsByKey: params.labelsByKey, service, accountId: profileId,
                    }) : null) ?? profileId,
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
    accountScope?: ServerAccountScope | null;
    providerId: string;
    machineId?: string | null;
    projectedOptions: readonly ExternalSessionBrowseSourceOption[];
    declarations: readonly PluginBackendExternalSessionSourceDeclarationV1[];
    profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
    labelsByKey: ExternalSessionBrowseLabels;
}>): ExternalSessionBrowseSourceOption[] {
    const getSourceOptions = resolveAgentUiBehavior(params.providerId, params.machineId, params.accountScope)
        .externalSessions?.browse?.getSourceOptions;
    if (!getSourceOptions) return [...params.projectedOptions];
    const presentationBySourceKey = new Map<string, ExternalSessionBrowseSourceOption>();
    for (const option of getSourceOptions({
        agentId: params.providerId,
        profile: params.profile,
        labelsByKey: params.labelsByKey,
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
    accountScope?: ServerAccountScope | null;
    providerId: ExternalSessionsAgentId;
    /**
     * The machine being browsed. An installed Agent's UI declaration is a fact
     * of one machine, so the browse presentation is read from the machine whose
     * sessions are being listed rather than from whichever machine happens to
     * have published first.
     */
    machineId?: string | null;
    profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
    labelsByKey: ExternalSessionBrowseLabels;
    agentSettings?: Readonly<Record<string, unknown>>;
    projection: PluginProjectionV2 | null | undefined;
    activeServerId?: string | null;
    interaction?: 'openSession' | 'pickRemoteSessionId';
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
    accountScope?: ServerAccountScope | null;
    providerId: ExternalSessionsAgentId;
    /** See `resolveExternalSessionBrowseSourceOptions`. */
    machineId?: string | null;
    profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
    labelsByKey: ExternalSessionBrowseLabels;
    agentSettings?: Readonly<Record<string, unknown>>;
    projection: PluginProjectionV2 | null | undefined;
    source: ExternalSessionsSource;
    activeServerId?: string | null;
    interaction?: 'openSession' | 'pickRemoteSessionId';
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

/** An older daemon can ignore a content selector, so only a current source advertisement admits it. */
export function resolveExternalSessionBrowseContentSearchCapability(params: Readonly<{
    providerId: ExternalSessionsAgentId | null;
    projection: PluginProjectionV2 | null | undefined;
    source: ExternalSessionsSource | null;
}>): boolean | undefined {
    if (!params.providerId || !params.source) return undefined;
    const projected = resolveProjectedExternalSessionsAgent({
        providerId: params.providerId,
        projection: params.projection,
    });
    if (projected?.externalSessions.operations.listCandidates !== true) return undefined;
    const declaration = projected.externalSessions.sources.find((source) => source.sourceKind === params.source?.kind);
    if (!declaration || !parseExternalSessionsSourceForDeclaration(declaration, params.source)) return undefined;
    return declaration.contentSearch;
}

export function resolveExternalSessionBrowseContentSearchSupported(
    params: Parameters<typeof resolveExternalSessionBrowseContentSearchCapability>[0],
): boolean {
    return resolveExternalSessionBrowseContentSearchCapability(params) === true;
}

export function listExternalSessionBrowseProviderIds(params: Readonly<{
    accountScope?: ServerAccountScope | null;
    projection: PluginProjectionV2 | null | undefined;
    /** See `resolveExternalSessionBrowseSourceOptions`. */
    machineId?: string | null;
    interaction?: 'openSession' | 'pickRemoteSessionId';
}>): ExternalSessionsAgentId[] {
    const projection = params.projection;
    if (!projection) return [];
    return Object.keys(projection.agentsById)
        .filter((providerId) => resolveProjectedExternalSessionBrowseAgent({
            providerId,
            projection,
            interaction: params.interaction,
        }) !== null)
        .sort((a, b) => {
            const orderA = resolveAgentUiBehavior(a, params.machineId, params.accountScope).externalSessions?.browse?.order ?? Number.MAX_SAFE_INTEGER;
            const orderB = resolveAgentUiBehavior(b, params.machineId, params.accountScope).externalSessions?.browse?.order ?? Number.MAX_SAFE_INTEGER;
            if (orderA !== orderB) return orderA - orderB;
            const titleA = projection.agentsById[a]?.title ?? a;
            const titleB = projection.agentsById[b]?.title ?? b;
            return titleA.localeCompare(titleB);
        });
}

/**
 * Client-side eligibility for observation-backed background follow of a linked
 * External Session: the Agent must still be projected by the current generation
 * from an enabled package, and the linked source must be a source that Agent
 * currently declares and accepts.
 *
 * It deliberately does not read `terminalFollow.userRowClassification`. That
 * cold opt-in gates native terminal-mode transcript projection
 * (`ES-PEP-03`/`ES-PEP-05`), which authors hosted transcript rows and therefore
 * needs provider-authored user-row origin classification. Background follow
 * writes no transcript rows — the canonical lease owner only derives observed
 * progress — so the amendment leaves observation and the generic private follow
 * owner unchanged. Live eligibility stays with the canonical daemon owner
 * (`canAttemptCanonicalExternalSessionLiveFollow`), whose typed
 * `background_follow_not_supported` result the surfaces already render.
 */
export function supportsExternalSessionBackgroundFollow(params: Readonly<{
    providerId: string;
    source: ExternalSessionsSource;
    projection: PluginProjectionV2 | null | undefined;
}>): boolean {
    const projected = resolveProjectedExternalSessionsAgent(params);
    const declaration = projected?.externalSessions.sources.find(
        (candidate) => candidate.sourceKind === params.source.kind,
    );
    // A resume-only source declares listing plus "resume in Happier" and
    // nothing else, so a retained link to one must never expose background
    // follow even though its source kind still parses.
    if (!declaration || declaration.resumeOnly === true) return false;
    return parseExternalSessionsSourceForDeclaration(declaration, params.source) !== null;
}

export function resolveExternalSessionBrowseLinkEnsureRequestExtras(params: Readonly<{
    accountScope?: ServerAccountScope | null;
    providerId: ExternalSessionsAgentId;
    /** See `resolveExternalSessionBrowseSourceOptions`. */
    machineId?: string | null;
    source: ExternalSessionsSource;
    candidate: Readonly<{ details?: Record<string, unknown> }>;
}>): ExternalSessionBrowseLinkEnsureRequestExtras {
    const buildExtras = resolveAgentUiBehavior(params.providerId, params.machineId, params.accountScope)
        .externalSessions?.browse?.buildLinkEnsureRequestExtras;
    if (!buildExtras) return {};
    return buildExtras({
        agentId: params.providerId,
        source: params.source,
        candidate: params.candidate,
    });
}

export function resolveExternalSessionBrowseCompatibleLinkSource(params: Readonly<{
    accountScope?: ServerAccountScope | null;
    providerId: ExternalSessionsAgentId;
    /** See `resolveExternalSessionBrowseSourceOptions`. */
    machineId?: string | null;
    selectedSource: ExternalSessionsSource;
    candidateSource?: ExternalSessionsSource | null;
}>): ExternalSessionsSource {
    const resolveCompatibleLinkSource = resolveAgentUiBehavior(params.providerId, params.machineId, params.accountScope)
        .externalSessions?.browse?.resolveCompatibleLinkSource;
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
