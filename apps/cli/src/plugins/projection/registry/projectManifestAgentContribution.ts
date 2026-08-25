import type {
    PluginAgentContributionV2,
    PluginSourceSpecV1,
    PluginSystemToolContributionV1,
} from '@happier-dev/protocol';

import {
    createManifestAgentCatalogEntry,
    projectNativeAgentCliRuntimeDescriptor,
} from './agentCliMetadata';
import { createAgentRuntimeCatalogEntryHooks } from './agentCatalogEntryHooks';
import { resolveContributedAgentRoutingId } from './agentRoutingIdentity';
import type { AgentRuntimeContribution } from './agentRuntimeContribution';
import type {
    ResolvedAgentContribution,
    ResolvedCatalogEntry,
    ResolvedContributionProvenance,
    ResolvedContributionSource,
} from './types';

const EMPTY_SYSTEM_TOOLS: readonly PluginSystemToolContributionV1[] = Object.freeze([]);

/**
 * Adapts the Agent's declared catalog facts to the one host Agent runtime
 * contribution shape. A bundled Agent supplies that contribution as a first-party
 * module; a contributed Agent declares its facts in the manifest, and both reach
 * the catalog through `createAgentRuntimeCatalogEntryHooks`.
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
 * Runtime Activity is projected from the Agent's declared Session capability.
 * The host binds a Session's agent-runtime Activity slot only when the catalog
 * entry says `supported`, so without this the public
 * `capabilities.sessions.runtimeActivitySnapshots` declaration would have no
 * reader and an Agent emitting `runtime-activity-snapshot` runtime events would
 * never be subscribed to. An Agent that declares nothing keeps the key absent,
 * which the catalog-entry hook owner reads as `not_applicable`.
 */
function readManifestAgentRuntimeContribution(
    definition: PluginAgentContributionV2,
    systemTools: readonly PluginSystemToolContributionV1[],
): AgentRuntimeContribution {
    const catalog = definition.catalog;
    const declaredCliSystemToolId = catalog?.agentCliSystemTool?.toolId;
    const boundCliSystemToolId = declaredCliSystemToolId
        && systemTools.some((tool) => tool.id === declaredCliSystemToolId)
        ? declaredCliSystemToolId
        : null;
    return Object.freeze({
        cliSessionCommand: Object.freeze({}),
        ...(catalog?.vendorResume
            ? { vendorResumeSupport: Object.freeze({ support: catalog.vendorResume.support }) }
            : {}),
        ...(boundCliSystemToolId
            ? { agentCliSystemTool: Object.freeze({ toolId: boundCliSystemToolId }) }
            : {}),
        ...(('sessions' in definition.capabilities
            && definition.capabilities.sessions?.runtimeActivitySnapshots)
            ? { runtimeActivityApplicability: 'supported' as const }
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
    const createHooks = createAgentRuntimeCatalogEntryHooks({
        agentId: params.agentId,
        packageName: params.pluginId,
        contribution: readManifestAgentRuntimeContribution(
            params.definition,
            params.systemTools,
        ),
        systemTools: params.systemTools,
    });
    return Object.freeze({ ...base, ...createHooks() });
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
     * the one catalog-entry hook owner.
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
