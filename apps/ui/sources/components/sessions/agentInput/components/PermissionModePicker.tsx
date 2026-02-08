import * as React from 'react';
import { Pressable, Text, View } from 'react-native';

import type { PermissionMode } from '@/sync/permissionTypes';

export type PermissionModePickerOption = Readonly<{
    value: PermissionMode;
    label: string;
    description: string;
}>;

export function PermissionModePicker(props: {
    title: string;
    options: readonly PermissionModePickerOption[];
    selected: PermissionMode;
    onSelect: (mode: PermissionMode) => void;
    styles: Readonly<{
        overlaySection: any;
        overlaySectionTitle: any;
        overlayOptionRow: any;
        overlayOptionRowPressed: any;
        overlayRadioOuter: any;
        overlayRadioOuterSelected: any;
        overlayRadioOuterUnselected: any;
        overlayRadioInner: any;
        overlayOptionLabel: any;
        overlayOptionLabelSelected: any;
        overlayOptionLabelUnselected: any;
        overlayOptionDescription: any;
    }>;
}): React.ReactNode {
    const selected = React.useMemo(() => {
        if (props.options.some((option) => option.value === props.selected)) {
            return props.selected;
        }
        return props.options[0]?.value ?? props.selected;
    }, [props.options, props.selected]);

    return (
        <View style={props.styles.overlaySection}>
            <Text style={props.styles.overlaySectionTitle}>{props.title}</Text>
            {props.options.map((option) => {
                const isSelected = selected === option.value;
                return (
                    <Pressable
                        key={option.value}
                        onPress={() => props.onSelect(option.value)}
                        style={({ pressed }) => [props.styles.overlayOptionRow, pressed ? props.styles.overlayOptionRowPressed : null]}
                    >
                        <View
                            style={[
                                props.styles.overlayRadioOuter,
                                isSelected ? props.styles.overlayRadioOuterSelected : props.styles.overlayRadioOuterUnselected,
                            ]}
                        >
                            {isSelected ? <View style={props.styles.overlayRadioInner} /> : null}
                        </View>
                        <View>
                            <Text
                                style={[
                                    props.styles.overlayOptionLabel,
                                    isSelected ? props.styles.overlayOptionLabelSelected : props.styles.overlayOptionLabelUnselected,
                                ]}
                            >
                                {option.label}
                            </Text>
                            <Text style={props.styles.overlayOptionDescription}>{option.description}</Text>
                        </View>
                    </Pressable>
                );
            })}
        </View>
    );
}
