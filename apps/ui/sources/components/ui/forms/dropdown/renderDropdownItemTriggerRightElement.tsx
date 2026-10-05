import { HappierFieldBoxTrigger, resolveHappierFieldBoxLabel } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';


import {
    ITEM_CHEVRON_SIZE,
    ITEM_TITLE_TEXT_METRICS,
} from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';


export function renderDropdownItemTriggerRightElement(params: Readonly<{
    detail: string | null;
    open: boolean;
    detailColor: string;
    chevronColor: string;
    detailDensity?: 'comfortable' | 'cozy' | 'compact' | 'tight';
    /**
     * Render the current value as a bordered field (configuration pages) instead of bare value text.
     * Colours come from the caller, which reads the theme.
     */
    field?: Readonly<{ borderColor: string; backgroundColor: string; valueColor: string; placeholderColor: string }>;
    /**
     * Configuration pages only: what an empty selection says ("Choose…") instead of a blank field or a
     * bare chevron. Grouped triggers leave it out and show only the chevron.
     */
    placeholder?: string;
    /** Colour of the placeholder beside a bare chevron (the field supplies its own). */
    placeholderColor?: string;
    /** Field only: a mark before the value (the selected agent's brand mark in a toolbar select). */
    leading?: React.ReactNode;
    /** Field only: a quieter second half after the value ("This session · happier"). */
    secondary?: string | null;
    /** Field only: the value reads quieter (a value the surface fills on its own). */
    quietValue?: boolean;
    /** Field only: colour of the quieter second half. */
    secondaryColor?: string;
    /** Field only: colour of a quiet value. */
    quietValueColor?: string;
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

    if (params.field) {
        // The field box is shared presentation (a plugin page-row select draws the same one); the
        // value text stays on core's Text adapter so the UI font-scale setting applies to it.
        const label = resolveHappierFieldBoxLabel({
            value: params.detail,
            placeholder: params.placeholder || t('common.choose'),
            colors: params.field,
        });
        return (
            <HappierFieldBoxTrigger colors={params.field} leading={params.leading} trailing={chevron}>
                <Text
                    style={[label.style, params.secondary ? { flexGrow: 0, flexShrink: 1, flexBasis: 'auto' } : null, params.quietValue && !label.placeholder && params.quietValueColor ? { color: params.quietValueColor } : null]}
                    numberOfLines={1}
                >
                    {label.text}
                </Text>
                {params.secondary && !label.placeholder ? (
                    <Text style={[label.style, { flexGrow: 1, flexShrink: 1000, flexBasis: 'auto', marginLeft: 6, color: params.secondaryColor ?? label.style.color }]} numberOfLines={1}>
                        {params.secondary}
                    </Text>
                ) : null}
            </HappierFieldBoxTrigger>
        );
    }

    const value = params.detail || params.placeholder || null;
    if (!value) return chevron;

    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', minWidth: 0 }}>
            <Text
                style={{
                    color: params.detail ? params.detailColor : (params.placeholderColor ?? params.detailColor),
                    marginRight: 8,
                    flexShrink: 1,
                    ...(detailTextStyle ?? {}),
                }}
                numberOfLines={1}
            >
                {value}
            </Text>
            {chevron}
        </View>
    );
}
