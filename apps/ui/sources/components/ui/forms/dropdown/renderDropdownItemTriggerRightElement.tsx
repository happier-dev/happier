import * as React from 'react';
import { View } from 'react-native';


import {
    ITEM_CHEVRON_SIZE,
    ITEM_TITLE_TEXT_METRICS,
} from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';


export function renderDropdownItemTriggerRightElement(params: Readonly<{
    detail: string | null;
    open: boolean;
    detailColor: string;
    chevronColor: string;
    detailDensity?: 'comfortable' | 'cozy' | 'compact' | 'tight';
}>) {
    const resolvedDensity = params.detailDensity ?? 'comfortable';
    const chevron = (
        <Icon
            name={params.open ? 'caret-up' : 'caret-down'}
            size={ITEM_CHEVRON_SIZE[resolvedDensity]}
            color={params.chevronColor}
        />
    );
    const detailTextStyle = ITEM_TITLE_TEXT_METRICS[resolvedDensity];

    if (!params.detail) return chevron;

    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', minWidth: 0 }}>
            <Text
                style={{
                    color: params.detailColor,
                    marginRight: 8,
                    flexShrink: 1,
                    ...(detailTextStyle ?? {}),
                }}
                numberOfLines={1}
            >
                {params.detail}
            </Text>
            {chevron}
        </View>
    );
}
