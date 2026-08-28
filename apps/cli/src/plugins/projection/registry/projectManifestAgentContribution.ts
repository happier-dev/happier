import type {
    PluginAgentContributionV2,
    PluginSourceSpecV1,
    PluginSystemToolContributionV1,
} from '@happier-dev/protocol';

import {
    createManifestAgentCatalogEntry,
    projectNativeAgentCliRuntimeDescriptor,
} from './agentCliMetadata';
import { projectAgentCliSessionCommandCatalogEntry } from './agentCatalogEntryHooks';
import { resolveContributedAgentRoutingId } from './agentRoutingIdentity';
import type {
    ResolvedAgentContribution,
    ResolvedCatalogEntry,
    ResolvedContributionProvenance,
    ResolvedContributionSource,
} from './types';

const EMPTY_SYSTEM_TOOLS: readonly PluginSystemToolContributionV1[] = Object.freeze([]);

/**
 * Adapts the Agent's declared catalog facts to the host catalog. Bundled and
 * installed Agents declare the same public manifest facts and both reach the
 * catalog through these canonical projection owners.
 *
 * `cliSessionCommand` is always present so the Agent's `happy <agent>` session
 * subcommand has exactly one builder. The declared block stays optional, so an
 * Agent that declares nothing keeps the plain session-command behavior.
 *
 * The Agent CLI system-tool binding is projected only when the caller supplied
 * the plugin's own system-tool declarations, because the binding is meaningless
 * without them. A manifest that names an undeclared tool never reaches here:
 * `validatePluginManifest` rejects the plugin at load, where the diagnostic can
 * be attributed to it. Projections built without system-tool context — the
 * runner's non-authoritative bootstrap view and the retained external-session
 * view — carry no binding and build no exec service from one.
 *
 * Static catalog facts are projected directly from the Agent's declared
 * `catalog` block. They do not pass through a bundled runtime aggregate.
 *
 * Runtime Activity is projected directly from the Agent's declared Session
 * capability. The host binds a Session's agent-runtime Activity slot only when
 * the catalog entry says `supported`, so without this the public
 * `capabilities.sessions.runtimeActivitySnapshots` declaration would have no
 * reader and an Agent emitting `runtime-activity-snapshot` runtime events would
 * never be subscribed to. An Agent that declares nothing keeps the key absent,
 * which the catalog-entry hook owner reads as `not_applicable`.
 */
function projectManifestAgentStaticCatalogEntry(params: Readonly<{
    definition: PluginAgentContributionV2;
    systemTools: readonly PluginSystemToolContributionV1[];
}>): Partial<Pick<ResolvedCatalogEntry, 'agentCliSystemTool' | 'vendorResumeSupport'>> {
    const catalog = params.definition.catalog;
    const declaredCliSystemToolId = catalog?.agentCliSystemTool?.toolId;
    const boundCliSystemToolId = declaredCliSystemToolId
        && params.systemTools.some((tool) => tool.id === declaredCliSystemToolId)
        ? declaredCliSystemToolId
        : null;
    return Object.freeze({
        ...(catalog?.vendorResume
            ? { vendorResumeSupport: catalog.vendorResume.support }
            : {}),
        ...(boundCliSystemToolId
            ? { agentCliSystemTool: Object.freeze({ toolId: boundCliSystemToolId }) }
            : {}),
    });
}

function projectManifestAgentCatalogEntry(params: Readonly<{
    agentId: string;
    pluginId: string;
    definition: PluginAgentContributionV2;
    cli: PluginAgentContributionV2['cli'] | null;
    systemTools: readonly PluginSystemToolContributionV1[];
    provenance: ResolvedContributionProvenance;
}>): ResolvedCatalogEntry | null {
    const base = createManifestAgentCatalogEntry({
        agentId: params.agentId,
        pluginId: params.pluginId,
        definition: params.definition,
        cli: params.cli ?? null,
        provenance: params.provenance,
    });
    if (!base) return null;
    const cliSessionCommand = projectAgentCliSessionCommandCatalogEntry({
        agentId: params.agentId,
    });
    const staticCatalog = projectManifestAgentStaticCatalogEntry({
        definition: params.definition,
        systemTools: params.systemTools,
    });
    const runtimeActivity = ('sessions' in params.definition.capabilities
        && params.definition.capabilities.sessions?.runtimeActivitySnapshots)
        ? { runtimeActivityApplicability: 'supported' as const }
        : {};
    return Object.freeze({ ...base, ...cliSessionCommand, ...staticCatalog, ...runtimeActivity });
}

/**
 * Projects one manifest Agent declaration into the canonical CLI Agent view.
 * Callers retain ownership of where the declaration came from; this function
 * only performs the shared declaration-to-host shape adaptation.
 */
export function projectManifestAgentContribution(params: Readonly<{
    definition: PluginAgentContributionV2;
    provenance: ResolvedContributionProvenance;
    source: ResolvedContributionSource;
    pluginId: string;
    /**
     * System tools the same plugin declares. The Agent's declared
     * `catalog.agentCliSystemTool` binding is validated against this list by
     * the canonical manifest projection.
     */
    systemTools?: readonly PluginSystemToolContributionV1[];
    sourceSpec?: PluginSourceSpecV1;
    hostAccess?: ResolvedAgentContribution['hostAccess'];
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
}>): ResolvedAgentContribution {
    const localId = params.definition.id;
    const agentId = resolveContributedAgentRoutingId({
        pluginId: params.pluginId,
        localId,
        provenance: params.provenance,
    });
    const cliMetadata = params.definition.cli ?? null;
    return Object.freeze({
        id: agentId,
        identity: Object.freeze({
            pluginId: params.pluginId,
            localId,
        }),
        provenance: params.provenance,
        source: params.source,
        definition: Object.freeze({
            kindVersion: 1,
            id: agentId,
            ownedBackendIds: Object.freeze([]),
            ...(params.definition.providerRequirements
                ? {
                    providerRequirements:
                        params.definition.providerRequirements,
                }
                : {}),
        }),
        richDefinition: Object.freeze({
            provenance: params.provenance,
            definition: params.definition,
        }),
        runtimeSpec: cliMetadata
            ? projectNativeAgentCliRuntimeDescriptor({
                agentId,
                title: params.definition.title,
                cli: cliMetadata,
            })
            : null,
        cliMetadata,
        catalogEntry: projectManifestAgentCatalogEntry({
            agentId,
            pluginId: params.pluginId,
            definition: params.definition,
            cli: cliMetadata,
            systemTools: params.systemTools ?? EMPTY_SYSTEM_TOOLS,
            provenance: params.provenance,
        }),
        ...(params.sourceSpec ? { sourceSpec: params.sourceSpec } : {}),
        pluginId: params.pluginId,
        ...(params.hostAccess ? { hostAccess: params.hostAccess } : {}),
        ...(params.manifestPath
            ? { manifestPath: params.manifestPath }
            : {}),
        ...(params.daemonEntryPath !== undefined
            ? { daemonEntryPath: params.daemonEntryPath }
            : {}),
        ...(params.devDaemonEntryPath !== undefined
            ? { devDaemonEntryPath: params.devDaemonEntryPath }
            : {}),
    });
}
