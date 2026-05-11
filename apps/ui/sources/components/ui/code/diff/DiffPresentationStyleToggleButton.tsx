import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import { useSettingMutable } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { t } from '@/text';

export type DiffPresentationStyleToggleButtonProps = Readonly<{
    disabled?: boolean;
    size?: number;
}>;

export const DiffPresentationStyleToggleButton = React.memo<DiffPresentationStyleToggleButtonProps>((props) => {
    const { theme } = useUnistyles();
    const [styleSetting, setStyleSetting] = useSettingMutable('filesDiffPresentationStyle');

    const effectiveStyle = styleSetting === 'unified' || styleSetting === 'split'
        ? styleSetting
        : (settingsDefaults.filesDiffPresentationStyle === 'split' ? 'split' : 'unified');
    const disabled = props.disabled === true;
    const iconSize = typeof props.size === 'number' ? props.size : 18;

    const accessibilityLabel = t(
        effectiveStyle === 'unified'
            ? 'settingsSourceControl.filesDisplay.diffPresentation.options.unified.title'
            : 'settingsSourceControl.filesDisplay.diffPresentation.options.split.title',
    );

    const toggle = React.useCallback(() => {
        if (disabled) return;
        setStyleSetting(effectiveStyle === 'unified' ? 'split' : 'unified');
    }, [disabled, effectiveStyle, setStyleSetting]);

    return (
        <Pressable
            onPress={toggle}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            style={(state) => {
                const { pressed } = state;
                // RN Web exposes `hovered` in the Pressable state callback, but `react-native` types do not model it.
                const hovered = (state as { hovered?: boolean }).hovered === true;
                return [
                    styles.root,
                    hovered ? styles.rootHovered : null,
                    pressed ? styles.rootPressed : null,
                    disabled ? styles.rootDisabled : null,
                ];
            }}
        >
            <View style={styles.icon}>
                <Ionicons
                    name={effectiveStyle === 'unified' ? 'swap-vertical-outline' : 'grid-outline'}
                    size={iconSize}
                    color={theme.colors.text.secondary}
                />
            </View>
        </Pressable>
    );
});

const styles = StyleSheet.create((theme) => ({
    root: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.inset,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    rootHovered: {
        backgroundColor: theme.colors.surface.elevated ?? theme.colors.surface.inset,
    },
    rootPressed: {
        opacity: 0.9,
    },
    rootDisabled: {
        opacity: 0.5,
    },
    icon: {
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 20,
    },
}));
