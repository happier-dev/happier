import * as React from 'react';
import { View } from 'react-native';

import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';

import {
    ITEM_CHEVRON_SIZE,
    ITEM_TITLE_TEXT_METRICS,
} from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';

const Ionicons = SafeIonicons;

export function renderDropdownItemTriggerRightElement(params: Readonly<{
    detail: string | null;
    open: boolean;
    detailColor: string;
    chevronColor: string;
    detailDensity?: 'comfortable' | 'cozy' | 'compact' | 'tight';
}>) {
    const resolvedDensity = params.detailDensity ?? 'comfortable';
    const chevron = (
        <Ionicons
            name={params.open ? 'chevron-up' : 'chevron-down'}
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
