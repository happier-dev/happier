import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';

import type { AgentId } from '@/agents/catalog/catalog';
import { getAgentCore } from '@/agents/catalog/catalog';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';

export function getAgentDropdownMenuItems(params: {
    agentIds: readonly AgentId[];
    iconColor: string;
    iconSize?: number;
}): readonly DropdownMenuItem[] {
    const iconSize = params.iconSize ?? 22;
    return params.agentIds.map((id) => {
        const core = getAgentCore(id);
        const iconName =
            typeof (core as any)?.ui?.agentPickerIconName === 'string' && String((core as any).ui.agentPickerIconName).trim()
                ? String((core as any).ui.agentPickerIconName).trim()
                : 'sparkles-outline';
        return {
            id: String(id),
            title: t(core.displayNameKey),
            subtitle: String(id),
            icon: <Ionicons name={iconName as any} size={iconSize} color={params.iconColor} />,
        };
    });
}
