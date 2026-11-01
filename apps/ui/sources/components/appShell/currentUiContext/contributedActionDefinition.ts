import type { ActionDefinitionSummaryV1 } from '@happier-dev/protocol/actions/actionDefinitionV1';
import type { PluginProjectedActionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { resolvePluginProjectedActionPresentation } from '@/sync/domains/plugins/ui/actionPresentation';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { getPreferredLanguage } from '@/text';

function actionSideEffectClass(
    dangerLevel: PluginProjectedActionV2['dangerLevel'],
): ActionDefinitionSummaryV1['sideEffectClass'] {
    switch (dangerLevel) {
        case 'safe':
            return undefined;
        case 'writesLocal':
        case 'writesRemote':
            return 'write';
        case 'externalSideEffect':
            return 'external';
        case 'destructive':
            return 'danger';
    }
}

export function projectedActionToDefinition(
    action: PluginProjectedActionV2,
    projection: PluginUiProjectionModel | null,
): ActionDefinitionSummaryV1 {
    const presentation = resolvePluginProjectedActionPresentation({
        pluginId: action.pluginId,
        presentation: action,
        projection,
        locale: getPreferredLanguage(),
    });
    const sideEffectClass = actionSideEffectClass(action.dangerLevel);
    const approval: NonNullable<ActionDefinitionSummaryV1['approval']> = action.dangerLevel === 'safe'
        ? { result: 'none' }
        : { result: 'required', flow: 'blocking' };
    return Object.freeze({
        id: formatQualifiedPluginActionId({ pluginId: action.pluginId, localId: action.id }),
        title: presentation.title,
        description: presentation.description,
        safety: action.dangerLevel === 'safe' ? 'safe' : 'danger',
        approval,
        placements: [],
        slash: action.slash ?? null,
        bindings: null,
        examples: null,
        surfaces: {
            ui: action.surfaces.includes('ui'),
            voice: action.surfaces.includes('voice'),
            agent: action.surfaces.includes('agent'),
            mcp: action.surfaces.includes('mcp'),
            cli: action.surfaces.includes('cli'),
            rpc: false,
            api: false,
            plugin: action.surfaces.includes('plugin'),
        },
        inputHints: presentation.inputHints,
        ...(action.sessionTarget === undefined ? {} : { sessionTarget: action.sessionTarget }),
        ...(sideEffectClass ? { sideEffectClass } : {}),
    });
}
