import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierRadioMark } from '@happier-dev/plugin-ui/presentation';

import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { EffectivePermissionModeDescription } from '@/sync/domains/permissions/describeEffectivePermissionMode';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';


export type PermissionModePickerOption = Readonly<{
    value: PermissionMode;
    label: string;
    description: string;
    /** Where an inherited default came from ("Team default"), trailing on the selected row only. */
    attribution?: string | null;
}>;

export function PermissionModePicker(props: {
    title: string;
    options: readonly PermissionModePickerOption[];
    /** Null chooses no row: several targets differ ("Mixed"). */
    selected: PermissionMode | null;
    onSelect: (mode: PermissionMode) => void;
    styles: Readonly<{
        overlaySection: any;
        overlaySectionTitle: any;
        overlayOptionRow: any;
        overlayOptionRowPressed: any;
        overlayOptionLabel: any;
        overlayOptionLabelSelected: any;
        overlayOptionLabelUnselected: any;
        overlayOptionDescription: any;
    }>;
    effectivePermissionLabel: string;
    effectivePermissionPolicy: EffectivePermissionModeDescription;
}): React.ReactNode {
    const { theme } = useUnistyles();
    const presentationTheme = usePluginUiTheme(theme);
    const selected = React.useMemo(() => {
        if (props.selected === null) return null;
        if (props.options.some((option) => option.value === props.selected)) {
            return props.selected;
        }
        return props.options[0]?.value ?? props.selected;
    }, [props.options, props.selected]);

    return (
        <View style={props.styles.overlaySection}>
            <Text style={props.styles.overlaySectionTitle}>{props.title}</Text>
            <View style={{ paddingHorizontal: 16 }}>
                <Text style={[props.styles.overlayOptionDescription]}>
                    {t('agentInput.permissionMode.effectiveLabel', { label: props.effectivePermissionLabel })}
                </Text>
                {props.effectivePermissionPolicy.notes.map((note, idx) => (
                    <Text key={idx} style={props.styles.overlayOptionDescription}>
                        {note}
                    </Text>
                ))}
            </View>
            {props.options.map((option) => {
                const isSelected = selected === option.value;
                return (
                    <Pressable
                        key={option.value}
                        testID={`permission-mode-${option.value}`}
                        accessibilityRole="radio"
                        accessibilityLabel={option.label}
                        accessibilityState={{ checked: isSelected }}
                        onPress={() => props.onSelect(option.value)}
                        style={({ pressed }) => [props.styles.overlayOptionRow, pressed ? props.styles.overlayOptionRowPressed : null]}
                    >
                        <HappierRadioMark selected={isSelected} theme={presentationTheme} style={{ marginRight: theme.space.s12 }} />
                        <View style={{ flex: 1 }}>
                            <Text
                                style={[
                                    props.styles.overlayOptionLabel,
                                    isSelected ? props.styles.overlayOptionLabelSelected : props.styles.overlayOptionLabelUnselected,
                                ]}
                            >
                                {option.label}
                            </Text>
                            {option.description ? <Text style={props.styles.overlayOptionDescription}>{option.description}</Text> : null}
                        </View>
                        {option.attribution ? (
                            <Text testID={`permission-mode-${option.value}-attribution`} numberOfLines={1}
                                style={[props.styles.overlayOptionDescription, { marginLeft: theme.space.s12, alignSelf: 'flex-start' }]}>
                                {option.attribution}
                            </Text>
                        ) : null}
                    </Pressable>
                );
            })}
        </View>
    );
}
