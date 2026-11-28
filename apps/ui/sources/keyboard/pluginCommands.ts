import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { resolvePluginProjectedActionPresentation } from '@/sync/domains/plugins/ui/actionPresentation';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { getKeyboardCommand } from './commands';
import type { KeyboardCommand } from './types';

/** Descriptive rows from the admitted catalog; invocation remains with its Action controller. */
export function buildPluginKeyboardCommands(projection: PluginUiProjectionModel | null, localize?: PluginLocalizedTextResolver): readonly KeyboardCommand[] {
    return Object.values(projection?.actionsById ?? {}).flatMap(action => {
        if (!action.surfaces.includes('ui') || !action.placementBindings?.includes('commandPalette')) return [];
        const command = getKeyboardCommand(`action:${formatQualifiedPluginActionId({ pluginId: action.pluginId, localId: action.id })}`);
        if (!command) return [];
        const { title } = resolvePluginProjectedActionPresentation({ pluginId: action.pluginId, presentation: action, projection, localize });
        return [{ ...command, settingsTitle: title }];
    });
}

export function readPluginKeyboardCommands(localize?: PluginLocalizedTextResolver): readonly KeyboardCommand[] {
    return buildPluginKeyboardCommands(readCurrentAppShellPluginUiProjection(), localize);
}
