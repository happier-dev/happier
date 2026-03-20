import React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import type {
    AgentInputChipPickerOption,
    AgentInputChipPickerOptionSection,
} from './AgentInputChipPickerTypes';

export type AgentInputChipPickerTopSelectorProps = Readonly<{
    sections: ReadonlyArray<AgentInputChipPickerOptionSection>;
    focusedOptionId: string | null;
    onFocusOption: (optionId: string) => void;
}>;

export function AgentInputChipPickerTopSelector(props: AgentInputChipPickerTopSelectorProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [open, setOpen] = React.useState(false);

    const items = React.useMemo<ReadonlyArray<DropdownMenuItem>>(
        () =>
            props.sections.flatMap((section) =>
                section.options.map((option) => ({
                    id: option.id,
                    title: option.label,
                    subtitle: option.subtitle,
                    category: section.label,
                    disabled: option.disabled,
                })),
            ),
        [props.sections],
    );

    const focusedOption = React.useMemo<AgentInputChipPickerOption | null>(() => {
        for (const section of props.sections) {
            const found = section.options.find((option) => option.id === props.focusedOptionId);
            if (found) return found;
        }
        return props.sections[0]?.options[0] ?? null;
    }, [props.focusedOptionId, props.sections]);

    const subtitle = focusedOption?.subtitle ?? focusedOption?.sectionLabel ?? null;

    return (
        <View testID="agent-input-chip-picker.top-selector" style={styles.container}>
            <DropdownMenu
                open={open}
                onOpenChange={setOpen}
                items={items}
                selectedId={focusedOption?.id ?? null}
                onSelect={props.onFocusOption}
                rowKind="item"
                variant="selectable"
                matchTriggerWidth
                trigger={({ toggle }) => (
                    <Pressable
                        testID="agent-input-chip-picker.top-selector-trigger"
                        accessibilityRole="button"
                        onPress={toggle}
                        style={({ pressed }) => [
                            styles.trigger,
                            open ? styles.triggerOpen : null,
                            pressed ? styles.triggerPressed : null,
                        ]}
                    >
                        <View style={styles.textBlock}>
                            <Text style={styles.title}>{focusedOption?.label ?? ''}</Text>
                            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
                        </View>
                        <Ionicons
                            name={open ? 'chevron-up' : 'chevron-down'}
                            size={18}
                            color={theme.colors.textSecondary}
                        />
                    </Pressable>
                )}
            />
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
    },
    trigger: {
        minHeight: 44,
        width: '100%',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
        paddingHorizontal: 12,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
    },
    triggerOpen: {
        borderColor: theme.colors.button.primary.background,
        backgroundColor: theme.colors.groupped.background,
    },
    triggerPressed: {
        opacity: 0.82,
    },
    textBlock: {
        flex: 1,
        gap: 1,
    },
    title: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    subtitle: {
        fontSize: 11,
        color: theme.colors.textSecondary,
    },
}));
