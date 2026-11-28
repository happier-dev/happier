import * as React from 'react';
import { useAppShellPluginUiDeclarationProjection, useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { buildPluginKeyboardCommands } from './pluginCommands';

export function usePluginKeyboardCommands() {
    const projection = useAppShellPluginUiDeclarationProjection();
    const localize = useProjectedPluginLocalizedTextResolver();
    return React.useMemo(() => buildPluginKeyboardCommands(projection, localize), [projection, localize]);
}
