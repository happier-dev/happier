import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { HorizontalScrollableRow } from '@/components/ui/scroll/HorizontalScrollableRow';

import type {
    AgentInputChipPickerOption,
    AgentInputChipPickerOptionSection,
} from './AgentInputChipPickerTypes';
import {
    AGENT_INPUT_CHIP_PICKER_OPTION_ICON_SIZE,
    AGENT_INPUT_CHIP_PICKER_OPTION_ROW_RADIUS,
    createAgentInputChipPickerOptionTransientStyles,
} from './agentInputChipPickerOptionStyles';

export type AgentInputChipPickerTopSelectorProps = Readonly<{
    sections: ReadonlyArray<AgentInputChipPickerOptionSection>;
    focusedOptionId: string | null;
    selectedOptionId: string | null;
    onFocusOption: (optionId: string) => void;
}>;

const PICKER_ICON_SIZE = AGENT_INPUT_CHIP_PICKER_OPTION_ICON_SIZE;
const PICKER_OPTION_SIZE = 36;

type WebHoverablePressableState = Readonly<{
    pressed: boolean;
    hovered?: boolean;
}>;

function normalizePickerIcon(icon: React.ReactNode): React.ReactNode {
    if (!icon) return undefined;

    const resizedIcon = React.isValidElement(icon) && icon.type !== React.Fragment
        ? React.cloneElement(icon as React.ReactElement<Record<string, unknown>>, {
            size: PICKER_ICON_SIZE,
        })
        : icon;

    return (
        <View style={iconStyles.iconWrapper}>
            {normalizeNodeForView(resizedIcon)}
        </View>
    );
}

export function AgentInputChipPickerTopSelector(props: AgentInputChipPickerTopSelectorProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const transientStyles = React.useMemo(
        () => createAgentInputChipPickerOptionTransientStyles(theme),
        [theme],
    );

    const options = React.useMemo<ReadonlyArray<AgentInputChipPickerOption>>(
        () => props.sections.flatMap((section) => section.options),
        [props.sections],
    );

    return (
        <View testID="agent-input-chip-picker.top-selector" style={styles.container}>
            <HorizontalScrollableRow
                testID="agent-input-chip-picker.top-selector-scroll"
                contentTestID="agent-input-chip-picker.top-selector-content"
                containerStyle={styles.scrollContainer}
                contentStyle={styles.scrollContent}
                fadeColor={theme.colors.background.canvas}
                indicatorColor={theme.colors.text.tertiary}
                fadeLeftStyle={styles.fadeLeft}
                fadeRightStyle={styles.fadeRight}
            >
                {options.map((option) => {
                    const active = props.focusedOptionId === option.id || props.selectedOptionId === option.id;
                    const disabled = option.disabled === true;
                    const muted = option.muted === true;

                    return (
                        <Pressable
                            key={option.id}
                            testID={`agent-input-chip-picker.top-selector-option:${option.id}`}
                            accessibilityRole="button"
                            accessibilityLabel={option.label}
                            accessibilityState={{
                                selected: props.selectedOptionId === option.id,
                                disabled,
                            }}
                            disabled={disabled}
                            onPress={() => {
                                if (disabled) return;
                                props.onFocusOption(option.id);
                            }}
                            style={(state) => {
                                const pressed = state.pressed;
                                // RN Web exposes `hovered` in the Pressable state callback, but `react-native` types do not model it.
                                const hovered = (state as WebHoverablePressableState).hovered === true;
                                return [
                                    styles.optionButton,
                                    Platform.OS === 'web'
                                        && hovered
                                        && !active
                                        && !disabled
                                        && !muted
                                        ? transientStyles.optionRowHovered
                                        : null,
                                    active ? transientStyles.optionRowFocused : null,
                                    pressed ? transientStyles.optionRowPressed : null,
                                    (disabled || muted) ? transientStyles.optionRowDisabled : null,
                                ];
                            }}
                        >
                            {normalizePickerIcon(option.icon)}
                        </Pressable>
                    );
                })}
            </HorizontalScrollableRow>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        backgroundColor: theme.colors.background.canvas,
    },
    scrollContainer: {
        width: '100%',
        minHeight: PICKER_OPTION_SIZE + 20,
        backgroundColor: theme.colors.background.canvas,
    },
    scrollContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        paddingRight: 24,
    },
    optionButton: {
        width: PICKER_OPTION_SIZE,
        height: PICKER_OPTION_SIZE,
        borderRadius: AGENT_INPUT_CHIP_PICKER_OPTION_ROW_RADIUS,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'transparent',
    },
    fadeLeft: {
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: 24,
        zIndex: 2,
    },
    fadeRight: {
        position: 'absolute',
        right: 0,
        top: 0,
        bottom: 0,
        width: 24,
        zIndex: 2,
    },
}));

const iconStyles = StyleSheet.create(() => ({
    iconWrapper: {
        width: PICKER_ICON_SIZE,
        height: PICKER_ICON_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
