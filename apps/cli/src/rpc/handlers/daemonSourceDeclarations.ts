import type { DaemonPluginUiTargetedContributionsReadRequest, DaemonPluginTargetedSourceDeclarationV1, DaemonPluginUiTargetedContributionsReadResponse } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

/** Select current source identities before projecting schema bodies. */
export function readDaemonSourceDeclarations(runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry,
    request: DaemonPluginUiTargetedContributionsReadRequest,
): Exclude<DaemonPluginUiTargetedContributionsReadResponse, { status: 'current' }> {
    const declarations = runtimeRegistry.contributes.pluginDeclarations;
    if (!declarations || !runtimeRegistry.readPluginOccurrenceId || !runtimeRegistry.readPluginSourceCustody) {
        return { status: 'unavailable', code: 'plugin_targeted_contributions_unavailable' };
    }
    const sourceDeclarations: DaemonPluginTargetedSourceDeclarationV1[] = [];
    const selected: { declaration: (typeof declarations)[number]; occurrenceId: string;
        sourceCustody: DaemonPluginTargetedSourceDeclarationV1['sourceCustody'] }[] = [];
    const readOccurrence = runtimeRegistry.readPluginOccurrenceId;
    const readCustody = runtimeRegistry.readPluginSourceCustody;
    for (const declaration of declarations) {
        if (request.sourcePluginId !== undefined && declaration.pluginId !== request.sourcePluginId) continue;
        const occurrenceId = readOccurrence(declaration.pluginId);
        if (!occurrenceId) continue;
        const contributes = declaration.manifest.contributes.targetedPluginContributions
            .some(entry => entry.target.pluginId === request.pluginId);
        if (!contributes && declaration.pluginId !== request.pluginId) continue;
        const sourceCustody = readCustody(declaration.pluginId);
        if (!sourceCustody) return { status: 'unavailable', code: 'plugin_targeted_contributions_unavailable' };
        selected.push({ declaration, occurrenceId, sourceCustody });
    }
    // Occurrences version admitted immutable manifests; custody and membership
    // also change this token on retirement, replacement and daemon restart.
    const sourceRevision = JSON.stringify(selected.map(row => [row.declaration.pluginId, row.occurrenceId, row.sourceCustody]));
    if (request.knownSourceRevision === sourceRevision) return {
        status: 'sourceDeclarationsUnchanged', pluginId: request.pluginId, sourceRevision,
    };
    for (const { declaration, occurrenceId, sourceCustody } of selected) {
        const contributions = declaration.manifest.contributes.targetedPluginContributions
            .filter((entry) => entry.target.pluginId === request.pluginId);
        const actionIds = new Set(contributions.flatMap((entry) => Object.values(entry.operations)));
        const rendererIds = new Set(contributions.flatMap((entry) => Object.values(entry.surfaces ?? {})
            .flatMap((surface) => [surface.renderer, ...(surface.fallbackRenderers ?? [])])));
        // Manifest ingestion already admitted these typed declarations.
        // Select their references here; the receiver validates the wire.
        sourceDeclarations.push({
            manifest: { id: declaration.pluginId, contributes: {
                // An Account Action can delegate to its own native
                // helper without that helper being a targeted operation.
                // This is declaration projection; the Machine receiver
                // still owns executable admission and handler lookup.
                actions: declaration.manifest.contributes.actions.filter((entry) => actionIds.has(entry.id)
                    || (declaration.pluginId === request.pluginId && entry.execution.target === 'daemon')),
                pluginContributionPoints: [],
                targetedPluginContributions: contributions,
                ui: { renderers: declaration.manifest.contributes.ui.renderers.filter((entry) => rendererIds.has(entry.id)) },
            } },
            occurrenceId,
            sourceCustody,
        });
    }
    return { status: 'sourceDeclarations', pluginId: request.pluginId, sourceRevision, sourceDeclarations };
}
