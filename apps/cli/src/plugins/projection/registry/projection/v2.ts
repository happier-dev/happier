import type {
    PluginDiagnosticRecordV1,
    PluginActionPresentUserGatePolicy,
    PluginProjectionBrandAssetV2,
    PluginProjectionInstalledPackageV2,
    PluginProjectionV2,
    PluginMachineExecutionOriginV1,
} from '@happier-dev/protocol';
import {
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    isDynamicPluginResourceContributionV2,
    PluginAgentCapabilitiesV2Schema,
    PluginActionDeclaredExecutionV2Schema,
    PluginActionScopeV2Schema,
    PluginMachineExecutionOriginV1Schema,
    PluginSettingsProjectionError,
    projectPluginSettingsContributionV2,
    PluginResourceKindV2Schema,
} from '@happier-dev/protocol';

import type { PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import type { PluginFinalPolicyCurrentGeneration } from '@/plugins/runtime/policy/facts';
import { projectTargetActionPresentUserAuthorizationFacts } from '@/plugins/runtime/policy/evaluate';
import type { PluginSettingsRollbackDeclarations } from '@/plugins/settings/settingsRollbackDeclarations';
import type {
    ResolvedActionContribution,
    ResolvedContributionRegistry,
    ResolvedContributionProvenance,
    ResolvedContributionSource,
    ResolvedContributionSourceKind,
    ResolvedAgentContribution,
} from '../types';
import {
    buildPluginProjectionFamiliesByIdV2,
} from '@/plugins/projection/families';
import { managedDependenciesProjectionFamily } from '../managedDependencies';
import { accountCollectionsProjectionFamily } from '../accountCollections';
import { mcpProjectionFamily } from '../mcp';
import { scmBackendProjectionFamily } from '../scmBackends';
import { scmHostingProviderProjectionFamily } from '../scmHostingProviders';
import {
    pluginUiProjectionFamily,
    type PluginUiProjectionHostRuntimeContext,
} from '../ui/projection';
import { pluginBrowserProjectionFamily } from '../browser';
import { providerProjectionFamily } from '../providers';
import { connectedAccountProjectionFamily } from '../connectedAccounts';
import { voiceModelPackProjectionFamily, voiceProviderProjectionFamily } from '../voiceDeclarations';
import {
    composerAttachmentsProjectionFamily,
    composerControlsProjectionFamily,
    composerRegionsProjectionFamily,
} from '../composer';
import {
    buildPluginContributionIntrospectionQualifiedId,
    projectPluginCompatibilityDiagnostics,
    projectPluginContributionIntrospection,
} from '@/plugins/projection/introspection/project';
import { mapPluginSourceToDiagnosticSource } from '@/plugins/projection/introspection/source';
import type { PluginTargetActivationIntrospectionSnapshot } from '@/plugins/projection/introspection/targetActivationFacts';
import {
    PluginLocalSettingsDeclarationError,
    resolveLocalSettingsDeclarations,
} from '@/plugins/settings/localSettingsContributions';
import { resolveNotificationChannelSettingsContributions } from '@/plugins/settings/notificationChannelSettings';

function readOptionalString(value: unknown): string | undefined {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : undefined;
}

function readLocalizedText(value: unknown): string | undefined {
    if (typeof value === 'string') return readOptionalString(value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return readOptionalString((value as Readonly<{ fallback?: unknown }>).fallback);
}

function qualifiedProjectionKey(pluginId: string, localId: string): string {
    return buildQualifiedPluginContributionKey(createPluginContributionIdentity({ pluginId, localId }));
}

function readAgentTitle(agent: ResolvedAgentContribution): string | undefined {
    const rich = agent.richDefinition;
    if (!rich) return undefined;
    return readLocalizedText(rich.definition.title);
}

function readAgentSubtitle(agent: ResolvedAgentContribution): string | undefined {
    const rich = agent.richDefinition;
    if (!rich) return undefined;
    return readLocalizedText(rich.definition.description);
}

function readAgentProjectionDefinition(
    agent: ResolvedAgentContribution,
): Readonly<Record<string, unknown>> {
    return (agent.richDefinition?.definition ?? agent.definition) as Readonly<Record<string, unknown>>;
}

function readAgentProjectionCatalogAgentId(
    definition: Readonly<Record<string, unknown>>,
): string | undefined {
    return readOptionalString(definition.catalogAgentId);
}

function readAgentProviderOwnedEnvironmentKeys(
    definition: Readonly<Record<string, unknown>>,
): readonly string[] {
    const providerRequirements = definition.providerRequirements;
    if (!providerRequirements || typeof providerRequirements !== 'object' || Array.isArray(providerRequirements)) return [];
    const authIsolation = Reflect.get(providerRequirements, 'authIsolation');
    if (!authIsolation || typeof authIsolation !== 'object' || Array.isArray(authIsolation)) return [];
    const ownedEnvKeys = Reflect.get(authIsolation, 'ownedEnvKeys');
    return Array.isArray(ownedEnvKeys)
        ? ownedEnvKeys.filter((key): key is string => typeof key === 'string')
        : [];
}

function projectAgentCapabilities(
    agent: ResolvedAgentContribution,
): PluginProjectionV2['agentsById'][string]['capabilities'] {
    const capabilities = agent.richDefinition?.definition.capabilities;
    return capabilities ? PluginAgentCapabilitiesV2Schema.parse(capabilities) : undefined;
}

/**
 * Carries the Agent's declared client UI-behavior descriptor onto the wire.
 * The daemon never interprets it: the client owns the single fail-closed
 * descriptor interpreter, and this is the only runtime channel an installed
 * Agent has to reach it.
 */
/**
 * Collects the Agents that own an MCP discovery source.
 *
 * Ownership is the declaration's `metadata.agentId` — never the contribution's
 * plugin-chosen local id — exactly as the daemon's detection resolves it in
 * `apps/cli/src/mcp/providerDetection/detectProviderMcpServers.ts`.
 */
/**
 * Carries the Agent's declared client UI-behavior descriptor onto the wire.
 * The daemon never interprets it: the client owns the single fail-closed
 * descriptor interpreter, and this is the only runtime channel an installed
 * Agent has to reach it.
 */
function projectAgentUiBehavior(
    agent: ResolvedAgentContribution,
): PluginProjectionV2['agentsById'][string]['ui'] {
    return agent.richDefinition?.definition.ui;
}

function projectAgentExternalSessions(
    agent: ResolvedAgentContribution,
    generation: number,
): PluginProjectionV2['agentsById'][string]['externalSessions'] {
    const identity = agent.identity;
    const definition = agent.richDefinition?.definition;
    const surfaces = definition?.capabilities.surfaces ?? [];
    const sources = definition?.surfaces?.externalSession?.sources ?? [];
    if (
        !identity
        || !surfaces.includes('externalSessions')
        || sources.length === 0
    ) {
        return undefined;
    }
    return {
        agent: identity,
        generation,
        operations: {
            listCandidates: true,
            resolveLinkIdentity: true,
            pageTranscript: true,
            readAfterTranscript: true,
        },
        sources: sources.map((source) => {
            const { instances, ...declaration } = source;
            return {
                ...declaration,
                schema: {
                    ...source.schema,
                    fields: source.schema.fields.map((field) => ({ ...field })),
                },
                key: {
                    segments: source.key.segments.map((segment) => ({ ...segment })),
                },
                ...(instances
                    ? {
                        instances: instances.map((instance) => {
                            if (instance.kind === 'connectedServiceProfiles') {
                                return {
                                    kind: instance.kind,
                                    serviceId: instance.serviceId,
                                    constants: { ...(instance.constants ?? {}) },
                                    fields: { ...instance.fields },
                                };
                            }
                            if (instance.kind === 'agentSetting') {
                                return {
                                    kind: instance.kind,
                                    settingId: instance.settingId,
                                    ...(instance.byServerIdSettingId
                                        ? { byServerIdSettingId: instance.byServerIdSettingId }
                                        : {}),
                                    field: instance.field,
                                    normalization: instance.normalization,
                                    constants: { ...(instance.constants ?? {}) },
                                };
                            }
                            if (instance.kind === 'agentSettingOverride') {
                                return {
                                    kind: instance.kind,
                                    settingId: instance.settingId,
                                    ...(instance.byServerIdSettingId
                                        ? { byServerIdSettingId: instance.byServerIdSettingId }
                                        : {}),
                                    field: instance.field,
                                    normalization: instance.normalization,
                                    constants: { ...(instance.constants ?? {}) },
                                };
                            }
                            return {
                                kind: instance.kind,
                                constants: { ...(instance.constants ?? {}) },
                            };
                        }),
                    }
                    : {}),
            };
        }),
    };
}

function resolveActionSurfaces(
    surfaces: Readonly<Record<string, unknown>>,
): ('agent' | 'mcp' | 'cli' | 'ui' | 'plugin' | 'voice')[] {
    const projected = new Set<'agent' | 'mcp' | 'cli' | 'ui' | 'plugin' | 'voice'>();
    if (surfaces.cli === true) {
        projected.add('cli');
    }
    if (surfaces.mcp === true) {
        projected.add('mcp');
    }
    if (surfaces.agent === true) {
        projected.add('agent');
    }
    if (surfaces.ui === true) {
        projected.add('ui');
    }
    if (surfaces.plugin === true) {
        projected.add('plugin');
    }
    if (surfaces.voice === true) {
        projected.add('voice');
    }
    return [...projected];
}

function resolveActionScopes(
    action: ResolvedActionContribution,
): PluginProjectionV2['actionsById'][string]['scopes'] {
    // Scope is a manifest-declared semantic fact. Surface only controls where
    // an Action can be invoked; deriving scope from it silently rewrites the
    // current qualified Action's host context.
    return PluginActionScopeV2Schema.array().min(1).parse(
        action.definition.scopes,
    );
}

type PluginContributionMetadata = Readonly<{
    pluginId: string;
    pluginVersion?: string;
    provenance?: ResolvedContributionProvenance;
    sourceKind?: ResolvedContributionSourceKind;
    displayName?: string;
    manifestPath?: string;
    sourceSpec?: Readonly<{
        kind?: string;
        locator?: string;
        resolvedVersion?: string;
        devWatch?: boolean;
    }>;
}>;

function collectPluginContributionMetadata(
    registry: ResolvedContributionRegistry,
): ReadonlyMap<string, PluginContributionMetadata> {
    const metadata = new Map<string, PluginContributionMetadata>();

    function upsert(entry: Readonly<{
        provenance?: ResolvedContributionProvenance;
        source?: ResolvedContributionSource;
        pluginId?: string;
        manifestPath?: string;
        sourceSpec?: PluginContributionMetadata['sourceSpec'];
        pluginVersion?: string;
        displayName?: string;
    }>): void {
        const pluginId = readOptionalString(entry.pluginId);
        if (!pluginId) {
            return;
        }
        const existing = metadata.get(pluginId);
        const mergedProvenance = existing?.provenance === 'first_party' || entry.provenance === 'first_party'
            ? 'first_party'
            : existing?.provenance ?? entry.provenance;
        const mergedSourceKind = existing?.sourceKind === 'bundled' || entry.source?.kind === 'bundled'
            ? 'bundled'
            : existing?.sourceKind ?? entry.source?.kind;
        metadata.set(pluginId, {
            pluginId,
            pluginVersion: readOptionalString(entry.pluginVersion) ?? existing?.pluginVersion,
            provenance: mergedProvenance,
            sourceKind: mergedSourceKind,
            displayName: readOptionalString(entry.displayName) ?? existing?.displayName,
            manifestPath: readOptionalString(entry.manifestPath) ?? existing?.manifestPath,
            sourceSpec: entry.sourceSpec ?? existing?.sourceSpec,
        });
    }

    for (const agent of registry.agents) {
        upsert({
            provenance: agent.provenance,
            source: agent.source,
            pluginId: agent.pluginId,
            manifestPath: agent.manifestPath,
            sourceSpec: agent.sourceSpec,
            displayName: readAgentTitle(agent),
        });
    }
    for (const action of registry.actions) {
        upsert(action);
    }
    for (const tool of registry.tools ?? []) {
        upsert(tool);
    }
    for (const command of registry.commands ?? []) {
        upsert(command);
    }
    for (const resource of registry.resources) {
        upsert(resource);
    }
    for (const target of registry.browserTargets ?? []) {
        upsert(target);
    }
    for (const action of registry.browserActions ?? []) {
        upsert(action);
    }
    for (const target of registry.activationTargets) {
        upsert(target);
    }
    for (const provider of registry.scmHostingProviders ?? []) {
        upsert({
            provenance: provider.provenance,
            source: provider.source,
            pluginId: provider.pluginId,
            manifestPath: provider.manifestPath,
            sourceSpec: provider.sourceSpec,
            displayName: readLocalizedText(provider.definition.title),
        });
    }
    for (const dependency of registry.managedDependencies ?? []) {
        const title = 'key' in dependency.definition
            ? dependency.definition.display.name
            : typeof dependency.definition.title === 'string'
                ? dependency.definition.title
                : dependency.definition.title.fallback;
        upsert({
            provenance: dependency.provenance,
            source: dependency.source,
            pluginId: dependency.pluginId,
            manifestPath: dependency.manifestPath,
            sourceSpec: dependency.sourceSpec,
            displayName: title,
        });
    }
    for (const systemTool of registry.systemTools ?? []) {
        const title = typeof systemTool.definition.title === 'string'
            ? systemTool.definition.title
            : systemTool.definition.title.fallback;
        upsert({
            provenance: systemTool.provenance,
            source: systemTool.source,
            pluginId: systemTool.pluginId,
            manifestPath: systemTool.manifestPath,
            sourceSpec: systemTool.sourceSpec,
            displayName: title,
        });
    }
    for (const server of registry.mcpServers ?? []) {
        upsert(server);
    }
    for (const source of registry.mcpDiscoverySources ?? []) {
        upsert(source);
    }
    for (const point of registry.pluginContributionPoints ?? []) {
        upsert(point);
    }
    for (const contribution of registry.targetedPluginContributions ?? []) {
        upsert(contribution);
    }
    for (const attachment of registry.composerAttachments ?? []) {
        upsert(attachment);
    }
    for (const control of registry.composerControls ?? []) {
        upsert(control);
    }
    for (const region of registry.composerRegions ?? []) {
        upsert(region);
    }

    return metadata;
}

function collectPluginDiagnosticMetadata(params: Readonly<{
    registry: ResolvedContributionRegistry;
    installedPackages: readonly PluginCatalogEntry[];
}>): ReadonlyMap<string, PluginDiagnosticRecordV1['plugin']> {
    const metadataByPluginId = new Map<string, PluginDiagnosticRecordV1['plugin']>();
    for (const entry of params.installedPackages) {
        metadataByPluginId.set(entry.pluginId, {
            id: entry.pluginId,
            version: entry.version,
            source: mapPluginSourceToDiagnosticSource(entry.source),
        });
    }
    for (const metadata of collectPluginContributionMetadata(params.registry).values()) {
        const sourceKind = metadata.sourceKind ?? metadata.sourceSpec?.kind;
        if (!metadata.pluginVersion || !sourceKind) continue;
        const candidate: PluginDiagnosticRecordV1['plugin'] = {
            id: metadata.pluginId,
            version: metadata.pluginVersion,
            source: mapPluginSourceToDiagnosticSource({
                kind: sourceKind,
                ...(metadata.sourceSpec?.devWatch === true ? { devWatch: true } : {}),
            }),
        };
        const existing = metadataByPluginId.get(metadata.pluginId);
        if (existing && (
            existing.version !== candidate.version || existing.source !== candidate.source
        )) {
            throw new Error(`Diagnostic metadata for '${metadata.pluginId}' is not current with its installed package`);
        }
        metadataByPluginId.set(metadata.pluginId, candidate);
    }
    return metadataByPluginId;
}

function projectAttributedPluginDiagnostics(params: Readonly<{
    registry: ResolvedContributionRegistry;
    installedPackages: readonly PluginCatalogEntry[];
    diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
    occurredAtMs: number;
}>): readonly PluginDiagnosticRecordV1[] {
    const metadataByPluginId = collectPluginDiagnosticMetadata(params);
    const records: PluginDiagnosticRecordV1[] = [];
    for (const pluginId of Object.keys(params.diagnosticsByPluginId).sort()) {
        const diagnostics = (params.diagnosticsByPluginId[pluginId] ?? []).filter((diagnostic) => (
            diagnostic.contribution !== undefined
        ));
        if (diagnostics.length === 0) continue;
        const plugin = metadataByPluginId.get(pluginId);
        if (!plugin) {
            throw new Error(`Missing current plugin metadata for attributed diagnostic '${pluginId}'`);
        }
        records.push(...projectPluginCompatibilityDiagnostics({
            diagnostics,
            plugin,
            defaultStage: 'normalization',
            generation: params.registry.immutableGenerationIdsByPluginId?.[pluginId],
            host: 'daemon',
            platform: process.platform,
            occurredAtMs: params.occurredAtMs,
        }));
    }
    return Object.freeze(records);
}

function buildDiagnostics(params: Readonly<{
    installedPackages: readonly PluginCatalogEntry[];
    diagnosticRecords: readonly PluginDiagnosticRecordV1[];
}>): PluginDiagnosticRecordV1[] {
    return [
        ...params.installedPackages.flatMap((entry) => entry.contributionIntrospection.diagnostics),
        ...params.diagnosticRecords,
    ];
}

function toInstalledPackage(
    entry: PluginCatalogEntry,
    immutableGenerationId: string | undefined,
): PluginProjectionInstalledPackageV2 {
    return {
        id: entry.pluginId,
        displayName: entry.title,
        version: readOptionalString(entry.version),
        enabled: entry.enabled,
        source: {
            kind: readOptionalString(entry.source.kind) ?? 'unknown',
            locator: readOptionalString(entry.source.locator) ?? entry.pluginId,
        },
        ...(immutableGenerationId ? { immutableGenerationId } : {}),
    };
}

function buildInstalledPackagesById(params: Readonly<{
    registry: ResolvedContributionRegistry;
    installedPackages: readonly PluginCatalogEntry[];
    pluginDiagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
    brandAssetsByPluginId?: Readonly<Record<string, PluginProjectionBrandAssetV2>>;
}>): PluginProjectionV2['installedPackagesById'] {
    const installedPackagesById: PluginProjectionV2['installedPackagesById'] = {};
    const metadataByPluginId = collectPluginContributionMetadata(params.registry);
    const brandAssetsByPluginId = params.brandAssetsByPluginId ?? {};

    for (const entry of params.installedPackages) {
        const brand = brandAssetsByPluginId[entry.pluginId];
        const immutableGenerationId = readOptionalString(
            params.registry.immutableGenerationIdsByPluginId?.[entry.pluginId],
        );
        installedPackagesById[entry.pluginId] = brand
            ? { ...toInstalledPackage(entry, immutableGenerationId), brand }
            : toInstalledPackage(entry, immutableGenerationId);
    }

    const fallbackPluginIds = new Set<string>([
        ...metadataByPluginId.keys(),
        ...Object.keys(params.pluginDiagnosticsByPluginId),
        ...Object.keys(brandAssetsByPluginId),
    ]);
    for (const pluginId of fallbackPluginIds) {
        if (installedPackagesById[pluginId]) {
            continue;
        }
        const metadata = metadataByPluginId.get(pluginId);
        const sourceKind = (() => {
            const kind = metadata?.sourceKind ?? readOptionalString(metadata?.sourceSpec?.kind);
            if (kind === 'bundled') {
                return 'bundled';
            }
            // These are legacy placeholders in the packetized model and should not appear in
            // new production data. Preserve them only as unknown so UI doesn't imply a real
            // installed package provenance.
            if (kind === 'package' || kind === 'marketplace') {
                return 'unknown';
            }
            return kind ?? 'unknown';
        })();
        const locator = sourceKind === 'bundled'
            ? pluginId
            : readOptionalString(metadata?.sourceSpec?.locator)
                ?? readOptionalString(metadata?.manifestPath)
                ?? pluginId;
        const brand = brandAssetsByPluginId[pluginId];
        const immutableGenerationId = readOptionalString(
            params.registry.immutableGenerationIdsByPluginId?.[pluginId],
        );
        installedPackagesById[pluginId] = {
            id: pluginId,
            displayName: metadata?.displayName ?? pluginId,
            version: readOptionalString(metadata?.sourceSpec?.resolvedVersion),
            enabled: true,
            source: {
                kind: sourceKind,
                locator,
            },
            ...(immutableGenerationId ? { immutableGenerationId } : {}),
            ...(brand ? { brand } : {}),
        };
    }

    return installedPackagesById;
}

function buildAgentsById(
    registry: ResolvedContributionRegistry,
    generation: number,
): PluginProjectionV2['agentsById'] {
    const agentsById: PluginProjectionV2['agentsById'] = {};
    for (const agent of registry.agents) {
        const identity = agent.identity;
        if (!identity) {
            throw new Error(`Agent '${agent.id}' is missing its manifest-qualified identity`);
        }
        const projectionDefinition = readAgentProjectionDefinition(agent);
        const externalSessions = projectAgentExternalSessions(agent, generation);
        const capabilities = projectAgentCapabilities(agent);
        const connectedServiceIds = agent.catalogEntry?.connectedServiceIds ?? [];
        const connectedAccounts = agent.richDefinition?.definition.connectedAccounts?.map((declaration) => ({
            ...declaration,
            service: typeof declaration.service === 'string'
                ? createPluginContributionIdentity({
                    pluginId: identity.pluginId,
                    localId: declaration.service,
                })
                : declaration.service,
        })) ?? [];
        const uiBehavior = projectAgentUiBehavior(agent);
        agentsById[agent.id] = {
            id: agent.id,
            identity,
            title: readAgentTitle(agent),
            subtitle: readAgentSubtitle(agent),
            channel: agent.provenance === 'external' ? 'plugin' : undefined,
            isBuiltIn: agent.provenance === 'first_party',
            settingsBackendId: readOptionalString(projectionDefinition.settingsBackendId),
            catalogAgentId: readAgentProjectionCatalogAgentId(projectionDefinition),
            iconAgentId: readOptionalString(projectionDefinition.iconAgentId),
            ...(connectedServiceIds.length > 0
                ? { connectedServiceIds: [...connectedServiceIds] }
                : {}),
            ...(connectedAccounts.length > 0 ? { connectedAccounts } : {}),
            providerOwnedEnvironmentKeys: [...readAgentProviderOwnedEnvironmentKeys(projectionDefinition)],
            ...(capabilities ? { capabilities } : {}),
            ...(agent.cliMetadata ? { cli: agent.cliMetadata } : {}),
            ...(externalSessions ? { externalSessions } : {}),
            ...(uiBehavior ? { ui: uiBehavior } : {}),
        };
    }
    return agentsById;
}

function buildActionsById(
    registry: ResolvedContributionRegistry,
    pluginExecutionOriginsByPluginId?: Readonly<Record<string, PluginMachineExecutionOriginV1>>,
    resolveActionPresentUserGatePolicy?: (
        pluginId: string,
        localId: string,
    ) => PluginActionPresentUserGatePolicy | null,
    pluginFinalPolicyCurrentGenerationsById?: ReadonlyMap<string, PluginFinalPolicyCurrentGeneration>,
    runtimeFactsByQualifiedId?: PluginTargetActivationIntrospectionSnapshot['runtimeFactsByQualifiedId'],
): PluginProjectionV2['actionsById'] {
    const actionsById: PluginProjectionV2['actionsById'] = {};
    for (const action of registry.actions) {
        if (!action.pluginId) {
            continue;
        }
        // Same owner as manifest ingestion and the raw catalog projection: an
        // absent realm is the daemon realm, a declared-but-invalid one is not.
        const execution = PluginActionDeclaredExecutionV2Schema.safeParse(action.definition.execution);
        if (!execution.success) {
            throw new Error(
                `Action '${action.pluginId}/${action.definition.id}' declares an unresolvable execution target`,
            );
        }
        const parsedOrigin = PluginMachineExecutionOriginV1Schema.safeParse(
            pluginExecutionOriginsByPluginId?.[action.pluginId],
        );
        const executionOrigin = parsedOrigin.success
            && parsedOrigin.data.materializationRef.pluginId === action.pluginId
            ? parsedOrigin.data
            : undefined;
        const localizedPresentation = action.localizedPresentation;
        const inputHints = localizedPresentation?.inputHints ?? action.definition.inputHints;
        let authorization: ReturnType<typeof projectTargetActionPresentUserAuthorizationFacts> | undefined;
        if (pluginFinalPolicyCurrentGenerationsById?.has(action.pluginId)) {
            try {
                const resolvedAuthorization = resolveActionPresentUserGatePolicy?.(
                    action.pluginId,
                    action.definition.id,
                )
                    ?.authorization;
                if (resolvedAuthorization) {
                    authorization = projectTargetActionPresentUserAuthorizationFacts(
                        resolvedAuthorization,
                        resolvedAuthorization.serviceAvailability,
                    );
                }
            } catch {
                // The additive wire field fails closed when the current policy
                // owner cannot resolve all exact Action facts.
            }
        }
        const activationUnavailable = runtimeFactsByQualifiedId?.get(
            buildPluginContributionIntrospectionQualifiedId({
                pluginId: action.pluginId,
                family: 'actions',
                identity: { kind: 'localId', localId: action.definition.id },
            }),
        )?.registration.state === 'unavailable';
        actionsById[qualifiedProjectionKey(action.pluginId, action.definition.id)] = {
            id: action.definition.id,
            pluginId: action.pluginId,
            title: localizedPresentation?.title ?? action.definition.title,
            description: localizedPresentation?.description ?? readOptionalString(action.definition.description),
            ...(action.definition.icon ? { icon: action.definition.icon } : {}),
            scopes: resolveActionScopes(action),
            surfaces: resolveActionSurfaces(action.definition.surfaces),
            execution: execution.data,
            ...(action.definition.operation
                ? { operation: action.definition.operation }
                : {}),
            ...(executionOrigin
                ? {
                    serverIdentityId: executionOrigin.serverIdentityId,
                    materializationRef: Object.freeze({ ...executionOrigin.materializationRef }),
                }
                : {}),
            ...(action.definition.placementBindings
                ? { placementBindings: [...action.definition.placementBindings] }
                : {}),
            ...(action.definition.slash ? { slash: { tokens: [...action.definition.slash.tokens] } } : {}),
            inputSchema: action.definition.inputSchema,
            ...(action.definition.outputSchema ? { outputSchema: action.definition.outputSchema } : {}),
            ...(inputHints ? { inputHints } : {}),
            ...(action.definition.priority === undefined ? {} : { priority: action.definition.priority }),
            dangerLevel: action.definition.dangerLevel,
            ...(action.definition.confirmation
                ? { confirmation: action.definition.confirmation }
                : {}),
            available: !activationUnavailable,
            ...(authorization ? { authorization } : {}),
        };
    }
    return actionsById;
}

function buildToolsById(
    registry: ResolvedContributionRegistry,
): PluginProjectionV2['toolsById'] {
    const toolsById: PluginProjectionV2['toolsById'] = {};
    for (const tool of registry.tools ?? []) {
        if (!tool.pluginId) {
            continue;
        }
        toolsById[qualifiedProjectionKey(tool.pluginId, tool.definition.id)] = {
            id: tool.definition.id,
            pluginId: tool.pluginId,
            title: readLocalizedText(tool.definition.title) ?? tool.definition.id,
            description: readLocalizedText(tool.definition.description),
            exposesToAgent: tool.definition.surfaces.includes('mcp') || tool.definition.surfaces.includes('agent'),
        };
    }
    return toolsById;
}

function buildCommandsById(
    registry: ResolvedContributionRegistry,
): PluginProjectionV2['commandsById'] {
    const commandsById: PluginProjectionV2['commandsById'] = {};
    for (const command of registry.commands ?? []) {
        if (!command.pluginId) {
            continue;
        }
        commandsById[qualifiedProjectionKey(command.pluginId, command.definition.id)] = {
            id: command.definition.id,
            pluginId: command.pluginId,
            title: readLocalizedText(command.definition.title) ?? command.definition.id,
            description: readLocalizedText(command.definition.description),
            surfaces: ['cli'],
            tokens: command.definition.path,
        };
    }
    return commandsById;
}

function buildResourcesById(
    registry: ResolvedContributionRegistry,
): PluginProjectionV2['resourcesById'] {
    const resourcesById: PluginProjectionV2['resourcesById'] = {};
    for (const resource of registry.resources) {
        if (!resource.pluginId) {
            continue;
        }
        // §3.6.1: a dynamic resource has no package path, and
        // `PluginProjectedResourceV2Schema.path` is a required wire field. It is
        // deliberately NOT projected as `path: <id>` — that would disclose a
        // fabricated package path. Projecting the dynamic arm requires adding
        // the `source` discriminant to the projection schema, which is a
        // wire-compatibility decision owned by the EU-4b UI-delivery leg that
        // makes these entries reachable from the app in the first place.
        if (isDynamicPluginResourceContributionV2(
            resource.definition as unknown as Readonly<Record<string, unknown>>,
        )) {
            continue;
        }
        const resourceKind = PluginResourceKindV2Schema.safeParse(resource.definition.type);
        if (!resourceKind.success) {
            throw new Error(
                `Invalid resource kind for '${resource.pluginId}/${resource.definition.id}'`,
            );
        }
        const key = qualifiedProjectionKey(resource.pluginId, resource.definition.id);
        resourcesById[key] = {
            id: resource.definition.id,
            pluginId: resource.pluginId,
            resourceKind: resourceKind.data,
            path: resource.definition.path ?? resource.definition.id,
            digest: readOptionalString(resource.definition.digest),
            contentType: readOptionalString(resource.definition.contentType),
        };
    }
    return resourcesById;
}

function buildSettingsById(
    registry: ResolvedContributionRegistry,
    settingsRollbackDeclarationsByPluginId?: PluginSettingsRollbackDeclarations,
): PluginProjectionV2['settingsById'] {
    const settingsById: PluginProjectionV2['settingsById'] = {};
    let declarations;
    try {
        declarations = resolveLocalSettingsDeclarations({
            settings: [
                ...(registry.settings ?? []),
                ...resolveNotificationChannelSettingsContributions(registry.notificationChannels ?? []),
            ],
        });
    } catch (error) {
        if (!(error instanceof PluginLocalSettingsDeclarationError)) throw error;
        const fieldContext = error.fieldId ? ` field '${error.fieldId}'` : '';
        throw new PluginSettingsProjectionError(
            `Cannot project settings contribution '${error.pluginId}/${error.contributionId}'${fieldContext}: ${error.reason}`,
            error.pluginId,
            error.contributionId,
            error.fieldId ?? null,
        );
    }
    for (const declaration of declarations) {
        const rollback = settingsRollbackDeclarationsByPluginId
            ?.get(declaration.pluginId)
            ?.get(declaration.definition.scope);
        settingsById[qualifiedProjectionKey(declaration.pluginId, declaration.definition.id)] =
            projectPluginSettingsContributionV2({
                pluginId: declaration.pluginId,
                definition: declaration.definition,
                ...(rollback ? { rollback } : {}),
            });
    }
    return settingsById;
}

export function buildPluginProjectionV2(params: Readonly<{
    registry: ResolvedContributionRegistry;
    generation: number;
    installedPackages?: readonly PluginCatalogEntry[];
    pluginDiagnosticsByPluginId?: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
    /** Immutable admitted brand facts from the Resource owner, never paths or bytes. */
    brandAssetsByPluginId?: Readonly<Record<string, PluginProjectionBrandAssetV2>>;
    pluginUiHostRuntime?: PluginUiProjectionHostRuntimeContext;
    /** Exact machine materialization facts for the same registry lease. */
    pluginExecutionOriginsByPluginId?: Readonly<Record<string, PluginMachineExecutionOriginV1>>;
    /**
     * The one supported rollback Settings declaration per (pluginId, scope)
     * from the same registry lease; it projects onto each Settings entry so
     * every consumer sees identical retention facts for bundled and external
     * plugins alike.
     */
    settingsRollbackDeclarationsByPluginId?: PluginSettingsRollbackDeclarations;
    /** Read-only current manifest Action policy owner for the same runtime lease. */
    resolveActionPresentUserGatePolicy?: (
        pluginId: string,
        localId: string,
    ) => PluginActionPresentUserGatePolicy | null;
    /** Current applied-policy facts; absent partial fixtures fail projection closed. */
    pluginFinalPolicyCurrentGenerationsById?: ReadonlyMap<string, PluginFinalPolicyCurrentGeneration>;
    introspectionRuntimeSnapshot?: PluginTargetActivationIntrospectionSnapshot;
    /** The requesting client's display locale, when it named one. */
    requestedLocale?: string;
    scmRuntimeAvailability?: Readonly<{
        backendIds: ReadonlySet<string>;
        hostingProviderIds: ReadonlySet<string>;
    }>;
}>): PluginProjectionV2 {
    const installedPackages = params.installedPackages ?? [];
    const pluginDiagnosticsByPluginId = params.pluginDiagnosticsByPluginId ?? params.registry.pluginDiagnosticsByPluginId;
    if (params.introspectionRuntimeSnapshot && params.introspectionRuntimeSnapshot.generation !== params.generation) {
        throw new Error(
            `Introspection runtime generation '${params.introspectionRuntimeSnapshot.generation}' does not match projection generation '${params.generation}'`,
        );
    }
    const runtimeDiagnosticRecords = params.introspectionRuntimeSnapshot?.diagnosticRecords ?? [];
    const attributedDiagnosticRecords = projectAttributedPluginDiagnostics({
        registry: params.registry,
        installedPackages,
        diagnosticsByPluginId: pluginDiagnosticsByPluginId,
        occurredAtMs: Date.now(),
    });
    const diagnostics = buildDiagnostics({
        installedPackages,
        diagnosticRecords: [
            ...attributedDiagnosticRecords,
            ...runtimeDiagnosticRecords,
        ],
    });
    const familyDescriptors = [
        providerProjectionFamily,
        connectedAccountProjectionFamily,
        scmHostingProviderProjectionFamily,
        scmBackendProjectionFamily,
        managedDependenciesProjectionFamily,
        mcpProjectionFamily,
        pluginUiProjectionFamily,
        pluginBrowserProjectionFamily,
        voiceModelPackProjectionFamily,
        voiceProviderProjectionFamily,
        accountCollectionsProjectionFamily,
        composerAttachmentsProjectionFamily,
        composerControlsProjectionFamily,
        composerRegionsProjectionFamily,
    ];

    return {
        v: 2,
        generation: params.generation,
        installedPackagesById: buildInstalledPackagesById({
            registry: params.registry,
            installedPackages,
            pluginDiagnosticsByPluginId,
            ...(params.brandAssetsByPluginId
                ? { brandAssetsByPluginId: params.brandAssetsByPluginId }
                : {}),
        }),
        agentsById: buildAgentsById(params.registry, params.generation),
        // The V2 wire field remains for mixed-version readers, but the host no
        // longer projects a parallel backend/runtime registry.
        backendsById: {},
        actionsById: buildActionsById(
            params.registry,
            params.pluginExecutionOriginsByPluginId,
            params.resolveActionPresentUserGatePolicy,
            params.pluginFinalPolicyCurrentGenerationsById,
            params.introspectionRuntimeSnapshot?.runtimeFactsByQualifiedId,
        ),
        toolsById: buildToolsById(params.registry),
        commandsById: buildCommandsById(params.registry),
        resourcesById: buildResourcesById(params.registry),
        settingsById: buildSettingsById(params.registry, params.settingsRollbackDeclarationsByPluginId),
        familiesById: buildPluginProjectionFamiliesByIdV2({
            registry: params.registry,
            generation: params.generation,
            pluginDiagnosticsByPluginId,
            ...(params.pluginExecutionOriginsByPluginId
                ? { pluginExecutionOriginsByPluginId: params.pluginExecutionOriginsByPluginId }
                : {}),
            pluginUiHostRuntime: params.pluginUiHostRuntime,
            ...(params.requestedLocale === undefined
                ? {}
                : { requestedLocale: params.requestedLocale }),
            scmRuntimeAvailability: params.scmRuntimeAvailability,
        }, familyDescriptors),
        contributionIntrospection: projectPluginContributionIntrospection({
            generation: params.generation,
            candidates: params.registry.introspectionContributions ?? [],
            diagnostics,
            runtimeFactsByQualifiedId: params.introspectionRuntimeSnapshot?.runtimeFactsByQualifiedId,
        }),
        diagnostics,
    };
}
