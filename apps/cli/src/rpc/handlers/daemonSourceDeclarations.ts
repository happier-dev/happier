import type { DaemonPluginUiTargetedContributionsReadRequest, DaemonPluginTargetedSourceDeclarationV1, DaemonPluginUiTargetedContributionsReadResponse } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginActionContributionV2Schema, type PluginActionContributionV2 } from '@happier-dev/protocol/plugins/actions/v2';
import { isDeclarationFieldJsonObject } from '@happier-dev/protocol/plugins/contributions/deferredDeclarationFields';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

function projectSourceAction(action: PluginActionContributionV2, fields: readonly string[]): Omit<PluginActionContributionV2, 'resultSchema'> {
    const projected = {} as Omit<PluginActionContributionV2, 'resultSchema'>;
    for (const field of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(action, field);
        if (descriptor) Object.defineProperty(projected, field, descriptor);
    }
    return projected;
}

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
    const unavailablePlugins = (runtimeRegistry.contributes.unavailablePlugins ?? [])
        .filter(source => request.sourcePluginId === undefined || source.pluginId === request.sourcePluginId);
    // Exclusions can change while the selected declaration list remains empty.
    // Keep conditional reuse tied to the complete admission snapshot.
    const sourceRevision = JSON.stringify([
        selected.map(row => [row.declaration.pluginId, row.occurrenceId, row.sourceCustody]), unavailablePlugins,
    ]);
    if (request.knownSourceRevision === sourceRevision) return {
        status: 'sourceDeclarationsUnchanged', pluginId: request.pluginId, sourceRevision,
    };
    const { resultSchema: _resultSchema, ...inputDeclarationShape } = PluginActionContributionV2Schema.shape;
    const actionFields = Object.keys(inputDeclarationShape);
    for (const { declaration, occurrenceId, sourceCustody } of selected) {
        const contributions = declaration.manifest.contributes.targetedPluginContributions
            .filter((entry) => entry.target.pluginId === request.pluginId);
        const actionIds = new Set(contributions.flatMap((entry) => Object.values(entry.operations)));
        const rendererIds = new Set(contributions.flatMap((entry) => Object.values(entry.surfaces ?? {})
            .flatMap((surface) => [surface.renderer, ...(surface.fallbackRenderers ?? [])])));
        // An Account Action can delegate to its own native helper without a targeted operation.
        const actions = declaration.manifest.contributes.actions.filter(entry => actionIds.has(entry.id)
            || (declaration.pluginId === request.pluginId && entry.execution.target === 'daemon'));
        const actionResultContractIds = actions.filter(action => isDeclarationFieldJsonObject(action, 'resultSchema'))
            .map(action => action.id);
        sourceDeclarations.push({
            manifest: { id: declaration.pluginId, contributes: {
                actions: actions.map(action => projectSourceAction(action, actionFields)),
                pluginContributionPoints: [],
                targetedPluginContributions: contributions,
                ui: { renderers: declaration.manifest.contributes.ui.renderers.filter((entry) => rendererIds.has(entry.id)) },
            } },
            occurrenceId,
            sourceCustody,
            ...(actionResultContractIds.length ? { actionResultContractIds } : {}),
        });
    }
    return { status: 'sourceDeclarations', pluginId: request.pluginId, sourceRevision, sourceDeclarations,
        ...(unavailablePlugins.length ? { unavailablePlugins } : {}) };
}
