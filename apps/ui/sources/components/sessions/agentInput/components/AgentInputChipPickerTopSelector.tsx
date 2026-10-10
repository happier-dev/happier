import React from 'react';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { HorizontalScrollableRow } from '@/components/ui/scroll/HorizontalScrollableRow';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { resolveAgentInputChipPickerOptionAccessibilityLabel } from "./AgentInputChipPickerTypes";
import type {
    AgentInputChipPickerOption,
    AgentInputChipPickerOptionSection,
} from './AgentInputChipPickerTypes';
import {
    AGENT_INPUT_CHIP_PICKER_OPTION_ROW_RADIUS,
    createAgentInputChipPickerOptionTransientStyles,
} from './agentInputChipPickerOptionStyles';
import { normalizeAgentInputChipPickerOptionIcon } from './agentInputChipPickerOptionIcon';

export type AgentInputChipPickerTopSelectorProps = Readonly<{
    sections: ReadonlyArray<AgentInputChipPickerOptionSection>;
    focusedOptionId: string | null;
    selectedOptionId: string | null;
    onFocusOption: (optionId: string) => void;
}>;

const PICKER_OPTION_TOUCH_TARGET_SIZE = resolveMinimumInteractiveTargetSize(Platform.OS);

type WebHoverablePressableState = Readonly<{
    pressed: boolean;
    hovered?: boolean;
}>;

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
                {options.map((option, index) => {
                    // A new labelled group ("Not on devbox yet") starts after a thin divider (lab agent-setup E1p).
                    const startsGroup = index > 0 && option.sectionId !== undefined && option.sectionId !== options[index - 1]?.sectionId;
                    const active = props.focusedOptionId === option.id || props.selectedOptionId === option.id;
                    const disabled = option.disabled === true;
                    const muted = option.muted === true;

                    return (
                        <React.Fragment key={option.id}>
                        {startsGroup ? <View testID={`agent-input-chip-picker.top-selector-divider:${option.sectionId}`} style={styles.groupDivider} /> : null}
                        <Pressable
                            testID={`agent-input-chip-picker.top-selector-option:${option.id}`}
                            accessibilityRole="button"
                            accessibilityLabel={resolveAgentInputChipPickerOptionAccessibilityLabel(option, props.selectedOptionId === option.id)}
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
                            <View style={styles.iconSlot}>
                                {normalizeAgentInputChipPickerOptionIcon(option.icon)}
                                {option.statusMarker && props.selectedOptionId !== option.id ? (
                                    <View style={styles.statusBadge} pointerEvents="none">{normalizeNodeForView(option.statusMarker)}</View>
                                ) : null}
                            </View>
                            <Text style={styles.optionLabel}>{option.label}</Text>
                        </Pressable>
                        </React.Fragment>
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
        minHeight: PICKER_OPTION_TOUCH_TARGET_SIZE + 20,
        backgroundColor: theme.colors.background.canvas,
    },
    scrollContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
    optionButton: {
        height: PICKER_OPTION_TOUCH_TARGET_SIZE,
        minWidth: PICKER_OPTION_TOUCH_TARGET_SIZE,
        minHeight: PICKER_OPTION_TOUCH_TARGET_SIZE,
        flexShrink: 0,
        flexDirection: 'row',
        gap: theme.margins.sm,
        paddingHorizontal: theme.margins.md,
        borderRadius: AGENT_INPUT_CHIP_PICKER_OPTION_ROW_RADIUS,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'transparent',
    },
    optionLabel: {
        ...Typography.rowMeta(),
        color: theme.colors.text.primary,
    },
    iconSlot: {
        position: 'relative',
    },
    groupDivider: {
        width: StyleSheet.hairlineWidth,
        height: 26,
        marginHorizontal: 4,
        backgroundColor: theme.colors.border.default,
    },
    statusBadge: {
        position: 'absolute',
        right: 3,
        bottom: 3,
        minWidth: 14,
        height: 14,
        borderRadius: 7,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.background.canvas,
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
