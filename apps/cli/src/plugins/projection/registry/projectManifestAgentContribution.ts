import type {
    PluginAgentContributionV2,
    PluginSourceSpecV1,
} from '@happier-dev/protocol';

import {
    createManifestAgentCatalogEntry,
    projectNativeAgentCliRuntimeDescriptor,
} from './agentCliMetadata';
import { createAgentRuntimeCatalogEntryHooks } from './agentCatalogEntryHooks';
import type { AgentRuntimeContribution } from './agentRuntimeContribution';
import type {
    ResolvedAgentContribution,
    ResolvedCatalogEntry,
    ResolvedContributionProvenance,
    ResolvedContributionSource,
} from './types';

/**
 * Adapts the Agent's declared catalog facts to the one host Agent runtime
 * contribution shape. A bundled Agent supplies that contribution as a first-party
 * module; a contributed Agent declares its facts in the manifest, and both reach
 * the catalog through `createAgentRuntimeCatalogEntryHooks`.
 *
 * `cliSessionCommand` is always present so the Agent's `happy <agent>` session
 * subcommand has exactly one builder. The declared block stays optional, so an
 * Agent that declares nothing keeps the plain session-command behavior.
 */
function readManifestAgentRuntimeContribution(
    definition: PluginAgentContributionV2,
): AgentRuntimeContribution {
    const catalog = definition.catalog;
    return Object.freeze({
        cliSessionCommand: Object.freeze({}),
        ...(catalog?.vendorResume
            ? { vendorResumeSupport: Object.freeze({ support: catalog.vendorResume.support }) }
            : {}),
    });
}

function projectManifestAgentCatalogEntry(params: Readonly<{
    agentId: string;
    pluginId: string;
    definition: PluginAgentContributionV2;
    cli: PluginAgentContributionV2['cli'] | null;
}>): ResolvedCatalogEntry | null {
    const base = createManifestAgentCatalogEntry({
        agentId: params.agentId,
        pluginId: params.pluginId,
        definition: params.definition,
        cli: params.cli ?? null,
    });
    if (!base) return null;
    const createHooks = createAgentRuntimeCatalogEntryHooks({
        agentId: params.agentId,
        packageName: params.pluginId,
        contribution: readManifestAgentRuntimeContribution(params.definition),
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
    sourceSpec?: PluginSourceSpecV1;
    hostAccess?: ResolvedAgentContribution['hostAccess'];
    manifestPath?: string;
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
}>): ResolvedAgentContribution {
    const agentId = params.definition.id;
    const cliMetadata = params.definition.cli ?? null;
    return Object.freeze({
        id: agentId,
        identity: Object.freeze({
            pluginId: params.pluginId,
            localId: agentId,
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
