import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Ionicons } from '@expo/vector-icons';

import type { AgentId } from '@/agents/catalog/catalog';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { getModelOptionsForAgentType, type ModelOption } from '@/sync/domains/models/modelOptions';

export const REFRESH_MODELS_DROPDOWN_ITEM_ID = '__refresh_models__';

export function getModelDropdownMenuItems(params: {
    modelOptions: readonly ModelOption[];
    iconColor: string;
    iconSize?: number;
    probe?: Readonly<{ phase: 'idle' | 'loading' | 'refreshing'; onRefresh?: () => void }>;
}): readonly DropdownMenuItem[] {
    const iconSize = params.iconSize ?? 22;
    const base = params.modelOptions.map((opt) => ({
        id: opt.value,
        title: opt.label,
        subtitle: opt.description,
        icon: <Ionicons name="layers-outline" size={iconSize} color={params.iconColor} />,
    }));

    if (!params.probe || typeof params.probe.onRefresh !== 'function') return base;

    const phase = params.probe.phase;
    const subtitle =
        phase === 'loading'
            ? 'Loading models…'
            : phase === 'refreshing'
                ? 'Refreshing models…'
                : 'Fetch the latest model list.';

    const icon = phase === 'idle'
        ? <Ionicons name="refresh-outline" size={iconSize} color={params.iconColor} />
        : (
            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator />
            </View>
        );

    return [
        {
            id: REFRESH_MODELS_DROPDOWN_ITEM_ID,
            title: 'Refresh models',
            subtitle,
            icon,
            disabled: phase !== 'idle',
        },
        ...base,
    ];
}

export function getModelDropdownMenuItemsForAgentType(params: {
    agentType: AgentId;
    iconColor: string;
    iconSize?: number;
}): readonly DropdownMenuItem[] {
    return getModelDropdownMenuItems({
        modelOptions: getModelOptionsForAgentType(params.agentType),
        iconColor: params.iconColor,
        iconSize: params.iconSize,
    });
}
