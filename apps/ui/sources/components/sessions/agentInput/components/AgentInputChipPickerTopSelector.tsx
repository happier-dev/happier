import React from 'react';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { HorizontalScrollableRow } from '@/components/ui/scroll/HorizontalScrollableRow';
import { useGlassSurfaceColor } from '@/components/ui/glass/useGlassSurfaceColor';
import { HAPPIER_PAGE_METRICS, HappierPressable } from '@happier-dev/plugin-ui/presentation';

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
import { useAgentInputChipPickerRovingFocus } from './useAgentInputChipPickerRovingFocus';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';

export type AgentInputChipPickerTopSelectorProps = Readonly<{
    sections: ReadonlyArray<AgentInputChipPickerOptionSection>;
    focusedOptionId: string | null;
    selectedOptionId: string | null;
    onFocusOption: (optionId: string) => void;
}>;

// An option is the Agent's mark alone in a control-height square (0.2's strip); its name is the accessible name, and a
// finger reaches it through the hit area.
const PICKER_OPTION_SIZE = HAPPIER_PAGE_METRICS.controlHeightPx;
/** Half the strip's 8 px gap on each side: neighbouring options' hit areas meet, never overlap. */
const PICKER_OPTION_HIT_REACH = { left: 4, right: 4 } as const;

type WebHoverablePressableState = Readonly<{
    pressed: boolean;
    hovered?: boolean;
}>;

export function AgentInputChipPickerTopSelector(props: AgentInputChipPickerTopSelectorProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    // The strip sits on the popover's material, so its scroll fades take the material's own colour.
    const fadeColor = useGlassSurfaceColor(theme.colors.edge.floatingFill, 'floating', false);
    const transientStyles = React.useMemo(
        () => createAgentInputChipPickerOptionTransientStyles(theme),
        [theme],
    );

    const options = React.useMemo<ReadonlyArray<AgentInputChipPickerOption>>(
        () => props.sections.flatMap((section) => section.options),
        [props.sections],
    );
    const roving = useAgentInputChipPickerRovingFocus({
        options,
        currentOptionId: props.focusedOptionId ?? props.selectedOptionId,
    });

    return (
        <View testID="agent-input-chip-picker.top-selector" style={styles.container}>
            <HorizontalScrollableRow
                testID="agent-input-chip-picker.top-selector-scroll"
                contentTestID="agent-input-chip-picker.top-selector-content"
                containerStyle={styles.scrollContainer}
                contentStyle={styles.scrollContent}
                fadeColor={fadeColor}
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
                        <HappierPressable
                            testID={`agent-input-chip-picker.top-selector-option:${option.id}`}
                            accessibilityRole="button"
                            accessibilityLabel={resolveAgentInputChipPickerOptionAccessibilityLabel(option, props.selectedOptionId === option.id)}
                            selected={props.selectedOptionId === option.id}
                            hitReach={PICKER_OPTION_HIT_REACH}
                            disabled={disabled}
                            tabIndex={roving.tabIndexFor(index)}
                            controlRef={(target) => roving.registerTarget(index, target)}
                            onKeyDown={(key) => roving.onKeyDown(index, key)}
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
                                    focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                                ];
                            }}
                        >
                            <View style={styles.iconSlot}>
                                {normalizeAgentInputChipPickerOptionIcon(option.icon)}
                                {option.statusMarker && props.selectedOptionId !== option.id ? (
                                    <View style={styles.statusBadge} pointerEvents="none">{normalizeNodeForView(option.statusMarker)}</View>
                                ) : null}
                            </View>
                        </HappierPressable>
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
    },
    scrollContainer: {
        width: '100%',
        minHeight: PICKER_OPTION_SIZE + theme.space.s12,
    },
    // The strip stands as far from the popover's top as from its side; the pane below brings its own top inset.
    scrollContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s12,
        paddingTop: theme.space.s12,
        paddingBottom: 0,
    },
    optionButton: {
        width: PICKER_OPTION_SIZE,
        height: PICKER_OPTION_SIZE,
        minWidth: PICKER_OPTION_SIZE,
        minHeight: PICKER_OPTION_SIZE,
        flexShrink: 0,
        borderRadius: AGENT_INPUT_CHIP_PICKER_OPTION_ROW_RADIUS,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'transparent',
    },
    iconSlot: {
        position: 'relative',
    },
    groupDivider: {
        width: StyleSheet.hairlineWidth,
        height: 26,
        marginHorizontal: theme.space.s4,
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
