import * as React from 'react';


import type { AgentId } from '@/agents/catalog/catalog';
import { getAgentCore } from '@/agents/catalog/catalog';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import { renderDropdownItemIcon } from '@/components/settings/pickers/renderDropdownItemIcon';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';

export function getAgentDropdownMenuItems(params: {
    agentIds: readonly AgentId[];
    iconColor: string;
    iconSize?: number;
}): readonly DropdownMenuItem[] {
    const iconSize = params.iconSize ?? 22;
    return params.agentIds.map((id) => {
        // An externally installed Agent contributes no bundled display name; the
        // formatted id keeps it selectable instead of dropping it from the menu.
        const core = getAgentCore(id);
        const iconName =
            typeof core?.ui?.agentPickerIconName === 'string' && core.ui.agentPickerIconName.trim()
                ? core.ui.agentPickerIconName.trim()
                : 'sparkles-outline';
        return {
            id: String(id),
            title: core ? t(core.displayNameKey) : formatAgentLikeIdForDisplay(id),
            subtitle: String(id),
            icon: renderDropdownItemIcon({
                name: iconName as any,
                color: params.iconColor,
                size: iconSize,
            }),
        };
    });
}
