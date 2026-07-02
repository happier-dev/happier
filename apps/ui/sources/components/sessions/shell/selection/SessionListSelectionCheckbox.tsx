import * as React from 'react';
import { Platform, Pressable, View, type GestureResponderEvent, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import { useOptionalSessionListSelectionRow } from './SessionListSelectionContext';

const CHECKBOX_SIZE = 18;
const CHECKBOX_INNER_SIZE = 14;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: 48,
        height: 48,
        alignItems: 'center',
        justifyContent: 'center',
    },
    box: {
        width: CHECKBOX_SIZE,
        height: CHECKBOX_SIZE,
        borderRadius: CHECKBOX_SIZE / 2,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    selectedFill: {
        width: CHECKBOX_INNER_SIZE,
        height: CHECKBOX_INNER_SIZE,
        borderRadius: CHECKBOX_INNER_SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

export type SessionListSelectionCheckboxProps = Readonly<{
    sessionId: string;
    selectionKey: string;
    selected?: boolean;
    onPress?: (event?: GestureResponderEvent) => void;
    accessibilityLabel?: string;
    style?: StyleProp<ViewStyle>;
}>;

export function SessionListSelectionCheckbox(props: SessionListSelectionCheckboxProps): React.ReactElement {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const rowSelection = useOptionalSessionListSelectionRow(props.selectionKey);
    const selected = props.selected ?? rowSelection.isSelected;
    const transitionStyle = React.useMemo(() => {
        if (Platform.OS !== 'web') return null;
        return {
            transitionProperty: 'background-color, border-color, opacity, transform',
            transitionDuration: `${reducedMotion ? motionTokens.durationMs.instant : motionTokens.durationMs.fast}ms`,
        } as unknown as ViewStyle;
    }, [reducedMotion]);
    const handlePress = React.useCallback((event?: GestureResponderEvent) => {
        const maybeEvent = event as unknown as {
            stopPropagation?: () => void;
            preventDefault?: () => void;
        } | undefined;
        maybeEvent?.stopPropagation?.();
        if (props.onPress) {
            props.onPress(event);
            return;
        }
        rowSelection.toggle();
    }, [props.onPress, rowSelection]);

    return (
        <Pressable
            testID={`session-list-selection-checkbox-${props.sessionId}`}
            accessibilityRole="checkbox"
            accessibilityLabel={props.accessibilityLabel ?? t('sessionsList.selectionCheckboxA11yLabel')}
            accessibilityState={{ checked: selected }}
            {...({
                'aria-checked': selected ? 'true' : 'false',
                'data-selected': selected ? 'true' : 'false',
                'data-state': selected ? 'selected' : 'unselected',
                dataSet: {
                    selected: selected ? 'true' : 'false',
                    state: selected ? 'selected' : 'unselected',
                },
            } as Record<string, unknown>)}
            onPress={handlePress}
            style={[styles.root, props.style]}
        >
            <View
                style={[
                    styles.box,
                    transitionStyle,
                    {
                        borderColor: selected ? 'transparent' : theme.colors.border.default,
                        backgroundColor: theme.colors.background.canvas,
                        opacity: selected ? 1 : 0.86,
                    },
                ]}
            >
                {selected ? (
                    <View
                        testID={`session-list-selection-checkbox-inner-${props.sessionId}`}
                        style={[styles.selectedFill, { backgroundColor: theme.colors.state.active.foreground }]}
                    >
                        <Ionicons name="checkmark" size={10} color={theme.colors.overlay.foreground} />
                    </View>
                ) : null}
            </View>
        </Pressable>
    );
}
