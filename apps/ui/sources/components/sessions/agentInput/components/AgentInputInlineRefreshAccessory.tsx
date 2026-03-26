import * as React from 'react';
import { ActivityIndicator, Pressable, View, type AccessibilityState } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import { t } from '@/text';

export type AgentInputInlineRefreshAccessoryProps = Readonly<{
    probe: OptionPickerProbeState | null | undefined;
    testID?: string;
    accessibilityLabel?: string;
}>;

export function AgentInputInlineRefreshAccessory(props: AgentInputInlineRefreshAccessoryProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const probe = props.probe ?? null;

    if (
        !probe
        || (
            probe.phase === 'idle'
            && typeof probe.onRefresh !== 'function'
        )
    ) {
        return null;
    }

    if (typeof probe.onRefresh === 'function') {
        const disabled = probe.phase !== 'idle';
        const accessibilityState: AccessibilityState = { disabled };

        return (
            <Pressable
                testID={props.testID}
                accessibilityRole="button"
                accessibilityLabel={props.accessibilityLabel ?? t('common.refresh')}
                accessibilityState={accessibilityState}
                onPress={!disabled ? probe.onRefresh : undefined}
                disabled={disabled}
                style={({ pressed }) => [
                    styles.button,
                    pressed && !disabled ? styles.buttonPressed : null,
                    disabled ? styles.buttonDisabled : null,
                ]}
            >
                {probe.phase === 'idle' ? (
                    <Ionicons name="refresh-outline" size={18} color={theme.colors.textSecondary} />
                ) : (
                    <ActivityIndicator size="small" />
                )}
            </Pressable>
        );
    }

    if (probe.phase === 'idle') {
        return null;
    }

    return (
        <View style={styles.button}>
            <ActivityIndicator size="small" />
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    button: {
        minWidth: 30,
        height: 30,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: 'transparent',
    },
    buttonPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    buttonDisabled: {
        opacity: 0.6,
    },
}));
